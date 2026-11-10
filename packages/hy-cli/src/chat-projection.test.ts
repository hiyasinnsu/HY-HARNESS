import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, SessionEvent } from '../../core/dist/index.js'
import { applyAgentEvent, projectChat } from './chat-projection.js'

const ev = (seq: number, type: string, payload: unknown, runId = 'run-test'): SessionEvent => ({
  v: 1,
  seq,
  ts: 1_000 + seq,
  sessionId: 's',
  runId,
  type,
  payload,
})

test('compaction notices survive a reload and manual completion does not duplicate them', () => {
  const entries = projectChat([
    ev(1, 'compaction/prune', { pruned: 2 }),
    ev(2, 'compaction/result', { outcome: 'shortened' }),
    ev(3, 'compaction/manual', { before: 10, after: 10, noticeHandled: true }),
    ev(4, 'compaction/summary', { pairs: 5 }),
    ev(5, 'compaction/result', { outcome: 'summarized' }, 'run-test.dialogue'),
    ev(6, 'compaction/result', { outcome: 'partial' }),
    ev(7, 'compaction/result', { outcome: 'failed' }),
  ], 'run-test')
  assert.deepEqual(entries.map((entry) => entry.id), ['compaction-2', 'compaction-5', 'compaction-6', 'compaction-7'])
  assert.deepEqual(entries.map((entry) => entry.kind === 'notice' && entry.level), ['info', 'info', 'warn', 'warn'])
})

test('projectChat rebuilds users, tool cards, plans and final answers', () => {
  const events: SessionEvent[] = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', { content: 'Inspect the repo' }),
    ev(3, 'assistant/message', { content: '{"tool":"read_file","args":{"path":"README.md"}}' }),
    ev(4, 'tool/result', { callId: 'step-1', name: 'read_file', output: '{"content":"# Hi"}', isError: false }),
    ev(5, 'step/end', { stepIndex: 1 }),
    ev(6, 'assistant/message', { content: '{"tool":"update_plan","args":{"plan":[{"step":"read","status":"completed"}]}}' }),
    ev(7, 'tool/result', { callId: 'step-2', name: 'update_plan', output: '{"ok":true}', isError: false }),
    ev(8, 'step/end', { stepIndex: 2 }),
    ev(9, 'assistant/message', { content: '{"final":"Done."}' }),
  ]
  const entries = projectChat(events, 'run-test')
  assert.equal(entries[0]?.kind, 'user')
  assert.equal(entries[0]?.kind === 'user' ? entries[0].text : '', 'Inspect the repo')
  const tool = entries.find((e) => e.kind === 'tool' && e.name === 'read_file')
  assert.equal(tool?.kind, 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.status : '', 'done')
  assert.ok(entries.some((e) => e.kind === 'plan'))
  const last = entries.at(-1)
  assert.equal(last?.kind, 'assistant')
  if (last?.kind !== 'assistant') return
  assert.equal(last.text, 'Done.')
})

test('projectChat attaches the Japanese thinking summary', () => {
  const entries = projectChat(
    [
      ev(1, 'assistant/thinking', { content: 'The user wants a small fix. I should inspect the file first.' }),
      ev(2, 'thinking/summary', { thinkingSeq: 1, summary: '小さな修正なので、まずファイルを確認します。' }),
    ],
    'run-test',
  )
  const thinking = entries.find((entry) => entry.kind === 'thinking')
  assert.equal(thinking?.kind, 'thinking')
  assert.equal(thinking?.kind === 'thinking' ? thinking.summary : '', '小さな修正なので、まずファイルを確認します。')
})

test('projectChat cleans legacy JSON summaries from the log', () => {
  const entries = projectChat(
    [
      ev(1, 'assistant/thinking', { content: 'I should inspect the files first.' }),
      ev(2, 'thinking/summary', { thinkingSeq: 1, summary: '{"思考":"要約: まずファイルを確認します。"}' }),
    ],
    'run-test',
  )
  const thinking = entries.find((entry) => entry.kind === 'thinking')
  assert.equal(thinking?.kind === 'thinking' ? thinking.summary : '', 'まずファイルを確認します。')
})

