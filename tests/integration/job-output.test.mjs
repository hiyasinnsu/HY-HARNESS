// `GET /api/sessions/:id/jobs/:jobId/output`: byte-offset paging of a running
// and a finished job's log, including multibyte text, plus query validation.
//
// The daemon guarantees that a page never ends inside a UTF-8 (or CP932)
// character. Without it, `decode_output` fails UTF-8 validation for the whole
// page and re-reads it as Shift_JIS, so Japanese output arrives as mojibake.
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

// 'あいうえお' built from code points so this file stays readable in any editor.
const CHAR = String.fromCodePoint(0x3042, 0x3044, 0x3046, 0x3048, 0x304a)
const EXPECTED = CHAR.repeat(30_000) // 150,000 characters, 450,000 UTF-8 bytes

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-job-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Job output fixture\n', 'utf8')
  fs.writeFileSync(
    path.join(dir, 'emit.js'),
    `process.stdout.write(String.fromCodePoint(0x3042, 0x3044, 0x3046, 0x3048, 0x304a).repeat(30000))\nconst end = Date.now() + 1500\nwhile (Date.now() < end) {}\n`,
    'utf8',
  )
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

const describePage = (page) =>
  `len=${page?.data?.length} next=${page?.nextOffset} total=${page?.totalBytes} eof=${page?.eof}`

test('job output: pages join back into the original multibyte stream', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const created = await ctx.request('/api/sessions', { method: 'POST', body: '{}' })
    assert.equal(created.status, 201, created.text)
    const runId = created.json.runId

    const accepted = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: 'CALL shell {"command":"node emit.js","foregroundWaitMs":50}' }),
    })
    assert.equal(accepted.status, 202, accepted.text)

    const jobId = await waitFor(async () => {
      const jobs = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/jobs`)
      if (jobs.status !== 200) return undefined
      return jobs.json.jobs[0]?.jobId
    }, 60_000)
    const base = `/api/sessions/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}/output`

    // A live job's current end is not authoritative: the page must still end on
    // a character boundary, or the whole page decodes as Shift_JIS.
    const live = await waitFor(async () => {
      const page = await ctx.request(`${base}?offset=0`)
      if (page.status !== 200) return undefined
      return (page.json.totalBytes ?? 0) >= 32_768 ? page : undefined
    }, 30_000)
    assert.equal(live.status, 200, live.text)
    assert.equal(live.json.data.includes('\uFFFD'), false, `a live page split a character: ${describePage(live.json)}`)
    assert.ok(live.json.data.startsWith(CHAR), 'a live page is not the start of the stream')
    assert.equal(live.json.eof, false)

    await waitFor(async () => {
      const jobs = await ctx.request(`/api/sessions/${encodeURIComponent(runId)}/jobs`)
      const job = jobs.json.jobs.find((j) => j.jobId === jobId)
      return job && job.status !== 'running' ? job : undefined
    }, 60_000)

    let offset = 0
    let text = ''
    let pages = 0
    let total
    for (;;) {
      const page = await ctx.request(`${base}?offset=${offset}`)
      assert.equal(page.status, 200, page.text)
      assert.ok(page.json.data.length <= 65_536, `page of ${page.json.data.length} bytes`)
      assert.equal(page.json.data.includes('\uFFFD'), false, `a page split a character: ${describePage(page.json)}`)
      text += page.json.data
      total ??= page.json.totalBytes
      assert.equal(page.json.totalBytes, total)
      pages += 1
      assert.ok(pages < 50, 'paging did not terminate')
      if (page.json.data === '' && !page.json.eof) {
        // The job is still running and nothing new has been flushed yet.
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }      if (page.json.eof) break
      assert.ok(page.json.nextOffset > offset, `nextOffset ${page.json.nextOffset} did not advance from ${offset}`)
      offset = page.json.nextOffset
    }
    assert.ok(pages > 1, `expected the output to need more than one page, got ${pages}`)
    assert.ok(text.includes(EXPECTED), `joined pages lose the stream (${text.length} chars)`)
    assert.ok(total >= Buffer.byteLength(EXPECTED), `totalBytes ${total} is short`)

    // Query-string validation: a typo is the caller's error, not a 500.
    for (const bad of ['abc', '1.5', '-1', '1e999']) {
      const rejected = await ctx.request(`${base}?offset=${encodeURIComponent(bad)}`)
      assert.equal(rejected.status, 400, `offset=${bad} answered ${rejected.status}: ${rejected.text}`)
    }
    // Past the end is an empty, finished page rather than an error.
    const past = await ctx.request(`${base}?offset=${total + 1000}`)
    assert.equal(past.status, 200, past.text)
    assert.equal(past.json.data, '')
    assert.equal(past.json.eof, true)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
