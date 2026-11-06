import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encryptPushPayload, loadVapidKeys, sendPush, vapidAuthorization } from './web-push.js'

// RFC 8291 §5, "Push Message Encryption Example".
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

test('aes128gcm encryption matches the RFC 8291 example byte for byte', () => {
  const body = encryptPushPayload(Buffer.from(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, {
    salt: Buffer.from(RFC.salt, 'base64url'),
    asPrivateKey: Buffer.from(RFC.asPrivate, 'base64url'),
  })
  assert.equal(body.toString('base64url'), RFC.body)
})

/** The receiving side of RFC 8291, to check a random encryption round-trips. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16)
  const idlen = body.readUInt8(20)
  const asPublic = body.subarray(21, 21 + idlen)
  const ciphertext = body.subarray(21 + idlen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const uaPublic = ecdh.getPublicKey()
  const h = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest()
  const ikm = h(h(auth, ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]))
  const prk = h(salt, ikm)
  const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16)
  const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter')
  return plain.subarray(0, plain.length - 1).toString('utf8')
}

test('a random-key encryption decrypts back to the payload', () => {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = Buffer.alloc(16, 7)
  const body = encryptPushPayload(Buffer.from('承認待ち: shell npm test'), { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') })
  assert.equal(decrypt(body, ua.getPrivateKey(), auth), '承認待ち: shell npm test')
})

test('VAPID keys persist and the JWT verifies against the advertised public key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-vapid-'))
  try {
    const file = path.join(dir, 'vapid.json')
    const keys = loadVapidKeys(file)
    assert.equal(loadVapidKeys(file).publicKey, keys.publicKey, 'the pair is reused, so subscriptions stay valid')
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:hy-harness@example.com', 1_800_000_000_000)
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
    assert.ok(match)
    const claims = JSON.parse(Buffer.from(match[2]!, 'base64url').toString())
    assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 12 * 3600, sub: 'mailto:hy-harness@example.com' })
    assert.equal(match[4], keys.publicKey)
    const raw = Buffer.from(keys.publicKey, 'base64url')
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' })
    assert.ok(verify('sha256', Buffer.from(`${match[1]}.${match[2]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(match[3]!, 'base64url')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a 410 from the push service marks the subscription gone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-vapid-'))
  try {
    const keys = loadVapidKeys(path.join(dir, 'vapid.json'))
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const subscription = { endpoint: 'https://push.example/sub/1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } }
    const seen: Array<Record<string, string>> = []
    const fake = (status: number) =>
      (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>)
        return new Response(null, { status })
      }) as typeof fetch
    assert.equal(await sendPush(subscription, { title: 't', body: 'b', tag: 'approval' }, keys, 'mailto:x@example.com', fake(201)), 'sent')
    assert.equal(await sendPush(subscription, { title: 't', body: 'b' }, keys, 'mailto:x@example.com', fake(410)), 'gone')
    assert.equal(await sendPush(subscription, { title: 't', body: 'b' }, keys, 'mailto:x@example.com', fake(500)), 'failed')
    assert.equal(seen[0]!['Content-Encoding'], 'aes128gcm')
    assert.match(seen[0]!.Authorization!, /^vapid t=/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
