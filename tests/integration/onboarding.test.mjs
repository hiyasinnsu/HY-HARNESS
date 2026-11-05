// WP-53: the first-run wizard (workspace -> sandbox -> model) and the signed
// release feed over the HTTP API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { startWebServer } = await import(pathToFileURL(path.join(repo, 'packages', 'hy-cli', 'dist', 'web-server.js')).href)
const { signRelease } = await import(pathToFileURL(path.join(repo, 'packages', 'hy-cli', 'dist', 'update-feed.js')).href)

function isolated(dir) {
  const previous = {
    HY_CONFIG_DIR: process.env.HY_CONFIG_DIR,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    HY_UPDATE_PUBLIC_KEY: process.env.HY_UPDATE_PUBLIC_KEY,
  }
  process.env.HY_CONFIG_DIR = path.join(dir, 'config')
  fs.mkdirSync(process.env.HY_CONFIG_DIR, { recursive: true })
  process.env.LOCALAPPDATA = path.join(dir, 'localappdata')
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function api(handle) {
  return (pathname, init = {}) =>
    fetch(new URL(pathname, handle.url), {
      ...init,
      headers: { Authorization: `Bearer ${handle.token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
}

test('the first-run wizard saves the choices and the next start applies them', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-onboarding-it-'))
  const restore = isolated(dir)
  let handle = await startWebServer({ overrides: { cwd: dir, mock: true }, port: 0, open: false, log: () => {} })
  try {
    let call = api(handle)
    const boot = await (await call('/api/bootstrap')).json()
    assert.equal(boot.onboarding.complete, false)
    assert.equal(boot.onboarding.steps.length, 3)
    assert.match(boot.version, /^\d+\.\d+\.\d+/)
    const fresh = await (await call('/api/onboarding')).json()
    assert.equal(fresh.onboarding.complete, false)
    assert.equal(fresh.onboarding.sandbox, boot.config.sandbox)
    assert.equal(fresh.onboarding.model.model, 'mock')

    // A mode the wizard may not set is a 400, not a silent change.
    const refused = await call('/api/onboarding/complete', {
      method: 'POST',
      body: JSON.stringify({ sandbox: 'low-integrity', complete: true }),
    })
    assert.equal(refused.status, 400)
    assert.match((await refused.json()).error, /sandbox must be one of/)

    const done = await call('/api/onboarding/complete', {
      method: 'POST',
      body: JSON.stringify({
        sandbox: 'read-only',
        provider: 'openai-compatible',
        model: 'gpt-4.1-mini',
        baseUrl: 'https://gateway.example/v1',
        complete: true,
      }),
    })
    assert.equal(done.status, 200)
    const view = await done.json()
    assert.equal(view.onboarding.complete, true)
    assert.deepEqual(view.applied, ['sandbox=read-only', 'model=openai-compatible:gpt-4.1-mini'])
    assert.equal(view.onboarding.saved.model, 'gpt-4.1-mini')
    // Applied to the running server without a restart.
    const after = await (await call('/api/bootstrap')).json()
    assert.equal(after.config.sandbox, 'read-only')
    assert.deepEqual(
      { provider: after.config.worker.provider, model: after.config.worker.model, baseUrl: after.config.worker.baseUrl },
      { provider: 'openai-compatible', model: 'gpt-4.1-mini', baseUrl: 'https://gateway.example/v1' },
    )
    await handle.close()
    handle = null

    // A restart reads the saved choices back (no --mock: the wizard's provider
    // would be ignored with it, because --mock is an explicit choice).
    handle = await startWebServer({ overrides: { cwd: dir }, port: 0, open: false, log: () => {} })
    call = api(handle)
    const restarted = await (await call('/api/bootstrap')).json()
    assert.equal(restarted.onboarding.complete, true)
    assert.equal(restarted.config.sandbox, 'read-only')
    assert.equal(restarted.config.worker.provider, 'openai-compatible')
    assert.equal(restarted.config.worker.model, 'gpt-4.1-mini')
    await handle.close()
    handle = null

    // An explicit flag still wins over the saved wizard.
    handle = await startWebServer({ overrides: { cwd: dir, mock: true, sandbox: 'unconfined' }, port: 0, open: false, log: () => {} })
    call = api(handle)
    const flagged = await (await call('/api/bootstrap')).json()
    assert.equal(flagged.config.sandbox, 'unconfined')
    assert.equal(flagged.config.worker.model, 'mock')
  } finally {
    await handle?.close().catch(() => {})
    restore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the release feed is checked on demand and a bad signature is refused', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-update-it-'))
  const restore = isolated(dir)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  process.env.HY_UPDATE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const entry = {
    version: '0.5.0',
    // Port 1 refuses instantly, so the download path fails fast in the test.
    url: 'https://127.0.0.1:1/HY-HARNESS-0.5.0-portable.exe',
    sha256: createHash('sha256').update('installer').digest('hex'),
    notes: 'the update path',
  }
  const feedFile = path.join(dir, 'stable.json')
  fs.writeFileSync(feedFile, JSON.stringify({ schema: 1, releases: [{ ...entry, signature: signRelease(entry, privatePem) }] }), 'utf8')
  const tamperedFile = path.join(dir, 'tampered.json')
  fs.writeFileSync(
    tamperedFile,
    JSON.stringify({
      schema: 1,
      releases: [{ ...entry, sha256: createHash('sha256').update('other installer').digest('hex'), signature: signRelease(entry, privatePem) }],
    }),
    'utf8',
  )

  const handle = await startWebServer({ overrides: { cwd: dir, mock: true }, port: 0, open: false, log: () => {} })
  try {
    const call = api(handle)
    // Without a feed the API says so instead of failing.
    const unconfigured = await (await call('/api/update')).json()
    assert.equal(unconfigured.configured, false)
    assert.equal(unconfigured.reason, 'not-configured')

    const checked = await call(`/api/update?${new URLSearchParams({ feed: feedFile })}`)
    assert.equal(checked.status, 200)
    const body = await checked.json()
    assert.equal(body.configured, true)
    assert.equal(body.release.version, '0.5.0')
    assert.equal(body.release.notes, 'the update path')
    assert.equal(body.currentVersion, '0.4.0')

    // A tampered entry no longer matches the signature: refused, not installed.
    const refused = await call(`/api/update?${new URLSearchParams({ feed: tamperedFile })}`)
    assert.equal(refused.status, 502)
    assert.match((await refused.json()).error, /signature verification failed/)

    // The fetch route verifies first, then fails on the unreachable host.
    const tamperedFetch = await call('/api/update/fetch', { method: 'POST', body: JSON.stringify({ feed: tamperedFile }) })
    assert.equal(tamperedFetch.status, 502)
    assert.match((await tamperedFetch.json()).error, /signature verification failed/)
    const offline = await call('/api/update/fetch', { method: 'POST', body: JSON.stringify({ feed: feedFile }) })
    assert.equal(offline.status, 502)
    assert.match((await offline.json()).error, /could not download 0\.5\.0/)
    assert.equal(fs.existsSync(path.join(dir, 'localappdata', 'hy-harness', 'state')), true)
  } finally {
    await handle.close()
    restore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
