// WP-22 (continuable subagents) over the real HTTP API: a background delegate
// starts an agent, the panel can list it, send it a follow-up turn, interrupt a
// running turn, and a restart turns a running agent into `interrupted`.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-agents-it-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Agents fixture\n\nA repository for the subagent test.\n', 'utf8')
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
  return { request, close }
}

const snapshot = (ctx, runId) => ctx.request(`/api/sessions/${encodeURIComponent(runId)}`)
const agentsOf = async (ctx, runId) => (await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/agents`)).json?.agents ?? []

async function newSession(ctx) {
  const created = await ctx.request('/api/sessions', { method: 'POST', body: '{}' })
  assert.equal(created.status, 201, created.text)
  return created.json.runId
}

async function waitIdle(ctx, runId) {
  await waitFor(async () => (await snapshot(ctx, runId)).json?.state?.busy === false, 60_000)
}

function delegateTurn(task, readOnly = true) {
  // The mock calls exactly one tool for a `CALL ...` objective.
  return JSON.stringify({ message: `CALL delegate ${JSON.stringify({ task, readOnly, background: true })}` })
}

test('a background subagent answers, takes a follow-up and can be closed', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 180_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const runId = await newSession(ctx)
    const started = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: delegateTurn('DONE helper work'),
    })
    assert.equal(started.status, 202, started.text)
    await waitIdle(ctx, runId)

    const agents = await waitFor(async () => {
      const list = await agentsOf(ctx, runId)
      return list.length === 1 && list[0].status === 'idle' ? list : undefined
    }, 60_000)
    const agent = agents[0]
    assert.equal(agent.agentId, `${runId}.sub1`)
    assert.equal(agent.task, 'DONE helper work')
    assert.equal(agent.readOnly, true)
    assert.equal(agent.background, true)
    assert.match(agent.final ?? '', /STATUS: done/)

    // A follow-up continues the same conversation (turns grow, not the id).
    const followed = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agent.agentId)}/message`, {
      method: 'POST',
      body: JSON.stringify({ message: 'SAY second answer' }),
    })
    assert.equal(followed.status, 202, followed.text)
    const afterFollowUp = await waitFor(async () => {
      const list = await agentsOf(ctx, runId)
      return list[0]?.status === 'idle' && list[0]?.final === 'second answer' ? list[0] : undefined
    }, 60_000)
    assert.equal(afterFollowUp.turns, 2)
    assert.equal(afterFollowUp.agentId, agent.agentId, 'the follow-up reuses the agent')

    // The log is the durable record of the whole exchange.
    const log = fs
      .readdirSync(dir, { recursive: true })
      .filter((name) => String(name).endsWith('.jsonl'))
      .map((name) => fs.readFileSync(path.join(dir, String(name)), 'utf8'))
      .join('\n')
    for (const type of ['agent/spawn', 'agent/message', 'agent/end']) assert.ok(log.includes(`"type":"${type}"`), type)

    const closed = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agent.agentId)}/close`, {
      method: 'POST',
    })
    assert.equal(closed.status, 200, closed.text)
    assert.equal(closed.json.agent.status, 'closed')
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a running subagent is interrupted by the API and by a restart', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 180_000, concurrency: false }, async () => {
  const dir = fixture()
  let ctx = await runServer(dir)
  const slow = 'CALL shell {"command":"Start-Sleep -Seconds 20"}'
  let runId = ''
  let agentId = ''
  try {
    runId = await newSession(ctx)
    const started = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: delegateTurn(slow, false),
    })
    assert.equal(started.status, 202, started.text)
    await waitIdle(ctx, runId)
    const running = await waitFor(async () => {
      const list = await agentsOf(ctx, runId)
      return list[0]?.status === 'running' ? list[0] : undefined
    }, 60_000)
    agentId = running.agentId

    const interrupted = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/interrupt`, {
      method: 'POST',
    })
    assert.equal(interrupted.status, 200, interrupted.text)
    assert.equal(interrupted.json.agent.status, 'interrupted')
    // The idempotent error is a conflict, not a crash.
    const again = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/interrupt`, {
      method: 'POST',
    })
    assert.equal(again.status, 409, again.text)

    // Start a second, slow turn and restart the server while it runs.
    const second = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/message`, {
      method: 'POST',
      body: JSON.stringify({ message: slow }),
    })
    assert.equal(second.status, 202, second.text)
    await waitFor(async () => (await agentsOf(ctx, runId))[0]?.status === 'running', 60_000)
    await ctx.close()
    ctx = await runServer(dir)
    const replayed = await waitFor(async () => {
      const list = await agentsOf(ctx, runId)
      return list.length === 1 ? list[0] : undefined
    }, 60_000)
    assert.equal(replayed.status, 'interrupted', 'a running agent cannot survive the restart')
    assert.equal(replayed.agentId, agentId)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
