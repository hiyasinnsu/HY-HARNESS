// WP-32: the FTS5 session index. Japanese text must hit, the API and the CLI
// must agree with the index, and `session_query` must not return the caller's
// own run.
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

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-search-it-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Search fixture\n\nA repository for the search test.\n', 'utf8')
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  return dir
}

async function waitFor(fn, timeout = 45_000, interval = 100) {
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
    overrides: { cwd: dir, mock: true, autoApprove: true, sessionQuery: true },
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

async function turn(ctx, runId, message) {
  const started = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
  assert.equal(started.status, 202, started.text)
  return waitFor(async () => {
    const snap = (await ctx.request(`/api/sessions/${encodeURIComponent(runId)}`)).json
    return snap?.state?.busy === false ? snap : undefined
  }, 60_000)
}

async function newSession(ctx) {
  const created = await ctx.request('/api/sessions', { method: 'POST', body: '{}' })
  assert.equal(created.status, 201, created.text)
  return created.json.runId
}

/** Runs the CLI with the same state dir the server is using. */
function cliRun(args, dir) {
  return spawnSync(process.execPath, [cli, ...args, '--cwd', dir], {
    encoding: 'utf8',
    env: { ...process.env, HY_CONFIG_DIR: path.join(dir, 'config'), LOCALAPPDATA: path.join(dir, 'localappdata') },
    timeout: 60_000,
  })
}

test('the session index finds Japanese text from the API, the CLI and the model', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 180_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  const phrase = 'データベース接続の再試行を追加した'
  try {
    const first = await newSession(ctx)
    // The mock echoes a SAY line into the assistant message.
    await turn(ctx, first, `SAY ${phrase} (fixture note)`)
    const second = await newSession(ctx)
    const snap = await turn(ctx, second, 'CALL session_query {"query":"データベース接続"}')
    const card = snap.entries.filter((entry) => entry.kind === 'tool').at(-1)
    assert.equal(card?.name, 'session_query', JSON.stringify(snap.entries.map((e) => [e.kind, e.name])))
    assert.match(card.output, new RegExp(first))
    // The caller's own run is excluded.
    assert.doesNotMatch(card.output, new RegExp(`"runId": "${second}"`))

    const api = await ctx.request(`/api/search?q=${encodeURIComponent('データベース接続')}`)
    assert.equal(api.status, 200, api.text)
    assert.ok(api.json.hits.length > 0, api.text)
    assert.ok(api.json.hits.some((hit) => hit.runId === first))
    assert.ok(api.json.status.events > 0)
    const latin = await ctx.request('/api/search?q=fixture%20note')
    assert.ok(latin.json.hits.length > 0, 'English text is searchable too')
  } finally {
    await ctx.close()
  }

  // The CLI works on the same index (and can rebuild it).
  try {
    const status = cliRun(['index', 'status'], dir)
    assert.equal(status.status, 0, status.stderr || status.stdout)
    assert.match(status.stdout, /events [1-9]\d*/)
    const sessions = cliRun(['sessions', '--search', 'データベース接続'], dir)
    assert.equal(sessions.status, 0, sessions.stderr)
    assert.match(sessions.stdout, /run-/, sessions.stdout)
    const rebuild = cliRun(['index', 'rebuild'], dir)
    assert.equal(rebuild.status, 0, rebuild.stderr)
    assert.match(rebuild.stdout, /rebuilt/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
