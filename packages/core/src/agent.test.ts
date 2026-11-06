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

test('a broken pseudo tool call in native mode is retried once, then ends with a fixed line', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Agent } = await import('./agent.js')
  const { ToolRuntime } = await import('./tools.js')
  const { SessionLog } = await import('./session-log.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-broken-call-'))
  try {
    const broken = ['I will read the file.', '{"tool":"read_file","args":{"path":"a.txt"'].join('\n')
    const replies = [broken, broken]
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
    assert.equal(r.outcome, 'final')
    assert.equal(r.final, 'The model produced an invalid tool call. No changes were made.')
    // The prompt tells the model not to put a pseudo call in the body.
    assert.match(systems[0]!, /never write JSON such as/)
    assert.match(systems[0]!, /never a final answer: emit a real function call/)
    const retries = log.events().filter((e) => e.type === 'turn/retry')
    assert.equal(retries.length, 1)
    assert.equal((retries[0]!.payload as { reason: string }).reason, 'broken-tool-call')
    assert.equal(events.filter((t) => t === 'retry').length, 1)
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
    assert.equal(r.outcome, 'final')
    assert.equal(r.final, 'The model returned an empty reply twice. No changes were made.')
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