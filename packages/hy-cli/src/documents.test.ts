import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DocumentError, findSoffice, previewDocument, resolvePreviewPath } from './documents.js'

/**
 * The converter test starts a `.cmd` shim through `cmd.exe` with piped stdio,
 * which a confined workspace may forbid (EPERM). Probe once and skip instead of
 * reporting a sandbox limitation as a product failure.
 */
function spawnBlockedReason(): string | undefined {
  try {
    const probe = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8', timeout: 15_000 })
    if (!probe.error) return undefined
    const code = (probe.error as NodeJS.ErrnoException).code
    return `spawning a child process with pipes is not available here (${code ?? probe.error.message})`
  } catch (error) {
    return `spawning a child process is not available here (${error instanceof Error ? error.message : String(error)})`
  }
}

const spawnBlocked = spawnBlockedReason()

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1')

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-docs-'))
  fs.mkdirSync(path.join(dir, 'docs'))
  fs.writeFileSync(path.join(dir, 'docs', 'pixel.png'), PNG)
  fs.writeFileSync(path.join(dir, 'docs', 'report.pdf'), PDF)
  fs.writeFileSync(path.join(dir, 'docs', 'memo.docx'), 'not really a docx')
  fs.writeFileSync(path.join(dir, 'docs', 'script.sh'), 'echo hi')
  return dir
}

test('PDFs and images are served as they are', () => {
  const dir = fixture()
  try {
    const stateDir = path.join(dir, 'state')
    const preview = previewDocument({ stateDir, workspaceRoot: dir, roots: [], rel: 'docs/report.pdf' })
    assert.equal(preview.kind, 'pdf')
    assert.equal(preview.contentType, 'application/pdf')
    assert.equal(preview.cached, false)
    assert.equal(fs.readFileSync(preview.file).toString('latin1'), PDF.toString('latin1'))

    const image = previewDocument({ stateDir, workspaceRoot: dir, roots: [], rel: 'docs/pixel.png' })
    assert.equal(image.kind, 'image')
    assert.equal(image.contentType, 'image/png')

    // Paths stay inside the workspace.
    assert.throws(() => previewDocument({ stateDir, workspaceRoot: dir, roots: [], rel: '../outside.pdf' }), /outside the workspace/)
    assert.throws(() => previewDocument({ stateDir, workspaceRoot: dir, roots: [], rel: 'docs/missing.pdf' }), /does not exist/)
    assert.throws(() => previewDocument({ stateDir, workspaceRoot: dir, roots: [], rel: 'docs/script.sh' }), (error: unknown) => {
      assert.ok(error instanceof DocumentError)
      assert.equal(error.status, 415)
      assert.match(error.message, /cannot be previewed/)
      return true
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an Office document without LibreOffice says so', () => {
  const dir = fixture()
  try {
    assert.throws(
      () => previewDocument({ stateDir: path.join(dir, 'state'), workspaceRoot: dir, roots: [], rel: 'docs/memo.docx', soffice: '' }),
      (error: unknown) => {
        assert.ok(error instanceof DocumentError)
        assert.equal(error.status, 415)
        assert.match(error.message, /LibreOffice is not installed/)
        return true
      },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a conversion is cached by content hash and failures are explained', { skip: spawnBlocked }, () => {
  const dir = fixture()
  try {
    const stateDir = path.join(dir, 'state')
    // A shim that behaves like `soffice --convert-to pdf --outdir DIR FILE`.
    const shimDir = path.join(dir, 'bin')
    fs.mkdirSync(shimDir)
    const body = [
      '@echo off',
      'set outdir=',
      'set infile=',
      ':loop',
      'if "%~1"=="" goto done',
      'if "%~1"=="--outdir" (set outdir=%~2& shift& shift& goto loop)',
      'set infile=%~1',
      'shift',
      'goto loop',
      ':done',
      'copy /y "%infile%" "%outdir%\\out.pdf" >nul',
      'exit /b 0',
      '',
    ].join('\r\n')
    const soffice = path.join(shimDir, 'soffice.cmd')
    fs.writeFileSync(soffice, body)

    const first = previewDocument({ stateDir, workspaceRoot: dir, roots: [], rel: 'docs/memo.docx', soffice })
    assert.equal(first.kind, 'pdf')
    assert.equal(first.cached, false)
    assert.ok(fs.existsSync(first.file))
    // The second call reuses the cache: the same file, marked cached.
    const second = previewDocument({ stateDir, workspaceRoot: dir, roots: [], rel: 'docs/memo.docx', soffice })
    assert.equal(second.file, first.file)
    assert.equal(second.cached, true)

    // A converter that fails surfaces its stderr tail.
    const failing = path.join(shimDir, 'broken.cmd')
    fs.writeFileSync(failing, '@echo off\r\necho conversion exploded 1>&2\r\nexit /b 3\r\n')
    fs.writeFileSync(path.join(dir, 'docs', 'other.docx'), 'another one')
    assert.throws(
      () => previewDocument({ stateDir, workspaceRoot: dir, roots: [], rel: 'docs/other.docx', soffice: failing }),
      (error: unknown) => {
        assert.ok(error instanceof DocumentError)
        assert.equal(error.status, 422)
        assert.match(error.message, /converting other\.docx failed/)
        return true
      },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a junction inside the workspace cannot preview a file outside it', () => {
  const dir = fixture()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-doc-outside-'))
  try {
    fs.writeFileSync(path.join(outside, 'secret.pdf'), PDF)
    fs.symlinkSync(outside, path.join(dir, 'link'), 'junction')
    assert.throws(() => resolvePreviewPath(dir, [], 'link/secret.pdf'), (e: unknown) => e instanceof DocumentError && /outside the workspace/.test(e.message))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('root-qualified previews and detection helpers behave', () => {
  const dir = fixture()
  try {
    const extra = path.join(dir, 'extra')
    fs.mkdirSync(extra)
    fs.writeFileSync(path.join(extra, 'shared.pdf'), PDF)
    const resolved = resolvePreviewPath(dir, [{ id: 'extra', path: extra }], 'root:extra/shared.pdf')
    assert.equal(fs.realpathSync.native(resolved), fs.realpathSync.native(path.join(extra, 'shared.pdf')))
    // Detection returns a path or undefined; HY_SOFFICE wins when it exists.
    assert.equal(typeof findSoffice() === 'string' || findSoffice() === undefined, true)
    const previous = process.env.HY_SOFFICE
    try {
      process.env.HY_SOFFICE = path.join(extra, 'shared.pdf')
      assert.equal(findSoffice(), path.join(extra, 'shared.pdf'))
    } finally {
      if (previous === undefined) delete process.env.HY_SOFFICE
      else process.env.HY_SOFFICE = previous
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
