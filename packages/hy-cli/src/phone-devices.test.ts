import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PAIRING_TTL_MS, PhoneDeviceStore, deviceNameFromUserAgent, parsePushSubscription } from './phone-devices.js'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

function store(now: { t: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-devices-'))
  return { dir, file: path.join(dir, 'devices.json'), make: () => new PhoneDeviceStore(path.join(dir, 'devices.json'), () => now.t) }
}

test('a pairing code is single use and turns into a long-lived device cookie', () => {
  const now = { t: 1_000_000 }
  const s = store(now)
  try {
    const devices = s.make()
    const pairing = devices.startPairing()
    assert.equal(devices.pairingState(pairing.code), 'pending')
    const claimed = devices.claim(pairing.code, IPHONE)
    assert.ok(claimed)
    assert.equal(claimed.device.name, 'iPhone · Safari')
    assert.equal(devices.pairingState(pairing.code), 'done')
    assert.equal(devices.claim(pairing.code, IPHONE), undefined, 'a code cannot be claimed twice')
    // The secret survives a restart (unlike the launch token) and only its hash is stored.
    const reopened = s.make()
    assert.equal(reopened.verify(claimed.cookie)?.id, claimed.device.id)
    const secret = claimed.cookie.split('.')[1]!
    assert.equal(fs.readFileSync(s.file, 'utf8').includes(secret), false)
    assert.equal(reopened.verify(`${claimed.device.id}.wrong`), undefined)
    assert.equal(reopened.verify('garbage'), undefined)
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true })
  }
})

test('an expired code cannot be claimed', () => {
  const now = { t: 0 }
  const s = store(now)
  try {
    const devices = s.make()
    const pairing = devices.startPairing()
    now.t += PAIRING_TTL_MS + 1
    assert.equal(devices.claim(pairing.code, IPHONE), undefined)
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true })
  }
})

test('revoking a device invalidates its cookie at once and drops its push subscription', () => {
  const now = { t: 0 }
  const s = store(now)
  try {
    const devices = s.make()
    const a = devices.claim(devices.startPairing().code, IPHONE)!
    const b = devices.claim(devices.startPairing().code, 'Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile')!
    assert.equal(b.device.name, 'Android · Chrome')
    devices.setPush(a.device.id, { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'BA', auth: 'AA' } })
    assert.deepEqual(devices.list().map((d) => [d.name, d.push]), [['iPhone · Safari', true], ['Android · Chrome', false]])
    assert.equal(devices.revoke(a.device.id), true)
    assert.equal(devices.verify(a.cookie), undefined)
    assert.deepEqual(devices.pushTargets(), [])
    assert.equal(devices.verify(b.cookie)?.id, b.device.id)
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true })
  }
})

test('names and push subscriptions are validated', () => {
  assert.equal(deviceNameFromUserAgent(undefined), 'Device')
  assert.equal(parsePushSubscription({ endpoint: 'http://insecure', keys: { p256dh: 'a', auth: 'b' } }), undefined)
  assert.equal(parsePushSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a b', auth: 'b' } }), undefined)
  assert.deepEqual(parsePushSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'BAbc', auth: 'xyz' }, extra: 1 }), {
    endpoint: 'https://fcm.googleapis.com/x',
    keys: { p256dh: 'BAbc', auth: 'xyz' },
  })
})
