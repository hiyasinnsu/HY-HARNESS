// Phone pairing and the paired-device list.
//
// Before this, a phone used the launch token: the URL itself was the
// credential, anyone who saw it could use the session, nothing listed who was
// connected, and the token changed on every server start so the phone had to be
// given a new URL after each restart. Modeled on Codex's remote-control pairing:
//   - the desktop asks for a one-time pairing code (short-lived, single use) and
//     shows it as a QR code;
//   - opening /pair?code=… on the phone claims it and gives that phone its own
//     long-lived secret (an HttpOnly cookie), stored here only as a hash;
//   - the desktop lists paired devices and can revoke any of them at once.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** A Web Push subscription as the browser reports it (`PushSubscription.toJSON()`). */
export interface PushSubscriptionJson {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface PhoneDevice {
  id: string
  /** From the user agent at pairing time; the user can rename it. */
  name: string
  createdAt: number
  lastSeenAt: number
  /** SHA-256 of the device secret (hex). The secret itself is never stored. */
  secretHash: string
  push?: PushSubscriptionJson
  /** UI language when notifications were turned on; notifications use it. */
  locale?: PhoneLocale
}

export type PhoneLocale = 'en' | 'ja' | 'zh'

export function phoneLocale(value: unknown): PhoneLocale {
  return value === 'ja' || value === 'zh' ? value : 'en'
}

/** Something a phone should hear about. */
export interface PhoneEvent {
  kind: 'approval' | 'question' | 'completed' | 'error' | 'test'
  /** The chat's name. */
  label: string
  body: string
  runId?: string
}

const PHONE_TITLES: Record<PhoneLocale, Record<PhoneEvent['kind'], string>> = {
  en: { approval: 'Approval needed', question: 'Question', completed: 'Done', error: 'Failed', test: 'Test notification' },
  ja: { approval: '承認待ち', question: '質問', completed: '完了', error: 'エラー', test: 'テスト通知' },
  zh: { approval: '等待批准', question: '提问', completed: '完成', error: '失败', test: '测试通知' },
}

/** The notification a phone shows for `event`, in that phone's language. */
export function phoneMessage(event: PhoneEvent, locale: PhoneLocale = 'en'): { title: string; body: string; tag: string; url: string } {
  const titles = PHONE_TITLES[locale]
  const body = event.body.replace(/\s+/g, ' ').trim().slice(0, 160)
  return {
    title: event.label ? `${titles[event.kind]} · ${event.label}` : titles[event.kind],
    body,
    // One notification per chat and kind: a newer one replaces the older.
    tag: `${event.kind === 'completed' || event.kind === 'error' ? 'turn' : event.kind}-${event.runId ?? 'hy'}`,
    url: event.runId ? `/?run=${encodeURIComponent(event.runId)}` : '/',
  }
}

export interface PhoneDeviceView {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  push: boolean
}

interface PairingCode {
  code: string
  expiresAt: number
}

export const PAIRING_TTL_MS = 5 * 60_000
/** `lastSeenAt` is written at most this often, so every request does not touch the disk. */
const SEEN_WRITE_INTERVAL_MS = 60_000
export const DEVICE_COOKIE = 'hy_device'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

/** A short, readable device name from a user agent. */
export function deviceNameFromUserAgent(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : 'Device'
  const browser = /EdgA?\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''
  return browser ? `${os} · ${browser}` : os
}

export class PhoneDeviceStore {
  private devices: PhoneDevice[] = []
  private readonly pairings = new Map<string, PairingCode>()

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.devices = this.load()
  }

  private load(): PhoneDevice[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { devices?: unknown }
      if (!Array.isArray(raw.devices)) return []
      return raw.devices.filter(
        (d): d is PhoneDevice =>
          !!d && typeof d === 'object' && typeof (d as PhoneDevice).id === 'string' && typeof (d as PhoneDevice).secretHash === 'string',
      )
    } catch {
      return []
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, devices: this.devices }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  /** A new single-use code; earlier unclaimed codes stay valid until they expire. */
  startPairing(ttlMs = PAIRING_TTL_MS): PairingCode {
    this.prune()
    const code = randomBytes(16).toString('base64url')
    const pairing = { code, expiresAt: this.now() + ttlMs }
    this.pairings.set(code, pairing)
    return pairing
  }

