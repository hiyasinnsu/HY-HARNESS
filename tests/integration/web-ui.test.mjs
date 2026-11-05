// The local Web GUI server: auth, bootstrap, chat, goal, tools, jobs,
// subagents, approvals, files and settings. The Electron shell renders the
// same server, so these are the contract tests for the desktop GUI too.
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
const { readEvents, sessionLogPath } = await import(pathToFileURL(path.join(repo, 'packages', 'core', 'dist', 'index.js')).href)

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-web-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Web Fixture\n\nA repository for the GUI test.\n', 'utf8')
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  return dir
}

async function waitFor(fn, timeout = 45_000, interval = 120) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeout) {
    last = await fn()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`timed out; last=${JSON.stringify(last)}`)
}

async function runServer(dir, overrides = {}, userConfig) {
  const previous = { HY_CONFIG_DIR: process.env.HY_CONFIG_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA }
  const configDir = path.join(dir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  if (userConfig) fs.writeFileSync(path.join(configDir, 'config.json'), `${JSON.stringify(userConfig, null, 2)}\n`, 'utf8')
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
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, text, json }
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

async function snapshot(ctx, runId) {
  const r = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}`)
  return r.json
}

async function turn(ctx, runId, message, body = {}) {
  const before = (await snapshot(ctx, runId)).entries.length
  const accepted = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
    method: 'POST',
    body: JSON.stringify({ message, ...body }),
  })
  assert.equal(accepted.status, 202, accepted.text)
  await waitFor(async () => {
    const s = await snapshot(ctx, runId)
    if (s.state.busy) return undefined
    const fresh = s.entries.slice(before)
    return fresh.some((e) => e.kind === 'assistant') ? s : undefined
  })
  return snapshot(ctx, runId)
}

test('web GUI: auth, bootstrap, files and settings', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const anonymous = await fetch(`${ctx.base}/api/bootstrap`)
    assert.equal(anonymous.status, 401)

    const page = await ctx.request('/')
    assert.equal(page.status, 200, page.text)
    assert.match(page.text, /rel="manifest"/)
    assert.match(page.text, /apple-touch-icon/)
    const manifest = await fetch(`${ctx.base}/manifest.webmanifest`)
    assert.equal(manifest.status, 200)
    assert.match(manifest.headers.get('content-type') ?? '', /application\/manifest\+json/)
    assert.equal((await manifest.json()).display, 'standalone')

    const runId = await newSession(ctx)
    const listed = await ctx.request('/api/sessions')
    assert.ok(listed.json.sessions.some((session) => session.runId === runId), 'new chat is listed before its first answer')
    const restricted = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/mcp-call`, {
      method: 'POST',
      body: JSON.stringify({ server: 'shell', tool: 'run' }),
    })
    assert.equal(restricted.status, 403, restricted.text)
    const unavailable = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/mcp-call`, {
      method: 'POST',
      body: JSON.stringify({ server: 'playwright', tool: 'browser_navigate', args: { url: 'about:blank' } }),
    })
    assert.equal(unavailable.status, 400, unavailable.text)

    const boot = await ctx.request('/api/bootstrap')
    assert.equal(boot.status, 200, boot.text)
    assert.equal(boot.json.workspace.root.toLowerCase(), fs.realpathSync.native(dir).toLowerCase())
    assert.equal(boot.json.config.worker.provider, 'mock')
    assert.equal(boot.json.desktop, false)

    const file = await ctx.request('/api/files?path=README.md')
    assert.equal(file.status, 200, file.text)
    assert.match(file.json.content, /Web Fixture/)

    const tree = await ctx.request('/api/files/tree?path=')
    assert.ok(tree.json.entries.some((entry) => entry.name === 'README.md'))

    const search = await ctx.request('/api/files/search?q=read')
    assert.ok(search.json.files.includes('README.md'))

    const traversal = await ctx.request('/api/files?path=../outside.txt')
    assert.ok(traversal.status >= 400)

    const plugins = await ctx.request('/api/plugins')
    assert.equal(plugins.status, 200, plugins.text)
    assert.ok(Array.isArray(plugins.json.configured))
    assert.ok(Array.isArray(plugins.json.directories))
    const reloaded = await ctx.request('/api/plugins/reload', { method: 'POST' })
    assert.equal(reloaded.status, 200, reloaded.text)
    assert.ok(Array.isArray(reloaded.json.tools))

    const settings = await ctx.request('/api/settings')
    assert.match(settings.json.path, /config/i)
    const saved = await ctx.request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        roles: {
          worker: { model: 'mock-next', effort: 'low' },
          orchestrator: { model: 'orchestrator-model' },
          subagent: { model: 'subagent-model', effort: 'medium' },
        },
        plugins: ['C:/hy-plugins/example.mjs'],
        memoryEnabled: true,
        webEnabled: false,
        automation: {
          browser: { enabled: true, browser: 'msedge', headless: true, isolated: false },
          desktop: { enabled: false },
        },
      }),
    })
    assert.equal(saved.status, 200, saved.text)
    assert.equal(saved.json.saved, true)
    assert.equal(saved.json.hotReloaded, true, 'model/effort settings apply without a restart')
    const after = await ctx.request('/api/bootstrap')
    assert.equal(after.json.config.worker.model, 'mock-next')
    assert.equal(after.json.config.worker.effort, 'low')
    assert.equal((await snapshot(ctx, runId)).state.effort, 'low')
    const written = JSON.parse(fs.readFileSync(settings.json.path, 'utf8'))
    assert.equal(written.roles.worker.model, 'mock-next')
    assert.equal(written.roles.orchestrator.model, 'orchestrator-model')
    assert.equal(written.roles.subagent.model, 'subagent-model')
    assert.equal(written.roles.subagent.effort, 'medium')
    assert.deepEqual(written.plugins, ['C:/hy-plugins/example.mjs'])
    assert.equal(written.memory.enabled, true)
    assert.equal(written.web.enabled, false)
    assert.equal(written.automation.browser.enabled, true)
    assert.equal(written.automation.browser.browser, 'msedge')
    assert.equal(written.automation.desktop.enabled, false)
    // The saved model/effort must be usable by the existing chat without a restart.
    const afterTurn = await turn(ctx, runId, 'SAY after settings')
    assert.ok(afterTurn.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('after settings')))
    const cleared = await ctx.request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ roles: { worker: { effort: null } } }),
    })
    assert.equal(cleared.status, 200, cleared.text)
    const afterClear = await ctx.request('/api/bootstrap')
    assert.equal(afterClear.json.config.worker.effort, undefined, 'selecting Default clears the role effort')
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: /model applies the model profile context and output limits', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  let ctx
  try {
    ctx = await runServer(
      dir,
      {},
      {
        roles: { worker: { provider: 'mock', model: 'mock', contextWindowTokens: 32_000, maxOutputTokens: 4_000 } },
        models: [
          {
            id: 'mock-large',
            name: 'Mock Large',
            provider: 'mock',
            model: 'mock-large',
            contextWindowTokens: 128_000,
            maxOutputTokens: 8_192,
          },
        ],
      },
    )
    const runId = await newSession(ctx)
    const switched = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/model`, {
      method: 'POST',
      body: JSON.stringify({ model: 'mock-large' }),
    })
    assert.equal(switched.status, 200, switched.text)
    const settings = await ctx.request('/api/settings')
    assert.equal(settings.json.active.worker.contextWindowTokens, 128_000, 'switching applies the profile context')
    assert.equal(settings.json.active.worker.maxOutputTokens, 8_192, 'switching applies the profile output cap')

    const saved = await ctx.request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ roles: { worker: { model: 'mock-large' } } }),
    })
    assert.equal(saved.status, 200, saved.text)
    const written = JSON.parse(fs.readFileSync(settings.json.path, 'utf8'))
    assert.equal(written.roles.worker.contextWindowTokens, 128_000, 'the partial save keeps the profile context')
    assert.equal(written.roles.worker.maxOutputTokens, 8_192, 'the partial save keeps the profile output cap')
  } finally {
    if (ctx) await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: persistent PTY keeps shell state', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const previousShell = process.env.HY_PTY_SHELL
  process.env.HY_PTY_SHELL = process.env.ComSpec ?? 'cmd.exe'
  let ctx
  try {
    ctx = await runServer(dir)
    const runId = await newSession(ctx)
    const pty = `/api/sessions/${encodeURIComponent(runId)}/pty`
    const start = await ctx.request(`${pty}/start`, {
      method: 'POST',
      body: JSON.stringify({ cols: 90, rows: 24 }),
    })
    assert.equal(start.status, 200, start.text)
    assert.equal(start.json.running, true)
    await new Promise((resolve) => setTimeout(resolve, 500))

    const events = await fetch(`${ctx.base}${pty}/events`, { headers: ctx.auth })
    assert.equal(events.status, 200)
    const reader = events.body.getReader()
    const first = await reader.read()
    assert.match(new TextDecoder().decode(first.value), /event: pty/)
    await reader.cancel()

    for (const data of ['echo PTY_ONE\r\n', 'cd /d C:\\Windows\r\n', 'cd\r\n']) {
      const input = await ctx.request(`${pty}/input`, { method: 'POST', body: JSON.stringify({ data }) })
      assert.equal(input.status, 200, input.text)
    }
    const status = await waitFor(async () => {
      const current = await ctx.request(pty)
      return current.json.output.includes('PTY_ONE') && current.json.output.includes('C:\\Windows') ? current.json : undefined
    }, 10_000, 200)
    assert.equal(status.running, true)
    assert.equal(status.shell, 'cmd.exe')

    const resize = await ctx.request(`${pty}/resize`, { method: 'POST', body: JSON.stringify({ cols: 120, rows: 40 }) })
    assert.equal(resize.status, 200, resize.text)
    assert.equal(resize.json.cols, 120)
    assert.equal(resize.json.rows, 40)
    const cleared = await ctx.request(`${pty}/clear`, { method: 'POST' })
    assert.equal(cleared.status, 200, cleared.text)
    assert.equal(cleared.json.output, '')

    const stop = await ctx.request(`${pty}/stop`, { method: 'POST' })
    assert.equal(stop.status, 200, stop.text)
    assert.equal(stop.json.running, false)
    const afterStop = await ctx.request(`${pty}/input`, { method: 'POST', body: JSON.stringify({ data: 'echo nope\r\n' }) })
    assert.equal(afterStop.status, 409, afterStop.text)
  } finally {
    await ctx?.close()
    if (previousShell === undefined) delete process.env.HY_PTY_SHELL
    else process.env.HY_PTY_SHELL = previousShell
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: plugin catalog and reload', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const plugin = path.join(dir, 'hello-plugin.mjs')
  fs.writeFileSync(
    plugin,
    [
      'export const tools = [{',
      "  name: 'hello_tool',",
      "  description: 'Say hello from a plugin.',",
      '  readOnly: true,',
      "  input: { type: 'object', properties: {}, required: [] },",
      "  run: async () => ({ hello: 'world' }),",
      '}]',
      '',
    ].join('\n'),
    'utf8',
  )
  const ctx = await runServer(dir, {}, { plugins: [plugin] })
  try {
    const reloaded = await ctx.request('/api/plugins/reload', { method: 'POST' })
    assert.equal(reloaded.status, 200, reloaded.text)
    assert.ok(reloaded.json.tools.some((t) => t.name === 'hello_tool'), reloaded.text)
    assert.ok(reloaded.json.configured.includes(plugin))
    const catalog = await ctx.request('/api/plugins')
    assert.equal(catalog.status, 200, catalog.text)
    assert.ok(catalog.json.tools.some((t) => t.name === 'hello_tool'), catalog.text)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: schedules and webhooks', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const invalid = await ctx.request('/api/automation/schedules', {
      method: 'POST',
      body: JSON.stringify({ name: 'bad', cron: 'not a cron', cwd: dir, objective: 'x' }),
    })
    assert.equal(invalid.status, 400)

    const created = await ctx.request('/api/automation/schedules', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Morning task',
        cron: '0 9 * * 1-5',
        cwd: dir,
        objective: 'SAY schedule ok',
        verifyCmds: [],
        autoApprove: true,
        enabled: true,
      }),
    })
    assert.equal(created.status, 201, created.text)
    const schedule = created.json
    const listed = await ctx.request('/api/automation')
    assert.ok(listed.json.schedules.some((s) => s.id === schedule.id))
    assert.ok(listed.json.schedules.find((s) => s.id === schedule.id)?.nextRun)

    const run = await ctx.request(`/api/automation/schedules/${encodeURIComponent(schedule.id)}/run`, { method: 'POST' })
    assert.equal(run.status, 202, run.text)
    const finished = await waitFor(async () => {
      const r = await ctx.request(`/api/automation/runs/${encodeURIComponent(run.json.id)}`)
      return r.json.status === 'running' ? undefined : r.json
    }, 60_000, 200)
    assert.equal(finished.status, 'succeeded', finished.output?.join('\n'))
    assert.match(finished.output.join('\n'), /schedule ok/)

    const webhook = await ctx.request('/api/automation/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Webhook task',
        cwd: dir,
        objective: 'SAY webhook ok',
        verifyCmds: [],
        autoApprove: true,
        enabled: true,
      }),
    })
    assert.equal(webhook.status, 201, webhook.text)
    const hook = webhook.json
    assert.match(hook.secret, /^whsec-/)
    const unauthorized = await fetch(`${ctx.base}${hook.endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(unauthorized.status, 401)
    const triggered = await fetch(`${ctx.base}${hook.endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hy-webhook-secret': hook.secret },
      body: JSON.stringify({}),
    })
    assert.equal(triggered.status, 202)
    const accepted = await triggered.json()
    const webhookDone = await waitFor(async () => {
      const r = await ctx.request(`/api/automation/runs/${encodeURIComponent(accepted.runId)}`)
      return r.json.status === 'running' ? undefined : r.json
    }, 60_000, 200)
    assert.equal(webhookDone.status, 'succeeded', webhookDone.output?.join('\n'))
    assert.match(webhookDone.output.join('\n'), /webhook ok/)

    await ctx.request(`/api/automation/schedules/${encodeURIComponent(schedule.id)}`, { method: 'DELETE' })
    await ctx.request(`/api/automation/webhooks/${encodeURIComponent(hook.id)}`, { method: 'DELETE' })
    const after = await ctx.request('/api/automation')
    assert.equal(after.json.schedules.some((s) => s.id === schedule.id), false)
    assert.equal(after.json.webhooks.some((w) => w.id === hook.id), false)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: chat, goal, subagent, background job and SSE', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir, { autoApprove: true })
  try {
    const goalRun = await newSession(ctx)
    const goal = await ctx.request(`/api/sessions/${encodeURIComponent(goalRun)}/goal`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'Keep the public API stable' }),
    })
    assert.equal(goal.status, 200, goal.text)
    assert.equal(goal.json.state.objective, 'Keep the public API stable')
    assert.equal(goal.json.state.phase, 'active')
    // DSH arms a created goal; pause it so this test controls the only turn.
    await ctx.request(`/api/sessions/${encodeURIComponent(goalRun)}/goal`, {
      method: 'POST',
      body: JSON.stringify({ action: 'pause' }),
    })
    const withGoal = await turn(ctx, goalRun, 'SAY hello')
    const user = withGoal.entries.find((e) => e.kind === 'user')
    assert.equal(user?.kind === 'user' ? user.text : '', 'SAY hello')
    const goalEvents = readEvents(sessionLogPath(ctx.handle.config.stateDir))
    assert.ok(
      goalEvents.some(
        (e) =>
          e.runId === goalRun &&
          e.type === 'goal/change' &&
          !!e.payload?.goal &&
          typeof e.payload.goal === 'object' &&
          e.payload.goal.objective === 'Keep the public API stable',
      ),
      'the goal state is persisted in the session log',
    )

    const runId = await newSession(ctx)
    const chat = await turn(ctx, runId, 'SAY hello web')
    assert.ok(chat.entries.some((e) => e.kind === 'assistant' && e.text === 'hello web'))

    const withImage = await turn(ctx, runId, 'SAY image', {
      images: [{ mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }],
    })
    assert.ok(withImage.entries.some((e) => e.kind === 'user' && e.images === 1))

    const pinned = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned: true }),
    })
    assert.equal(pinned.status, 200, pinned.text)
    const pinnedList = await ctx.request('/api/sessions')
    assert.equal(pinnedList.json.sessions.find((s) => s.runId === runId)?.pinned, true)
    const archived = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived: true }),
    })
    assert.equal(archived.status, 200, archived.text)
    assert.equal((await ctx.request('/api/sessions')).json.sessions.some((s) => s.runId === runId), false)
    assert.equal((await ctx.request('/api/sessions?archived=1')).json.sessions.find((s) => s.runId === runId)?.archived, true)
    await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/archive`, { method: 'POST', body: JSON.stringify({ archived: false }) })

    const delegated = await turn(ctx, runId, 'CALL delegate {"task":"SAY subagent ok","readOnly":true}')
    assert.ok(delegated.entries.some((e) => e.kind === 'tool' && e.name === 'delegate'))
    const subs = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/subagents`)
    assert.equal(subs.status, 200, subs.text)
    assert.equal(subs.json.subagents.length, 1)
    const child = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/subagents/${encodeURIComponent(subs.json.subagents[0].runId)}`)
    assert.ok(child.json.entries.some((e) => e.kind === 'assistant' && e.text === 'subagent ok'))

    const jobTurn = await turn(ctx, runId, 'CALL shell {"command":"Start-Sleep -Seconds 2","foregroundWaitMs":50}')
    const jobTool = jobTurn.entries.find((e) => e.kind === 'tool' && e.name === 'shell')
    assert.ok(jobTool?.result?.jobId, JSON.stringify(jobTool))
    const jobs = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/jobs`)
    assert.equal(jobs.status, 200, jobs.text)
    assert.ok(jobs.json.jobs.some((job) => job.jobId === jobTool.result.jobId))
    const output = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobTool.result.jobId)}/output`)
    assert.equal(output.status, 200, output.text)
    assert.equal(typeof output.json.data, 'string')
    await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobTool.result.jobId)}/kill`, { method: 'POST' })

    // SSE: the first frame is a complete snapshot for reconnects.
    const controller = new AbortController()
    const response = await fetch(`${ctx.base}/api/sessions/${encodeURIComponent(runId)}/events`, {
      headers: ctx.auth,
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const first = await reader.read()
    const text = new TextDecoder().decode(first.value)
    assert.match(text, /event: snapshot/)
    controller.abort()
    await reader.cancel().catch(() => {})

    const terminal = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/terminal`, {
      method: 'POST',
      body: JSON.stringify({ command: 'git status --short' }),
    })
    assert.equal(terminal.status, 200, terminal.text)
    assert.equal(terminal.json.result.exitCode, 0)
    assert.equal(terminal.json.result.status, 'completed')

    // The Verifier loop runs the existing CLI in a child process and streams
    // its output. With the mock provider one round is enough.
    const ralph = await ctx.request('/api/ralph', {
      method: 'POST',
      body: JSON.stringify({ objective: 'Create the demo file', verifyCmds: ['git status --short'], maxRounds: 1, autoApprove: true }),
    })
    assert.equal(ralph.status, 201, ralph.text)
    const ralphResult = await waitFor(
      async () => {
        const r = await ctx.request(`/api/ralph/${encodeURIComponent(ralph.json.id)}`)
        return r.json.status === 'running' ? undefined : r.json
      },
      90_000,
      250,
    )
    assert.equal(ralphResult.status, 'succeeded', ralphResult.output)
    assert.match(ralphResult.runId ?? '', /^run-/)
    assert.match(ralphResult.output, /Succeeded/)

    const trajectory = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/trajectory`)
    assert.ok(trajectory.json.events.some((e) => e.type === 'tool/result'))
    const memory = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/memory`)
    assert.ok(Array.isArray(memory.json.entries))
    const mcp = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/mcp`)
    assert.ok(Array.isArray(mcp.json.tools))
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: the grader completes an achieved goal', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir, { autoApprove: true })
  try {
    const runId = await newSession(ctx)
    const goal = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/goal`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'COMPLETE the mock objective', maxGoalRounds: 3 }),
    })
    assert.equal(goal.status, 200, goal.text)
    const complete = await waitFor(async () => {
      const snap = await snapshot(ctx, runId)
      const state = snap.state.goalState
      return state?.phase === 'complete' ? state : undefined
    })
    assert.equal(complete.roundsStarted, 1)
    assert.equal(complete.activation, 'disarmed')
    const events = readEvents(sessionLogPath(ctx.handle.config.stateDir))
    assert.ok(events.some((e) => e.runId === runId && e.type === 'goal/grade' && e.payload?.pass === true), 'the grader ran and passed')
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: goal rounds auto-start and stop at the round cap', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir, { autoApprove: true })
  try {
    const runId = await newSession(ctx)
    const goal = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/goal`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'Create the demo file', maxGoalRounds: 1 }),
    })
    assert.equal(goal.status, 200, goal.text)
    const blocked = await waitFor(async () => {
      const snap = await snapshot(ctx, runId)
      const state = snap.state.goalState
      return state?.phase === 'blocked' && state.blockerReason === 'round-limit' ? state : undefined
    })
    assert.equal(blocked.roundsStarted, 1)
    assert.equal(blocked.maxGoalRounds, 1)
    assert.equal(blocked.activation, 'disarmed')
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: cancel stops an in-flight shell tool', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir, { autoApprove: true })
  try {
    const runId = await newSession(ctx)
    const accepted = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: 'CALL shell {"command":"Start-Sleep -Seconds 30"}' }),
    })
    assert.equal(accepted.status, 202, accepted.text)
    await waitFor(async () => {
      const s = await snapshot(ctx, runId)
      return s.state.busy && s.entries.some((e) => e.kind === 'tool' && e.status === 'running')
    })
    const started = Date.now()
    const cancelled = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
    assert.equal(cancelled.status, 200, cancelled.text)
    await waitFor(async () => {
      const s = await snapshot(ctx, runId)
      return s.state.busy === false ? s : undefined
    }, 15_000)
    assert.ok(Date.now() - started < 15_000)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: deleting a running chat removes it from the session list', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir, { autoApprove: true })
  try {
    const runId = await newSession(ctx)
    const accepted = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: 'CALL shell {"command":"Start-Sleep -Seconds 30"}' }),
    })
    assert.equal(accepted.status, 202, accepted.text)
    await waitFor(async () => {
      const s = await snapshot(ctx, runId)
      return s.state.busy ? s : undefined
    })
    const deleted = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}`, { method: 'DELETE' })
    assert.equal(deleted.status, 200, deleted.text)
    assert.equal((await ctx.request('/api/sessions')).json.sessions.some((s) => s.runId === runId), false)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    assert.equal((await ctx.request('/api/sessions')).json.sessions.some((s) => s.runId === runId), false, 'late turn events must not resurrect the tab')
    assert.equal((await ctx.request(`/api/sessions/${encodeURIComponent(runId)}`)).status, 404)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: approval request, deny, and tool error', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const runId = await newSession(ctx)
    const accepted = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: 'CALL shell {"command":"npm install"}' }),
    })
    assert.equal(accepted.status, 202, accepted.text)
    const approval = await waitFor(async () => {
      const s = await snapshot(ctx, runId)
      return s.entries.find((e) => e.kind === 'approval')
    })
    assert.match(approval.request.command, /npm install/)
    const denied = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/approval`, {
      method: 'POST',
      body: JSON.stringify({ requestId: approval.requestId, approved: false, reason: 'test denial' }),
    })
    assert.equal(denied.status, 200, denied.text)
    const after = await waitFor(async () => {
      const s = await snapshot(ctx, runId)
      if (s.state.busy) return undefined
      const tool = s.entries.find((e) => e.kind === 'tool' && e.name === 'shell')
      return tool && tool.status === 'error' ? s : undefined
    })
    const tool = after.entries.find((e) => e.kind === 'tool' && e.name === 'shell')
    assert.equal(tool.status, 'error')
    assert.match(tool.output, /not approved/)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: adding a root keeps the same chat and separates same-name files', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const extra = path.join(dir, 'extra')
  fs.mkdirSync(extra)
  fs.writeFileSync(path.join(extra, 'README.md'), '# Extra root\n', 'utf8')
  const ctx = await runServer(dir)
  try {
    const runId = await newSession(ctx)
    await turn(ctx, runId, 'SAY before root')
    const added = await ctx.request('/api/workspace/roots', {
      method: 'POST',
      body: JSON.stringify({ path: extra, writable: true, label: 'Extra' }),
    })
    assert.equal(added.status, 201, added.text)
    assert.equal(added.json.roots.length, 2)
    const extraRoot = added.json.roots.find((root) => root.id !== 'main')
    assert.equal(extraRoot.writable, true)
    assert.equal(extraRoot.label, 'Extra')

    const extraFile = await ctx.request(`/api/files?path=README.md&root=${encodeURIComponent(extraRoot.id)}`)
    assert.equal(extraFile.status, 200, extraFile.text)
    assert.match(extraFile.json.content, /Extra root/)
    const tree = await ctx.request(`/api/files/tree?root=${encodeURIComponent(extraRoot.id)}`)
    assert.equal(tree.status, 200, tree.text)
    assert.ok(tree.json.entries.some((entry) => entry.name === 'README.md'))
    const escaped = await ctx.request(`/api/files?path=../outside.txt&root=${encodeURIComponent(extraRoot.id)}`)
    assert.notEqual(escaped.status, 200)

    const after = await turn(ctx, runId, 'SAY after root')
    assert.equal(after.state.runId, runId, 'the run id survives adding a root')
    assert.ok(after.entries.some((entry) => entry.kind === 'user' && entry.text.includes('before root')))
    assert.ok(after.entries.some((entry) => entry.kind === 'user' && entry.text.includes('after root')))

    const shellTurn = await turn(
      ctx,
      runId,
      `CALL shell ${JSON.stringify({ command: "Write-Output 'EXTRA_ROOT_OK'", root: extraRoot.id })}`,
    )
    const shellTool = shellTurn.entries
      .filter((entry) => entry.kind === 'tool' && entry.name === 'shell')
      .at(-1)
    assert.ok(shellTool, JSON.stringify(shellTurn.entries))
    assert.equal(shellTool.status, 'done', JSON.stringify(shellTool))
    assert.match(shellTool.output, /EXTRA_ROOT_OK/)

    const duplicate = await ctx.request('/api/workspace/roots', { method: 'POST', body: JSON.stringify({ path: extra }) })
    assert.equal(duplicate.status, 409, duplicate.text)
    const relative = await ctx.request('/api/workspace/roots', { method: 'POST', body: JSON.stringify({ path: 'relative' }) })
    assert.equal(relative.status, 400, relative.text)
    const removed = await ctx.request(`/api/workspace/roots/${encodeURIComponent(extraRoot.id)}`, { method: 'DELETE' })
    assert.equal(removed.status, 200, removed.text)
    assert.equal(removed.json.roots.length, 1)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: orchestration spawns ordinary worker sessions and rejects overlap', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const started = await ctx.request('/api/orchestration/start', { method: 'POST', body: '{}' })
    assert.equal(started.status, 201, started.text)
    const orchestratorId = started.json.runId
    assert.equal(started.json.orchestration.active.status, 'active')
    const planOff = await ctx.request(`/api/sessions/${encodeURIComponent(orchestratorId)}/plan-mode`, {
      method: 'POST',
      body: JSON.stringify({ on: false }),
    })
    assert.equal(planOff.status, 409, planOff.text)

    const spawn = await ctx.request(`/api/sessions/${encodeURIComponent(orchestratorId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({
        message: `CALL orchestrator_spawn ${JSON.stringify({ title: 'Worker A', task: 'SAY worker A done', scope: ['src'] })}`,
      }),
    })
    assert.equal(spawn.status, 202, spawn.text)

    const worker = await waitFor(async () => {
      const list = await ctx.request('/api/sessions')
      return list.json.sessions.find((s) => s.kind === 'worker' && s.workerStatus === 'waiting')
    })
    assert.equal(worker.workerTitle, 'Worker A')
    assert.equal(worker.parentRunId, orchestratorId)
    const workerSnap = await snapshot(ctx, worker.runId)
    assert.equal(workerSnap.state.kind, 'worker')
    assert.ok(workerSnap.entries.some((e) => e.kind === 'notice' && e.text.includes('orchestrator assignment')))
    assert.ok(workerSnap.entries.some((e) => e.kind === 'assistant'))

    const direct = await ctx.request(`/api/sessions/${encodeURIComponent(worker.runId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: 'hello' }),
    })
    assert.equal(direct.status, 403, direct.text)

    await waitFor(async () => {
      const current = await snapshot(ctx, orchestratorId)
      return current.state.busy ? undefined : true
    })
    const subSpawn = await ctx.request(`/api/sessions/${encodeURIComponent(orchestratorId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({
        message: `CALL orchestrator_spawn ${JSON.stringify({
          title: 'Sub worker',
          task: `CALL delegate ${JSON.stringify({ task: 'SAY subagent ok' })}`,
          scope: ['docs'],
        })}`,
      }),
    })
    assert.equal(subSpawn.status, 202, subSpawn.text)
    const subWorker = await waitFor(async () => {
      const list = await ctx.request('/api/sessions')
      return list.json.sessions.find((s) => s.kind === 'worker' && s.workerTitle === 'Sub worker' && s.workerStatus === 'waiting')
    })
    const subSnap = await snapshot(ctx, subWorker.runId)
    const delegate = subSnap.entries.find((e) => e.kind === 'tool' && e.name === 'delegate')
    assert.ok(delegate, JSON.stringify(subSnap.entries))
    assert.equal(delegate.status, 'done', JSON.stringify(delegate))

    await waitFor(async () => {
      const current = await snapshot(ctx, orchestratorId)
      return current.state.busy ? undefined : true
    })
    const overlap = await ctx.request(`/api/sessions/${encodeURIComponent(orchestratorId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({
        message: `CALL orchestrator_spawn ${JSON.stringify({ title: 'Worker B', task: 'SAY worker B', scope: ['src/ui'] })}`,
      }),
    })
    assert.equal(overlap.status, 202, overlap.text)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const after = await ctx.request('/api/sessions')
    assert.equal(after.json.sessions.filter((s) => s.kind === 'worker').length, 2)

    const stopped = await ctx.request('/api/orchestration/stop', { method: 'POST', body: '{}' })
    assert.equal(stopped.status, 200, stopped.text)
    assert.equal(stopped.json.orchestration.active.status, 'stopped')
    const afterStop = await ctx.request('/api/sessions')
    assert.equal(afterStop.json.sessions.some((s) => s.runId === orchestratorId), false, 'the orchestrator chat closes')
    assert.equal(afterStop.json.sessions.some((s) => s.kind === 'worker'), false, 'worker chats close too')
    assert.equal((await snapshot(ctx, orchestratorId)).state.kind, 'chat')
    const restarted = await ctx.request('/api/orchestration/start', { method: 'POST', body: '{}' })
    assert.equal(restarted.status, 201, restarted.text)
    assert.notEqual(restarted.json.runId, orchestratorId, 'a new orchestrator chat is created')
    assert.equal(restarted.json.orchestration.active.status, 'active')
    const restartedList = await ctx.request('/api/sessions')
    assert.ok(restartedList.json.sessions.some((s) => s.runId === restarted.json.runId && s.kind === 'orchestrator'))
    await ctx.request('/api/orchestration/stop', { method: 'POST', body: '{}' })
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: the orchestrator sees open workers, delivery and review state', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const started = await ctx.request('/api/orchestration/start', { method: 'POST', body: '{}' })
    assert.equal(started.status, 201, started.text)
    const orchestratorId = started.json.runId
    const spawn = await ctx.request(`/api/sessions/${encodeURIComponent(orchestratorId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({
        message: `CALL orchestrator_spawn ${JSON.stringify({ title: 'Review me', task: 'DONE review done', scope: ['src'] })}`,
      }),
    })
    assert.equal(spawn.status, 202, spawn.text)
    const worker = await waitFor(async () => {
      const listed = await ctx.request('/api/sessions')
      return listed.json.sessions.find((s) => s.kind === 'worker' && s.workerTitle === 'Review me' && s.workerStatus === 'waiting')
    })

    const listedTurn = await turn(ctx, orchestratorId, 'CALL orchestrator_workers {}')
    const listTool = listedTurn.entries.filter((e) => e.kind === 'tool' && e.name === 'orchestrator_workers').at(-1)
    assert.ok(listTool, 'orchestrator_workers ran')
    const list = JSON.parse(listTool.output)
    const card = list.workers.find((w) => w.workerId === worker.runId)
    assert.ok(card, 'the waiting worker is visible')
    assert.equal(card.status, 'waiting')
    assert.equal(card.statusLabel, 'waiting for review')
    assert.equal(card.reportStatus, 'done')
    assert.equal(card.scopeHeld, true)
    assert.equal(card.awaitingReview, true)
    assert.deepEqual(card.scope, ['src'])
    assert.equal(typeof card.reportPreview, 'string')
    assert.equal('task' in card, false, 'the compact list does not repeat the full task')
    assert.ok(list.awaitingReview.includes(worker.runId))

    const events = readEvents(sessionLogPath(ctx.handle.config.stateDir))
    const digest = events
      .filter((e) => e.runId === orchestratorId && e.type === 'user/message')
      .map((e) => String(e.payload?.content ?? ''))
      .find((text) => text.startsWith('[orchestration status:'))
    assert.ok(digest, 'the orchestrator receives the open-worker digest')
    assert.match(digest, /waiting for review/)
    assert.match(digest, /Awaiting review:/)
    assert.match(digest, new RegExp(worker.runId))

    const sentTurn = await turn(
      ctx,
      orchestratorId,
      `CALL orchestrator_send ${JSON.stringify({ workerId: worker.runId, message: 'DONE follow-up done' })}`,
    )
    const sentTool = sentTurn.entries.filter((e) => e.kind === 'tool' && e.name === 'orchestrator_send').at(-1)
    assert.ok(sentTool, 'orchestrator_send ran')
    const delivered = JSON.parse(sentTool.output)
    assert.equal(delivered.delivered, true)
    assert.equal(delivered.queued, false)
    assert.equal(delivered.status, 'running')
    assert.equal(delivered.scopeHeld, true)
    assert.deepEqual(delivered.scope, ['src'])

    await waitFor(async () => {
      const current = await ctx.request('/api/orchestration')
      const w = current.json.workers.find((x) => x.workerId === worker.runId)
      return w.status === 'waiting' ? w : undefined
    })
    const closedTurn = await turn(
      ctx,
      orchestratorId,
      `CALL orchestrator_close ${JSON.stringify({ workerId: worker.runId })}`,
    )
    const closedTool = closedTurn.entries.filter((e) => e.kind === 'tool' && e.name === 'orchestrator_close').at(-1)
    assert.ok(closedTool, 'orchestrator_close ran')
    assert.equal(closedTool.status, 'done', JSON.stringify(closedTool))
    const after = await ctx.request('/api/orchestration')
    const done = after.json.workers.find((w) => w.workerId === worker.runId)
    assert.equal(done.status, 'done')
    assert.equal(done.scopeHeld, false)
    await ctx.request('/api/orchestration/stop', { method: 'POST', body: '{}' })
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: a restart turns stale running workers into interrupted work and wakes the orchestrator', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  let ctx = await runServer(dir)
  let orchestratorId
  let workerId
  try {
    const started = await ctx.request('/api/orchestration/start', { method: 'POST', body: '{}' })
    assert.equal(started.status, 201, started.text)
    orchestratorId = started.json.runId
    const spawn = await ctx.request(`/api/sessions/${encodeURIComponent(orchestratorId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({
        message: `CALL orchestrator_spawn ${JSON.stringify({ title: 'Restart me', task: 'DONE first pass', scope: ['src'] })}`,
      }),
    })
    assert.equal(spawn.status, 202, spawn.text)
    const worker = await waitFor(async () => {
      const listed = await ctx.request('/api/sessions')
      return listed.json.sessions.find((s) => s.kind === 'worker' && s.workerTitle === 'Restart me' && s.workerStatus === 'waiting')
    })
    workerId = worker.runId
  } finally {
    await ctx.close()
  }
  const statePath = path.join(ctx.handle.config.stateDir, 'orchestration.json')
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const stored = state.active.workers.find((w) => w.runId === workerId)
  stored.status = 'running'
  stored.lastReportStatus = 'done'
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')

  ctx = await runServer(dir)
  try {
    const interrupted = await waitFor(async () => {
      const current = await ctx.request('/api/orchestration')
      const w = current.json.workers.find((x) => x.workerId === workerId)
      return w?.status === 'interrupted' ? w : undefined
    })
    assert.match(interrupted.lastError, /restarted/)
    const notice = await waitFor(async () => {
      const s = await snapshot(ctx, orchestratorId)
      return s.entries.find((e) => e.kind === 'notice' && e.text.includes('[host restart]'))
    })
    assert.match(notice.text, /interrupted/)
    assert.match(notice.text, new RegExp(workerId))
    assert.match(notice.text, /orchestrator_workers/)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: a blocked worker is surfaced and cannot be closed as a normal success', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const started = await ctx.request('/api/orchestration/start', { method: 'POST', body: '{}' })
    assert.equal(started.status, 201, started.text)
    const orchestratorId = started.json.runId
    const spawn = await ctx.request(`/api/sessions/${encodeURIComponent(orchestratorId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({
        message: `CALL orchestrator_spawn ${JSON.stringify({
          title: 'Blocked worker',
          task: 'BLOCK missing credentials',
          scope: ['src'],
        })}`,
      }),
    })
    assert.equal(spawn.status, 202, spawn.text)

    const worker = await waitFor(async () => {
      const list = await ctx.request('/api/sessions')
      return list.json.sessions.find(
        (s) => s.kind === 'worker' && s.workerTitle === 'Blocked worker' && s.workerStatus === 'blocked',
      )
    })
    const orchestration = await ctx.request('/api/orchestration')
    const card = orchestration.json.workers.find((w) => w.workerId === worker.runId)
    assert.equal(card.status, 'blocked')
    assert.equal(card.reportStatus, 'blocked')
    assert.match(card.blocker, /missing credentials/)

    const report = await waitFor(async () => {
      const s = await snapshot(ctx, orchestratorId)
      return s.entries.find((e) => e.kind === 'notice' && e.text.includes('[worker report]'))
    })
    assert.match(report.text, /status: blocked/)
    assert.match(report.text, /blocker: missing credentials/)
    assert.match(report.text, /BLOCKED_BY: missing credentials/)
    assert.match(report.text, /do not present it as done/i)

    // The mock orchestrator does not mention the blocker, so the host must
    // surface it even when the model forgets.
    const guard = await waitFor(async () => {
      const s = await snapshot(ctx, orchestratorId)
      return s.entries.find((e) => e.kind === 'notice' && e.text.includes('[unresolved blockers]'))
    })
    assert.match(guard.text, /Blocked worker/)
    assert.match(guard.text, /missing credentials/)
    assert.match(guard.text, /not complete/i)

    await waitFor(async () => {
      const s = await snapshot(ctx, orchestratorId)
      return s.state.busy ? undefined : true
    })
    const refused = await ctx.request(`/api/sessions/${encodeURIComponent(orchestratorId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({
        message: `CALL orchestrator_close ${JSON.stringify({ workerId: worker.runId })}`,
      }),
    })
    assert.equal(refused.status, 202, refused.text)
    const closeError = await waitFor(async () => {
      const s = await snapshot(ctx, orchestratorId)
      if (s.state.busy) return undefined
      return s.entries.find((e) => e.kind === 'tool' && e.name === 'orchestrator_close' && e.status === 'error')
    })
    assert.match(closeError.output, /blocked/)
    assert.match(closeError.output, /summary/)
    const stillBlocked = await ctx.request('/api/orchestration')
    assert.equal(
      stillBlocked.json.workers.find((w) => w.workerId === worker.runId).status,
      'blocked',
      'a refused close must not mark the worker done',
    )

    const closed = await ctx.request(`/api/sessions/${encodeURIComponent(orchestratorId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({
        message: `CALL orchestrator_close ${JSON.stringify({
          workerId: worker.runId,
          summary: 'Blocked on missing credentials; the user must provide them.',
        })}`,
      }),
    })
    assert.equal(closed.status, 202, closed.text)
    const done = await waitFor(async () => {
      const s = await snapshot(ctx, orchestratorId)
      if (s.state.busy) return undefined
      const current = await ctx.request('/api/orchestration')
      const w = current.json.workers.find((x) => x.workerId === worker.runId)
      return w.status === 'done' ? w : undefined
    })
    assert.equal(done.status, 'done')
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('web GUI: the orchestrator cannot approve an unconfined worker command; the user can decide it', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const started = await ctx.request('/api/orchestration/start', { method: 'POST', body: '{}' })
    assert.equal(started.status, 201, started.text)
    const orchestratorId = started.json.runId
    const spawn = await ctx.request(`/api/sessions/${encodeURIComponent(orchestratorId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({
        message: `CALL orchestrator_spawn ${JSON.stringify({ title: 'Installer', task: 'CALL shell {"command":"npm install"}', scope: ['src'] })}`,
      }),
    })
    assert.equal(spawn.status, 202, spawn.text)
    const worker = await waitFor(async () => {
      const list = await ctx.request('/api/sessions')
      return list.json.sessions.find((s) => s.kind === 'worker' && s.workerTitle === 'Installer')
    })
    const approval = await waitFor(async () => {
      const s = await snapshot(ctx, worker.runId)
      return s.entries.find((e) => e.kind === 'approval')
    })
    assert.equal(approval.request.sandbox, 'unconfined')
    await waitFor(async () => {
      const current = await snapshot(ctx, orchestratorId)
      return current.state.busy ? undefined : true
    })

    // The orchestrator (a model) is refused.
    const tryApprove = await ctx.request(`/api/sessions/${encodeURIComponent(orchestratorId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({
        message: `CALL orchestrator_approve ${JSON.stringify({ workerId: worker.runId, requestId: approval.requestId, approved: true })}`,
      }),
    })
    assert.equal(tryApprove.status, 202, tryApprove.text)
    const refused = await waitFor(async () => {
      const s = await snapshot(ctx, orchestratorId)
      if (s.state.busy) return undefined
      return s.entries.find((e) => e.kind === 'tool' && e.name === 'orchestrator_approve')
    })
    assert.equal(refused.status, 'error', JSON.stringify(refused))
    assert.match(refused.output, /only the user can approve it/)
    assert.equal((await snapshot(ctx, worker.runId)).entries.filter((e) => e.kind === 'approval' && e.decision).length, 0, 'still pending')

    // The user decides it from the worker chat (denied here, so nothing is installed).
    const denied = await ctx.request(`/api/sessions/${encodeURIComponent(worker.runId)}/approval`, {
      method: 'POST',
      body: JSON.stringify({ requestId: approval.requestId, approved: false, reason: 'not now' }),
    })
    assert.equal(denied.status, 200, denied.text)
    const tool = await waitFor(async () => {
      const s = await snapshot(ctx, worker.runId)
      const t = s.entries.find((e) => e.kind === 'tool' && e.name === 'shell')
      return t && t.status === 'error' ? t : undefined
    })
    assert.match(tool.output, /not approved/)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
// WP-60: a generated chat name. The mock provider never answers a title
// request, so the deterministic fallback is what the API and the list show.
test('web GUI: a chat name is generated on request and a manual name wins', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const runId = await newSession(ctx)
    // A chat with no user message has nothing to name.
    const empty = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/title/generate`, { method: 'POST', body: '{}' })
    assert.equal(empty.status, 409, empty.text)

    await turn(ctx, runId, 'Fix the flaky login test in the uploader. Then run the suite.')
    const generated = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/title/generate`, {
      method: 'POST',
      body: JSON.stringify({ from: 'all' }),
    })
    assert.equal(generated.status, 200, generated.text)
    assert.equal(generated.json.title, 'Fix the flaky login test in the uploader')
    assert.equal(generated.json.source, 'heuristic')
    assert.match(generated.json.reason, /mock provider/)
    assert.equal(generated.json.effective, generated.json.title)

    // The list carries the generated name next to the first message.
    const listed = await ctx.request('/api/sessions')
    const summary = listed.json.sessions.find((s) => s.runId === runId)
    assert.equal(summary.generatedTitle, generated.json.title)
    assert.equal(summary.title, undefined)

    // A manual name wins, and the generated one survives as the fallback.
    const renamed = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/title`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Login fix' }),
    })
    assert.equal(renamed.status, 200, renamed.text)
    const after = (await ctx.request('/api/sessions')).json.sessions.find((s) => s.runId === runId)
    assert.equal(after.title, 'Login fix')
    assert.equal(after.generatedTitle, generated.json.title)

    // Regenerating does not steal the manual name.
    const again = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/title/generate`, { method: 'POST', body: '{}' })
    assert.equal(again.status, 200, again.text)
    assert.equal(again.json.effective, 'Login fix')

    const unknown = await ctx.request('/api/sessions/run-missing/title/generate', { method: 'POST', body: '{}' })
    assert.equal(unknown.status, 404)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
// WP-60: timings are measured live, written once per turn, and restored from
// the log after a restart (the numbers must not silently reset).
test('web GUI: session timings are measured and survive a restart', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  let ctx = await runServer(dir)
  try {
    const stateDir = (await ctx.request('/api/bootstrap')).json.workspace.stateDir
    const runId = await newSession(ctx)
    // The mock calls one tool, so both the provider and the tool are timed.
    await turn(ctx, runId, 'CALL read_file {"path":"README.md"}')
    const result = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/stats`)
    assert.equal(result.status, 200, result.text)
    const stats = result.json.stats
    assert.equal(stats.turns, 1)
    assert.ok(stats.steps >= 1, JSON.stringify(stats))
    assert.ok(stats.llmMs >= 0)
    assert.ok(stats.toolMs >= 0)
    assert.ok(stats.lastTurnMs > 0)
    assert.ok(stats.firstResponseMs >= 0)
    assert.equal(stats.tools.read_file.calls, 1, JSON.stringify(stats.tools))
    assert.equal(stats.tools.read_file.errors, 0)

    // The snapshot is in the log, not only in memory.
    const events = readEvents(sessionLogPath(stateDir))
    const snapshots = events.filter((event) => event.type === 'session/stats' && event.runId === runId)
    assert.equal(snapshots.length, 1, `expected one snapshot, got ${snapshots.length}`)
    assert.equal(snapshots[0].payload.turns, 1)

    // A restart reads the same numbers back.
    await ctx.close()
    ctx = await runServer(dir)
    const restored = (await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/stats`)).json.stats
    assert.equal(restored.turns, stats.turns)
    assert.equal(restored.steps, stats.steps)
    assert.equal(restored.tools.read_file.calls, 1)
    assert.equal(restored.lastTurnMs, stats.lastTurnMs)

    const unknown = await ctx.request('/api/sessions/run-missing/stats')
    assert.equal(unknown.status, 404)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
// WP-60: a fork copies the history into a new run and keeps the original
// intact; both chats continue independently.
test('web GUI: a chat forks into a new run with the same history', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const source = await newSession(ctx)
    await turn(ctx, source, 'CALL read_file {"path":"README.md"}')
    const before = await snapshot(ctx, source)

    const forked = await ctx.request(`/api/sessions/${encodeURIComponent(source)}/fork`, { method: 'POST', body: '{}' })
    assert.equal(forked.status, 201, forked.text)
    assert.equal(forked.json.forkedFrom, source)
    const copy = forked.json.runId
    assert.notEqual(copy, source)

    // The copy has the same user turn and answer, and is idle.
    const copySnapshot = await snapshot(ctx, copy)
    assert.equal(copySnapshot.state.busy, false)
    const userText = (snapshot) => snapshot.entries.filter((e) => e.kind === 'user').map((e) => e.text)
    const assistantText = (snapshot) => snapshot.entries.filter((e) => e.kind === 'assistant').map((e) => e.text)
    assert.deepEqual(userText(copySnapshot), userText(before))
    assert.deepEqual(assistantText(copySnapshot), assistantText(before))

    // The list marks the provenance and the original still has one turn.
    const listed = (await ctx.request('/api/sessions')).json.sessions
    assert.equal(listed.find((s) => s.runId === copy).forkedFrom, source)
    assert.equal(listed.find((s) => s.runId === source).forkedFrom, undefined)
    assert.equal((await snapshot(ctx, source)).state.turns, 1)

    // The fork continues on its own.
    const continued = await turn(ctx, copy, 'SAY hello from the fork')
    assert.equal(userText(continued).length, 2)
    assert.match(String(assistantText(continued).at(-1)), /hello from the fork/)
    assert.equal(userText(await snapshot(ctx, source)).length, 1)

    const missing = await ctx.request('/api/sessions/run-missing/fork', { method: 'POST', body: '{}' })
    assert.equal(missing.status, 404)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
// WP-60: `@` references offer files and earlier chats; a `@session:` reference
// is expanded into labelled, bounded context for the model but not for the chat.
test('web GUI: @session references and folder drill-down', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  fs.mkdirSync(path.join(dir, 'docs'))
  fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n', 'utf8')
  const ctx = await runServer(dir)
  try {
    const first = await newSession(ctx)
    await turn(ctx, first, 'SAY the login bug is fixed')

    // The `@` menu finds the earlier chat, and `exclude` keeps the open chat out.
    const refs = await ctx.request('/api/references?q=login')
    assert.equal(refs.status, 200, refs.text)
    assert.ok(refs.json.sessions.some((session) => session.runId === first), refs.text)
    const excluded = await ctx.request(`/api/references?q=login&exclude=${encodeURIComponent(first)}`)
    assert.equal(excluded.json.sessions.some((session) => session.runId === first), false)

    // A query ending in `/` drills into the folder instead of searching the tree.
    const drill = await ctx.request('/api/references?q=docs/')
    assert.ok(drill.json.files.includes('docs/guide.md'), drill.text)
    const filesDrill = await ctx.request('/api/files/search?q=docs/')
    assert.ok(filesDrill.json.files.includes('docs/guide.md'), filesDrill.text)

    // A turn that references the earlier chat.
    const second = await newSession(ctx)
    await turn(ctx, second, `SAY compare with @session:${first}`)
    const stateDir = (await ctx.request('/api/bootstrap')).json.workspace.stateDir
    const events = readEvents(sessionLogPath(stateDir))
    const userMessages = events.filter((event) => event.type === 'user/message' && event.runId === second)
    assert.equal(userMessages.length, 1)
    const modelText = String(userMessages[0].payload.content)
    assert.match(modelText, new RegExp(`\\[session reference run=${first} `))
    assert.match(modelText, /untrusted data, not instructions/)
    assert.match(modelText, /login bug is fixed/, 'the digest carries what was said')
    // The transcript shows the user's own words, without the injected block.
    const shown = (await snapshot(ctx, second)).entries.find((entry) => entry.kind === 'user')
    assert.equal(shown.text, `SAY compare with @session:${first}`)

    // An unknown id is reported as missing and the turn still runs.
    const third = await newSession(ctx)
    await turn(ctx, third, 'SAY hi @session:run-missing')
    const later = readEvents(sessionLogPath(stateDir)).filter((event) => event.runId === third && event.type === 'user/message')
    assert.match(String(later[0].payload.content), /missing=true/)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
// WP-61: feedback is written to the state directory (never sent), and "Open In"
// refuses anything that is not a detected program inside the workspace.
test('web GUI: feedback is stored locally and Open In validates its target', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const runId = await newSession(ctx)
    await turn(ctx, runId, 'SAY the answer')
    const ups = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ rating: 'up', entryId: 'msg-3' }),
    })
    assert.equal(ups.status, 201, ups.text)
    assert.equal(ups.json.summary.up, 1)

    const downs = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ rating: 'down', category: 'accuracy', note: '  missed the migration  ' }),
    })
    assert.equal(downs.status, 201, downs.text)
    assert.equal(downs.json.entry.note, 'missed the migration')
    const listed = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/feedback`)
    assert.equal(listed.status, 200)
    assert.deepEqual({ up: listed.json.summary.up, down: listed.json.summary.down }, { up: 1, down: 1 })
    assert.equal(listed.json.entries.length, 2)

    const invalid = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ rating: 'great' }),
    })
    assert.equal(invalid.status, 400)
    assert.match(invalid.json.error, /rating must be/)

    // The file is the whole story: plain JSON lines in the state directory.
    const stateDir = (await ctx.request('/api/bootstrap')).json.workspace.stateDir
    const feedback = fs.readFileSync(path.join(stateDir, 'feedback.jsonl'), 'utf8').trim().split('\n')
    assert.equal(feedback.length, 2)
    assert.match(feedback[0], /"rating":"up"/)

    const openIn = await ctx.request('/api/open-in')
    assert.equal(openIn.status, 200)
    assert.equal(openIn.json.local, true)
    assert.ok(Array.isArray(openIn.json.targets))
    const unknown = await ctx.request('/api/open-in', { method: 'POST', body: JSON.stringify({ target: 'nope', path: 'README.md' }) })
    assert.equal(unknown.status, 400)
    assert.match(unknown.json.error, /unknown target/)
    const escape = await ctx.request('/api/open-in', { method: 'POST', body: JSON.stringify({ target: openIn.json.targets[0]?.id ?? 'nope', path: '../../outside.txt' }) })
    assert.equal(escape.status, 404)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
