import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { SessionLog, readEvents } from './session-log.js'

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
