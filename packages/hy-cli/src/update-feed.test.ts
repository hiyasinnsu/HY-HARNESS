import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  UpdateFeedError,
  canonicalReleasePayload,
  compareVersions,
  downloadRelease,
  loadFeed,
  parseReleaseFeed,
  pickRelease,
  publicKeyFingerprint,
  readPublicKey,
  releaseFileName,
  signRelease,
  verifyReleaseSignature,
  type FetchLike,
  type ReleaseEntry,
} from './update-feed.js'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const other = generateKeyPairSync('ed25519')
const otherPublicPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString()

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function release(version: string, extra: Partial<ReleaseEntry> = {}): ReleaseEntry {
  const base = {
    version,
    url: `https://releases.example/${version}/HY-HARNESS-${version}-portable.exe`,
    sha256: sha256(`body ${version}`),
    ...extra,
  }
  return { ...base, signature: signRelease(base, privatePem) }
}

function feedOf(releases: ReleaseEntry[], channel?: string): { schema: number; channel?: string; releases: ReleaseEntry[] } {
  return { schema: 1, ...(channel ? { channel } : {}), releases }
}

test('the canonical payload is line based and stable', () => {
  const payload = canonicalReleasePayload({
    version: '0.3.0',
    url: 'https://releases.example/x.exe',
    sha256: 'A'.repeat(64),
    mandatory: true,
  })
  assert.equal(
    payload,
    ['hy-release/v1', '0.3.0', 'a'.repeat(64), 'https://releases.example/x.exe', '', 'true'].join('\n'),
  )
  // A signature covers the payload, not the JSON around it.
  const entry = release('0.3.0')
  assert.equal(verifyReleaseSignature(entry, publicPem), true)
  assert.equal(verifyReleaseSignature({ ...entry, sha256: sha256('tampered') }, publicPem), false)
  assert.equal(verifyReleaseSignature(entry, otherPublicPem), false)
  assert.equal(verifyReleaseSignature({ ...entry, signature: 'not base64' }, publicPem), false)
})

test('a signed feed verifies and the newest newer release is picked', () => {
  const feed = parseReleaseFeed(
    feedOf([release('0.2.0'), release('0.3.0', { mandatory: true, notes: 'fixes the update path' }), release('0.3.0-rc.1')]),
    publicPem,
  )
  // 0.3.0-rc.1 < 0.3.0, so 0.3.0 is still the newest.
  const newest = pickRelease(feed, '0.2.0')
  assert.equal(newest.release?.version, '0.3.0')
  assert.equal(newest.release?.mandatory, true)
  assert.equal(pickRelease(feed, '0.3.0').reason, 'up-to-date')
  assert.equal(pickRelease(feed, '0.4.0').reason, 'older-only')
  assert.equal(pickRelease(feed, '0.2.0', { channel: 'beta' }).reason, 'no-release-for-channel')
  // Prereleases are only offered on a channel that names them.
  const beta = parseReleaseFeed(feedOf([release('0.4.0-beta.2', { channel: 'beta' }), release('0.3.0')], 'stable'), publicPem)
  assert.equal(pickRelease(beta, '0.3.0', { channel: 'beta' }).release?.version, '0.4.0-beta.2')
  assert.equal(pickRelease(beta, '0.3.0').reason, 'up-to-date')
})

test('a feed with a bad signature, shape or version is rejected as a whole', () => {
  const good = release('0.3.0')
  assert.throws(
    () => parseReleaseFeed(feedOf([release('0.2.0'), { ...good, version: '0.4.0' }]), publicPem),
    (error: unknown) => {
      assert.ok(error instanceof UpdateFeedError)
      assert.match(error.message, /signature verification failed for 0\.4\.0/)
      return true
    },
  )
  assert.throws(() => parseReleaseFeed(feedOf([good]), otherPublicPem), /signature verification failed/)
  assert.throws(() => parseReleaseFeed('not json', publicPem), /not valid JSON/)
  assert.throws(() => parseReleaseFeed({ schema: 2, releases: [] }, publicPem), /unsupported feed schema/)
  assert.throws(() => parseReleaseFeed({ releases: {} }, publicPem), /releases must be an array/)
  assert.throws(() => parseReleaseFeed(feedOf([{ ...good, version: 'v1' }]), publicPem), /must look like 1\.2\.3/)
  assert.throws(
    () => parseReleaseFeed(feedOf([release('0.3.0'), release('0.3.0')]), publicPem),
    /duplicate release 0\.3\.0/,
  )
  assert.throws(
    () => parseReleaseFeed(feedOf([{ ...good, sha256: 'abc' }]), publicPem),
    /sha256 must be 64 lowercase hex/,
  )
  assert.throws(() => parseReleaseFeed(feedOf([{ ...good, signature: '' }]), publicPem), /signature is required/)
})

