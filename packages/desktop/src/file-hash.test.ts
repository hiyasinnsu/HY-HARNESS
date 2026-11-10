import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { FileHashCache } from './file-hash.js'

function fixture(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-file-hash-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return path.join(dir, 'build.exe')
}

test('unchanged and concurrent checks reuse reads; apply reads afresh and same-size changes invalidate the cache', async (t) => {
  const file = fixture(t)
  fs.writeFileSync(file, 'first')
  const read = t.mock.method(fs, 'createReadStream')
  const cache = new FileHashCache()
  const hashes = await Promise.all([cache.hash(file), cache.hash(file)])
  assert.equal(hashes[0], hashes[1])
  assert.equal(await cache.hash(file), hashes[0])
  assert.equal(read.mock.callCount(), 1)
  assert.equal(await cache.hash(file, true), hashes[0])
  assert.equal(read.mock.callCount(), 2, 'applying an update bypasses the UI cache')
  const before = fs.statSync(file)
  await new Promise((resolve) => setTimeout(resolve, 10))
  fs.writeFileSync(file, 'other')
  fs.utimesSync(file, before.atime, before.mtime)
  assert.notEqual(await cache.hash(file), hashes[0], 'restoring mtime does not hide a changed file')
  assert.equal(read.mock.callCount(), 3)
})

test('large hashes let the event loop run between reads', async (t) => {
  const file = fixture(t)
  const bytes = Buffer.alloc(32 * 1024 * 1024, 7)
  fs.writeFileSync(file, bytes)
  const expected = createHash('sha256').update(bytes).digest('hex')
  const original = fs.createReadStream
  let finished = false
  let timerRanDuringHash = false
  t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
    const stream = original(...args)
    stream.once('data', () => setTimeout(() => { timerRanDuringHash = !finished }, 0))
    return stream
  })
  assert.equal(await new FileHashCache().hash(file), expected)
  finished = true
  assert.equal(timerRanDuringHash, true, 'reading and hashing must not monopolize the UI thread')
})

test('changed or missing files fail without poisoning later checks', async (t) => {
  const file = fixture(t)
  const cache = new FileHashCache()
  await assert.rejects(cache.hash(file), /ENOENT/)
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024))
  const original = fs.createReadStream
  const read = t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
    const stream = original(...args)
    stream.once('data', () => fs.writeFileSync(file, 'replacement'))
    return stream
  })
  await assert.rejects(cache.hash(file), /changed while hashing/)
  read.mock.restore()
  assert.equal(await cache.hash(file), createHash('sha256').update('replacement').digest('hex'))
})
