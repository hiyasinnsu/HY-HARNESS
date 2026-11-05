// WP-12: a session can switch its sandbox mode; the switch is logged, applies
// to the next tool call, and read-only really blocks writes (shell and patch).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { startWebServer } = await import(pathToFileURL(path.join(repo, 'packages', 'hy-cli', 'dist', 'web-server.js')).href)
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')

// Confined modes need a volume with ACLs and no inherited package ACEs, so the
// fixture lives under the user profile rather than %TEMP%.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'hy-mode-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Sandbox mode fixture\n', 'utf8')
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  return dir
}

async function waitFor(fn, timeout = 60_000, interval = 150) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeout) {
    last = await fn()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`timed out; last=${JSON.stringify(last)}`)
}

async function runServer(dir) {
  const previous = { HY_CONFIG_DIR: process.env.HY_CONFIG_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA }
  const configDir = path.join(dir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  process.env.HY_CONFIG_DIR = configDir
  process.env.LOCALAPPDATA = path.join(dir, 'localappdata')
  const handle = await startWebServer({
    overrides: { cwd: dir, mock: true, autoApprove: true },
    port: 0,
    open: false,
    log: () => {},
  })
  const base = new URL(handle.localUrl).origin
  const auth = { Authorization: `Bearer ${handle.token}` }
  const request = async (route, init = {}) => {
    const response = await fetch(`${base}${route}`, {
      ...init,
      headers: { ...auth, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    return { status: response.status, text, json: parsed }
  }
  const close = async () => {
    await handle.close()
    if (previous.HY_CONFIG_DIR === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = previous.HY_CONFIG_DIR
    if (previous.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous.LOCALAPPDATA
  }
  return { request, close }
}

async function sessionState(ctx, runId) {
  const response = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}`)
  assert.equal(response.status, 200, response.text)
  return response.json.state
}

async function turn(ctx, runId, message) {
  const response = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
  assert.equal(response.status, 202, response.text)
  await waitFor(async () => {
    const state = await sessionState(ctx, runId)
    return state.busy ? undefined : true
  }, 90_000)
}

async function switchMode(ctx, runId, mode) {
  return ctx.request(`/api/sessions/${encodeURIComponent(runId)}/sandbox`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  })
}

test('sandbox mode: switch, read-only blocks writes, unconfined writes, restart replays', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 180_000, concurrency: false }, async () => {
  const dir = fixture()
  let ctx = await runServer(dir)
  let runId
  try {
    const created = await ctx.request('/api/sessions', { method: 'POST', body: '{}' })
    assert.equal(created.status, 201, created.text)
    runId = created.json.runId
    assert.equal((await sessionState(ctx, runId)).sandboxMode, 'unconfined')

    // Invalid and user-policy-only modes are refused.
    const invalid = await switchMode(ctx, runId, 'yolo')
    assert.equal(invalid.status, 400, invalid.text)
    const lowIntegrity = await switchMode(ctx, runId, 'low-integrity')
    assert.equal(lowIntegrity.status, 400, lowIntegrity.text)

    // Switching to a confined mode grants the workspace on this explicit action.
    const readOnly = await switchMode(ctx, runId, 'read-only')
    assert.equal(readOnly.status, 200, readOnly.text)
    assert.equal(readOnly.json.mode, 'read-only')
    assert.equal(readOnly.json.state.sandboxMode, 'read-only')

    // Shell writes are refused by the restricted token.
    await turn(ctx, runId, 'CALL shell {"command":"Set-Content -Path MODE.txt -Value hi"}')
    assert.equal(fs.existsSync(path.join(dir, 'MODE.txt')), false, 'read-only must not create a file through shell')

    // apply_patch is refused too (control plane, before the daemon).
    await turn(ctx, runId, 'CALL apply_patch {"file":"HY_DEMO.md","content":"x"}')
    assert.equal(fs.existsSync(path.join(dir, 'HY_DEMO.md')), false, 'read-only must not patch a file')

    // Back to unconfined: the same command now writes.
    const unconfined = await switchMode(ctx, runId, 'unconfined')
    assert.equal(unconfined.status, 200, unconfined.text)
    await turn(ctx, runId, 'CALL shell {"command":"Set-Content -Path MODE.txt -Value hi"}')
    assert.equal(fs.readFileSync(path.join(dir, 'MODE.txt'), 'utf8').trim(), 'hi')

    // The last switch is durable: a restart replays it from the session log.
    assert.equal((await switchMode(ctx, runId, 'read-only')).status, 200)
    await ctx.close()
    ctx = await runServer(dir)
    assert.equal((await sessionState(ctx, runId)).sandboxMode, 'read-only')

    // Leave the workspace unconfined and revoke the grant before deleting it.
    assert.equal((await switchMode(ctx, runId, 'unconfined')).status, 200)
  } finally {
    await ctx.close()
    spawnSync(process.execPath, [cli, 'sandbox', 'revoke', '--cwd', dir], {
      cwd: dir,
      env: { ...process.env, HY_CONFIG_DIR: path.join(dir, 'config'), LOCALAPPDATA: path.join(dir, 'localappdata') },
      encoding: 'utf8',
      timeout: 60_000,
    })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
