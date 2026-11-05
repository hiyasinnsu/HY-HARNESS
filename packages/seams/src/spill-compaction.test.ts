import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Agent,
  Ledger,
  SessionLog,
  ToolRuntime,
  readEvents,
  type ChatMessage,
  type Completion,
  type LlmProvider,
} from '../../core/dist/index.js'
import { SpillCompaction, pruneImages } from './spill-compaction.js'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hy-compact-'))
}

/** Replies from a script and reports the given input tokens per call. */
class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted'
  readonly requests: ChatMessage[][] = []
  constructor(
    private readonly replies: (i: number) => string,
    private readonly inputTokens: (i: number) => number = () => 100,
  ) {}
  async complete(messages: ChatMessage[]): Promise<Completion> {
    const i = this.requests.length
    this.requests.push(messages.map((m) => ({ ...m })))
    return { content: this.replies(i), usage: { inputTokens: this.inputTokens(i), outputTokens: 10 } }
  }
}

function stubTools(output: () => unknown): ToolRuntime {
  return { execute: async () => output(), takeClaim: () => undefined, takeImages: () => [] } as unknown as ToolRuntime
}

/** After the system prompt and the objective, assistant and user alternate. */
function assertPairsIntact(messages: ChatMessage[]): void {
  assert.equal(messages[0]!.role, 'system')
  assert.equal(messages[1]!.role, 'user')
  messages.slice(2).forEach((m, i) => assert.equal(m.role, i % 2 === 0 ? 'assistant' : 'user', `message ${i + 2}`))
  messages.forEach((m, i) => {
    if (/^TOOL (RESULT|ERROR)/.test(m.content)) assert.match(messages[i - 1]!.content, /"tool"/, `orphaned result at ${i}`)
  })
}

