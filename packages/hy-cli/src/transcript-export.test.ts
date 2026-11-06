import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '../../core/dist/index.js'
import { exportJson, exportMarkdown, runEvents } from './transcript-export.js'

let seq = 0
const ev = (type: string, payload: unknown, runId = 'run-a'): SessionEvent => ({ v: 1, seq: ++seq, ts: Date.UTC(2026, 10, 6, 1, 2, seq), sessionId: 's', runId, type, payload })

const events = [
  ev('turn/start', { turn: 1 }),
  ev('user/message', { content: 'Fix the bug' }),
  ev('assistant/thinking', { content: 'Look at a.ts first' }),
  ev('step/end', { stepIndex: 1, model: 'mock', usage: { inputTokens: 10, outputTokens: 2 } }),
  ev('assistant/message', { content: '{"tool":"read_file","args":{"path":"a.ts"}}' }),
  ev('tool/result', { callId: 't1-step-1', name: 'read_file', output: 'short', isError: false, spillRef: { path: 'spill://s/c1' } }),
  ev('user/message', { content: 'other run' }, 'run-b'),
  ev('subagent/start', { parentRunId: 'run-a' }, 'run-a.sub1'),
  ev('tool/result', { name: 'shell', output: 'boom', isError: true }, 'run-a.sub1'),
  ev('assistant/message', { content: '{"final":"Fixed with key sk-abcdefghijklmnopqrstuvwxyz123456"}' }),
  ev('turn/undo', { turn: 1, keepFiles: true }),
]

test('runEvents keeps the run and its subagents in log order', () => {
  const mine = runEvents([...events].reverse(), 'run-a')
  assert.deepEqual(mine.map((e) => e.runId), ['run-a', 'run-a', 'run-a', 'run-a', 'run-a', 'run-a', 'run-a.sub1', 'run-a.sub1', 'run-a', 'run-a'])
})

test('the Markdown export has messages, thinking, tool calls, full spilled results and undone turns', () => {
  const md = exportMarkdown(events, {
    runId: 'run-a',
    workspaceRoot: 'C:/ws',
    now: Date.UTC(2026, 10, 6),
    readSpill: (ref) => (ref === 'spill://s/c1' ? 'the whole file' : undefined),
  })
  assert.match(md, /^# HY-HARNESS chat history: run-a/)
  assert.match(md, /## Turn 1/)
  assert.match(md, /### User\n<sub>.*<\/sub>\n\nFix the bug/)
  assert.match(md, /### Thinking[\s\S]*Look at a\.ts first/)
  assert.match(md, /\*\*Tool call:\*\* `read_file`[\s\S]*"path": "a\.ts"/)
  assert.match(md, /### Tool result: `read_file`[\s\S]*short[\s\S]*Full output \(spill:\/\/s\/c1\):[\s\S]*the whole file/)
  assert.match(md, /### Tool error: `shell` \(subagent run-a\.sub1\)[\s\S]*boom/)
  assert.match(md, /Fixed with key sk-abcdefghijklmnopqrstuvwxyz123456/)
  assert.match(md, /\*\*Turn 1 was undone\*\*/)
  assert.match(md, /step 1 · mock · in 10 \/ out 2 tokens/)
  assert.doesNotMatch(md, /other run/)
  const masked = exportMarkdown(events, { runId: 'run-a', workspaceRoot: 'C:/ws', mask: true })
  assert.doesNotMatch(masked, /sk-abcdefghijklmnopqrstuvwxyz123456/)
})

test('the JSON export carries the raw events', () => {
  const data = JSON.parse(exportJson(events, { runId: 'run-a', workspaceRoot: 'C:/ws', now: 0 })) as { runId: string; events: SessionEvent[] }
  assert.equal(data.runId, 'run-a')
  assert.equal(data.events.length, 10)
  assert.equal(data.events.at(-1)?.type, 'turn/undo')
})
