// The model registry over the HTTP API (the GUI's model list) and the roles the
// running server actually uses. Models are user-registered data.
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
  // The harness ships no per-model facts: the list is exactly what the user registered.
  fs.writeFileSync(
    path.join(process.env.HY_CONFIG_DIR, 'config.json'),
    JSON.stringify({
      models: [
        { id: 'mock', name: 'Mock', provider: 'mock', model: 'mock', contextWindowTokens: 32_768, maxOutputTokens: 4_096, capabilities: { tools: true } },
        { id: 'gateway', name: 'Gateway', provider: 'openai-compatible', model: 'my-model', pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 }, compat: { tokenField: 'max_tokens' } },
      ],
    }),
  )
  process.env.LOCALAPPDATA = path.join(dir, 'localappdata')
  const handle = await startWebServer({ overrides: { cwd: dir, mock: true }, port: 0, open: false, log: () => {} })
  try {
    const response = await fetch(new URL('/api/models', handle.url), { headers: { Authorization: `Bearer ${handle.token}` } })
    assert.equal(response.status, 200)
    const body = await response.json()
    const ids = new Set(body.models.map((entry) => entry.id))
    assert.equal(ids.size, body.models.length)
    assert.deepEqual([...ids].sort(), ['mock:mock', 'openai-compatible:my-model'])
    for (const entry of body.models) assert.equal(entry.id, `${entry.provider}:${entry.model}`)
    // The mock server's worker role is the mock model.
    assert.deepEqual(body.roles.worker, { provider: 'mock', model: 'mock' })
  } finally {
    await handle.close()
    if (previous.HY_CONFIG_DIR === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = previous.HY_CONFIG_DIR
    if (previous.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous.LOCALAPPDATA
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