test('an output above the threshold is spilled and readable through read_file', async () => {
  const dir = tmp()
  try {
    const sc = new SpillCompaction({ spillDir: path.join(dir, 'spill'), sessionId: 'sess', contextWindowTokens: 10_000, thresholdBytes: 1_000 })
    assert.deepEqual(sc.toolOutput('step-1', 'small'), { visible: 'small' })
    const big = `${'a'.repeat(5_000)}\nMIDDLE-MARKER\n${'z'.repeat(5_000)}`
    const v = sc.toolOutput('step-2', big)
    assert.equal(v.spillRef?.path, 'spill://sess/step-2')
    assert.equal(v.spillRef?.byteLength, Buffer.byteLength(big))
    assert.equal(v.spillRef?.totalLines, 3)
    assert.ok(!v.visible.includes('MIDDLE-MARKER'), 'the middle is not shown')
    assert.match(v.visible, /^a{100}/)
    assert.match(v.visible, /z{100}\nSpillRef: /)
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(ws)
    const tools = new ToolRuntime(null as never, ws, undefined, false, { spillDir: path.join(dir, 'spill') })
    const read = (await tools.execute('read_file', { path: v.spillRef!.path, startLine: 2, endLine: 2 })) as { content: string }
    assert.equal(read.content, 'MIDDLE-MARKER')
    await assert.rejects(tools.execute('read_file', { path: 'spill://../../etc' }), /unknown spill reference/)
    await assert.rejects(tools.execute('apply_patch', { file: 'spill://sess/step-2', content: 'x' }))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tier 1 prunes old tool outputs to locators and keeps recent ones', async () => {
  const dir = tmp()
  try {
    const log = new SessionLog(path.join(dir, 'session.v1.jsonl'))
    const sc = new SpillCompaction({
      spillDir: path.join(dir, 'spill'),
      sessionId: log.sessionId,
      contextWindowTokens: 10_000,
      keepRecentTurns: 2,
      log,
    })
    const worker = new ScriptedProvider(
      (i) => (i < 5 ? `{"tool":"read_file","args":{"path":"f${i}.txt"}}` : '{"final":"done"}'),
      (i) => (i >= 4 ? 9_000 : 1_000),
    )
    const agent = new Agent({
      provider: worker,
      tools: stubTools(() => ({ content: 'line\n'.repeat(400) })),
      sessionLog: log,
      workspaceRoot: dir,
      context: sc,
    })
    await agent.run('read the files')
    const last = worker.requests.at(-1)!
    assertPairsIntact(last)
    const results = last.filter((m) => m.content.startsWith('TOOL RESULT'))
    assert.equal(results.length, 5)
    assert.equal(results.filter((m) => m.content.includes('[pruned to save context')).length, 3)
    const locator = /spill:\/\/[\w-]+\/[\w.-]+/.exec(results[0]!.content)![0]
    const file = path.join(dir, 'spill', `${locator.slice('spill://'.length)}.txt`)
    // The pruned tool result (JSON) is kept on disk in full.
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).content, 'line\n'.repeat(400))
    assert.ok(readEvents(log.file).some((e) => e.type === 'compaction/prune'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tier 2 summarizes between pairs and constraints + notes stay verbatim', async () => {
  const dir = tmp()
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Never edit vendor/.\n')
    const log = new SessionLog(path.join(dir, 'session.v1.jsonl'))
    log.setRun('run-c')
    const ledger = Ledger.forRun(log, 'run-c', [{ source: 'AGENTS.md', text: 'Never edit vendor/.' }])
    ledger.upsert({ key: 'legacy-cjs', rule: 'keep src/legacy CommonJS', rationale: 'the loader requires it' })
    const compactor = new ScriptedProvider(() => '- Read f0..f3; nothing changed yet.')
    const sc = new SpillCompaction({
      spillDir: path.join(dir, 'spill'),
      sessionId: log.sessionId,
      contextWindowTokens: 1_000,
      keepRecentTurns: 2,
      compactor,
      ledgerKeys: () => ledger.list().map((n) => n.key),
      log,
    })
    const worker = new ScriptedProvider(
      (i) => (i < 6 ? `{"tool":"read_file","args":{"path":"f${i}.txt"}}` : '{"final":"done"}'),
      // From the fifth request on, the context is "full".
      (i) => (i >= 4 ? 900 : 100),
    )
    const agent = new Agent({
      provider: worker,
      tools: stubTools(() => ({ content: 'short' })),
      sessionLog: log,
      workspaceRoot: dir,
      ledger,
      context: sc,
    })
    await agent.run('read the files')

    const compacted = worker.requests.find((r) => r[1]!.content.includes('<session_summary>'))
    assert.ok(compacted, 'a request after compaction')
    assertPairsIntact(compacted)
    assert.ok(compacted.length < worker.requests[4]!.length + 2, 'older pairs were removed')
    assert.match(compacted[1]!.content, /^read the files\n\n<session_summary>\n.*\n- Read f0\.\.f3; nothing changed yet\.\n<\/session_summary>$/)
    // Re-rendered verbatim, independent of the summary.
    assert.ok(compacted[0]!.content.includes('--- AGENTS.md ---\nNever edit vendor/.'))
    assert.ok(compacted[0]!.content.includes('- legacy-cjs: keep src/legacy CommonJS\n  why: the loader requires it'))
    // The compactor was told not to paraphrase the ledger.
    assert.match(compactor.requests[0]![0]!.content, /Do not restate these agent notes.*legacy-cjs/)
    const summary = readEvents(log.file).find((e) => e.type === 'compaction/summary')
    assert.ok(summary)
    assert.equal((summary.payload as { summaryMarkdown: string }).summaryMarkdown, '- Read f0..f3; nothing changed yet.')
    for (const r of worker.requests) assertPairsIntact(r)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a step that carries a steering message keeps its tool result attached', async () => {
  const dir = tmp()
  try {
    const sc = new SpillCompaction({
      spillDir: path.join(dir, 'spill'),
      sessionId: 'sess',
      contextWindowTokens: 10_000,
      keepRecentTurns: 1,
    })
    const big = `TOOL RESULT (read_file):\n${'x'.repeat(1_000)}`
    const steer = '[the user sent this while you were working]\nalso check the tests'
    // The older step answered two user messages: the tool result and a steer.
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read the files' },
      { role: 'assistant', content: '{"tool":"read_file","args":{"path":"a"}}' },
      { role: 'user', content: big },
      { role: 'user', content: steer },
      { role: 'assistant', content: '{"tool":"read_file","args":{"path":"b"}}' },
      { role: 'user', content: 'TOOL RESULT (read_file):\n{}' },
    ]
    const out = await sc.beforeRequest(messages, 9_000)
    const resultAt = out.findIndex((m) => m.content.startsWith('TOOL RESULT'))
    assert.ok(resultAt > 0)
    assert.match(out[resultAt]!.content, /pruned to save context/, 'the older tool output is pruned')
    assert.equal(out[resultAt + 1]!.content, steer, 'the steering message stays with the step it interrupted')
    // The step boundary moved, not the message order: the result still answers
    // the assistant call before it.
    assert.match(out[resultAt - 1]!.content, /"tool"/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-17: old image attachments are dropped, recent ones kept', () => {
  const image = { mimeType: 'image/png', data: 'AA==' }
  const messages = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'first', images: [image] },
    { role: 'assistant' as const, content: 'a' },
    { role: 'user' as const, content: 'second', images: [image, image] },
    { role: 'assistant' as const, content: 'b' },
    { role: 'user' as const, content: 'third', images: [image] },
  ]
  const pruned = pruneImages(messages, 2)
  assert.equal(pruned[1]!.images, undefined, 'the oldest attachment is removed')
  assert.match(pruned[1]!.content, /1 image\(s\) removed to save context/)
  assert.equal(pruned[3]!.images?.length, 2, 'the recent two are kept')
  assert.equal(pruned[5]!.images?.length, 1)
  // Nothing changes when there is nothing to drop.
  assert.deepEqual(pruneImages(messages.slice(3), 2), messages.slice(3))
})

test('CP-17: pruning happens even below the compaction trigger', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-media-'))
  try {
    const compaction = new SpillCompaction({ spillDir: dir, sessionId: 's', contextWindowTokens: 1_000_000 })
    const image = { mimeType: 'image/png', data: 'AA==' }
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'old', images: [image] },
      { role: 'assistant' as const, content: 'a' },
      { role: 'user' as const, content: 'middle', images: [image] },
      { role: 'assistant' as const, content: 'b' },
      { role: 'user' as const, content: 'new', images: [image] },
    ]
    const out = await compaction.beforeRequest(messages, 0)
    assert.equal(out[1]!.images, undefined)
    assert.equal(out[3]!.images?.length, 1)
    assert.equal(out[5]!.images?.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function longSession(): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'objective' },
  ]
  for (let i = 0; i < 8; i++) {
    messages.push({ role: 'assistant', content: `step ${i}` })
    messages.push({ role: 'user', content: `TOOL RESULT (read_file): ${'a'.repeat(200)}-${i}` })
  }
  return messages
}

