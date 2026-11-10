// WP-00: the golden invariants of HY-HARNESS (K1..K14).
//
// These are the behaviors the DSH adoption must never regress. They are cheap
// and daemon-free; the heavier system checks (checkpoints, Ralph, Guardian,
// sandbox, orchestration) run from the curated files in `pnpm test:regression`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const core = await import(pathToFileURL(path.join(repo, 'packages', 'core', 'dist', 'index.js')).href)
const cli = path.join(repo, 'packages', 'hy-cli', 'dist')
const queue = await import(pathToFileURL(path.join(cli, 'turn-queue.js')).href)
const queueView = await import(pathToFileURL(path.join(cli, 'turn-queue-view.js')).href)
const title = await import(pathToFileURL(path.join(cli, 'session-title.js')).href)

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hy-golden-'))
}

test('K2/K14: the session log is append-only, seq-monotonic and tolerates a torn tail', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'session.v1.jsonl')
    const first = new core.SessionLog(file)
    first.setRun('run-1')
    first.append('turn/start', { turn: 1 })
    first.append('turn/end', { outcome: 'completed' })
    const second = new core.SessionLog(file)
    second.setRun('run-2')
    second.append('turn/start', { turn: 1 })
    const events = core.readEvents(file)
    // WP-20: every log starts with its format header, written exactly once.
    assert.equal(events.length, 4)
    assert.equal(events[0].type, 'session/format')
    assert.deepEqual(events[0].payload, { format: core.SESSION_FORMAT_VERSION })
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2, 3, 4],
      'seq must continue across SessionLog instances',
    )
    assert.ok(events.every((event) => event.v === 1))
    // A crash can leave a half-written last line; it must be ignored, not throw.
    fs.appendFileSync(file, '{"v":1,"seq":5,"ts":', 'utf8')
    assert.equal(core.readEvents(file).length, 4)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('K6: a turn that was running when the process died becomes uncertain and paused', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'turn-queue.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessions: { run: [{ id: 'a', message: 'one', images: [], queuedAt: 1 }] },
        running: { run: 'a' },
        uncertain: {},
        completed: {},
        paused: [],
      }),
      'utf8',
    )
    const state = queue.loadTurnQueue(file)
    assert.deepEqual(state.uncertain.run, ['a'])
    assert.equal(state.paused.includes('run'), true)
    assert.equal(state.running.run, undefined)
    assert.equal(queue.peekNextTurn(state, 'run'), undefined, 'an uncertain head never restarts on its own')
    assert.throws(() => queue.beginTurn(state, 'run', 'a'), /paused/)
    const resolved = queue.resolveUncertain(state, 'run', 'a', 'discard')
    assert.deepEqual(resolved.uncertain, {})
    assert.equal(queue.isTurnSeen(resolved, 'run', 'a'), true, 'a discarded id is never queued again')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('K6: commit removes the running turn, remembers it, and clears the pause', () => {
  const base = queue.EMPTY_TURN_QUEUE
  const enqueued = queue.enqueueTurn(base, 'run', { id: 'a', message: 'one', images: [], queuedAt: 1 })
  assert.equal(enqueued.ok, true)
  const started = queue.beginTurn(enqueued.state, 'run', 'a')
  assert.equal(started.running.run, 'a')
  const paused = queue.releaseTurn(started, 'run')
  assert.equal(queue.peekNextTurn(paused, 'run'), undefined)
  const committed = queue.commitTurn(started, 'run', 'a')
  assert.deepEqual(committed.sessions, {})
  assert.deepEqual(committed.running, {})
  assert.deepEqual(committed.completed.run, ['a'])
  assert.equal(committed.paused.includes('run'), false)
})

test('K6: the queue view never carries image bytes and the request parser rejects junk', () => {
  const state = {
    version: 1,
    sessions: { run: [{ id: 'a', message: 'text', images: [{ mimeType: 'image/png', data: 'AAAA' }], queuedAt: 1 }] },
    running: {},
    uncertain: {},
    completed: {},
    paused: [],
  }
  const view = queueView.turnQueueView(state, 'run')
  assert.equal(view.queued[0].images, 1)
  assert.equal(JSON.stringify(view).includes('AAAA'), false, 'base64 must never reach the view')
  assert.equal(queueView.parseEnqueueRequest({ runId: 'run', id: 'a', message: 'hi' }).ok, true)
  assert.equal(queueView.parseEnqueueRequest({ runId: '../escape', id: 'a', message: 'hi' }).ok, false)
  assert.equal(queueView.parseEnqueueRequest({ runId: 'run', id: 'a', message: '   ' }).ok, false)
  assert.equal(queueView.parseResolveRequest({ runId: 'run', id: 'a', decision: 'maybe' }).ok, false)
})