test('projectChat computes an instant summary for Japanese thinking', () => {
  const entries = projectChat([ev(1, 'assistant/thinking', { content: 'まずREADMEを確認する。次に構成をまとめる。' })], 'run-test')
  const thinking = entries.find((entry) => entry.kind === 'thinking')
  assert.equal(thinking?.kind === 'thinking' ? thinking.summary : '', 'まずREADMEを確認する。次に構成をまとめる。')
  assert.equal(thinking?.kind === 'thinking' ? thinking.summaryProvisional : undefined, true)
})

test('projectChat strips the session goal and counts images', () => {
  const entries = projectChat(
    [ev(1, 'user/message', { content: '[session goal: keep it stable]\n\nFix the bug', images: 2 })],
    'run-test',
  )
  const first = entries[0]
  assert.equal(first?.kind, 'user')
  if (first?.kind !== 'user') return
  assert.equal(first.text, 'Fix the bug')
  assert.equal(first.images, 2)
})

test('projectChat strips the multi-line workspace roots catalog', () => {
  const content = [
    '[workspace roots]',
    '- main: G:\\work (writable)',
    '- docs: F:\\docs (read-only)',
    'Use "rootId:relative/path" with read_file / search_glob / search_grep; pass root: "rootId" to apply_patch / shell.',
    'For shell, cwd is relative to that root (default: its top).',
    'Only the primary root (main) has LSP and checkpoint/undo support.',
    '',
    'Search the docs root for the API table',
  ].join('\n')
  const entries = projectChat([ev(1, 'user/message', { content })], 'run-test')
  const first = entries[0]
  assert.equal(first?.kind, 'user')
  assert.equal(first?.kind === 'user' ? first.text : '', 'Search the docs root for the API table')
})

test('projectChat strips the session goal and the workspace roots catalog together', () => {
  const content = [
    '[session goal: keep it stable]',
    '',
    '[workspace roots]',
    '- main: G:\\work (writable)',
    '- docs: F:\\docs (read-only)',
    'Use "rootId:relative/path" with read_file / search_glob / search_grep; pass root: "rootId" to apply_patch / shell.',
    '',
    'Fix the bug',
  ].join('\n')
  const entries = projectChat([ev(1, 'user/message', { content })], 'run-test')
  const first = entries[0]
  assert.equal(first?.kind, 'user')
  assert.equal(first?.kind === 'user' ? first.text : '', 'Fix the bug')
})

test('projectChat keeps a user message that merely starts with a bracket', () => {
  const entries = projectChat([ev(1, 'user/message', { content: '[bug] the run never stops' })], 'run-test')
  const first = entries[0]
  assert.equal(first?.kind === 'user' ? first.text : '', '[bug] the run never stops')
})

test('projectChat shows a steering message verbatim, marked as one', () => {
  const entries = projectChat(
    [
      ev(1, 'turn/start', { turn: 1 }),
      ev(2, 'user/message', { content: 'Read the repo' }),
      ev(3, 'tool/result', { callId: 'step-1', name: 'read_file', output: 'x', isError: false }),
      // Logged raw: the transcript shows what the user typed, not the marker.
      ev(4, 'user/steer', { content: 'also check the tests', step: 2 }),
      ev(5, 'step/end', { stepIndex: 2 }),
      ev(6, 'assistant/message', { content: '{"final":"Done."}' }),
    ],
    'run-test',
  )
  const steer = entries.find((e) => e.kind === 'user' && e.steering === true)
  assert.equal(steer?.kind === 'user' ? steer.text : '', 'also check the tests')
  const plain = entries.filter((e) => e.kind === 'user' && e.steering !== true)
  assert.equal(plain.length, 1, 'the original turn is not marked')
  // The delivery bookkeeping is not a transcript entry of its own.
  assert.equal(entries.filter((e) => e.kind === 'notice').length, 0)})

