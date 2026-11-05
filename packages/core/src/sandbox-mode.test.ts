import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSandboxMode, switchableSandboxModes } from './sandbox-mode.js'
import type { SessionEvent } from './session-log.js'

function event(runId: string, type: string, payload: unknown, seq = 1): SessionEvent {
  return { v: 1, seq, ts: 0, sessionId: 's', runId, type, payload } as SessionEvent
}

test('a session without a switch keeps the configured mode', () => {
  assert.equal(resolveSandboxMode([], 'run', 'unconfined'), 'unconfined')
  assert.equal(resolveSandboxMode([event('run', 'turn/start', {}, 1)], 'run', 'workspace-write'), 'workspace-write')
})

test('the last sandbox/mode event wins on replay', () => {
  const events = [
    event('run', 'sandbox/mode', { mode: 'read-only' }, 1),
    event('run', 'sandbox/mode', { mode: 'workspace-write' }, 2),
    event('run', 'sandbox/mode', { mode: 'unconfined' }, 3),
  ]
  assert.equal(resolveSandboxMode(events, 'run', 'read-only'), 'unconfined')
})

test('events of another run and malformed payloads are ignored', () => {
  const events = [
    event('other', 'sandbox/mode', { mode: 'unconfined' }, 1),
    event('run', 'sandbox/mode', { mode: 'yolo' }, 2),
    event('run', 'sandbox/mode', {}, 3),
    event('run', 'sandbox/mode', null, 4),
    event('run', 'sandbox/mode', { mode: 'read-only' }, 5),
  ]
  assert.equal(resolveSandboxMode(events, 'run', 'workspace-write'), 'read-only')
})

test('the switchable set is the three documented modes', () => {
  assert.deepEqual([...switchableSandboxModes()], ['read-only', 'workspace-write', 'unconfined'])
})
