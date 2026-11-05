// WP-41: the model catalog over the HTTP API (the GUI's model list) and the
// roles the running server actually uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { startWebServer } = await import(pathToFileURL(path.join(repo, 'packages', 'hy-cli', 'dist', 'web-server.js')).href)

test('the API lists the model catalog with the roles in use', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 60_000, concurrency: false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-models-it-'))
  const previous = { HY_CONFIG_DIR: process.env.HY_CONFIG_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.HY_CONFIG_DIR = path.join(dir, 'config')
  fs.mkdirSync(process.env.HY_CONFIG_DIR, { recursive: true })
  process.env.LOCALAPPDATA = path.join(dir, 'localappdata')
  const handle = await startWebServer({ overrides: { cwd: dir, mock: true }, port: 0, open: false, log: () => {} })
  try {
    const response = await fetch(new URL('/api/models', handle.url), { headers: { Authorization: `Bearer ${handle.token}` } })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(body.models.length >= 5)
    const ids = new Set(body.models.map((entry) => entry.id))
    assert.equal(ids.size, body.models.length)
    for (const entry of body.models) {
      assert.equal(entry.id, `${entry.provider}:${entry.model}`)
      assert.ok(entry.contextWindowTokens > 0 && entry.maxOutputTokens > 0)
      assert.equal(typeof entry.capabilities.tools, 'boolean')
    }
    // The mock server's worker role is the mock model.
    assert.deepEqual(body.roles.worker, { provider: 'mock', model: 'mock' })
    assert.ok(ids.has('mock:mock'))
  } finally {
    await handle.close()
    if (previous.HY_CONFIG_DIR === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = previous.HY_CONFIG_DIR
    if (previous.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous.LOCALAPPDATA
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
