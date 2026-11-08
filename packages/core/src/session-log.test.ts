import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { SessionLog, readEvents, sessionLogLockTiming } from './session-log.js'

function tmpLog(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-session-log-'))
  return { dir, file: path.join(dir, 'session.jsonl') }
}

test('seq continues after events another process appended', () => {
  const { dir, file } = tmpLog()
  try {
    const log = new SessionLog(file)
    log.append('a', {})
    const before = readEvents(file).at(-1)!.seq
    // Another process (its own counter) writes two events meanwhile.
    const foreign = (seq: number) => JSON.stringify({ v: 1, seq, ts: 0, sessionId: 'other', type: 'x', payload: {} }) + '\n'
    fs.appendFileSync(file, foreign(before + 1) + foreign(before + 2))
    const next = log.append('b', {})
    assert.equal(next.seq, before + 3)
    const seqs = readEvents(file).map((e) => e.seq)
    assert.equal(new Set(seqs).size, seqs.length, `duplicate seq: ${seqs.join(',')}`)
    assert.ok(!fs.existsSync(`${file}.lock`), 'the lock is released')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a partial last line left by a crash does not swallow the next event', () => {
  const { dir, file } = tmpLog()
  try {
    const log = new SessionLog(file)
    log.append('a', {})
    fs.appendFileSync(file, '{"v":1,"seq":99,"type":"tor')
    const next = log.append('after-crash', { ok: true })
    const events = readEvents(file)
    assert.equal(events.at(-1)!.type, 'after-crash')
    assert.equal(events.at(-1)!.seq, next.seq)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('seq continues after a foreign event or partial line larger than the tail window', () => {
  const { dir, file } = tmpLog()
  try {
    const log = new SessionLog(file)
    log.append('a', {})
    const seq = readEvents(file).at(-1)!.seq + 1
    fs.appendFileSync(file, JSON.stringify({ v: 1, seq, ts: 0, sessionId: 'other', type: 'x', payload: 'あ'.repeat(300_000) }) + '\n')
    assert.equal(log.append('after-large-event', {}).seq, seq + 1)
    fs.appendFileSync(file, '{"payload":"' + 'x'.repeat(600_000))
    assert.equal(log.append('after-large-partial', {}).seq, seq + 2)
    const seqs = readEvents(file).map((event) => event.seq)
    assert.equal(new Set(seqs).size, seqs.length)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a held lock times out without writing or removing the lock', () => {
  const { dir, file } = tmpLog()
  try {
    const log = new SessionLog(file)
    log.append('before', {})
    const before = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(`${file}.lock`, 'held')
    // A wait shorter than the takeover (not the defaults) to reach the timeout.
    const saved = { ...sessionLogLockTiming }
    Object.assign(sessionLogLockTiming, { staleMs: 60_000, waitMs: 100 })
    try {
      assert.throws(() => log.append('must-not-write', {}), /timed out acquiring session log lock/)
    } finally {
      Object.assign(sessionLogLockTiming, saved)
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), 'held')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the default wait outlasts the stale-lock takeover', () => {
  assert.ok(sessionLogLockTiming.waitMs > sessionLogLockTiming.staleMs)
})

test('a lock left by a crashed writer moments ago is taken over, not a failure', () => {
  const { dir, file } = tmpLog()
  const saved = { ...sessionLogLockTiming }
  // Scaled-down defaults: the wait outlasts the takeover.
  Object.assign(sessionLogLockTiming, { staleMs: 150, waitMs: 400 })
  try {
    const log = new SessionLog(file)
    fs.writeFileSync(`${file}.lock`, '')
    log.append('after-crash', {})
    assert.equal(readEvents(file).at(-1)!.type, 'after-crash')
    assert.ok(!fs.existsSync(`${file}.lock`))
  } finally {
    Object.assign(sessionLogLockTiming, saved)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale lock from a crashed writer is taken over', () => {
  const { dir, file } = tmpLog()
  try {
    fs.writeFileSync(`${file}.lock`, '')
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(`${file}.lock`, old, old)
    const log = new SessionLog(file)
    const started = Date.now()
    log.append('a', {})
    assert.ok(Date.now() - started < 2_000, 'did not wait for the full timeout')
    assert.equal(readEvents(file).at(-1)!.type, 'a')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