test('applyAgentEvent hides a truncated tool call instead of showing broken JSON', () => {
  const entries = [] as ReturnType<typeof projectChat>
  const truncated: AgentEvent = {
    type: 'assistant',
    step: 1,
    content: '{"calls":[{"tool":"read_file","args":{"path":"a.txt"}},{"tool":"shell","args":{"command":"Get-ChildI',
  }
  applyAgentEvent(entries, 'run-test', truncated)
  assert.equal(entries.length, 0, 'the structured tool-start event owns the card')
  const text: AgentEvent = { type: 'assistant', step: 2, content: 'A normal final answer.' }
  applyAgentEvent(entries, 'run-test', text)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.kind, 'assistant')
})

test('applyAgentEvent updates the running tool card on completion', () => {
  const entries = [] as ReturnType<typeof projectChat>
  const start: AgentEvent = { type: 'tool-start', step: 1, callId: 'step-1', name: 'shell', args: { command: 'git status' } }
  const done: AgentEvent = { type: 'tool', step: 1, callId: 'step-1', name: 'shell', result: { exitCode: 0 } }
  applyAgentEvent(entries, 'run-test', start)
  assert.equal(entries[0]?.kind, 'tool')
  assert.equal(entries[0]?.kind === 'tool' ? entries[0].status : '', 'running')
  applyAgentEvent(entries, 'run-test', done)
  assert.equal(entries[0]?.kind === 'tool' ? entries[0].status : '', 'done')
  assert.match(entries[0]?.kind === 'tool' ? (entries[0].output ?? '') : '', /exitCode/)
})

test('a presented file becomes a durable artifact card (WP-23)', () => {
  const files = [{ path: 'docs/report.md', size: 1_234, lines: 42, description: 'the finished report' }]
  const projected = projectChat([ev(1, 'deliverable/presented', { files })], 'run-test')
  const card = projected.find((entry) => entry.kind === 'deliverables')
  assert.ok(card)
  assert.equal(card?.kind === 'deliverables' ? card.files[0]?.path : '', 'docs/report.md')
  assert.equal(card?.kind === 'deliverables' ? card.files[0]?.lines : 0, 42)
  // The live path produces the same card from the tool result.
  const live = [] as ReturnType<typeof projectChat>
  applyAgentEvent(live, 'run-test', { type: 'tool', step: 1, callId: 'step-1', name: 'present', result: { presented: files, count: 1 } })
  const liveCard = live.find((entry) => entry.kind === 'deliverables')
  assert.equal(liveCard?.kind === 'deliverables' ? liveCard.files[0]?.description : '', 'the finished report')
})

test('CP-06: a sandbox denial is attached to its tool card, live and after a reload', () => {
  const projected = projectChat(
    [
      ev(1, 'assistant/message', { content: '{"tool":"shell","args":{"command":"rm -rf ."}}' }),
      ev(2, 'sandbox/denial', { callId: 'step-1', tool: 'shell', kind: 'policy', detail: 'denied by policy' }),
      ev(3, 'tool/result', { callId: 'step-1', name: 'shell', output: 'command denied by policy', isError: true }),
    ],
    'run-test',
  )
  const card = projected.find((entry) => entry.kind === 'tool')
  assert.equal(card?.kind === 'tool' ? card.denial : undefined, 'policy')

  // A live denial arrives on the error event and updates the existing card.
  const live = [] as ReturnType<typeof projectChat>
  applyAgentEvent(live, 'run-test', { type: 'tool-start', step: 1, callId: 'step-1', name: 'shell', args: { command: 'x' } })
  applyAgentEvent(live, 'run-test', {
    type: 'tool-error',
    step: 1,
    callId: 'step-1',
    name: 'shell',
    message: 'read-only sandbox forbids file writes',
    denial: { kind: 'sandbox', detail: 'forbids file writes' },
  })
  assert.equal(live[0]?.kind === 'tool' ? live[0].denial : undefined, 'sandbox')
})

