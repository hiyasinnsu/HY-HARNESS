// Phone access: the Tailscale listener, QR pairing, per-device secrets,
// owner-only management, Web Push and immediate revocation. The listener is
// bound to 127.0.0.1 here (phoneHostOverride) instead of a Tailscale address.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createECDH } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { startWebServer } = await import(pathToFileURL(path.join(repo, 'packages', 'hy-cli', 'dist', 'web-server.js')).href)

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-phone-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Phone fixture\n', 'utf8')
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  return dir
}

test('phone access: pair by QR, owner-only management, push, and immediate revoke', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000 }, async () => {
  const dir = fixture()
  const previous = { HY_CONFIG_DIR: process.env.HY_CONFIG_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.HY_CONFIG_DIR = path.join(dir, 'config')
  process.env.LOCALAPPDATA = path.join(dir, 'localappdata')
  const pushed = []
  const pushFetch = async (endpoint, init) => {
    pushed.push({ endpoint, headers: init.headers, bytes: init.body.length })
    return new Response(null, { status: 201 })
  }
  const handle = await startWebServer({ overrides: { cwd: dir, mock: true }, port: 0, open: false, log: () => {}, phoneHostOverride: '127.0.0.1', pushFetch })
  const owner = { Authorization: `Bearer ${handle.token}` }
  const local = new URL(handle.url).origin
  const call = async (base, route, init = {}, headers = owner) => {
    const response = await fetch(`${base}${route}`, { redirect: 'manual', ...init, headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } })
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, json, text, headers: response.headers }
  }
  try {
    assert.equal((await call(local, '/api/phone')).json.enabled, false)
    assert.equal((await call(local, '/api/phone/pairing', { method: 'POST' })).status, 409, 'pairing needs phone access on')

    const enabled = await call(local, '/api/phone/enable', { method: 'POST' })
    assert.equal(enabled.json.enabled, true)
    const phoneBase = enabled.json.url.replace(/\/$/, '')
    assert.match(phoneBase, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config', 'config.json'), 'utf8')).phone.enabled, true, 'remembered for the next start')

    // Without pairing, the phone listener refuses the API.
    assert.equal((await call(phoneBase, '/api/bootstrap', {}, {})).status, 401)

    const pairing = await call(local, '/api/phone/pairing', { method: 'POST' })
    assert.equal(pairing.status, 200, pairing.text)
    assert.match(pairing.json.qrSvg, /^<svg/)
    assert.equal(pairing.json.url, `${phoneBase}/pair?code=${encodeURIComponent(pairing.json.code)}`)

    const claimed = await call(phoneBase, `/pair?code=${encodeURIComponent(pairing.json.code)}`, {}, { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' })
    assert.equal(claimed.status, 302)
    const cookie = claimed.headers.get('set-cookie')
    assert.match(cookie, /^hy_device=[^;]+; HttpOnly; SameSite=Strict/)
    const device = { Cookie: cookie.split(';')[0] }
    assert.equal((await call(phoneBase, `/pair?code=${encodeURIComponent(pairing.json.code)}`, {}, {})).status, 403, 'single use')
    assert.equal((await call(local, `/api/phone/pairing?code=${encodeURIComponent(pairing.json.code)}`)).json.state, 'done')

    // The paired phone uses the app but cannot manage phone access.
    assert.equal((await call(phoneBase, '/api/bootstrap', {}, device)).status, 200)
    const asDevice = await call(phoneBase, '/api/phone', {}, device)
    assert.equal(asDevice.json.client.kind, 'device')
    assert.equal(asDevice.json.client.name, 'iPhone · Safari')
    assert.deepEqual(asDevice.json.devices, [], 'a phone does not see the device list')
    assert.equal((await call(phoneBase, '/api/phone/pairing', { method: 'POST' }, device)).status, 403)
    assert.equal((await call(phoneBase, `/api/phone/devices/${asDevice.json.client.id}`, { method: 'DELETE' }, device)).status, 403)

    // Notifications: subscribe, then a test push goes to the push service encrypted.
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const key = await call(phoneBase, '/api/push/key', {}, device)
    assert.match(key.json.publicKey, /^B[A-Za-z0-9_-]{86}$/)
    const subscription = { endpoint: 'https://push.example/sub/1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } }
    assert.equal((await call(phoneBase, '/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription, locale: 'ja' }) }, device)).status, 200)
    assert.equal((await call(phoneBase, '/api/push/test', { method: 'POST' }, device)).status, 200)
    assert.equal(pushed.length, 1)
    assert.equal(pushed[0].endpoint, 'https://push.example/sub/1')
    assert.equal(pushed[0].headers['Content-Encoding'], 'aes128gcm')
    const listed = await call(local, '/api/phone')
    assert.deepEqual(listed.json.devices.map((d) => [d.name, d.push]), [['iPhone · Safari', true]])

    // Revoking cuts an open stream and every later request.
    const stream = await fetch(`${phoneBase}/api/events`, { headers: device })
    assert.equal(stream.status, 200)
    const reader = stream.body.getReader()
    await reader.read()
    const revoked = await call(local, `/api/phone/devices/${listed.json.devices[0].id}`, { method: 'DELETE' })
    assert.equal(revoked.status, 200)
    const ended = await Promise.race([
      (async () => {
        for (;;) {
          const { done } = await reader.read()
          if (done) return true
        }
      })(),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ])
    assert.equal(ended, true, 'the open stream of a revoked phone is closed')
    assert.equal((await call(phoneBase, '/api/bootstrap', {}, device)).status, 401)

    const disabled = await call(local, '/api/phone/disable', { method: 'POST' })
    assert.equal(disabled.json.enabled, false)
    await assert.rejects(fetch(`${phoneBase}/api/bootstrap`), 'the phone listener is closed')
  } finally {
    await handle.close()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
