// WP-10: the Web GUI behind TLS, the Host/Origin fence, and the advertised
// public URL behind a prefix-stripping proxy (DSH `connection`/`web-app` parity).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { startWebServer } = await import(pathToFileURL(path.join(repo, 'packages', 'hy-cli', 'dist', 'web-server.js')).href)

const tlsDir = path.join(repo, 'tests', 'fixtures', 'tls')
const CERT = path.join(tlsDir, 'cert.pem')
const KEY = path.join(tlsDir, 'key.pem')

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-deploy-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Deploy fixture\n', 'utf8')
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  return dir
}

/** A request helper that can override Host/Origin (fetch forbids both). */
function rawRequest(base, route, { method = 'GET', headers = {}, body, token } = {}) {
  const url = new URL(route, base)
  const lib = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8')
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': payload.length }),
          ...headers,
        },
        ...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

async function runServer(dir, options = {}) {
  const previous = { HY_CONFIG_DIR: process.env.HY_CONFIG_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA }
  const configDir = path.join(dir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  process.env.HY_CONFIG_DIR = configDir
  process.env.LOCALAPPDATA = path.join(dir, 'localappdata')
  const handle = await startWebServer({
    overrides: { cwd: dir, mock: true, ...(options.overrides ?? {}) },
    port: 0,
    open: false,
    log: () => {},
    ...options.server,
  })
  const close = async () => {
    await handle.close()
    if (previous.HY_CONFIG_DIR === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = previous.HY_CONFIG_DIR
    if (previous.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous.LOCALAPPDATA
  }
  return { handle, base: new URL(handle.localUrl).origin, token: handle.token, close }
}

test('web deploy: TLS serves HTTPS and the fence rejects unknown hosts and origins', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir, { server: { tlsCert: CERT, tlsKey: KEY, trustedHosts: ['app.example'] } })
  try {
    assert.match(ctx.handle.url, /^https:\/\//)
    const health = await rawRequest(ctx.base, '/api/health', { token: ctx.token })
    assert.equal(health.status, 200, health.text)
    assert.equal(JSON.parse(health.text).ok, true)

    // A leaked launch URL replayed under another authority is refused.
    const evilHost = await rawRequest(ctx.base, '/api/health', { token: ctx.token, headers: { host: 'evil.example' } })
    assert.equal(evilHost.status, 403, evilHost.text)
    assert.match(evilHost.text, /host not accepted/)
    const trustedHost = await rawRequest(ctx.base, '/api/health', { token: ctx.token, headers: { host: 'app.example' } })
    assert.equal(trustedHost.status, 200, trustedHost.text)

    const evilOrigin = await rawRequest(ctx.base, '/api/health', { token: ctx.token, headers: { origin: 'https://evil.example' } })
    assert.equal(evilOrigin.status, 403, evilOrigin.text)
    assert.match(evilOrigin.text, /origin not accepted/)
    const sameOrigin = await rawRequest(ctx.base, '/api/health', { token: ctx.token, headers: { origin: ctx.base } })
    assert.equal(sameOrigin.status, 200, sameOrigin.text)

    // The launch-token exchange mints a Secure cookie when the listener is TLS.
    const launch = await rawRequest(ctx.base, `/?token=${encodeURIComponent(ctx.token)}`)
    assert.equal(launch.status, 302, launch.text)
    assert.match(String(launch.headers['set-cookie']), /HttpOnly/)
    assert.match(String(launch.headers['set-cookie']), /Secure/)

    const boot = JSON.parse((await rawRequest(ctx.base, '/api/bootstrap', { token: ctx.token })).text)
    assert.equal(boot.web.tls, true)
    assert.deepEqual(boot.web.trustedHosts, ['app.example'])
    assert.equal(boot.web.publicUrl, null)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web deploy: the public URL is advertised and validated', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 60_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir, {
    server: { tlsCert: CERT, tlsKey: KEY, trustedHosts: ['app.example'], publicUrl: 'https://app.example/ui' },
  })
  try {
    assert.equal(ctx.handle.url, `https://app.example/ui/?token=${encodeURIComponent(ctx.token)}`)
    const boot = JSON.parse((await rawRequest(ctx.base, '/api/bootstrap', { token: ctx.token })).text)
    assert.equal(boot.web.publicUrl, 'https://app.example/ui/')
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }

  await assert.rejects(
    startWebServer({ overrides: { cwd: dir, mock: true }, port: 0, open: false, publicUrl: 'ftp://app.example/' }),
    /must start with http/,
  )
  await assert.rejects(
    startWebServer({ overrides: { cwd: dir, mock: true }, port: 0, open: false, publicUrl: 'https://app.example/?a=1' }),
    /query or fragment/,
  )
})

test('web deploy: TLS material must be a valid pair and fails before the daemon starts', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 60_000, concurrency: false }, async () => {
  const dir = fixture()
  try {
    await assert.rejects(
      startWebServer({ overrides: { cwd: dir, mock: true }, port: 0, open: false, tlsCert: CERT }),
      /must be given together/,
    )
    await assert.rejects(
      startWebServer({
        overrides: { cwd: dir, mock: true },
        port: 0,
        open: false,
        tlsCert: path.join(dir, 'missing.pem'),
        tlsKey: KEY,
      }),
      /cannot read TLS material/,
    )
    fs.writeFileSync(path.join(dir, 'empty.pem'), '', 'utf8')
    await assert.rejects(
      startWebServer({
        overrides: { cwd: dir, mock: true },
        port: 0,
        open: false,
        tlsCert: path.join(dir, 'empty.pem'),
        tlsKey: KEY,
      }),
      /empty/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web deploy: plain HTTP keeps working and still fences unknown hosts', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 60_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    assert.match(ctx.handle.url, /^http:\/\//)
    const health = await rawRequest(ctx.base, '/api/health', { token: ctx.token })
    assert.equal(health.status, 200, health.text)
    const evil = await rawRequest(ctx.base, '/api/health', { token: ctx.token, headers: { host: 'evil.example' } })
    assert.equal(evil.status, 403, evil.text)
    const boot = JSON.parse((await rawRequest(ctx.base, '/api/bootstrap', { token: ctx.token })).text)
    assert.equal(boot.web.tls, false)
    assert.deepEqual(boot.web.trustedHosts, [])
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
