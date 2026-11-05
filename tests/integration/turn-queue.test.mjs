// The durable turn queue over the real HTTP API: reserving a message while a
// turn runs, the automatic hand-over, the paused/uncertain state a restart
// leaves behind, and the cancel/resume/resolve endpoints.
//
// These complement `packages/hy-cli/src/turn-queue.test.ts` (pure state
// transitions) and `turn-queue-view.test.ts` (parsing) by driving the actual
// server, which is where the lifecycle bugs live.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-tq-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Turn queue fixture\n\nA repository for the queue test.\n', 'utf8')
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runServer(dir, overrides = {}) {
  const previous = { HY_CONFIG_DIR: process.env.HY_CONFIG_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA }
  const configDir = path.join(dir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  process.env.HY_CONFIG_DIR = configDir
  process.env.LOCALAPPDATA = path.join(dir, 'localappdata')
  const handle = await startWebServer({
    overrides: { cwd: dir, mock: true, ...overrides },
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
  return { handle, base, auth, request, close }
}

async function newSession(ctx) {
  const created = await ctx.request('/api/sessions', { method: 'POST', body: '{}' })
  assert.equal(created.status, 201, created.text)
  return created.json.runId
}

const snapshot = async (ctx, runId) => (await ctx.request(`/api/sessions/${encodeURIComponent(runId)}`)).json
const queueView = async (ctx, runId) => (await ctx.request(`/api/turn-queue?runId=${encodeURIComponent(runId)}`)).json

function startSlowTurn(ctx, runId, message = 'CALL shell {"command":"Start-Sleep -Seconds 6"}') {
  return ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
}

async function waitBusy(ctx, runId) {
  return waitFor(async () => {
    const s = await snapshot(ctx, runId)
    return s.state.busy ? s : undefined
  }, 30_000)
}

function queuedIds(view) {
  return view.queued.map((turn) => turn.id)
}

test('turn queue: a message reserved while a turn runs starts after it', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir, { autoApprove: true })
  try {
    const runId = await newSession(ctx)
    const first = await startSlowTurn(ctx, runId)
    assert.equal(first.status, 202, first.text)
    await waitBusy(ctx, runId)

    const reserved = await ctx.request('/api/turn-queue', {
      method: 'POST',
      body: JSON.stringify({ runId, id: 'q-1', message: 'SAY queued one' }),
    })
    assert.equal(reserved.status, 200, reserved.text)
    assert.deepEqual(queuedIds(reserved.json), ['q-1'])
    assert.equal(reserved.json.running, null, 'a plain running turn is not a queued turn')
    assert.equal(reserved.json.paused, false)

    // It must not start while the shell turn still runs.
    await sleep(300)
    assert.equal((await snapshot(ctx, runId)).state.busy, true)
    assert.deepEqual(queuedIds(await queueView(ctx, runId)), ['q-1'])

    const finished = await waitFor(async () => {
      const s = await snapshot(ctx, runId)
      if (s.state.busy) return undefined
      return s.entries.some((e) => e.kind === 'assistant' && e.text.includes('queued one')) ? s : undefined
    }, 60_000)
    assert.ok(finished.entries.some((e) => e.kind === 'user' && e.text === 'SAY queued one'))

    const after = await waitFor(async () => {
      const view = await queueView(ctx, runId)
      return view.queued.length === 0 && view.running === null ? view : undefined
    }, 15_000)
    assert.equal(after.paused, false)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('turn queue: queue:true answers 202 with a position and rejects a duplicate id', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir, { autoApprove: true })
  try {
    const runId = await newSession(ctx)
    assert.equal((await startSlowTurn(ctx, runId)).status, 202)
    await waitBusy(ctx, runId)

    const one = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: 'SAY one', queue: true, id: 'q-one' }),
    })
    assert.equal(one.status, 202, one.text)
    assert.equal(one.json.queued, true)
    assert.equal(one.json.position, 1)
    assert.deepEqual(queuedIds(one.json.view), ['q-one'])

    const two = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: 'SAY two', queue: true, id: 'q-two' }),
    })
    assert.equal(two.status, 202, two.text)
    assert.equal(two.json.position, 2)
    assert.deepEqual(queuedIds(two.json.view), ['q-one', 'q-two'])

    const duplicate = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: 'SAY two', queue: true, id: 'q-two' }),
    })
    assert.equal(duplicate.status, 409, duplicate.text)
    assert.match(duplicate.json.error, /already sent/i)

    // Both reserved turns run in FIFO order.
    await waitFor(async () => {
      const s = await snapshot(ctx, runId)
      if (s.state.busy) return undefined
      const answers = s.entries.filter((e) => e.kind === 'assistant').map((e) => e.text)
      return answers.some((t) => t.includes('one')) && answers.some((t) => t.includes('two')) ? s : undefined
    }, 60_000)
    const drained = await waitFor(async () => {
      const view = await queueView(ctx, runId)
      return view.queued.length === 0 && view.running === null ? view : undefined
    }, 15_000)
    assert.equal(drained.paused, false)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('turn queue: a restart marks the in-flight turn uncertain and stays paused', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fixture()
  let ctx = await runServer(dir)
  let runId
  let stateDir
  try {
    const bootstrap = await ctx.request('/api/bootstrap')
    stateDir = bootstrap.json.workspace.stateDir
    runId = await newSession(ctx)
  } finally {
    await ctx.close()
  }

  // A process that died with `q-crash` in flight, plus one waiting turn.
  const file = path.join(stateDir, 'turn-queue.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sessions: { [runId]: [{ id: 'q-crash', message: 'SAY crashed', images: [], queuedAt: 1 }, { id: 'q-next', message: 'SAY next', images: [], queuedAt: 2 }] },
      running: { [runId]: 'q-crash' },
      uncertain: {},
      completed: {},
      paused: [],
    }),
    'utf8',
  )

  ctx = await runServer(dir)
  try {
    const view = await queueView(ctx, runId)
    assert.deepEqual(view.uncertain, ['q-crash'])
    assert.equal(view.paused, true, 'a restored queue must wait for the user')
    assert.equal(view.running, null)
    assert.deepEqual(queuedIds(view), ['q-crash', 'q-next'])

    // Nothing may start on its own after a restart.
    await sleep(800)
    const idle = await snapshot(ctx, runId)
    assert.equal(idle.state.busy, false)
    assert.equal(idle.entries.some((e) => e.kind === 'assistant'), false)

    // Resume alone cannot skip the uncertain head.
    const resumed = await ctx.request('/api/turn-queue/resume', { method: 'POST', body: JSON.stringify({ runId }) })
    assert.equal(resumed.status, 200, resumed.text)
    assert.equal(resumed.json.paused, false)
    assert.deepEqual(queuedIds(resumed.json), ['q-crash', 'q-next'])
    await sleep(500)
    assert.equal((await snapshot(ctx, runId)).state.busy, false)

    // Resolving it as `discard` drops it and blocks the id from coming back.
    const discard = await ctx.request('/api/turn-queue/resolve', {
      method: 'POST',
      body: JSON.stringify({ runId, id: 'q-crash', decision: 'discard' }),
    })
    assert.equal(discard.status, 200, discard.text)
    assert.deepEqual(queuedIds(discard.json), ['q-next'])
    assert.deepEqual(discard.json.uncertain, [])

    // The next turn now starts (the resolve endpoint runs the new head).
    await waitFor(async () => {
      const s = await snapshot(ctx, runId)
      return s.state.busy === false && s.entries.some((e) => e.kind === 'assistant' && e.text.includes('next')) ? s : undefined
    }, 30_000)
    await waitFor(async () => {
      const v = await queueView(ctx, runId)
      return v.queued.length === 0 && v.running === null ? v : undefined
    }, 15_000)

    const replay = await ctx.request('/api/turn-queue', {
      method: 'POST',
      body: JSON.stringify({ runId, id: 'q-crash', message: 'SAY crashed' }),
    })
    assert.equal(replay.status, 409, replay.text)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('turn queue: cancel one and cancel all, then resume starts the rest', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir, { autoApprove: true })
  try {
    const runId = await newSession(ctx)
    assert.equal((await startSlowTurn(ctx, runId)).status, 202)
    await waitBusy(ctx, runId)
    for (const id of ['c-1', 'c-2', 'c-3']) {
      const r = await ctx.request('/api/turn-queue', {
        method: 'POST',
        body: JSON.stringify({ runId, id, message: `SAY ${id}` }),
      })
      assert.equal(r.status, 200, r.text)
    }
    assert.deepEqual(queuedIds(await queueView(ctx, runId)), ['c-1', 'c-2', 'c-3'])

    const one = await ctx.request('/api/turn-queue/cancel', { method: 'POST', body: JSON.stringify({ runId, id: 'c-2' }) })
    assert.equal(one.status, 200, one.text)
    assert.deepEqual(queuedIds(one.json), ['c-1', 'c-3'])

    // Cancel the running turn of the queue (the plain shell turn) so the rest
    // stay parked instead of draining behind it.
    const cancelled = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
    assert.equal(cancelled.status, 200, cancelled.text)
    await waitFor(async () => ((await snapshot(ctx, runId)).state.busy ? undefined : true), 30_000)

    // A cancelled plain turn pauses the queue; nothing runs behind it.
    const paused = await waitFor(async () => {
      const view = await queueView(ctx, runId)
      return view.paused ? view : undefined
    }, 15_000)
    assert.deepEqual(queuedIds(paused), ['c-1', 'c-3'])

    const cleared = await ctx.request('/api/turn-queue/cancel', { method: 'POST', body: JSON.stringify({ runId }) })
    assert.equal(cleared.status, 200, cleared.text)
    assert.deepEqual(queuedIds(cleared.json), [])
    assert.equal(cleared.json.paused, false, 'clearing the last turn drops the pause marker')
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('turn queue: rejects unknown runs, worker chats and malformed bodies', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const unknown = await ctx.request('/api/turn-queue', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run-does-not-exist', id: 'x', message: 'hi' }),
    })
    assert.equal(unknown.status, 404, unknown.text)

    const noRunId = await ctx.request('/api/turn-queue?runId=', { method: 'GET' })
    assert.equal(noRunId.status, 400, noRunId.text)

    const badBody = await ctx.request('/api/turn-queue', { method: 'POST', body: '[]' })
    assert.equal(badBody.status, 400, badBody.text)

    const badImage = await ctx.request('/api/turn-queue', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run-1', id: 'i-1', message: 'hi', images: [{ mimeType: 'text/plain', data: 'aGk=' }] }),
    })
    assert.equal(badImage.status, 400, badImage.text)

    // A view of an id the GUI has not seen yet is empty, not an error.
    const empty = await ctx.request('/api/turn-queue?runId=fresh-chat')
    assert.equal(empty.status, 200, empty.text)
    assert.deepEqual(empty.json.queued, [])
    assert.equal(empty.json.paused, false)

    // Resume/clear of a session with nothing queued is a no-op.
    const resume = await ctx.request('/api/turn-queue/resume', { method: 'POST', body: JSON.stringify({ runId: 'fresh-chat' }) })
    assert.equal(resume.status, 200, resume.text)
    const clear = await ctx.request('/api/turn-queue/cancel', { method: 'POST', body: JSON.stringify({ runId: 'fresh-chat' }) })
    assert.equal(clear.status, 200, clear.text)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
