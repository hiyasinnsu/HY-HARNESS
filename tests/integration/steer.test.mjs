// WP-21 (steering inbox) over the real HTTP API: a message sent while a turn
// runs joins that turn at its next step boundary instead of starting a new one,
// is recorded in the session log, and shows up in the transcript as a steering
// entry. An idle session has nothing to steer, so the endpoint says so.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-steer-it-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Steering fixture\n\nA repository for the steering test.\n', 'utf8')
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
    overrides: { cwd: dir, mock: true, autoApprove: true },
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
  return { handle, request, close }
}

/** Every session log written under the fixture (the state dir lives inside it). */
function logText(dir) {
  const found = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl')) found.push(fs.readFileSync(full, 'utf8'))
    }
  }
  walk(dir)
  return found.join('\n')
}

const snapshot = (ctx, runId) => ctx.request(`/api/sessions/${encodeURIComponent(runId)}`)
const steer = (ctx, runId, message) =>
  ctx.request(`/api/sessions/${encodeURIComponent(runId)}/steer`, { method: 'POST', body: JSON.stringify({ message }) })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a steering message joins the running turn and reaches the model', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const created = await ctx.request('/api/sessions', { method: 'POST', body: '{}' })
    assert.equal(created.status, 201, created.text)
    const runId = created.json.runId

    // A turn with a slow tool call: the window the steer has to land in.
    const started = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: 'CALL shell {"command":"Start-Sleep -Seconds 4"}' }),
    })
    assert.equal(started.status, 202, started.text)

    // Wait for the tool card, not merely for `busy`: the first step has then
    // asked the model, so the steer really lands mid-turn (step 2), which is the
    // behaviour under test.
    await waitFor(async () => {
      const snap = (await snapshot(ctx, runId)).json
      return snap?.entries?.some((e) => e.kind === 'tool' && e.name === 'shell')
    }, 30_000)
    const during = await steer(ctx, runId, 'also check the tests')
    assert.equal(during.status, 202, during.text)
    assert.equal(during.json.accepted, true)
    assert.ok(during.json.entryId, 'the API returns the transcript id it created')

    // The turn ends with the mock echoing the steer, which proves the message
    // was in the request the model saw after its tool call.
    const done = await waitFor(async () => {
      const state = (await snapshot(ctx, runId)).json
      return state?.state?.busy === false ? state : undefined
    }, 60_000)
    const finals = done.entries.filter((e) => e.kind === 'assistant')
    assert.equal(
      finals.some((e) => e.text === 'steer: also check the tests'),
      true,
      `the model answered the steer; entries=${JSON.stringify(done.entries.map((e) => [e.kind, e.text]))}`,
    )

    // The transcript keeps the user's text verbatim and marks it as a steer.
    const entry = done.entries.find((e) => e.kind === 'user' && e.steering === true)
    assert.ok(entry, 'the steering entry is in the transcript')
    assert.equal(entry.text, 'also check the tests')

    const log = logText(dir)
    // The log records the steer at the step the model saw it, so a resume
    // replays exactly the history the live turn had.
    const steerEvents = log
      .split('\n')
      .filter((line) => line.includes('"type":"user/steer"'))
      .map((line) => JSON.parse(line))
    assert.equal(steerEvents.length, 1, 'exactly one steer event is logged')
    assert.equal(steerEvents[0].payload.content, 'also check the tests')
    assert.equal(steerEvents[0].payload.step, 2, 'the steer joined the step after the tool call')

    // Nothing to steer once the turn is over: the client sends a normal turn.
    const idle = await steer(ctx, runId, 'too late')
    assert.equal(idle.status, 400, idle.text)
    assert.equal(idle.json.hint, 'turn')
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty steering message is refused while the turn keeps running', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const created = await ctx.request('/api/sessions', { method: 'POST', body: '{}' })
    const runId = created.json.runId
    const started = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: 'CALL shell {"command":"Start-Sleep -Seconds 20"}' }),
    })
    assert.equal(started.status, 202, started.text)
    await waitFor(async () => (await snapshot(ctx, runId)).json?.state?.busy, 30_000)

    const empty = await steer(ctx, runId, '   ')
    assert.equal(empty.status, 400, empty.text)
    assert.equal(empty.json.error, 'message is required')

    // Cancel so the fixture does not keep a 20 s command alive.
    const cancelled = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: '{}' })
    assert.equal(cancelled.status, 200, cancelled.text)
    await waitFor(async () => (await snapshot(ctx, runId)).json?.state?.busy === false, 60_000)
    await sleep(50)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