  /** Whether `code` was claimed (it is gone) or expired; for the desktop's QR dialog. */
  pairingState(code: string): 'pending' | 'done' {
    this.prune()
    return this.pairings.has(code) ? 'pending' : 'done'
  }

  /** Consumes a pairing code; returns the new device and its secret (cookie value), once. */
  claim(code: string, userAgent: string | undefined): { device: PhoneDevice; cookie: string } | undefined {
    this.prune()
    const pairing = this.pairings.get(code)
    if (!pairing) return undefined
    this.pairings.delete(code)
    const secret = randomBytes(32).toString('base64url')
    const now = this.now()
    const device: PhoneDevice = { id: randomUUID(), name: deviceNameFromUserAgent(userAgent), createdAt: now, lastSeenAt: now, secretHash: sha256(secret) }
    this.devices.push(device)
    this.save()
    return { device, cookie: `${device.id}.${secret}` }
  }

  /** The device a `hy_device` cookie belongs to, or undefined (unknown, revoked, malformed). */
  verify(cookie: string | undefined): PhoneDevice | undefined {
    if (!cookie) return undefined
    const dot = cookie.indexOf('.')
    if (dot <= 0) return undefined
    const id = cookie.slice(0, dot)
    const secret = cookie.slice(dot + 1)
    const device = this.devices.find((d) => d.id === id)
    if (!device || !sameHex(device.secretHash, sha256(secret))) return undefined
    const now = this.now()
    if (now - device.lastSeenAt > SEEN_WRITE_INTERVAL_MS) {
      device.lastSeenAt = now
      this.save()
    }
    return device
  }

  list(): PhoneDeviceView[] {
    return this.devices.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, push: d.push !== undefined }))
  }

  revoke(id: string): boolean {
    const before = this.devices.length
    this.devices = this.devices.filter((d) => d.id !== id)
    if (this.devices.length === before) return false
    this.save()
    return true
  }

  rename(id: string, name: string): boolean {
    const device = this.devices.find((d) => d.id === id)
    const clean = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60)
    if (!device || !clean) return false
    device.name = clean
    this.save()
    return true
  }

  setPush(id: string, subscription: PushSubscriptionJson | undefined, locale?: PhoneLocale): boolean {
    const device = this.devices.find((d) => d.id === id)
    if (!device) return false
    if (subscription) device.push = subscription
    else delete device.push
    if (locale) device.locale = locale
    this.save()
    return true
  }

  /** Devices that asked for notifications. */
  pushTargets(): Array<{ id: string; subscription: PushSubscriptionJson; locale: PhoneLocale }> {
    return this.devices.flatMap((d) => (d.push ? [{ id: d.id, subscription: d.push, locale: d.locale ?? 'en' }] : []))
  }

  private prune(): void {
    const now = this.now()
    for (const [code, pairing] of this.pairings) if (pairing.expiresAt <= now) this.pairings.delete(code)
  }
}

/** Validates a body as a push subscription (https endpoint, base64url keys). */
export function parsePushSubscription(value: unknown): PushSubscriptionJson | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  if (typeof v.endpoint !== 'string' || !/^https:\/\//.test(v.endpoint) || v.endpoint.length > 2048) return undefined
  const b64 = /^[A-Za-z0-9_-]+={0,2}$/
  if (typeof v.keys?.p256dh !== 'string' || typeof v.keys.auth !== 'string') return undefined
  if (!b64.test(v.keys.p256dh) || !b64.test(v.keys.auth)) return undefined
  return { endpoint: v.endpoint, keys: { p256dh: v.keys.p256dh, auth: v.keys.auth } }
}
