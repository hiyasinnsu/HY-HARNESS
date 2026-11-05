import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '../../core/dist/index.js'
import {
  applyAgentEvent,
  emptyClock,
  emptyStats,
  finishTurn,
  statsFromEvents,
  statsView,
} from './session-stats.js'

function event(type: string, payload: unknown = {}): SessionEvent {
  return { v: 1, seq: 0, ts: 0, sessionId: 'side', type, payload }
}

test('live events measure provider time, tool time and the first answer', () => {
  const clock = emptyClock()
  let stats = emptyStats()
  // A turn with one step that calls two tools.
  stats = applyAgentEvent(stats, clock, { type: 'step-start' }, 1_000)
  stats = applyAgentEvent(stats, clock, { type: 'step-end' }, 1_400)
  assert.equal(stats.steps, 1)
  assert.equal(stats.llmMs, 400)
  stats = applyAgentEvent(stats, clock, { type: 'tool-start', callId: 'c1', name: 'read_file' }, 1_410)
  stats = applyAgentEvent(stats, clock, { type: 'tool', callId: 'c1', name: 'read_file' }, 1_430)
  stats = applyAgentEvent(stats, clock, { type: 'tool-start', callId: 'c2', name: 'shell' }, 1_440)
  stats = applyAgentEvent(stats, clock, { type: 'tool-error', callId: 'c2', name: 'shell' }, 1_500)
  assert.equal(stats.toolMs, 80)
  assert.deepEqual(stats.tools.read_file, { calls: 1, errors: 0, ms: 20 })
  assert.deepEqual(stats.tools.shell, { calls: 1, errors: 1, ms: 60 })

  const finished = finishTurn(stats, clock, 2_000)
  assert.equal(finished.stats.turns, 1)
  assert.equal(finished.lastTurnMs, 1_000)
  assert.equal(finished.firstResponseMs, 400)
  // The clock is reset for the next turn.
  assert.equal(clock.turnStart, undefined)
  assert.equal(clock.stepStart, undefined)
  assert.equal(clock.toolStarts.size, 0)
  // A second turn adds to the totals.
  const next = finishTurn(applyAgentEvent(finished.stats, clock, { type: 'step-start' }, 5_000), clock, 5_200)
  assert.equal(next.stats.turns, 2)
  assert.equal(next.firstResponseMs, 0, 'a turn without a step end has no first answer')
  assert.equal(next.lastTurnMs, 200)
})

test('a missing tool start still counts the call without inventing time', () => {
  const clock = emptyClock()
  const stats = applyAgentEvent(emptyStats(), clock, { type: 'tool', callId: 'unknown', name: 'web_fetch' }, 10)
  assert.equal(stats.toolMs, 0)
  assert.deepEqual(stats.tools.web_fetch, { calls: 1, errors: 0, ms: 0 })
})

test('the newest snapshot wins and later tool results are counted', () => {
  const snapshot = {
    turns: 2,
    steps: 3,
    llmMs: 900,
    toolMs: 100,
    lastTurnMs: 500,
    firstResponseMs: 300,
    tools: { read_file: { calls: 1, errors: 0, ms: 100 } },
  }
  const restored = statsFromEvents([
    event('turn/start'),
    event('session/stats', snapshot),
    event('tool/result', { name: 'shell', isError: true }),
    event('tool/result', { name: 'read_file', isError: false }),
  ])
  assert.equal(restored.turns, snapshot.turns)
  assert.equal(restored.llmMs, 900)
  assert.deepEqual(restored.tools.shell, { calls: 1, errors: 1, ms: 0 })
  assert.deepEqual(restored.tools.read_file, { calls: 2, errors: 0, ms: 100 })
})

test('a log with no snapshot still reports turns, steps and tool calls', () => {
  const stats = statsFromEvents([
    event('turn/start'),
    event('step/end', { stepIndex: 1 }),
    event('tool/result', { name: 'read_file', isError: false }),
    event('turn/start'),
    event('turn/undo'),
    event('step/end', { stepIndex: 2 }),
    event('round/start'),
  ])
  assert.equal(stats.turns, 2)
  assert.equal(stats.steps, 2)
  assert.equal(stats.llmMs, 0, 'the log has no step timings')
  assert.deepEqual(stats.tools.read_file, { calls: 1, errors: 0, ms: 0 })
})

test('a malformed snapshot is ignored', () => {
  const stats = statsFromEvents([event('session/stats', { turns: 'many' }), event('turn/start')])
  assert.equal(stats.turns, 1)
  assert.equal(stats.steps, 0)
})

test('the view sorts tool names so the GUI does not reorder them', () => {
  const view = statsView({
    ...emptyStats(),
    tools: { shell: { calls: 2, errors: 0, ms: 5 }, apply_patch: { calls: 1, errors: 0, ms: 3 } },
  })
  assert.deepEqual(Object.keys(view.tools), ['apply_patch', 'shell'])
})
