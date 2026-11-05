import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acceptKey, decodeFrame, encodeFrame } from './ws.js'
import { backoff, claimLock, DaemonRunningError, readDaemonInfo, stateKey } from './daemon.js'

/** A masked client frame, as a browser sends it. */
function clientFrame(opcode: number, text: string, fin = true): Buffer {
  const payload = Buffer.from(text)
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))
  const len = payload.length
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, len >> 8, len & 0xff])
  return Buffer.concat([head, mask, masked])
}

test('CP-27: the RFC 6455 accept key', () => {
  // The example from RFC 6455 §1.3.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('CP-27: frames round-trip, masked and unmasked, short and 16-bit lengths', () => {
  const short = decodeFrame(clientFrame(0x1, 'hello'))!
  assert.deepEqual([short.fin, short.opcode, short.masked, short.payload.toString()], [true, 1, true, 'hello'])
  const long = 'x'.repeat(300)
  const decoded = decodeFrame(clientFrame(0x1, long))!
  assert.equal(decoded.payload.toString(), long)
  const server = decodeFrame(encodeFrame(0x1, Buffer.from(long)))!
  assert.equal(server.masked, false)
  assert.equal(server.payload.toString(), long)
  const big = decodeFrame(encodeFrame(0x1, Buffer.alloc(70_000, 97)))!
  assert.equal(big.payload.length, 70_000)
  // An incomplete frame waits for more bytes.
  assert.equal(decodeFrame(clientFrame(0x1, 'hello').subarray(0, 5)), undefined)
  // A fragment keeps fin=false.
  assert.equal(decodeFrame(clientFrame(0x1, 'part', false))!.fin, false)
})

test('CP-27: daemon lock is exclusive while the holder lives, and released by its owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-lock-'))
  try {
    const info = { pid: process.pid, pipe: '\\\\.\\pipe\\hy-test-none', token: 't', startedAt: 1, version: 'x', workspace: dir }
    const release = await claimLock(dir, info)
    assert.equal(readDaemonInfo(dir)?.pid, process.pid)
    // A second claim: the holder (this process) is alive but its pipe does not
    // answer, so the lock counts as stale and is taken over.
    const release2 = await claimLock(dir, { ...info, token: 'u' })
    assert.equal(readDaemonInfo(dir)?.token, 'u')
    release()
    release2()
    assert.equal(readDaemonInfo(dir), undefined)
    // A dead holder's lock is stale too.
    fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ ...info, pid: 999_999 }))
    const release3 = await claimLock(dir, info)
    release3()
    assert.ok(DaemonRunningError)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-27: backoff doubles and is capped; state keys are stable', () => {
  assert.deepEqual([0, 1, 2, 3, 10].map((n) => backoff(n)), [100, 200, 400, 800, 3200])
  assert.equal(stateKey('C:\\State'), stateKey('c:\\state'))
  assert.equal(stateKey('a').length, 16)
})
