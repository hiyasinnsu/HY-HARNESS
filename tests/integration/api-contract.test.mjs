// WP-43: the API contract at runtime. A body of the wrong type is a typed 400
// (not a 500), the contract covers the routes the GUI uses, and the generated
// client types describe them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { startWebServer } = await import(pathToFileURL(path.join(repo, 'packages', 'hy-cli', 'dist', 'web-server.js')).href)
const contract = await import(pathToFileURL(path.join(repo, 'packages', 'hy-cli', 'dist', 'api-contract.js')).href)

test('a wrong body type is a 400 with the field name', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 60_000, concurrency: false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-contract-it-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Contract fixture\n', 'utf8')
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init']]) {
    spawnSync('git', args, { cwd: dir })
  }
  const previous = { HY_CONFIG_DIR: process.env.HY_CONFIG_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.HY_CONFIG_DIR = path.join(dir, 'config')
  fs.mkdirSync(process.env.HY_CONFIG_DIR, { recursive: true })
  process.env.LOCALAPPDATA = path.join(dir, 'localappdata')
  const handle = await startWebServer({ overrides: { cwd: dir, mock: true, autoApprove: true }, port: 0, open: false, log: () => {} })
  const auth = { Authorization: `Bearer ${handle.token}`, 'Content-Type': 'application/json' }
  const request = async (route, init = {}) => {
    const response = await fetch(new URL(route, handle.url), { ...init, headers: { ...auth, ...(init.headers ?? {}) } })
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, text, json }
  }
  try {
    const created = await request('/api/sessions', { method: 'POST', body: '{}' })
    assert.equal(created.status, 201, created.text)
    const runId = created.json.runId

    // A number where a string belongs: the contract answers before the route.
    const bad = await request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: 42 }),
    })
    assert.equal(bad.status, 400, bad.text)
    assert.match(bad.json.error, /invalid request: message must be a string/)

    // A missing field keeps the route's own message (backward compatible).
    const missing = await request(`/api/sessions/${encodeURIComponent(runId)}/turn`, { method: 'POST', body: '{}' })
    assert.equal(missing.status, 400, missing.text)
    assert.equal(missing.json.error, 'message is required')

    // A wrong type on another declared route.
    const settings = await request('/api/settings', { method: 'PUT', body: JSON.stringify({ roles: [] }) })
    assert.equal(settings.status, 400, settings.text)
    assert.match(settings.json.error, /roles must be an object/)

    // The valid shape still works.
    const ok = await request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: 'SAY contract ok' }),
    })
    assert.equal(ok.status, 202, ok.text)
  } finally {
    await handle.close()
    if (previous.HY_CONFIG_DIR === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = previous.HY_CONFIG_DIR
    if (previous.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous.LOCALAPPDATA
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the generated client types match the contract and the GUI uses them', { timeout: 60_000, concurrency: false }, () => {
  const generated = fs.readFileSync(path.join(repo, 'packages', 'hy-cli', 'web', 'src', 'api.gen.ts'), 'utf8')
  // Every contract route appears in the generated file (path is unique enough).
  for (const route of contract.API_ROUTES) {
    assert.ok(generated.includes(`path: ${JSON.stringify(route.path)}`), `missing ${route.method} ${route.path}`)
  }
  assert.ok(generated.includes('export function apiPath('))
  const client = fs.readFileSync(path.join(repo, 'packages', 'hy-cli', 'web', 'src', 'api.ts'), 'utf8')
  assert.match(client, /from '\.\/api\.gen\.js'/, 'the client imports the generated route helpers')
})