test('CP-22: a failing compactor keeps the tier-1 result and reports it', async () => {
  const dir = tmp()
  try {
    const log = new SessionLog(path.join(dir, 'session.v1.jsonl'))
    log.setRun('run-f')
    const calls: string[] = []
    const sc = new SpillCompaction({
      spillDir: path.join(dir, 'spill'),
      sessionId: log.sessionId,
      contextWindowTokens: 1_000,
      keepRecentTurns: 2,
      compactor: {
        name: 'boom',
        complete: async () => {
          throw new Error('HTTP 500')
        },
      } as never,
      log,
      hooks: {
        preCompact: (info: { pairs: number }) => {
          calls.push(`pre:${info.pairs}`)
        },
        postCompact: (info: { summarized: boolean }) => {
          calls.push(`post:${info.summarized}`)
        },
      },
    })
    const out = await sc.beforeRequest(longSession(), 900)
    assert.ok(!out.some((m) => m.content.includes('<session_summary>')), 'no summary was added')
    assert.ok(log.events().some((event) => event.type === 'compaction/failed'), 'the failure is logged')
    assert.deepEqual(calls, ['pre:6', 'post:false'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-22: a successful compaction reports the pairs and the summary', async () => {
  const dir = tmp()
  try {
    const log = new SessionLog(path.join(dir, 'session.v1.jsonl'))
    log.setRun('run-g')
    const calls: string[] = []
    const sc = new SpillCompaction({
      spillDir: path.join(dir, 'spill'),
      sessionId: log.sessionId,
      contextWindowTokens: 1_000,
      keepRecentTurns: 2,
      compactor: { name: 'ok', complete: async () => ({ content: '{"summary":"did things"}', usage: { inputTokens: 0, outputTokens: 0 } }) } as never,
      log,
      hooks: {
        preCompact: (info: { pairs: number }) => {
          calls.push(`pre:${info.pairs}`)
        },
        postCompact: (info: { summarized: boolean }) => {
          calls.push(`post:${info.summarized}`)
        },
      },
    })
    const out = await sc.beforeRequest(longSession(), 900)
    assert.ok(out.some((m) => m.content.includes('<session_summary>') && m.content.includes('did things')))
    assert.deepEqual(calls, ['pre:6', 'post:true'])
    assert.ok(log.events().some((event) => event.type === 'compaction/summary'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-22: afterResponse warms a summary and the next request reuses it once', async () => {
  const dir = tmp()
  try {
    const log = new SessionLog(path.join(dir, 'session.v1.jsonl'))
    log.setRun('run-w')
    let calls = 0
    const compactor = {
      name: 'warm',
      complete: async () => {
        calls += 1
        return { content: '{"summary":"warm summary"}', usage: { inputTokens: 0, outputTokens: 0 } }
      },
    }
    const sc = new SpillCompaction({
      spillDir: path.join(dir, 'spill'),
      sessionId: log.sessionId,
      contextWindowTokens: 1_000,
      keepRecentTurns: 2,
      compactor: compactor as never,
      log,
    })
    const messages = longSession()
    sc.afterResponse(messages, { usage: { inputTokens: 900 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls, 1, 'the summary was produced in the background')

    const next = [...messages, { role: 'assistant' as const, content: 'step 8' }, { role: 'user' as const, content: 'TOOL RESULT (read_file): done' }]
    const out = await sc.beforeRequest(next, 900)
    assert.equal(calls, 1, 'the warm summary was reused instead of calling the compactor again')
    assert.ok(out.some((m) => m.content.includes('<session_summary>') && m.content.includes('warm summary')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-22: afterResponse without a compactor or below the trigger does nothing', () => {
  const dir = tmp()
  try {
    const sc = new SpillCompaction({ spillDir: path.join(dir, 'spill'), sessionId: 's', contextWindowTokens: 1_000 })
    sc.afterResponse(longSession(), { usage: { inputTokens: 900 } })
    const withCompactor = new SpillCompaction({
      spillDir: path.join(dir, 'spill'),
      sessionId: 's2',
      contextWindowTokens: 1_000,
      compactor: { name: 'x', complete: async () => ({ content: '{"summary":"x"}', usage: { inputTokens: 0, outputTokens: 0 } }) } as never,
    })
    withCompactor.afterResponse(longSession(), { usage: { inputTokens: 100 } })
    // Nothing throws and nothing is cached: the next request computes synchronously.
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})