test('todo_write replaces the plan card, live and after a reload', () => {
  const args = {
    todos: [
      { content: 'read the code', status: 'completed' },
      { content: 'fix the bug', status: 'in_progress' },
    ],
  }
  const calls = JSON.stringify({ tool: 'todo_write', args })
  const projected = projectChat(
    [
      ev(1, 'assistant/message', { content: calls }),
      ev(2, 'tool/result', { callId: 'step-1', name: 'todo_write', output: '{"ok":true}', isError: false }),
    ],
    'run-test',
  )
  const card = projected.find((entry) => entry.kind === 'plan')
  assert.deepEqual(card?.kind === 'plan' ? card.plan : [], [
    { step: 'read the code', status: 'completed' },
    { step: 'fix the bug', status: 'in_progress' },
  ])
  // The live event replaces the previous plan instead of stacking cards.
  const live = [] as ReturnType<typeof projectChat>
  applyAgentEvent(live, 'run-test', { type: 'tool-start', step: 1, callId: 'step-1', name: 'todo_write', args })
  applyAgentEvent(live, 'run-test', { type: 'tool', step: 1, callId: 'step-1', name: 'todo_write', args, result: { ok: true } })
  assert.equal(live.filter((entry) => entry.kind === 'plan').length, 1)
})

test('CP-18: streamed deltas grow one message and the final replaces it', () => {
  const live = [] as ReturnType<typeof projectChat>
  applyAgentEvent(live, 'run-x', { type: 'assistant-delta', step: 1, content: 'Hel' })
  applyAgentEvent(live, 'run-x', { type: 'assistant-delta', step: 1, content: 'lo' })
  assert.equal(live.length, 1)
  assert.equal(live[0]?.kind === 'assistant' ? live[0].text : '', 'Hello')
  applyAgentEvent(live, 'run-x', { type: 'assistant', step: 1, content: 'Hello (final)' })
  assert.equal(live.length, 1, 'the draft is replaced, not duplicated')
  assert.equal(live[0]?.kind === 'assistant' ? live[0].text : '', 'Hello (final)')
})
test('CP-33: a user message carries the turn it opened; undo keeps the numbering right', () => {
  const events: SessionEvent[] = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', { content: 'first' }),
    ev(3, 'assistant/message', { content: '{"final":"one"}' }),
    ev(4, 'turn/start', { turn: 2 }),
    ev(5, 'user/message', { content: 'second' }),
    ev(6, 'user/steer', { content: 'steer within turn 2' }),
    ev(7, 'assistant/message', { content: '{"final":"two"}' }),
    ev(8, 'turn/undo', { turn: 2 }),
    ev(9, 'turn/start', { turn: 2 }),
    ev(10, 'user/message', { content: 'second again' }),
  ]
  const users = projectChat(events, 'run-test').flatMap((e) => (e.kind === 'user' ? [{ text: e.text, turn: e.turn }] : []))
  assert.deepEqual(users, [
    { text: 'first', turn: 1 },
    { text: 'second again', turn: 2 },
  ])
})

test('CP-21: the chat shows the user\'s words, not the skill bodies added for the model', () => {
  const events: SessionEvent[] = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', { content: 'Ship it with @skill:release\n\n<skill name="release">\nStep 1\n</skill>\n\n[not installed skills: @skill:ghost]' }),
  ]
  const user = projectChat(events, 'run-test').find((e) => e.kind === 'user')
  assert.equal(user?.kind === 'user' ? user.text : '', 'Ship it with @skill:release')
})

test('dialogue remains in the parent transcript and worker steering is a notice, not user speech', () => {
  const entries = projectChat([
    ev(1, 'orchestration/dialogue', { role: 'user', content: 'Unrelated small talk' }),
    ev(2, 'orchestration/dialogue', { role: 'assistant', content: 'A natural reply' }),
    ev(3, 'user/steer', { source: 'worker', content: 'A worker result' }),
    ev(4, 'turn/failure', { nudge: 'The task is incomplete.' }),
  ], 'run-test')
  assert.deepEqual(entries.map((e) => [e.kind, 'text' in e ? e.text : '']), [
    ['user', 'Unrelated small talk'], ['assistant', 'A natural reply'], ['notice', 'A worker result'], ['notice', 'The task is incomplete.'],
  ])
})
