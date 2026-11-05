// WP-52: document previews over the HTTP API. Images and PDFs are served as
// they are, Office documents are converted when a converter is available, and
// the absence of one is an explicit 415 rather than a broken page.
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
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1')

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-docs-it-'))
  fs.mkdirSync(path.join(dir, 'docs'))
  fs.writeFileSync(path.join(dir, 'docs', 'pixel.png'), PNG)
  fs.writeFileSync(path.join(dir, 'docs', 'report.pdf'), PDF)
  fs.writeFileSync(path.join(dir, 'docs', 'memo.docx'), 'pretend docx')
  fs.writeFileSync(path.join(dir, 'README.md'), '# Docs fixture\n')
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  return dir
}

async function runServer(dir, env = {}) {
  const previous = { HY_CONFIG_DIR: process.env.HY_CONFIG_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA, HY_SOFFICE: process.env.HY_SOFFICE }
  process.env.HY_CONFIG_DIR = path.join(dir, 'config')
  process.env.LOCALAPPDATA = path.join(dir, 'localappdata')
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  const handle = await startWebServer({ overrides: { cwd: dir, mock: true }, port: 0, open: false, log: () => {} })
  const auth = { Authorization: `Bearer ${handle.token}` }
  const request = async (route) => {
    const response = await fetch(new URL(route, handle.url), { headers: auth })
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) }
  }
  const created = await fetch(new URL('/api/sessions', handle.url), {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: '{}',
  })
  const session = (await created.json()).runId
  const close = async () => {
    await handle.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const preview = (rel) => request(`/api/sessions/${encodeURIComponent(session)}/document?path=${encodeURIComponent(rel)}`)
  return { request, preview, close, session }
}

test('images and PDFs preview as they are; Office says when it cannot convert', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 180_000, concurrency: false }, async () => {
  const dir = fixture()
  const ctx = await runServer(dir)
  try {
    const image = await ctx.preview('docs/pixel.png')
    assert.equal(image.status, 200, image.body.toString().slice(0, 120))
    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.deepEqual(image.body, PNG)

    const pdf = await ctx.preview('docs/report.pdf')
    assert.equal(pdf.status, 200)
    assert.equal(pdf.headers.get('content-type'), 'application/pdf')
    assert.deepEqual(pdf.body, PDF)

    // No converter (HY_SOFFICE unset) unless this machine really has LibreOffice.
    const office = await ctx.preview('docs/memo.docx')
    if (office.status === 200) {
      assert.equal(office.headers.get('content-type'), 'application/pdf')
      assert.equal(office.body.subarray(0, 4).toString(), '%PDF')
    } else {
      assert.equal(office.status, 415)
      assert.match(JSON.parse(office.body.toString()).error, /LibreOffice is not installed/)
    }

    const missing = await ctx.preview('docs/nope.pdf')
    assert.equal(missing.status, 404)
    const outside = await ctx.preview('../escape.pdf')
    assert.equal(outside.status, 400)
    const unsupported = await ctx.preview('README.md')
    assert.equal(unsupported.status, 415)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a converter on HY_SOFFICE converts and caches the PDF', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 180_000, concurrency: false }, async () => {
  const dir = fixture()
  // A shim that copies the input to `<outdir>/converted.pdf`.
  const shim = path.join(dir, 'soffice.cmd')
  fs.writeFileSync(
    shim,
    [
      '@echo off',
      'set outdir=',
      ':loop',
      'if "%~1"=="" goto done',
      'if "%~1"=="--outdir" (set outdir=%~2& shift& shift& goto loop)',
      'set infile=%~1',
      'shift',
      'goto loop',
      ':done',
      'copy /y "%infile%" "%outdir%\\converted.pdf" >nul',
      'exit /b 0',
      '',
    ].join('\r\n'),
  )
  const ctx = await runServer(dir, { HY_SOFFICE: shim })
  try {
    const first = await ctx.preview('docs/memo.docx')
    assert.equal(first.status, 200, first.body.toString().slice(0, 200))
    assert.equal(first.headers.get('content-type'), 'application/pdf')
    assert.equal(first.headers.get('x-hy-preview-cached'), '0')
    assert.deepEqual(first.body, Buffer.from('pretend docx'))
    const second = await ctx.preview('docs/memo.docx')
    assert.equal(second.status, 200)
    assert.equal(second.headers.get('x-hy-preview-cached'), '1')
    assert.deepEqual(second.body, first.body)
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