test('versions compare by semver precedence', () => {
  assert.equal(compareVersions('0.3.0', '0.2.9'), 1)
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0)
  assert.equal(compareVersions('1.0.0', '2.0.0'), -1)
  assert.equal(compareVersions('0.3.0-rc.1', '0.3.0'), -1)
  assert.equal(compareVersions('0.3.0-alpha.2', '0.3.0-alpha.10'), -1)
  assert.equal(compareVersions('0.3.0-beta', '0.3.0-alpha'), 1)
  assert.equal(compareVersions('0.3.0-1', '0.3.0-alpha'), -1)
  assert.throws(() => compareVersions('0.3', '0.3.0'), /not a version/)
})

test('a download is verified before it is visible and leaves nothing on a mismatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-feed-'))
  try {
    const body = Buffer.from('MZ portable exe bytes')
    const entry = release('0.3.0', { sha256: createHash('sha256').update(body).digest('hex'), size: body.length })
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    })
    const result = await downloadRelease(entry, dir, { fetchImpl })
    assert.equal(result.bytes, body.length)
    assert.equal(result.sha256, entry.sha256)
    assert.deepEqual(fs.readFileSync(result.file), body)
    assert.equal(fs.readFileSync(result.sidecar, 'utf8'), `${entry.sha256}\n`)
    assert.equal(releaseFileName(entry), `HY-HARNESS-0.3.0-portable.exe`)
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.part')), false)

    const wrongHash = { ...entry, sha256: sha256('something else') }
    await assert.rejects(downloadRelease(wrongHash, path.join(dir, 'bad'), { fetchImpl }), /checksum mismatch/)
    assert.equal(fs.existsSync(path.join(dir, 'bad', releaseFileName(entry))), false)

    const wrongSize = { ...entry, size: body.length + 1 }
    await assert.rejects(downloadRelease(wrongSize, path.join(dir, 'size'), { fetchImpl }), /size mismatch/)

    const plain: FetchLike = async () => ({ ok: false, status: 503, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) })
    await assert.rejects(downloadRelease(entry, dir, { fetchImpl: plain }), /HTTP 503/)
    // An http url needs an explicit opt-in.
    await assert.rejects(downloadRelease({ ...entry, url: 'http://localhost/x.exe' }, dir, { fetchImpl }), /must use https/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('feeds load from a file and from an https url', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-feed-file-'))
  try {
    const file = path.join(dir, 'stable.json')
    const text = JSON.stringify(feedOf([release('0.3.0')]))
    fs.writeFileSync(file, text, 'utf8')
    assert.equal((await loadFeed(file, publicPem)).releases[0]?.version, '0.3.0')
    // The public key is accepted inline or from a file.
    assert.equal(readPublicKey(publicPem), publicPem)
    const keyFile = path.join(dir, 'key.pem')
    fs.writeFileSync(keyFile, publicPem, 'utf8')
    assert.equal(readPublicKey(keyFile), publicPem)
    assert.throws(() => readPublicKey(path.join(dir, 'missing.pem')), /could not read|ENOENT|not an Ed25519|no such file/i)
    assert.match(publicKeyFingerprint(publicPem), /^[0-9a-f]{4}(:[0-9a-f]{4}){7}$/)

    const notAKey = path.join(dir, 'not-a-key.pem')
    fs.writeFileSync(notAKey, 'hello', 'utf8')
    assert.throws(() => readPublicKey(notAKey), /not an Ed25519 public key/)

    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, text: async () => text, arrayBuffer: async () => new ArrayBuffer(0) })
    assert.equal((await loadFeed('https://feeds.example/stable.json', publicPem, { fetchImpl })).releases.length, 1)
    await assert.rejects(loadFeed('http://feeds.example/stable.json', publicPem, { fetchImpl }), /must use https/)
    const failing: FetchLike = async () => {
      throw new Error('offline')
    }
    await assert.rejects(loadFeed('https://feeds.example/stable.json', publicPem, { fetchImpl: failing }), /could not reach/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