// WP-62: telemetry is opt-in and carries identifiers, timings and counts only.
test('web GUI: opt-in telemetry posts spans without content', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const http = await import('node:http')
  const bodies = []
  const collector = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      bodies.push(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve))
  collector.unref()
  const port = collector.address().port
  const dir = fixture()
  // Off by default: the same turn sends nothing.
  const quiet = await runServer(dir)
  try {
    const quietRun = await newSession(quiet)
    await turn(quiet, quietRun, 'SAY no telemetry')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(bodies.length, 0, 'telemetry must be off unless configured')
  } finally {
    await quiet.close()
  }
  const ctx = await runServer(dir, {}, { telemetry: { enabled: true, endpoint: `http://127.0.0.1:${port}` } })
  try {
    const runId = await newSession(ctx)
    await turn(ctx, runId, 'CALL read_file {"path":"README.md"}')
    await waitFor(async () => (bodies.length > 0 ? true : undefined), 20_000)
    const spans = bodies.flatMap((body) => {
      const parsed = JSON.parse(body)
      return parsed.resourceSpans[0].scopeSpans[0].spans
    })
    const names = spans.map((span) => span.name)
    assert.ok(names.includes('hy.step'), names.join(','))
    assert.ok(names.includes('hy.tool'), names.join(','))
    assert.ok(names.includes('hy.turn'), names.join(','))
    const toolSpan = spans.find((span) => span.name === 'hy.tool')
    const attributes = Object.fromEntries(toolSpan.attributes.map((attribute) => [attribute.key, attribute.value]))
    assert.equal(attributes['hy.tool'].stringValue, 'read_file')
    assert.equal(attributes['hy.run_id'].stringValue, runId)
    // Nothing read, said or written is in the payload.
    const payload = JSON.stringify(spans)
    assert.equal(payload.includes('README.md'), false)
    assert.equal(payload.includes('Web Fixture'), false)
    assert.equal(payload.includes('content'), false)
    // The turn span reports counts, not tokens from a provider that cannot price.
    const turnSpan = spans.find((span) => span.name === 'hy.turn')
    assert.ok(turnSpan.endTimeUnixNano > turnSpan.startTimeUnixNano)
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 250))
    await ctx.close()
    collector.closeAllConnections?.()
    await new Promise((resolve) => collector.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
