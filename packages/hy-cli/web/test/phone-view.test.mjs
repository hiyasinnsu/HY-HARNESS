import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pushSupport, renderPhoneSection } from '../dist/phone-view.js'

// Runs against the web build (`npx tsc -p packages/hy-cli/tsconfig.web.json`).

const NOW = 1_800_000_000_000
const ok = { secure: true, supported: true, needsHomeScreen: false, permission: 'default' }
const owner = (extra = {}) => ({ enabled: true, url: 'https://pc.tail1.ts.net:3443/', https: true, devices: [], client: { kind: 'owner' }, ...extra })

test('the owner turns access on, sees the address, pairs by QR and can revoke', () => {
  const off = renderPhoneSection({ enabled: false, https: false, devices: [], client: { kind: 'owner' } }, undefined, ok, 'en', NOW)
  assert.match(off, /data-action="phone-enable"/)
  assert.doesNotMatch(off, /phone-pair"/)

  const on = renderPhoneSection(owner({ devices: [{ id: 'd1', name: 'iPhone · Safari', createdAt: NOW - 1e6, lastSeenAt: NOW - 120_000, push: true }] }), undefined, ok, 'en', NOW)
  assert.match(on, /https:\/\/pc\.tail1\.ts\.net:3443\//)
  assert.match(on, /data-action="phone-pair"/)
  assert.match(on, /iPhone · Safari/)
  assert.match(on, /last seen 2 min ago · Notifications on/)
  assert.match(on, /data-action="phone-revoke" data-device-id="d1"/)

  const pairing = renderPhoneSection(owner(), { code: 'c', url: 'https://pc/pair?code=c', expiresAt: NOW + 4.5 * 60_000, qrSvg: '<svg id="qr"></svg>' }, ok, 'ja', NOW)
  assert.match(pairing, /<svg id="qr"><\/svg>/)
  assert.match(pairing, /あと 5 分で無効になります/)
  assert.doesNotMatch(pairing, /data-action="phone-pair"/, 'one QR at a time')
})

test('http-only access and errors are explained, and names are escaped', () => {
  const http = renderPhoneSection(owner({ url: 'http://100.1.2.3:3443/', https: false, warning: 'cert <failed>' }), undefined, ok, 'en', NOW)
  assert.match(http, /notifications need HTTPS/)
  assert.match(http, /cert &lt;failed&gt;/)
  const error = renderPhoneSection({ enabled: false, https: false, error: 'Tailscale is not connected', devices: [], client: { kind: 'owner' } }, undefined, ok, 'en', NOW)
  assert.match(error, /Tailscale is not connected/)
  const named = renderPhoneSection(owner({ devices: [{ id: 'x', name: '<b>me</b>', createdAt: NOW, lastSeenAt: NOW, push: false }] }), undefined, ok, 'en', NOW)
  assert.match(named, /&lt;b&gt;me&lt;\/b&gt;/)
})

test('a paired phone sees only its own notification switch, with the reason when it is unavailable', () => {
  const device = (push) => ({ enabled: true, https: true, devices: [], client: { kind: 'device', id: 'd1', name: 'iPhone · Safari', push } })
  assert.match(renderPhoneSection(device(false), undefined, ok, 'en', NOW), /data-action="push-enable"/)
  const on = renderPhoneSection(device(true), undefined, ok, 'en', NOW)
  assert.match(on, /data-action="push-test"/)
  assert.doesNotMatch(on, /phone-revoke|phone-enable/, 'a phone cannot manage access')
  assert.match(renderPhoneSection(device(false), undefined, { ...ok, secure: false, supported: false }, 'en', NOW), /need HTTPS/)
  assert.match(renderPhoneSection(device(false), undefined, { ...ok, needsHomeScreen: true }, 'ja', NOW), /ホーム画面に追加/)
  assert.match(renderPhoneSection(device(false), undefined, { ...ok, permission: 'denied' }, 'en', NOW), /blocked/)
})

test('push support follows the page: HTTPS, APIs, and the iPhone home-screen rule', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
  assert.deepEqual(pushSupport({ isSecureContext: true, hasServiceWorker: true, hasPushManager: true, userAgent: iphone, standalone: false, permission: 'default' }), {
    secure: true,
    supported: true,
    needsHomeScreen: true,
    permission: 'default',
  })
  assert.equal(pushSupport({ isSecureContext: true, hasServiceWorker: true, hasPushManager: true, userAgent: iphone, standalone: true }).needsHomeScreen, false)
  assert.equal(pushSupport({ isSecureContext: false, hasServiceWorker: true, hasPushManager: true, userAgent: 'Android', standalone: false }).supported, false)
})
