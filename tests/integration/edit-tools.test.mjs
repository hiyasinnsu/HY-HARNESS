// WP-30: write_file / edit_file / read_image / working_directory over the real
// HTTP API, including the working directory surviving a restart.
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

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-edit-it-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Edit fixture\n\nA repository for the edit test.\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'report.md'), '# Report\n\nline one\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'pixel.png'), PNG)
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

/** One mock turn: `CALL <tool> <json>` runs exactly that tool, then answers. */
async function call(ctx, runId, tool, args) {
  const message = `CALL ${tool} ${JSON.stringify(args)}`
  const started = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
  assert.equal(started.status, 202, started.text)
  const snap = await waitFor(async () => {
    const current = (await ctx.request(`/api/sessions/${encodeURIComponent(runId)}`)).json
    return current?.state?.busy === false ? current : undefined
  }, 60_000)
  const cards = snap.entries.filter((entry) => entry.kind === 'tool')
  return cards.at(-1)
}

const logText = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .filter((name) => String(name).endsWith('.jsonl'))
    .map((name) => fs.readFileSync(path.join(dir, String(name)), 'utf8'))
    .join('\n')

test('write_file and edit_file change the workspace through the tool API', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 180_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const runId = await newSession(ctx)
    const wrote = await call(ctx, runId, 'write_file', { file: 'notes.md', content: '# Notes\n\nwritten by the harness\n' })
    assert.notEqual(wrote.isError, true, wrote.output)
    assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), '# Notes\n\nwritten by the harness\n')

    // apply_patch's read-before-edit rule applies to edit_file as well.
    const editWithoutRead = await call(ctx, runId, 'edit_file', { file: 'README.md', old: 'A repository', new: 'The repository' })
    assert.equal(editWithoutRead.isError, true)
    assert.match(editWithoutRead.output, /read_file is required/)
    const read = await call(ctx, runId, 'read_file', { path: 'README.md' })
    assert.notEqual(read.isError, true, read.output)
    const edited = await call(ctx, runId, 'edit_file', { file: 'README.md', old: 'A repository', new: 'The repository' })
    assert.notEqual(edited.isError, true, edited.output)
    assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /The repository for the edit test\./)

    // A miss explains itself instead of guessing.
    const missing = await call(ctx, runId, 'edit_file', { file: 'README.md', old: 'A repository', new: 'x' })
    assert.equal(missing.isError, true)
    assert.match(missing.output, /not found/)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('working_directory moves reads and the shell, and survives a restart', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 180_000, concurrency: false }, async () => {
  const dir = fixture()
  let ctx = await runServer(dir)
  try {
    const runId = await newSession(ctx)
    const moved = await call(ctx, runId, 'working_directory', { path: 'docs' })
    assert.notEqual(moved.isError, true, moved.output)
    assert.match(moved.output, /docs/)

    // Relative paths now resolve inside docs/.
    const read = await call(ctx, runId, 'read_file', { path: 'report.md' })
    assert.notEqual(read.isError, true, read.output)
    assert.match(read.output, /docs\/report\.md/)

    // The shell's default cwd follows the session.
    const shell = await call(ctx, runId, 'shell', { command: 'Get-Location | Select-Object -ExpandProperty Path' })
    assert.notEqual(shell.isError, true, shell.output)
    assert.match(shell.output, /docs/i)

    // The switch is durable.
    assert.match(logText(dir), /"type":"session\/cwd"/)
    await ctx.close()
    ctx = await runServer(dir)
    const afterRestart = await call(ctx, runId, 'read_file', { path: 'report.md' })
    assert.notEqual(afterRestart.isError, true, afterRestart.output)
    assert.match(afterRestart.output, /docs\/report\.md/)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('read_image returns metadata and attaches the bytes', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const runId = await newSession(ctx)
    const card = await call(ctx, runId, 'read_image', { path: 'pixel.png' })
    assert.notEqual(card.isError, true, card.output)
    assert.match(card.output, /image\/png/)
    assert.match(card.output, /"width": 1/)
    // The base64 never becomes part of the transcript text.
    assert.doesNotMatch(card.output, /iVBORw0KGgo/)
    assert.match(logText(dir), /"type":"image\/attached"/)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
