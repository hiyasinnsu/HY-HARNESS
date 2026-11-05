// WP-31: the persistent shell keeps cd, environment variables and functions
// between tool calls, and a timed-out command discards the shell instead of
// leaving it in an unknown state.
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

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-shell-it-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Shell fixture\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  return dir
}

async function waitFor(fn, timeout = 60_000, interval = 100) {
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
    overrides: { cwd: dir, mock: true, autoApprove: true, persistentShell: true },
    port: 0,
    open: false,
    log: () => {},
  })
  const base = new URL(handle.url).origin
  const auth = { Authorization: `Bearer ${handle.token}` }
  const request = async (route, init = {}) => {
    const hasBody = init.body !== undefined
    const response = await fetch(`${base}${route}`, {
      ...init,
      headers: {
        ...auth,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
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

async function newSession(ctx) {
  const created = await ctx.request('/api/sessions', { method: 'POST', body: '{}' })
  assert.equal(created.status, 201, created.text)
  return created.json.runId
}

/** One mock turn that calls `shell`; returns the tool card. */
async function shell(ctx, runId, command, extra = {}) {
  const message = `CALL shell ${JSON.stringify({ command, persistent: true, ...extra })}`
  const started = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
  assert.equal(started.status, 202, started.text)
  const snap = await waitFor(async () => {
    const current = (await ctx.request(`/api/sessions/${encodeURIComponent(runId)}`)).json
    return current?.state?.busy === false ? current : undefined
  }, 90_000)
  return snap.entries.filter((entry) => entry.kind === 'tool' && entry.name === 'shell').at(-1)
}

test('the persistent shell keeps cd and environment variables between calls', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 180_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const runId = await newSession(ctx)
    const first = await shell(ctx, runId, 'Set-Location docs; $env:HY_SHELL_TEST = "kept"')
    assert.notEqual(first.isError, true, first.output)
    assert.match(first.output, /"shell": "persistent"/)
    assert.match(first.output, /"status": "completed"/)

    const second = await shell(ctx, runId, 'Write-Output ("cwd=" + (Get-Location).Path); Write-Output ("env=" + $env:HY_SHELL_TEST)')
    assert.notEqual(second.isError, true, second.output)
    assert.match(second.output, /cwd=.*docs/i, second.output)
    assert.match(second.output, /env=kept/)

    // A command that hangs is discarded; the next call starts a fresh shell.
    const timedOut = await shell(ctx, runId, 'Start-Sleep -Seconds 30', { hardTimeoutMs: 1_500 })
    assert.notEqual(timedOut.isError, true, timedOut.output)
    assert.match(timedOut.output, /"timedOut": true/)
    const recovered = await shell(ctx, runId, 'Write-Output ("again=" + (Get-Location).Path)')
    assert.notEqual(recovered.isError, true, recovered.output)
    assert.match(recovered.output, /again=/, recovered.output)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