test('K1: the four sandbox modes parse strictly and the default is workspace-write', () => {
  for (const mode of ['unconfined', 'workspace-write', 'read-only', 'low-integrity']) {
    assert.equal(core.parseSandboxMode(mode), mode)
  }
  assert.throws(() => core.parseSandboxMode('yolo'))
  // isolate.mjs sets HY_SANDBOX=unconfined for the suite; the default is only
  // visible without it. CP-01 (2026-11-05) made workspace-write the default.
  const saved = process.env.HY_SANDBOX
  delete process.env.HY_SANDBOX
  try {
    const config = core.loadConfig({ mock: true })
    assert.equal(config.sandbox, 'workspace-write', 'CP-01: the sandbox is on by default')
    assert.equal(config.sandboxSource, 'default')
  } finally {
    if (saved === undefined) delete process.env.HY_SANDBOX
    else process.env.HY_SANDBOX = saved
  }
  assert.equal(core.loadConfig({ mock: true, sandbox: 'unconfined' }).sandbox, 'unconfined', 'an explicit opt-out still wins')
})

// K9 was redefined by CP-10 (docs/codex-adoption-plan.md): the budget applies to
// the *initial* tool prompt, deferred tools stay out of it until `tool_search`
// loads them, and the token measurement lives in tool-overhead.test.mjs.
test('K9: the initial tool set is fixed, deferred tools stay out of it, and SDK-only tools stay inside run_code', () => {
  const allFeatures = new Set(['skills', 'mcp', 'delegate', 'web', 'ask', 'search', 'lsp', 'memory', 'deferred'])
  const initial = core.offeredTools(true, core.TOOL_SPECS, false, allFeatures).map((spec) => spec.name)
  assert.deepEqual(initial.sort(), [
    'apply_patch',
    'ask_user',
    'current_time',
    'delegate',
    'get_context_remaining',
    'git_status',
    'read_file',
    'request_permissions',
    'run_code',
    'search_glob',
    'search_grep',
    'shell',
    'skill_load',
    'sleep',
    'tool_search',
    'update_plan',
    'verify_file',
    'write_stdin',
  ])
  for (const spec of core.TOOL_SPECS.filter((s) => s.exposure === 'deferred')) {
    assert.equal(spec.wire, true, `${spec.name}: a deferred tool is a wire tool once loaded`)
    assert.equal(initial.includes(spec.name), false, `${spec.name} must not be in the initial prompt`)
  }
  // Job control became a wire tool when the session has a shell: a command
  // that outlives the foreground wait must stay controllable without run_code.
  for (const name of ['job_status', 'job_output', 'job_wait', 'job_kill']) {
    const spec = core.TOOLS_BY_NAME.get(name)
    assert.ok(spec, `${name} must still exist`)
    assert.equal(spec.wire, true, `${name} is a wire tool when a shell is offered`)
    assert.equal(spec.wireRequires, 'shell', `${name} needs a shell session`)
  }
  for (const name of ['rationale_upsert', 'rationale_supersede', 'rationale_remove']) {
    const spec = core.TOOLS_BY_NAME.get(name)
    assert.ok(spec, `${name} must still exist`)
    assert.equal(spec.wire, false, `${name} must stay SDK-only`)
  }
  const readFile = core.TOOLS_BY_NAME.get('read_file')
  assert.ok(readFile)
  assert.ok(core.validate(readFile.input, { path: 'README.md' }).length === 0)
  assert.ok(core.validate(readFile.input, {}).length > 0, 'a missing required path is rejected')
})

test('K9: a repeat tool call is guarded and a broken tool call is recognized', () => {
  assert.equal(core.looksLikeBrokenToolCall('{"tool": "read_file", "args": {"path"'), true)
  assert.equal(core.looksLikeBrokenToolCall('A normal final answer.'), false)
})

test('K13: chat titles are normalized and never carry control characters', () => {
  assert.deepEqual(title.normalizeSessionTitle('  hello   world  '), { title: 'hello world' })
  assert.deepEqual(title.normalizeSessionTitle('a\u0000b'), { title: 'a b' })
  assert.deepEqual(title.normalizeSessionTitle(''), { title: null })
  assert.ok('error' in title.normalizeSessionTitle('x'.repeat(500)), 'an over-long title is rejected, not truncated')
})
