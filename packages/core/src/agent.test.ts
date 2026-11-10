import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Agent, rebuildHistory, toolErrorMessage, toolResultMessage } from './agent.js'
import { SessionLog } from './session-log.js'
import { ToolRuntime } from './tools.js'
import { Hooks } from './hooks.js'
import { steerMessage } from './steering.js'
import type { SessionEvent } from './session-log.js'

let seq = 0
const ev = (type: string, payload: unknown, runId = 'run-a'): SessionEvent => ({
  v: 1,
  seq: ++seq,
  ts: seq,
  sessionId: 's',
  runId,
  type,
  payload,
})

test('rebuildHistory replays what the model saw and honours /undo', () => {
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('user/message', { content: 'first' }),
    ev('assistant/message', { content: '{"tool":"read_file","args":{"path":"a"}}' }),
    ev('tool/result', { name: 'read_file', output: '{"content":"x"}', isError: false }),
    ev('assistant/message', { content: '{"final":"done"}' }),
    ev('user/message', { content: 'other run' }, 'run-b'),
    ev('turn/start', { turn: 2 }),
    ev('user/message', { content: 'second' }),
    ev('assistant/message', { content: '{"tool":"shell","args":{}}' }),
    ev('tool/result', { name: 'shell', output: 'boom', isError: true }),
    ev('turn/undo', { turn: 2 }),
    ev('turn/start', { turn: 2 }),
    ev('user/message', { content: 'second again' }),
  ]
  // Out-of-order input is sorted by seq.
  const history = rebuildHistory([...events].reverse(), 'run-a')
  assert.deepEqual(history, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: '{"tool":"read_file","args":{"path":"a"}}' },
    { role: 'user', content: toolResultMessage('read_file', '{"content":"x"}') },
    { role: 'assistant', content: '{"final":"done"}' },
    { role: 'user', content: 'second again' },
  ])
  assert.match(toolErrorMessage('shell', 'boom'), /^TOOL ERROR \(shell\): boom\n/)
})

test('rebuildHistory applies compaction/summary and drops shadowed steps', () => {
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('user/message', { content: 'objective' }),
    ev('assistant/message', { content: '{"tool":"read_file","args":{"path":"f1"}}' }),
    ev('tool/result', { name: 'read_file', output: 'content1', isError: false }),
    ev('assistant/message', { content: '{"tool":"read_file","args":{"path":"f2"}}' }),
    ev('tool/result', { name: 'read_file', output: 'content2', isError: false }),
    ev('assistant/message', { content: '{"tool":"read_file","args":{"path":"f3"}}' }),
    ev('tool/result', { name: 'read_file', output: 'content3', isError: false }),
    ev('compaction/summary', {
      shadowedThroughSeq: 8,
      summaryMarkdown: '{"summary":"Read f1 and f2."}',
      pairs: 2,
    }),
    ev('assistant/message', { content: '{"final":"done"}' }),
  ]
  const history = rebuildHistory(events, 'run-a')
  assert.equal(history.length, 4) // objective with summary + step 3 (assistant + tool) + final assistant
  assert.match(history[0]!.content, /^objective\n\n<session_summary>\nSummary of earlier steps \(written by the compactor\):\nRead f1 and f2\.\n<\/session_summary>$/)
  assert.equal(history[1]!.role, 'assistant')
  assert.equal(history[1]!.content, '{"tool":"read_file","args":{"path":"f3"}}')
  assert.equal(history[2]!.role, 'user')
  assert.equal(history[2]!.content, toolResultMessage('read_file', 'content3'))
  assert.equal(history[3]!.role, 'assistant')
  assert.equal(history[3]!.content, '{"final":"done"}')
})

