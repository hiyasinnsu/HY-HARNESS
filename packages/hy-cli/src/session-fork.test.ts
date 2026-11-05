import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '../../core/dist/index.js'
import { ForkError, planFork, sourceEvents } from './session-fork.js'

function event(seq: number, runId: string | undefined, type: string, payload: unknown = {}): SessionEvent {
  return { v: 1, seq, ts: 1_000 + seq, sessionId: 'sid', ...(runId ? { runId } : {}), type, payload }
}

const log: SessionEvent[] = [
  event(1, undefined, 'session/format', { format: 2 }),
  event(2, 'run-a', 'turn/start', { turn: 1 }),
  event(3, 'run-a', 'user/message', { content: 'first' }),
  event(4, 'run-a', 'step/end', { stepIndex: 1 }),
  event(5, 'run-a', 'assistant/message', { content: '{"final":"done"}' }),
  event(6, 'run-a', 'turn/end', { status: 'completed' }),
  event(7, 'run-a.sub1', 'subagent/start', { task: 'read' }),
  event(8, 'run-b', 'turn/start', { turn: 1 }),
  event(9, 'run-b', 'user/message', { content: 'other chat' }),
  event(10, 'run-a', 'turn/start', { turn: 2 }),
  event(11, 'run-a', 'user/message', { content: 'second' }),
]

test('a fork copies one run only and keeps its timestamps', () => {
  const plan = planFork(log, 'run-a', 'run-copy')
  assert.deepEqual(
    plan.events.map((e) => e.type),
    ['turn/start', 'user/message', 'step/end', 'assistant/message', 'turn/end', 'turn/start', 'user/message'],
  )
  assert.equal(plan.upToSeq, 11)
  assert.equal(plan.turns, 2)
  assert.equal(plan.skippedSubagents, 1)
  for (const copied of plan.events) {
    assert.equal(copied.runId, 'run-copy', 'every copied event belongs to the new run')
    const source = log.find((e) => e.seq === copied.ts - 1_000)!
    assert.equal(copied.ts, source.ts, 'history timestamps are preserved')
  }
  // Source events are not mutated.
  assert.equal(log[1]!.runId, 'run-a')
})

test('a cut keeps the history before it', () => {
  const beforeSecond = planFork(log, 'run-a', 'run-copy', { upToSeq: 6 })
  assert.equal(beforeSecond.upToSeq, 6)
  assert.equal(beforeSecond.turns, 1)
  assert.equal(beforeSecond.events.some((e) => e.type === 'user/message' && (e.payload as { content: string }).content === 'second'), false)
  // A cut that lands on a subagent event copies the parent's events before it.
  const midTurn = planFork(log, 'run-a', 'run-copy', { upToSeq: 7 })
  assert.equal(midTurn.events.length, 5)
  assert.equal(midTurn.upToSeq, 6)
})

test('an empty source or a cut before it is refused', () => {
  assert.throws(() => planFork(log, 'run-missing', 'run-copy'), (error: unknown) => {
    assert.ok(error instanceof ForkError)
    assert.match(error.message, /no events to fork/)
    return true
  })
  assert.throws(() => planFork(log, 'run-a', 'run-copy', { upToSeq: 1 }), /before the first event/)
  assert.deepEqual(sourceEvents(log, 'run-b').map((e) => e.type), ['turn/start', 'user/message'])
})
