// WP-23: `todo_write` and `present` over the real HTTP API. The todo list must
// survive a reload (and a restart), and a presented file becomes an artifact
// card in the transcript that the GUI can open.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-present-it-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Present fixture\n\nA repository for the artifact test.\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'report.md'), '# Report\n\nline one\nline two\n', 'utf8')
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
  return { request, close }
}

async function newSession(ctx) {
  const created = await ctx.request('/api/sessions', { method: 'POST', body: '{}' })
  assert.equal(created.status, 201, created.text)
  return created.json.runId
}

async function turn(ctx, runId, message) {
  const started = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
  assert.equal(started.status, 202, started.text)
  await waitFor(async () => {
    const snap = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}`)
    return snap.json?.state?.busy === false
  }, 60_000)
  return (await ctx.request(`/api/sessions/${encodeURIComponent(runId)}`)).json
}

test('todo_write survives a reload and a restart', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fixture()
  let ctx = await runServer(dir)
  try {
    const runId = await newSession(ctx)
    const message =
      'CALL todo_write ' +
      JSON.stringify({
        todos: [
          { content: 'read the code', status: 'completed' },
          { content: 'fix the bug', status: 'in_progress' },
        ],
      })
    const snap = await turn(ctx, runId, message)
    const card = snap.entries.find((entry) => entry.kind === 'plan')
    assert.ok(card, 'the todo card is in the transcript')
    assert.deepEqual(
      card.plan.map((step) => [step.step, step.status]),
      [
        ['read the code', 'completed'],
        ['fix the bug', 'in_progress'],
      ],
    )
    const plan = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/plan`)
    assert.match(plan.json.plan, /fix the bug/)

    // A restart rebuilds the list from the log (the runtime is fresh).
    await ctx.close()
    ctx = await runServer(dir)
    const afterRestart = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/plan`)
    assert.match(afterRestart.json.plan, /read the code/)
    assert.match(afterRestart.json.plan, /fix the bug/)
    const transcript = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}`)
    assert.ok(transcript.json.entries.some((entry) => entry.kind === 'plan'), 'the card survives the reload')
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('present turns a workspace file into an artifact card', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const runId = await newSession(ctx)
    const message =
      'CALL present ' +
      JSON.stringify({ files: [{ path: 'docs/report.md', description: 'the finished report' }] })
    const snap = await turn(ctx, runId, message)
    const card = snap.entries.find((entry) => entry.kind === 'deliverables')
    assert.ok(card, 'the artifact card is in the transcript')
    assert.equal(card.files.length, 1)
    assert.equal(card.files[0].path, 'docs/report.md')
    assert.equal(card.files[0].description, 'the finished report')
    assert.equal(card.files[0].lines, 5, 'the card carries the real line count')
    assert.ok(card.files[0].size > 0)

    // The file is readable through the same API the Open button uses.
    const file = await ctx.request(`/api/files?path=${encodeURIComponent('docs/report.md')}&root=main`)
    assert.equal(file.status, 200, file.text)
    assert.match(file.json.content, /line one/)

    // A path outside the workspace is refused (the card must stay honest).
    const outside = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/reveal`, {
      method: 'POST',
      body: JSON.stringify({ path: '../secrets.txt' }),
    })
    assert.equal(outside.status, 400, outside.text)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
