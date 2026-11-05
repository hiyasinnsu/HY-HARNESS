import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  SESSION_FORMAT_VERSION,
  hasFormatHeader,
  migrateSessionEvents,
  sessionFormatOf,
} from './session-format.js'
import { SessionLog, readEvents, type SessionEvent } from './session-log.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const legacyFixture = path.join(repo, 'tests', 'fixtures', 'session-v1.jsonl')

function event(seq: number, type = 'turn/start', payload: unknown = {}): SessionEvent {
  return { v: 1, seq, ts: 0, sessionId: 's', runId: 'run', type, payload }
}

test('a log without a header is format 1 and migrates to the current format', () => {
  const events = [event(1), event(2, 'turn/end', { outcome: 'completed' })]
  assert.equal(sessionFormatOf(events), 1)
  const migrated = migrateSessionEvents(events)
  assert.equal(migrated.format, SESSION_FORMAT_VERSION)
  assert.equal(migrated.unsupported, false)
  assert.deepEqual(migrated.events, events, 'the v1 to v2 migration is additive')
})

test('a header wins over the legacy default and a future log is best-effort', () => {
  const current = [event(1, 'session/format', { format: SESSION_FORMAT_VERSION }), event(2)]
  assert.equal(sessionFormatOf(current), SESSION_FORMAT_VERSION)
  assert.equal(migrateSessionEvents(current).unsupported, false)

  const future = [event(1, 'session/format', { format: SESSION_FORMAT_VERSION + 7 }), event(2)]
  const migrated = migrateSessionEvents(future)
  assert.equal(migrated.unsupported, true)
  assert.equal(migrated.format, SESSION_FORMAT_VERSION + 7)
  assert.deepEqual(migrated.events, future, 'an unknown future log is read unchanged')
})

test('SessionLog writes the format header exactly once and keeps seq monotonic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-format-'))
  try {
    const file = path.join(dir, 'session.v1.jsonl')
    const first = new SessionLog(file)
    first.setRun('run-1')
    first.append('turn/start', { turn: 1 })
    const events = readEvents(file)
    assert.equal(events[0]?.type, 'session/format')
    assert.deepEqual(events[0]?.payload, { format: SESSION_FORMAT_VERSION })
    assert.equal(hasFormatHeader(events), true)
    assert.deepEqual(
      events.map((entry) => entry.seq),
      [1, 2],
    )

    // A second session appending to the same file does not duplicate the header.
    const second = new SessionLog(file)
    second.setRun('run-2')
    second.append('turn/start', { turn: 1 })
    const after = readEvents(file)
    assert.equal(after.filter((entry) => entry.type === 'session/format').length, 1)
    assert.deepEqual(
      after.map((entry) => entry.seq),
      [1, 2, 3],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a legacy fixture with no header and a torn tail still reads', () => {
  const events = readEvents(legacyFixture)
  assert.equal(events.length, 3)
  assert.equal(events[0]?.type, 'session/start')
  assert.equal(sessionFormatOf(events), 1)
  assert.equal(migrateSessionEvents(events).format, SESSION_FORMAT_VERSION)
})
