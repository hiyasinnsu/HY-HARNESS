// Web Push without a dependency: RFC 8291 message encryption (aes128gcm) and
// RFC 8292 VAPID authentication, on node:crypto.
//
// The phone's service worker subscribes with the server's VAPID public key; the
// browser vendor's push service (FCM, Apple, Mozilla) delivers the encrypted
// payload, so the phone is told about an approval or a finished turn while the
// tab is closed. The push service sees only ciphertext.
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { PushSubscriptionJson } from './phone-devices.js'

const b64u = (buf: Buffer): string => buf.toString('base64url')
const fromB64u = (text: string): Buffer => Buffer.from(text, 'base64url')
const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest()

export interface EncryptOptions {
  /** Test hook: fixed 16-byte salt (RFC 8291 §5 example). */
  salt?: Buffer
  /** Test hook: fixed application-server ECDH private key (32 bytes). */
  asPrivateKey?: Buffer
  /** Record size; the payload must fit one record. */
  recordSize?: number
}

/** RFC 8291 §3–4: encrypts `payload` for one subscription as an aes128gcm body. */
export function encryptPushPayload(payload: Buffer, keys: { p256dh: string; auth: string }, options: EncryptOptions = {}): Buffer {
  const uaPublic = fromB64u(keys.p256dh)
  const authSecret = fromB64u(keys.auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('p256dh must be an uncompressed P-256 point')
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes')
  const recordSize = options.recordSize ?? 4096
  if (payload.length + 1 + 16 > recordSize) throw new Error('payload too large for one record')

  const ecdh = createECDH('prime256v1')
  if (options.asPrivateKey) ecdh.setPrivateKey(options.asPrivateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const ecdhSecret = ecdh.computeSecret(uaPublic)

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const prkKey = hmac(authSecret, ecdhSecret)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic, Buffer.from([1])])
  const ikm = hmac(prkKey, keyInfo)

  const salt = options.salt ?? randomBytes(16)
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12)

  // A single, last record: payload || 0x02 (no padding).
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(16 + 4 + 1)
  salt.copy(header, 0)
  header.writeUInt32BE(recordSize, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, ciphertext])
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (what `pushManager.subscribe` takes). */
  publicKey: string
  privateKey: KeyObject
}

/** Loads the server's VAPID key pair, creating it on first use (file is 0600). */
export function loadVapidKeys(file: string): VapidKeys {
  try {
    const jwk = JSON.parse(fs.readFileSync(file, 'utf8')) as { kty: string; crv: string; x: string; y: string; d: string }
    if (jwk.kty === 'EC' && jwk.crv === 'P-256' && jwk.d) {
      return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])), privateKey: createPrivateKey({ key: jwk, format: 'jwk' }) }
    }
  } catch {
    // Missing or unreadable: make a new pair below.
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(jwk)}\n`, { encoding: 'utf8', mode: 0o600 })
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])), privateKey }
}

/** RFC 8292: `Authorization: vapid t=<JWT>, k=<public key>` for one push service origin. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const audience = new URL(endpoint).origin
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`
}

export interface PushMessage {
  title: string
  body: string
  /** Notifications with one tag replace each other on the phone. */
  tag?: string
  /** Where tapping the notification opens (same origin). */
  url?: string
}

export type PushOutcome = 'sent' | 'gone' | 'failed'

/**
 * Sends one message. `gone` (404/410) means the subscription expired and should
 * be dropped; `failed` is anything else (network, 4xx/5xx), kept for a retry.
 */
export async function sendPush(
  subscription: PushSubscriptionJson,
  message: PushMessage,
  keys: VapidKeys,
  subject: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PushOutcome> {
  const body = encryptPushPayload(Buffer.from(JSON.stringify(message), 'utf8'), subscription.keys)
  try {
    const response = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        TTL: '86400',
        Urgency: 'high',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: vapidAuthorization(subscription.endpoint, keys, subject),
        ...(message.tag ? { Topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'hy' } : {}),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 404 || response.status === 410) return 'gone'
    return response.ok ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}