test('identical consecutive tool calls get a reminder (RepeatToolReminderGuard)', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-repeat-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n')
    const call = JSON.stringify({ tool: 'read_file', args: { path: 'a.txt' } })
    const replies = [call, call, call, JSON.stringify({ tool: 'read_file', args: { path: 'a.txt', startLine: 1 } }), '{"final":"ok"}']
    const seen: string[] = []
    const provider = {
      name: 'scripted',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.at(-1)!.content)
        return { content: replies.shift()!, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    const tools = new ToolRuntime({} as never, dir)
    const result = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir }).run('go')
    assert.equal(result.final, 'ok')
    // seen[n] is the result of reply n-1.
    assert.doesNotMatch(seen[1]!, /\[reminder\]/)
    assert.match(seen[2]!, /\[reminder\] This is the same call with the same arguments 2 times in a row/)
    assert.match(seen[3]!, /3 times in a row/)
    assert.doesNotMatch(seen[4]!, /\[reminder\]/, 'different arguments reset the count')
    assert.equal(log.events().filter((e) => e.type === 'guard/repeat').length, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('switching work mode appends context while preserving the cached conversation prefix', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-work-mode-'))
  try {
    let mode: 'fast' | 'thorough' = 'fast'
    const requests: Array<Array<{ role: string; content: string }>> = []
    const provider = { name: 'scripted', complete: async (messages: Array<{ role: string; content: string }>) => {
      requests.push(messages.map((m) => ({ role: m.role, content: m.content })))
      return { content: '{"final":"done"}', usage: { inputTokens: 0, outputTokens: 0 } }
    } }
    const agent = new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: new SessionLog(path.join(dir, 'log.jsonl')), workspaceRoot: dir, workMode: () => mode })
    const first = await agent.run('first')
    mode = 'thorough'
    await agent.run('second', first.history)
    assert.match(requests[0]!.at(-1)!.content, /Work mode: Fast/)
    assert.equal(requests[1]![0]!.content, requests[0]![0]!.content)
    assert.deepEqual(requests[1]![1], requests[0]![1])
    assert.match(requests[1]!.at(-1)!.content, /Work mode: Thorough/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('MCP availability does not change the system prompt or the tools; the catalog rides in the session context', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-mcp-context-'))
  try {
    const seen: Array<{ system: string; last: string; tools: string[] }> = []
    const provider = {
      name: 'scripted',
      complete: async (messages: Array<{ role: string; content: string }>, options: { tools?: Array<{ name: string }> }) => {
        seen.push({ system: messages[0]!.content, last: messages.at(-1)!.content, tools: (options.tools ?? []).map((t) => t.name) })
        return { content: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    // The same session launched twice: once every MCP server started, once none did.
    for (const mcpCatalog of ['MCP tools (call with mcp_call {"server","tool","args"}):\n- docs/search(args: { q: string })', 'MCP servers are configured, but none is running.']) {
      await new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: new SessionLog(path.join(dir, 'log.jsonl')), workspaceRoot: dir, nativeTools: true, mcpCatalog }).run('hi')
    }
    assert.equal(seen[0]!.system, seen[1]!.system, 'the cached prefix survives a change in which servers started')
    assert.doesNotMatch(seen[0]!.system, /docs\/search/)
    // The offered tools do not depend on which servers started either.
    assert.deepEqual(seen[0]!.tools, seen[1]!.tools)
    assert.match(seen[0]!.last, /docs\/search/)
    assert.match(seen[1]!.last, /none is running/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('switching work mode preserves native tools, including the PTC SDK', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-work-mode-native-'))
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
  try {
    let mode: 'fast' | 'thorough' = 'fast'
    const requests: Array<{ messages: Array<{ role: string; content: string }>; tools: unknown }> = []
    const provider = { name: 'scripted', complete: async (messages: Array<{ role: string; content: string }>, options: { tools?: unknown }) => {
      requests.push({ messages: messages.map(m => ({ role: m.role, content: m.content })), tools: options.tools })
      return { content: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
    } }
    const agent = new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: new SessionLog(path.join(dir, 'log.jsonl')), workspaceRoot: dir, nativeTools: true, ptc: true, workMode: () => mode })
    const first = await agent.run('first')
    mode = 'thorough'
    await agent.run('second', first.history)
    assert.deepEqual(requests[1]!.tools, requests[0]!.tools)
    assert.deepEqual(requests[1]!.messages.slice(0, requests[0]!.messages.length), requests[0]!.messages)
    assert.match(requests[1]!.messages.at(-1)!.content, /Work mode: Thorough/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('turn usage does not claim complete cache totals when one step omits them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-cache-usage-'))
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
    let step = 0
    const provider = { name: 'scripted', complete: async () => ++step === 1
      ? { content: JSON.stringify({ tool: 'read_file', args: { path: 'a.txt' } }), usage: { inputTokens: 10, outputTokens: 1, cacheHitTokens: 0, cacheMissTokens: 10 } }
      : { content: '{"final":"done"}', usage: { inputTokens: 20, outputTokens: 2 } } }
    const agent = new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: new SessionLog(path.join(dir, 'log.jsonl')), workspaceRoot: dir })
    const result = await agent.run('go')
    assert.equal(result.usage.inputTokens, 30)
    assert.equal(result.usage.cacheHitTokens, undefined)
    assert.equal(result.usage.cacheMissTokens, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('prefix cache: one system prompt per session; context changes are appended; the rebuilt history matches what was sent', async () => {
  const { Ledger } = await import('./ledger.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-prefix-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n')
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-p')
    const ledger = Ledger.forRun(log, 'run-p', [{ source: 'AGENTS.md', text: 'Never edit vendor/.' }])
    const replies = [
      'not json at all', // invalid-json retry
      JSON.stringify({ tool: 'read_file', args: { path: 'a.txt' } }),
      '{"final":"first done"}',
      '{"final":"second done"}',
    ]
    const requests: Array<Array<{ role: string; content: string }>> = []
    const provider = {
      name: 'scripted',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        requests.push(messages.map((m) => ({ role: m.role, content: m.content })))
        return { content: replies.shift()!, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    }
    const tools = new ToolRuntime({} as never, dir)
    const agent = () => new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir, ledger })
    const first = await agent().run('turn one')
    assert.equal(first.final, 'first done')
    // A note recorded between turns changes the session context, not the system prompt.
    ledger.upsert({ key: 'cjs', rule: 'keep CommonJS', rationale: 'the loader needs it' })
    const second = await agent().run('turn two', first.history)
    assert.equal(second.final, 'second done')

    const system = requests[0]![0]!.content
    assert.ok(requests.every((r) => r[0]!.content === system), 'the system prompt never changes')
    assert.doesNotMatch(system, /Today is|Never edit vendor|hy_session_context/, 'date and constraints are not in the system prompt')
    // The first request carries the context once, at the end of the user message.
    assert.match(requests[0]![1]!.content, /^turn one\n\n<hy_session_context>\n[\s\S]*Today is \d{4}-\d{2}-\d{2}\.[\s\S]*Never edit vendor\/\.[\s\S]*<\/hy_session_context>$/)
    // Unchanged context is not repeated in the same turn.
    assert.equal(requests[1]!.filter((m) => m.content.includes('<hy_session_context>')).length, 1)
    // Turn two starts with exactly what turn one sent last, plus its answer: a
    // pure append, so the whole earlier request is a reusable prefix.
    const lastOfFirst = requests[2]!
    const firstOfSecond = requests[3]!
    assert.deepEqual(firstOfSecond.slice(0, lastOfFirst.length), lastOfFirst)
    assert.deepEqual(firstOfSecond[lastOfFirst.length], { role: 'assistant', content: '{"final":"first done"}' })
    // The changed context rides on turn two's message.
    assert.match(firstOfSecond.at(-1)!.content, /^turn two\n\n<hy_session_context>[\s\S]*keep CommonJS[\s\S]*<\/hy_session_context>$/)
    // A resume rebuilds the same bytes from the log (retry nudge included).
    const rebuilt = rebuildHistory(log.events(), 'run-p')
    assert.deepEqual(rebuilt, second.history.map((m) => ({ role: m.role, content: m.content })))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('reasoningHistory full: the reasoning rides on its assistant message, and a rebuild keeps it', async () => {
  for (const mode of ['full', 'none'] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hy-reason-${mode}-`))
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n')
      const log = new SessionLog(path.join(dir, 'log.jsonl'))
      log.setRun('run-r')
      const replies = [
        { content: JSON.stringify({ tool: 'read_file', args: { path: 'a.txt' } }), reasoning: 'I should read a.txt first.' },
        { content: '{"final":"done"}', reasoning: 'It says x; done.' },
      ]
      const requests: Array<Array<{ role: string; content: string; reasoning?: string }>> = []
      const provider = {
        name: 'scripted',
        complete: async (messages: Array<{ role: string; content: string; reasoning?: string }>) => {
          requests.push(messages.map((m) => ({ ...m })))
          return { ...replies.shift()!, usage: { inputTokens: 0, outputTokens: 0 } }
        },
      }
      const tools = new ToolRuntime({} as never, dir)
      const result = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir, reasoningHistory: mode }).run('go')
      const assistant = requests[1]!.find((m) => m.role === 'assistant')!
      if (mode === 'full') assert.equal(assistant.reasoning, 'I should read a.txt first.')
      else assert.equal(assistant.reasoning, undefined, 'none: only the reply goes back')
      const rebuilt = rebuildHistory(log.events(), 'run-r')
      assert.deepEqual(rebuilt, result.history.map((m) => ({ role: m.role, content: m.content, ...(m.reasoning ? { reasoning: m.reasoning } : {}) })))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('detectCycle finds a repeated multi-step sequence once per lap', async () => {
  const { detectCycle } = await import('./agent.js')
  assert.equal(detectCycle(['a', 'b', 'c', 'a', 'b']), undefined, 'not a full second lap yet')
  assert.deepEqual(detectCycle(['a', 'b', 'c', 'a', 'b', 'c']), { period: 3, times: 2 })
  assert.equal(detectCycle(['a', 'b', 'c', 'a', 'b', 'c', 'a']), undefined, 'mid-lap: no repeat of the reminder')
  assert.deepEqual(detectCycle(['x', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c']), { period: 3, times: 3 })
  assert.deepEqual(detectCycle(['a', 'b', 'a', 'b']), { period: 2, times: 2 })
  assert.deepEqual(detectCycle(['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd']), { period: 4, times: 2 })
  assert.equal(detectCycle(['a', 'a', 'a', 'a']), undefined, 'one call repeated is the repeat guard’s job')
  assert.equal(detectCycle(['a', 'b', 'c', 'd', 'e', 'a', 'b', 'c', 'd', 'e']), undefined, 'longer cycles are not checked')
  assert.equal(detectCycle(['a', 'b', 'c', 'a', 'b', 'd']), undefined)
})

test('a failing read → patch → shell loop tells the model it is looping', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-cycle-'))
  try {
    const lap = [
      JSON.stringify({ tool: 'read_file', args: { path: 'missing.txt' } }),
      JSON.stringify({ tool: 'apply_patch', args: { patch: 'not a patch' } }),
      JSON.stringify({ tool: 'read_file', args: { path: 'also-missing.txt' } }),
    ]
    const replies = [...lap, ...lap, ...lap, '{"final":"stopped"}']
    const seen: string[] = []
    const provider = {
      name: 'scripted',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.at(-1)!.content)
        return { content: replies.shift()!, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    const tools = new ToolRuntime({} as never, dir)
    const result = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir }).run('go')
    assert.equal(result.final, 'stopped')
    // seen[n] is the result of reply n-1: the 6th step closes the second lap.
    for (const n of [1, 2, 3, 4, 5, 7, 8]) assert.doesNotMatch(seen[n]!, /You are in a loop/, `step ${n}`)
    assert.match(seen[6]!, /\[reminder\] You are in a loop: the last 3 steps \(read_file → apply_patch → read_file\) repeat the same calls for the 2nd time, and the calls keep failing/)
    assert.match(seen[9]!, /for the 3rd time/)
    const guards = log.events().filter((e) => e.type === 'guard/cycle')
    assert.deepEqual(guards.map((e) => (e.payload as { times: number }).times), [2, 3])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unchanged MCP calls stop before execution even when other calls are interleaved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-no-progress-'))
  try {
    const usage = { inputTokens: 0, outputTokens: 0 }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-repeat')
    const repeated = { name: 'mcp_browser_probe', args: { code: 'probe()' } }
    let executions = 0
    let step = 0
    const tools = new ToolRuntime({} as never, dir)
    tools.execute = async (name) => name === repeated.name
      ? (executions++, { value: null })
      : { value: step }
    const provider = {
      name: 'scripted',
      complete: async () => {
        step++
        const call = step === 2 || step === 4
          ? { name: 'read_file', args: { path: `file-${step}.txt` } }
          : repeated
        return { content: '', toolCalls: [call], usage }
      },
    }
    const result = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('probe')
    assert.equal(executions, 3)
    assert.equal(step, 7)
    assert.equal(result.outcome, 'stalled')
    assert.deepEqual(rebuildHistory(log.events(), 'run-repeat'), result.history)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('changed observations can repeat, and an output-limited batch never runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-tool-retry-'))
  try {
    const usage = { inputTokens: 0, outputTokens: 0 }
    const calls = [{ name: 'read_file', args: { path: 'changing.txt' } }]
    const replies = [
      { content: '', usage, toolCalls: calls, outputLimited: true as const },
      ...Array.from({ length: 6 }, () => ({ content: '', usage, toolCalls: calls })),
      { content: 'Done.', usage },
    ]
    let reads = 0
    const tools = new ToolRuntime({} as never, dir)
    tools.execute = async () => ({ value: ++reads })
    const provider = { name: 'scripted', complete: async () => replies.shift()! }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    const result = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('check')
    assert.equal(reads, 6)
    assert.equal(result.final, 'Done.')
    assert.ok(log.events().some((event) => event.type === 'turn/retry' && (event.payload as { reason?: string }).reason === 'output-limit'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-13: each turn records a session snapshot with the shell cwd', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-snapshot-'))
  try {
    const provider = {
      name: 'scripted',
      complete: async () => ({ content: '{"final":"ok"}', usage: { inputTokens: 0, outputTokens: 0 } }),
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    const tools = new ToolRuntime({} as never, dir)
    await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir }).run('go')
    const snapshot = log.events().find((event) => event.type === 'session/snapshot')
    assert.ok(snapshot, 'a session/snapshot event is written')
    const payload = snapshot.payload as { cwd: string; workspaceRoot: string; provider: string }
    assert.equal(payload.cwd, '')
    assert.equal(payload.workspaceRoot, dir)
    assert.equal(payload.provider, 'scripted')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
test('goal mode nudges a plan-only native reply into a tool call', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-goal-mode-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n')
    const replies = [
      { content: '了解。この形で進めます。' },
      { content: '', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { content: 'done' },
    ]
    const seen: string[] = []
    const provider = {
      name: 'goal',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.at(-1)!.content)
        return { ...replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    const agent = new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      nativeTools: true,
      goalMode: true,
    })
    const result = await agent.run('go')
    assert.equal(result.final, 'done')
    assert.match(seen[1]!, /Goal mode: do not reply with a plan/)
    assert.equal(log.events().filter((e) => e.type === 'turn/retry' && (e.payload as { reason?: string }).reason === 'goal-plan-without-action').length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('native tool calls: parallel reads, a plain-text final, and history that resumes', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent, rebuildHistory } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-native-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A')
    fs.writeFileSync(path.join(dir, 'b.txt'), 'B')
    const requests: Array<{ tools?: unknown[]; system: string }> = []
    const replies = [
      { content: '', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }, { name: 'read_file', args: { path: 'b.txt' } }] },
      { content: 'Both files read: A and B.' },
    ]
    const provider = {
      name: 'native',
      complete: async (messages: Array<{ role: string; content: string }>, o: { tools?: unknown[] }) => {
        requests.push({ ...(o.tools ? { tools: o.tools } : {}), system: messages[0]!.content })
        return { ...replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-n')
    const tools = new ToolRuntime({} as never, dir)
    const r = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('read both')
    assert.equal(r.final, 'Both files read: A and B.')
    assert.ok(requests[0]!.tools!.some((t) => (t as { name: string }).name === 'apply_patch'))
    assert.match(requests[0]!.system, /Use the provided tools through function calls/)
    assert.doesNotMatch(requests[0]!.system, /Reply with exactly one JSON object/)
    // One user message holds both results, in call order.
    const results = r.history.find((m) => m.content.startsWith('TOOL RESULT'))!.content
    assert.match(results, /^TOOL RESULT \(read_file\):[\s\S]*"content": "A"[\s\S]*TOOL RESULT \(read_file\):[\s\S]*"content": "B"/)
    assert.deepEqual(rebuildHistory(log.events(), 'run-n'), r.history, 'the log rebuilds the same conversation')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a model that rejects tools falls back to the text protocol; text mode accepts batched calls', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const { LlmError } = await import('./llm.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-fallback-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A')
    let calls = 0
    const systems: string[] = []
    const provider = {
      name: 'old-model',
      complete: async (messages: Array<{ role: string; content: string }>, o: { tools?: unknown[] }) => {
        calls += 1
        if (o.tools) throw new LlmError('ollama HTTP 400: {"error":"m does not support tools"}', 400)
        systems.push(messages[0]!.content)
        const last = messages.at(-1)!.content
        const content = last.startsWith('TOOL')
          ? '{"final":"done"}'
          : JSON.stringify({ calls: [{ tool: 'read_file', args: { path: 'a.txt' } }, { tool: 'read_file', args: { path: 'missing.txt' } }] })
        return { content, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    const r = await new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('go')
    assert.equal(r.final, 'done')
    assert.equal(calls, 3, 'one rejected native request, then two text requests')
    assert.match(systems[0]!, /Reply with exactly one JSON object/)
    const results = r.history.find((m) => m.content.startsWith('TOOL'))!.content
    assert.match(results, /TOOL RESULT \(read_file\)[\s\S]*TOOL ERROR \(read_file\)/)
    assert.equal(log.events().filter((e) => e.type === 'native-tools/off').length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a reply cut off for repeating itself is retried once; the history replays exactly', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-repetition-'))
  try {
    const seen: Array<Array<{ role: string; content: string }>> = []
    const replies = [
      { content: '{"tool":"shell","args":{"command":"dir"}}]}}', degenerate: 'repetition' as const, usage: { inputTokens: 0, outputTokens: 9 } },
      { content: 'All done.', usage: { inputTokens: 1, outputTokens: 1 } },
    ]
    const provider = {
      name: 'looping',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.map((m) => ({ role: m.role, content: m.content })))
        return replies.shift()!
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-r')
    const r = await new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('list files')
    assert.equal(r.outcome, 'final')
    assert.equal(r.final, 'All done.')
    const retries = log.events().filter((e) => e.type === 'turn/retry')
    assert.deepEqual(retries.map((e) => (e.payload as { reason: string }).reason), ['repetition'])
    const second = seen[1]!
    assert.equal(second.at(-2)!.content, '{"tool":"shell","args":{"command":"dir"}}]}}')
    assert.match(second.at(-1)!.content, /fell into a loop repeating the same characters/)
    // A resumed chat sends the same history the second request saw.
    const rebuilt = rebuildHistory(log.events(), 'run-r')
    assert.deepEqual(
      rebuilt.slice(0, second.length - 1).map((m) => m.content),
      second.slice(1).map((m) => m.content),
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a broken pseudo tool call is retried natively, downgraded, retried once more, then stalls', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-broken-call-'))
  try {
    const broken = ['I will read the file.', '{"tool":"read_file","args":{"path":"a.txt"'].join('\n')
    // One reply per request. The downgrade to the text protocol is a fresh
    // start, so the text protocol gets its own retry before the turn stalls
    // (verify-agent-budget 4-a). Before, the flag from native mode survived the
    // downgrade and the very first text reply ended the turn: three replies
    // were enough and this test pinned that as the expected behaviour.
    const replies = [broken, broken, broken, broken]
    const systems: string[] = []
    const provider = {
      name: 'broken',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        systems.push(messages[0]!.content)
        return { content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-b')
    const events: string[] = []
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      nativeTools: true,
      onEvent: (e) => events.push(e.type),
    }).run('read a')
    assert.equal(r.outcome, 'stalled')
    assert.match(r.final, /task is incomplete.*earlier results and changes are preserved/)
    assert.deepEqual(rebuildHistory(log.events(), 'run-b'), r.history)
    // The prompt tells the model not to put a pseudo call in the body.
    assert.match(systems[0]!, /never write JSON such as/)
    assert.match(systems[0]!, /never a final answer: emit a real function call/)
    const retries = log.events().filter((e) => e.type === 'turn/retry')
    assert.equal(retries.length, 3, 'native retry, downgrade, one text-protocol retry')
    assert.deepEqual(
      retries.map((e) => (e.payload as { reason: string }).reason),
      ['broken-tool-call', 'tool-protocol-fallback', 'broken-tool-call'],
    )
    assert.match(r.final, /invalid tool replies persisted after switching protocols/)
    assert.doesNotMatch(systems[2]!, /emit a real function call/)
    assert.doesNotMatch(systems[3]!, /emit a real function call/)
    assert.equal(events.filter((t) => t === 'retry').length, 3)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a {"tools":[...]} batch written as text runs like calls instead of ending the turn', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-tools-batch-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'secret-marker\n')
    const seen: string[] = []
    const replies = ['<tool calls>\n<tool name="shell" args="{}"></tool>\n</tool>', '{"tools":[{"name":"read_file","arguments":{"path":"a.txt"}}]}', 'Done.']
    const provider = {
      name: 'batch',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.map((m) => m.content).join('\n'))
        return { content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-t')
    const r = await new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('read a')
    assert.equal(r.final, 'Done.')
    assert.equal(seen.length, 3, 'neither leaked markup nor the batch ended the turn')
    assert.match(seen[1]!, /tool reply was invalid and none of its calls ran/)
    assert.match(seen[2]!, /secret-marker/, 'the read ran and its result was sent')
    assert.deepEqual(log.events().filter((e) => e.type === 'tool/result').map((e) => (e.payload as { name: string }).name), ['read_file'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a final that announces its next step is nudged once: the model acts, a repeat is accepted, and resume matches', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-announce-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'gamma-marker')
    const run = async (replies: string[]) => {
      const seen: Array<Array<{ role: string; content: string }>> = []
      const provider = {
        name: 'announcing',
        complete: async (messages: Array<{ role: string; content: string }>) => {
          seen.push(messages.map((m) => ({ role: m.role, content: m.content })))
          return { content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
        },
      }
      const log = new SessionLog(path.join(dir, `log-${Math.random()}.jsonl`))
      log.setRun('run-n')
      const r = await new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('look at a.txt')
      return { r, seen, log }
    }
    // Announces, gets nudged, then actually reads the file.
    const acted = await run(['ファイルを確認します。', '{"tool":"read_file","args":{"path":"a.txt"}}', '確認しました。中身は gamma-marker です。'])
    assert.equal(acted.r.final, '確認しました。中身は gamma-marker です。')
    assert.match(acted.seen[1]!.at(-1)!.content, /announcing something you are about to do/)
    assert.match(acted.seen[2]!.map((m) => m.content).join(' '), /gamma-marker/)
    assert.deepEqual(acted.log.events().filter((e) => e.type === 'turn/nudge').map((e) => (e.payload as { reason: string }).reason), ['announced-without-action'])
    // The history a resumed chat sends equals what the model saw.
    const rebuilt = rebuildHistory(acted.log.events(), 'run-n')
    assert.deepEqual(rebuilt.slice(0, acted.seen[2]!.length - 1).map((m) => m.content), acted.seen[2]!.slice(1).map((m) => m.content))
    // Repeating the announcement after the nudge ends the turn: no loop.
    const repeated = await run(['確認します。', '確認します。'])
    assert.equal(repeated.r.final, '確認します。')
    assert.equal(repeated.seen.length, 2)
    // Right after handing work to a worker, describing that work is how the turn should end.
    const dispatched = await (async () => {
      const seen: string[] = []
      const provider = {
        name: 'dispatching',
        complete: async (messages: Array<{ role: string; content: string }>) => {
          seen.push(messages.at(-1)!.content)
          return seen.length === 1
            ? { content: '', toolCalls: [{ name: 'delegate', args: { task: 'add the regression test' } }], usage: { inputTokens: 1, outputTokens: 1 } }
            : { content: '回帰テストと型検査まで行います。', usage: { inputTokens: 1, outputTokens: 1 } }
        },
      }
      const tools = new ToolRuntime({} as never, dir)
      ;(tools as unknown as { execute: unknown }).execute = async () => ({ ok: true })
      const log = new SessionLog(path.join(dir, `log-${Math.random()}.jsonl`))
      log.setRun('run-d2')
      const r = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('delegate it')
      return { r, seen, log }
    })()
    assert.equal(dispatched.r.final, '回帰テストと型検査まで行います。')
    assert.equal(dispatched.seen.length, 2, 'no nudge after a successful hand-off')
    // A final that hands back is not nudged at all.
    const handsBack = await run(['どちらを先に進めますか？'])
    assert.equal(handsBack.seen.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an unwrapped batch runs every call; a partial reply runs nothing and says so', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-unwrapped-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha-marker')
    fs.writeFileSync(path.join(dir, 'b.txt'), 'beta-marker')
    const run = async (replies: string[]) => {
      const seen: string[] = []
      const provider = {
        name: 'unwrapped',
        complete: async (messages: Array<{ role: string; content: string }>) => {
          seen.push(messages.map((m) => m.content).join(' | '))
          return { content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
        },
      }
      const log = new SessionLog(path.join(dir, `log-${Math.random()}.jsonl`))
      log.setRun('run-u')
      const r = await new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('read both')
      return { r, seen, log }
    }
    // Both calls of the unwrapped batch run.
    const ok = await run(['{"tool":"read_file","args":{"path":"a.txt"}},{"tool":"read_file","args":{"path":"b.txt"}}]}', 'Done.'])
    assert.equal(ok.r.final, 'Done.')
    assert.match(ok.seen[1]!, /alpha-marker/)
    assert.match(ok.seen[1]!, /beta-marker/)
    assert.equal(ok.log.events().filter((e) => e.type === 'reply/recovered').length, 1)
    // A garbled batch: the first object alone is not run; the model is told none ran.
    const partial = await run(['{"tool":"read_file","args":{"path":"a.txt"}},{"tool":"read_file","args":{"path":"b.txt"}', 'Done.'])
    assert.doesNotMatch(partial.seen[1]!, /alpha-marker/, 'the first call was not run on its own')
    assert.match(partial.seen[1]!, /none of its calls ran/)
    assert.equal(partial.log.events().filter((e) => e.type === 'turn/retry').length, 1)
    // A batch with an entry that is not a call: nothing runs either.
    const bad = await run(['{"calls":[{"tool":"read_file","args":{"path":"a.txt"}},{"note":"read the other file too"}]}', 'Done.'])
    assert.doesNotMatch(bad.seen[1]!, /alpha-marker/)
    assert.match(bad.seen[1]!, /none of its calls ran/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a call batch cut short by leaked template tags runs instead of ending the turn', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-dsml-tail-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'dsml-marker\n')
    const seen: string[] = []
    const replies = ['{"calls":[{"tool":"read_file","args":{"path":"a.txt"}}]</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>', 'Done.']
    const provider = {
      name: 'dsml',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.map((m) => m.content).join('\n'))
        return { content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-d')
    const r = await new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('read a')
    assert.equal(r.final, 'Done.')
    assert.match(seen[1]!, /dsml-marker/, 'the repaired call ran')
    assert.equal(log.events().filter((e) => e.type === 'turn/retry').length, 0, 'no retry was spent')
    assert.equal(log.events().filter((e) => e.type === 'reply/recovered').length, 1)
    // The history holds the repaired call, as sent in the next request.
    const rebuilt = rebuildHistory(log.events(), 'run-d')
    assert.ok(rebuilt.some((m) => m.role === 'assistant' && m.content === '{"calls":[{"tool":"read_file","args":{"path":"a.txt"}}]}'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a broken pseudo tool call in native mode is retried and the next plain reply is final', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-broken-retry-'))
  try {
    const broken = '{"calls":[{"tool":"read_file","args":{},'
    const replies = [broken, 'Nothing to change: both files were already read.']
    const provider = {
      name: 'broken-once',
      complete: async () => ({ content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }),
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-r')
    const events: string[] = []
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      nativeTools: true,
      onEvent: (e) => events.push(e.type),
    }).run('read a')
    assert.equal(r.outcome, 'final')
    assert.equal(r.final, 'Nothing to change: both files were already read.')
    assert.equal(log.events().filter((e) => e.type === 'turn/retry').length, 1)
    assert.equal(events.filter((t) => t === 'retry').length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('native mode: two empty replies end the turn instead of retrying forever', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-empty-reply-'))
  try {
    let calls = 0
    const provider = {
      name: 'empty',
      complete: async () => {
        calls += 1
        // Reasoning only, as a thinking model can return.
        return { content: '', reasoning: 'Thinking about the task.', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-e')
    const events: Array<{ type: string; reason?: unknown }> = []
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      nativeTools: true,
      onEvent: (e) => events.push({ type: e.type, ...(e.reason !== undefined ? { reason: e.reason } : {}) }),
    }).run('do nothing')
    assert.equal(r.outcome, 'stalled')
    assert.match(r.final, /task is incomplete: the model returned an empty reply twice/)
    assert.equal(calls, 2, 'an empty reply is retried exactly once')
    const retries = log.events().filter((e) => e.type === 'turn/retry')
    assert.equal(retries.length, 1)
    assert.equal((retries[0]!.payload as { reason: string }).reason, 'empty-reply')
    const retryEvents = events.filter((e) => e.type === 'retry')
    assert.equal(retryEvents.length, 1)
    assert.equal(retryEvents[0]!.reason, 'empty-reply', 'the live event carries the same reason as the log')
    assert.ok(r.history.some((m) => /your reply had no tool call and no text/i.test(m.content)), 'the retry asks for a call or a summary')
    assert.doesNotMatch(JSON.stringify(r.history), /single valid JSON object/, 'the text-protocol retry never runs in native mode')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('native mode: one empty reply is retried and the next plain reply is final', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-empty-reply-once-'))
  try {
    const replies = ['', 'Nothing to change: the files already match.']
    let calls = 0
    const provider = {
      name: 'empty-once',
      complete: async () => {
        calls += 1
        return { content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-e2')
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      nativeTools: true,
    }).run('check the files')
    assert.equal(calls, 2)
    assert.equal(r.outcome, 'final')
    assert.equal(r.final, 'Nothing to change: the files already match.')
    const retries = log.events().filter((e) => e.type === 'turn/retry')
    assert.equal(retries.length, 1)
    assert.equal((retries[0]!.payload as { reason: string }).reason, 'empty-reply')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the text protocol still retries an unparseable reply (invalid-json)', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-text-retry-'))
  try {
    const replies = ['I will read the file now.', '{"final":"done"}']
    let calls = 0
    const provider = {
      name: 'text',
      complete: async () => {
        calls += 1
        return { content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-t')
    const events: Array<{ type: string; reason?: unknown }> = []
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      onEvent: (e) => events.push({ type: e.type, ...(e.reason !== undefined ? { reason: e.reason } : {}) }),
    }).run('read a file')
    assert.equal(calls, 2)
    assert.equal(r.outcome, 'final')
    assert.equal(r.final, 'done')
    const retries = log.events().filter((e) => e.type === 'turn/retry')
    assert.equal(retries.length, 1)
    assert.equal((retries[0]!.payload as { reason: string }).reason, 'invalid-json')
    const retryEvents = events.filter((e) => e.type === 'retry')
    assert.equal(retryEvents.length, 1)
    assert.equal(retryEvents[0]!.reason, 'invalid-json')
    assert.ok(r.history.some((m) => m.content.includes('single valid JSON object')), 'the JSON instruction is still sent in text mode')
    const native = new Agent({
      provider: {
        name: 'native',
        complete: async (messages) => {
          assert.ok(!messages.some((m) => /single valid JSON object|I will read the file now/.test(m.content)))
          assert.ok(messages.some((m) => m.content === '{"final":"done"}'))
          return { content: 'Resumed.', usage: { inputTokens: 1, outputTokens: 1 } }
        },
      },
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      nativeTools: true,
    })
    assert.equal((await native.run('resume', rebuildHistory(log.events(), 'run-t'))).final, 'Resumed.')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a steering message joins the conversation at the next step boundary (WP-21)', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const { createSteerInbox, isSteerMessage } = await import('./steering.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-steer-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n')
    fs.writeFileSync(path.join(dir, 'b.txt'), 'y\n')
    const replies = [
      JSON.stringify({ tool: 'read_file', args: { path: 'a.txt' } }),
      JSON.stringify({ final: 'done' }),
    ]
    const seen: Array<Array<{ role: string; content: string }>> = []
    const inbox = createSteerInbox()
    const provider = {
      name: 'scripted',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        seen.push([...messages])
        // The user types while the first tool call is running.
        if (seen.length === 1) inbox.push({ text: 'also read b.txt' })
        return { content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-s')
    const result = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      steer: inbox,
    }).run('read a.txt')
    assert.equal(result.final, 'done')
    // The first request cannot carry it; the second one must.
    assert.equal(seen[0]!.some((m) => m.content.includes('also read b.txt')), false)
    const last = seen[1]!.at(-1)!
    assert.equal(last.role, 'user')
    assert.ok(isSteerMessage(last.content), 'the steer is marked in the history')
    assert.match(last.content, /also read b\.txt/)
    assert.equal(inbox.size(), 0, 'the inbox is drained, not re-injected every step')
    const logged = log.events().filter((e) => e.type === 'user/steer')
    assert.deepEqual(
      logged.map((e) => ({ content: (e.payload as { content: string }).content, step: (e.payload as { step: number }).step })),
      [{ content: 'also read b.txt', step: 2 }],
      'the log records the steer where the model saw it',
    )
    assert.ok(
      result.history.some((m) => m.role === 'user' && isSteerMessage(m.content)),
      'the returned history keeps the steer, so a resume replays it',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rebuildHistory replays a steering message exactly as the agent appended it', () => {
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('user/message', { content: 'read a.txt' }),
    ev('assistant/message', { content: '{"tool":"read_file","args":{"path":"a.txt"}}' }),
    ev('tool/result', { name: 'read_file', output: 'x', isError: false }),
    ev('user/steer', { content: 'also read b.txt', step: 2 }),
  ]
  const history = rebuildHistory(events, 'run-a')
  assert.deepEqual(
    history.map((m) => m.role),
    ['user', 'assistant', 'user', 'user'],
  )
  assert.equal(history.at(-1)!.content, steerMessage('also read b.txt'))
})

test('undo drops the steer of the turn it undoes and keeps an earlier one', () => {
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('user/message', { content: 'first' }),
    ev('user/steer', { content: 'steer in turn 1', step: 1 }),
    ev('assistant/message', { content: '{"final":"one"}' }),
    ev('turn/start', { turn: 2 }),
    ev('user/message', { content: 'second' }),
    ev('user/steer', { content: 'steer in turn 2', step: 1 }),
    ev('assistant/message', { content: '{"final":"two"}' }),
    ev('turn/undo', { turn: 2 }),
  ]
  const history = rebuildHistory(events, 'run-a')
  assert.deepEqual(
    history.map((m) => m.content),
    ['first', steerMessage('steer in turn 1'), '{"final":"one"}'],
  )
  // Undoing the first turn as well leaves nothing, steering included.
  assert.deepEqual(rebuildHistory([...events, ev('turn/undo', { turn: 1 })], 'run-a'), [])
})


test('read_image attaches the image to the next request (WP-30)', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-image-agent-'))
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    )
    fs.writeFileSync(path.join(dir, 'pixel.png'), png)
    let runtime: InstanceType<typeof ToolRuntime> | undefined
    const tools = new ToolRuntime({} as never, dir, undefined, false, {
      plugins: new Map([
        [
          'read_image',
          {
            name: 'read_image',
            description: 'attach an image',
            input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            readOnly: true,
            run: (args: Record<string, unknown>) => runtime!.readImage(args, true),
            spec: { name: 'read_image', wire: true, readOnly: true, description: 'attach an image', input: {}, output: {} },
            plugin: 'edit',
          },
        ],
      ]),
    })
    runtime = tools
    const replies = [JSON.stringify({ tool: 'read_image', args: { path: 'pixel.png' } }), JSON.stringify({ final: 'I see a pixel.' })]
    type AgentMessage = { role: string; content: string; images?: Array<{ mimeType: string; data: string }> }
    const seen: AgentMessage[][] = []
    const provider = {
      name: 'scripted',
      complete: async (messages: AgentMessage[]) => {
        seen.push([...messages])
        return { content: replies.shift()!, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-i')
    const result = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir }).run('look at the image')
    assert.equal(result.final, 'I see a pixel.')
    const attached = seen[1]!.find((message) => message.images && message.images.length > 0)
    assert.ok(attached, 'the second request carries the image')
    assert.match(attached.content, /\[image attached: pixel\.png\]/)
    assert.equal(attached.images![0]!.mimeType, 'image/png')
    // The image rides on the tool-result message, so the alternation is intact.
    assert.match(attached.content, /^TOOL RESULT \(read_image\)/)
    const toolResult = attached
    assert.ok(toolResult)
    assert.doesNotMatch(toolResult.content, /iVBORw0KGgo/)
    assert.equal(log.events().filter((e) => e.type === 'image/attached').length, 1)
    assert.ok(result.history.some((message) => message.images && message.images.length === 1))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-18: provider deltas become assistant-delta events', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-delta-'))
  try {
    const events: Array<{ type?: string; content?: string; reasoning?: string }> = []
    const provider = {
      name: 'streamy',
      complete: async (_messages: unknown, options?: { onDelta?: (delta: { content?: string; reasoning?: string }) => void }) => {
        options?.onDelta?.({ content: 'a' })
        options?.onDelta?.({ reasoning: 'r' })
        return { content: '{"final":"done"}', usage: { inputTokens: 0, outputTokens: 0 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    await new Agent({
      provider: provider as never,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      onEvent: (event) => events.push(event),
    }).run('go')
    assert.deepEqual(
      events.filter((event) => event.type === 'assistant-delta'),
      [
        { type: 'assistant-delta', step: 1, content: 'a' },
        { type: 'assistant-delta', step: 1, reasoning: 'r' },
      ],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-19: userPromptSubmit context reaches the model and a block ends the turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-hook-agent-'))
  try {
    const seen: string[] = []
    const provider = {
      name: 'scripted',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.at(-1)!.content)
        return { content: '{"final":"ok"}', usage: { inputTokens: 0, outputTokens: 0 } }
      },
    }
    const contextRunner = async () => ({ code: 0, stdout: 'HOOK-CONTEXT', stderr: '', timedOut: false })
    const hooks = new Hooks({ userPromptSubmit: [{ command: ['hook'] }] }, undefined, undefined, contextRunner)
    await new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: new SessionLog(path.join(dir, 'a.jsonl')), workspaceRoot: dir, hooks }).run('do it')
    assert.match(seen[0]!, /HOOK-CONTEXT/)
    assert.match(seen[0]!, /<untrusted_hook_context>/)

    const blockRunner = async () => ({ code: 2, stdout: '', stderr: 'nope', timedOut: false })
    const blocking = new Hooks({ userPromptSubmit: [{ command: ['hook'] }] }, undefined, undefined, blockRunner)
    await assert.rejects(
      new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: new SessionLog(path.join(dir, 'b.jsonl')), workspaceRoot: dir, hooks: blocking }).run('do it'),
      /userPromptSubmit hook blocked this turn: nope/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-23: each step records the estimated and actual input tokens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-tokens-'))
  try {
    const provider = {
      name: 'metered',
      complete: async () => ({ content: '{"final":"ok"}', usage: { inputTokens: 500, outputTokens: 10 } }),
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    await new Agent({ provider, tools: new ToolRuntime({} as never, dir), sessionLog: log, workspaceRoot: dir }).run('go')
    const samples = log.events().filter((event) => event.type === 'token/estimate')
    assert.equal(samples.length, 1)
    const payload = samples[0]!.payload as { estimated: number; actual: number; ratio?: number }
    assert.equal(payload.actual, 500)
    assert.ok(payload.estimated > 0)
    assert.equal(payload.ratio, Math.round((500 / payload.estimated) * 1000) / 1000)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-38: the streaming feature can be turned off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-features-'))
  try {
    const seen: Array<{ onDelta?: unknown }> = []
    const provider = {
      name: 'capture',
      complete: async (_messages: unknown, options?: { onDelta?: unknown }) => {
        seen.push(options ?? {})
        return { content: '{"final":"ok"}', usage: { inputTokens: 0, outputTokens: 0 } }
      },
    }
    const on = { ...provider, complete: provider.complete }
    await new Agent({ provider: on as never, tools: new ToolRuntime({} as never, dir), sessionLog: new SessionLog(path.join(dir, 'a.jsonl')), workspaceRoot: dir, onEvent: () => {} }).run('go')
    assert.equal(typeof seen[0]!.onDelta, 'function', 'streaming is on by default')
    seen.length = 0
    await new Agent({ provider: on as never, tools: new ToolRuntime({} as never, dir), sessionLog: new SessionLog(path.join(dir, 'b.jsonl')), workspaceRoot: dir, onEvent: () => {}, features: { streaming: false } }).run('go')
    assert.equal(seen[0]!.onDelta, undefined, 'the feature turns streaming off')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a correction between calls prevents stale edits and records its source and acknowledgement', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const { createSteerInbox } = await import('./steering.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-safe-correction-'))
  try {
    const inbox = createSteerInbox()
    const edits: string[] = []
    const tools = new ToolRuntime({} as never, dir)
    tools.execute = async (name, args) => {
      if (name === 'read_file') {
        inbox.push({ id: 'change-1', source: 'orchestrator', text: 'Use the corrected parent, not the old one.' })
        return { content: 'original' }
      }
      edits.push((args as { content: string }).content)
      return { appliedFiles: ['a.txt'] }
    }
    let step = 0
    const provider = {
      name: 'correction-test',
      complete: async (messages: import('./llm.js').ChatMessage[]) => {
        step++
        if (step === 1) return { content: '', toolCalls: [
          { id: 'read', name: 'read_file', args: { path: 'a.txt' } },
          { id: 'stale', name: 'apply_patch', args: { file: 'a.txt', content: 'old parent' } },
        ], usage: { inputTokens: 1, outputTokens: 1 } }
        if (step === 2) {
          assert.ok(messages.some((m) => m.content.includes('[the orchestrator sent this while you were working]')))
          return { content: '', toolCalls: [{ id: 'fixed', name: 'apply_patch', args: { file: 'a.txt', content: 'corrected parent' } }], usage: { inputTokens: 1, outputTokens: 1 } }
        }
        return { content: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-correction')
    const applied: unknown[] = []
    const result = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir, nativeTools: true, steer: inbox,
      onEvent: (event) => { if (event.type === 'steer-applied') applied.push(event.id) },
    }).run('change the parent')
    assert.deepEqual(edits, ['corrected parent'])
    assert.deepEqual(applied, ['change-1'])
    assert.deepEqual(rebuildHistory(log.events(), 'run-correction'), result.history)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a worker observation between calls does not cancel the remaining write', async () => {
  const { createSteerInbox } = await import('./steering.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-worker-observation-'))
  try {
    const inbox = createSteerInbox()
    const calls: string[] = []
    const tools = new ToolRuntime({} as never, dir)
    tools.execute = async (name) => {
      calls.push(name)
      if (name === 'read_file') inbox.push({ text: 'Worker finished.', source: 'worker', interrupt: false })
      return {}
    }
    let step = 0
    const usage = { inputTokens: 1, outputTokens: 1 }
    const provider = {
      name: 'observation-test',
      complete: async (messages: import('./llm.js').ChatMessage[]) => {
        if (++step === 1) return { content: '', toolCalls: [
          { name: 'read_file', args: { path: 'a.txt' } },
          { name: 'apply_patch', args: { file: 'a.txt', content: 'updated' } },
        ], usage }
        assert.ok(messages.some((message) => message.content.includes('Worker finished.')))
        return { content: 'done', usage }
      },
    }
    await new Agent({ provider, tools, sessionLog: new SessionLog(path.join(dir, 'log.jsonl')), workspaceRoot: dir, nativeTools: true, steer: inbox }).run('make the edit')
    assert.deepEqual(calls, ['read_file', 'apply_patch'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('top-level tool arguments beside tool and malformed calls batches run without spending a retry', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-top-level-args-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'top-level-alpha\n')
    fs.writeFileSync(path.join(dir, 'b.txt'), 'top-level-beta\n')
    const seen: string[] = []
    const replies = [
      // Batch with missing `}` on first call AND top-level `path` beside `"tool"` on second call.
      '{"calls":[{"tool":"read_file","args":{"path":"a.txt"},{"tool":"read_file","path":"b.txt"}]}',
      'Done.',
    ]
    const provider = {
      name: 'top-level-and-malformed',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.map((m) => m.content).join('\n'))
        return { content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-tla')
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      nativeTools: true,
    }).run('read both')
    assert.equal(r.final, 'Done.')
    assert.match(seen[1]!, /top-level-alpha/)
    assert.match(seen[1]!, /top-level-beta/)
    assert.equal(log.events().filter((e) => e.type === 'turn/retry').length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('single-key shorthand in calls array, arguments alias, and <tool_call> wrapper run without retries', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-shorthand-calls-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'shorthand-alpha\n')
    fs.writeFileSync(path.join(dir, 'b.txt'), 'shorthand-beta\n')
    fs.writeFileSync(path.join(dir, 'c.txt'), 'shorthand-gamma\n')
    const seen: string[] = []
    const replies = [
      // Pattern I: single-key shorthand inside `{"calls":[...]}` (L12397)
      '{"calls":[{"read_file":{"path":"a.txt"}}]}',
      // Pattern G+H: `"arguments"` key + trailing `]}</arg_value:...>` (L12819)
      '{"tool": "read_file", "arguments": {"path": "b.txt"}}]}</arg_value:6124c78e></tool_calls:6124c78e>',
      // Pattern K: `<tool_call>` with `"name"` and `"arguments"` (L12027)
      '<tool_call>\n{"name": "read_file", "arguments": {"path": "c.txt"}}\n</tool_call>',
      'Done.',
    ]
    const provider = {
      name: 'shorthand',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.map((m) => m.content).join('\n'))
        return { content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-sh')
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      nativeTools: true,
    }).run('read all three')
    assert.equal(r.final, 'Done.')
    assert.match(seen[1]!, /shorthand-alpha/)
    assert.match(seen[2]!, /shorthand-beta/)
    assert.match(seen[3]!, /shorthand-gamma/)
    assert.equal(log.events().filter((e) => e.type === 'turn/retry').length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('allowWaitingReply skips goalMode and announce nudges when yielding to wait for async workers', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-waiting-'))
  try {
    const provider = {
      name: 'waiting',
      complete: async () => ({ content: 'Workers are running; waiting for reports and will integrate next.', usage: { inputTokens: 1, outputTokens: 1 } }),
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      nativeTools: true,
      goalMode: true,
      allowWaitingReply: () => true,
    }).run('wait')
    assert.equal(r.steps, 1)
    assert.match(r.final, /waiting for reports/)
    assert.equal(log.events().filter((e) => e.type === 'turn/retry' || e.type === 'turn/nudge').length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a JSON-shaped reply cut short is retried as a broken call, not taken as the answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-truncated-'))
  try {
    // No tool key at all in this one, so only "starts with { and is not JSON"
    // can tell it apart from an answer. Native mode used to end the turn here.
    const truncated = '{"content":"abc…'
    const replies = [truncated, truncated, '{"final":"done"}']
    const provider = {
      name: 'truncated',
      complete: async () => ({ content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }),
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-truncated')
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      nativeTools: true,
    }).run('go')
    assert.equal(r.final, 'done')
    // One native retry, then the protocol downgrade; the text reply is a final.
    const retries = log.events().filter((e) => e.type === 'turn/retry')
    assert.deepEqual(
      retries.map((e) => (e.payload as { reason: string }).reason),
      ['broken-tool-call', 'tool-protocol-fallback'],
    )
    assert.doesNotMatch(JSON.stringify(r.history), /abc…/, 'the cut-off text is never stored as an answer')
    assert.deepEqual(rebuildHistory(log.events(), 'run-truncated'), r.history)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a native reply cut off after a readable {"final":…} object is not the answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-truncated-final-'))
  try {
    // The first object parses, so it used to be taken as the answer even though
    // the reply was cut off after it.
    const replies = ['{"final":"The answer is 42"}…', '{"final":"done"}']
    const provider = {
      name: 'truncated-final',
      complete: async () => ({ content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }),
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      nativeTools: true,
    }).run('go')
    assert.equal(r.final, 'done')
    assert.deepEqual(
      log.events().filter((e) => e.type === 'turn/retry').map((e) => (e.payload as { reason: string }).reason),
      ['broken-tool-call'],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a native reply of prose that mentions a brace is still the final answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-prose-brace-'))
  try {
    const answer = 'The fix is in src/a.ts: guard {the parser} before the call. Nothing else is needed.'
    const provider = {
      name: 'prose',
      complete: async () => ({ content: answer, usage: { inputTokens: 1, outputTokens: 1 } }),
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      nativeTools: true,
    }).run('go')
    assert.equal(r.outcome, 'final')
    assert.equal(r.final, answer)
    assert.equal(log.events().filter((e) => e.type === 'turn/retry' || e.type === 'turn/nudge').length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('yielding to wait for workers ends the conversation on the assistant message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-waiting-blocked-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n')
    const call = JSON.stringify({ tool: 'read_file', args: { path: 'a.txt' } })
    // The same read returns the same result three times, so the fourth is
    // blocked; with async workers active the turn yields and waits instead.
    const replies = [call, call, call, call, '{"final":"unused"}']
    const provider = {
      name: 'blocked',
      complete: async () => ({ content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }),
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-wait')
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
      allowWaitingReply: () => true,
    }).run('wait')
    const waiting = 'Waiting for the active workers. Their reports will resume this turn’s work.'
    assert.equal(r.outcome, 'final')
    assert.equal(r.final, waiting)
    // The turn ends on this text, so the history and the log both end on the
    // assistant message (the tool result used to be the last entry).
    assert.deepEqual(r.history.at(-1), { role: 'assistant', content: waiting })
    const assistant = log.events().filter((e) => e.type === 'assistant/message').at(-1)!
    assert.equal((assistant.payload as { content: string }).content, waiting)
    assert.ok(log.events().some((e) => e.type === 'turn/end' && (e.payload as { reason?: string }).reason === 'waiting-for-workers'))
    assert.deepEqual(rebuildHistory(log.events(), 'run-wait'), r.history)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a successful call resets the no-progress counter between blocked steps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-blocked-reset-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n')
    const a = JSON.stringify({ tool: 'read_file', args: { path: 'a.txt' } })
    const b = JSON.stringify({ tool: 'read_file', args: { path: 'b.txt' } })
    // Three identical reads, a blocked fourth, a successful read of another
    // file, then the same read again: progress in between means the two blocked
    // steps are not consecutive and the turn must not stall there.
    const replies = [a, a, a, a, b, a, '{"final":"done"}']
    const provider = {
      name: 'blocked-twice',
      complete: async () => ({ content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }),
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-reset')
    const r = await new Agent({
      provider,
      tools: new ToolRuntime({} as never, dir),
      sessionLog: log,
      workspaceRoot: dir,
    }).run('go')
    assert.equal(r.outcome, 'final')
    assert.equal(r.final, 'done')
    assert.equal(log.events().filter((e) => e.type === 'guard/no-progress').length, 2)
    assert.equal(log.events().filter((e) => e.type === 'turn/failure').length, 0)
    assert.deepEqual(rebuildHistory(log.events(), 'run-reset'), r.history)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a successful shell command invalidates other observations but keeps its own repeat count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-shell-clears-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n')
    const read = JSON.stringify({ tool: 'read_file', args: { path: 'a.txt' } })
    const shell = JSON.stringify({ tool: 'shell', args: { command: 'echo hi' } })
    const replies = [read, read, read, shell, shell, read, '{"final":"done"}']
    const seen: string[] = []
    const provider = {
      name: 'shell',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.at(-1)!.content)
        return { content: replies.shift()!, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-shell')
    // The tools are stubbed so the test is about the observation cache, not
    // about starting a shell: both shell runs return the same result, as they
    // would in a real workspace.
    const tools = new ToolRuntime({} as never, dir)
    const executed: string[] = []
    tools.execute = async (name) => {
      executed.push(name)
      return name === 'shell'
        ? { exitCode: 0, timedOut: false, stdout: 'hi\n', stderr: '', status: 'completed' }
        : { content: 'x\n' }
    }
    const r = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir }).run('go')
    assert.equal(r.final, 'done')
    // The repeated shell call is still recognised as a repeat ...
    assert.deepEqual(
      log.events().filter((e) => e.type === 'guard/repeat').map((e) => e.payload as { tool: string; times: number }),
      [{ tool: 'read_file', times: 2 }, { tool: 'read_file', times: 3 }, { tool: 'shell', times: 2 }],
    )
    assert.match(seen[5]!, /same call with the same arguments 2 times/)
    // ... while the read observed three times before the shell ran again
    // instead of being blocked as unchanged.
    assert.equal(log.events().filter((e) => e.type === 'guard/no-progress').length, 0)
    assert.deepEqual(executed, ['read_file', 'read_file', 'read_file', 'shell', 'shell', 'read_file'])
    const readResults = log.events().filter((e) => e.type === 'tool/result' && (e.payload as { name: string }).name === 'read_file')
    assert.equal(readResults.length, 4)
    assert.ok(readResults.every((e) => (e.payload as { isError: boolean }).isError === false), 'every read ran')
    assert.deepEqual(rebuildHistory(log.events(), 'run-shell'), r.history)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
