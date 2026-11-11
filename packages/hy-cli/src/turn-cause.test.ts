import { test } from 'node:test'
import assert from 'node:assert/strict'
import { turnEndCause } from './turn-cause.js'
import { workerEvidence } from './orchestration.js'

function named(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error(message)
  error.name = name
  return Object.assign(error, extra)
}

test('C2: the recorded abort reason wins; otherwise the error type decides', () => {
  assert.deepEqual(turnEndCause(new Error('x'), 'user-cancel'), { kind: 'user-cancel' })
  assert.deepEqual(turnEndCause(new Error('x'), 'something-else'), { kind: 'aborted' })
  assert.deepEqual(turnEndCause(named('BudgetExhaustedError', 'budget exhausted (usd): …', { dimension: 'usd' })), { kind: 'budget', detail: 'usd' })
  assert.deepEqual(turnEndCause(named('TooManyDenialsError', 'Guardian denied')), { kind: 'guardian' })
  assert.deepEqual(turnEndCause(named('LlmError', 'HTTP 429 rate limited', { status: 429 })), { kind: 'provider', detail: 'HTTP 429' })
  assert.deepEqual(turnEndCause(named('LlmError', 'maximum context length exceeded', { status: 400 })), { kind: 'context-overflow' })
  assert.deepEqual(turnEndCause(named('ExecRpcError', 'pipe closed')), { kind: 'exec-daemon' })
  assert.deepEqual(turnEndCause('boom'), { kind: 'error' })
})

test('C1: a done report gets what the worker\'s tool results show, and a concern when unchecked', () => {
  const ev = (seq: number, type: string, payload: unknown, runId = 'w1') => ({ seq, type, payload, runId })
  const verified = workerEvidence([
    ev(1, 'turn/start', {}),
    ev(2, 'turn/verification', { editedFiles: ['src/a.ts'], checks: [{ target: 'npm test', passed: true, exitCode: 0 }], verifiedAfterLastEdit: true, lastCheckPassed: true }),
  ], 'w1')
  assert.deepEqual(verified, { lines: ['host evidence: edited src/a.ts', 'checks run: npm test → passed'] })
  const unchecked = workerEvidence([
    ev(1, 'turn/start', {}),
    ev(2, 'turn/verification', { editedFiles: ['src/a.ts'], checks: [], verifiedAfterLastEdit: false }),
  ], 'w1')
  assert.match(unchecked.concern!, /no check ran after its last edit/)
  const failed = workerEvidence([
    ev(1, 'turn/start', {}),
    ev(2, 'turn/verification', { editedFiles: ['a.ts'], checks: [{ target: 'pytest', passed: false, exitCode: 1 }], verifiedAfterLastEdit: true, lastCheckPassed: false }),
  ], 'w1')
  assert.match(failed.lines[1]!, /pytest → failed \(exit 1\)/)
  assert.match(failed.concern!, /last check failed/)
  // An older turn's summary and another run's do not count.
  const stale = workerEvidence([
    ev(1, 'turn/verification', { editedFiles: ['a.ts'], verifiedAfterLastEdit: false }),
    ev(2, 'turn/start', {}),
    ev(3, 'turn/verification', { editedFiles: ['b.ts'], verifiedAfterLastEdit: false }, 'other'),
  ], 'w1')
  assert.match(stale.lines[0]!, /no file edits or checks recorded/)
  assert.equal(stale.concern, undefined)
})
