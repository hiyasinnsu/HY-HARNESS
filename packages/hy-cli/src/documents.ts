import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * WP-52: document previews.
 *
 * PDFs and images are served as they are. Office documents are converted to PDF
 * with LibreOffice (`soffice`) **only when it is installed** — nothing is
 * bundled, so the UI can say "not available" instead of failing mysteriously.
 * Converted PDFs are cached under the state directory by the source's SHA-256.
 */
export class DocumentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'DocumentError'
  }
}

export type PreviewKind = 'pdf' | 'image'

export interface PreviewResult {
  kind: PreviewKind
  /** Absolute path of the file to serve. */
  file: string
  contentType: string
  /** True when the file came from the conversion cache. */
  cached: boolean
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const OFFICE_TYPES = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp'])

/** Resolves a preview path inside the workspace (or an added root). */
export function resolvePreviewPath(workspaceRoot: string, roots: readonly { id: string; path: string }[], rel: string): string {
  const raw = rel.replace(/\\/g, '/').trim()
  if (!raw) throw new DocumentError('path is required', 400)
  const rootMatch = /^root:([^/]+)\/(.+)$/.exec(raw)
  const base = rootMatch ? roots.find((root) => root.id === rootMatch[1])?.path : workspaceRoot
  if (!base) throw new DocumentError(`unknown root in ${rel}`, 404)
  const target = path.resolve(base, rootMatch ? rootMatch[2]! : raw)
  const baseReal = fs.realpathSync.native(base)
  const lexical = path.resolve(baseReal, path.relative(base, target))
  if (lexical !== baseReal && !lexical.startsWith(`${baseReal}${path.sep}`)) {
    throw new DocumentError(`${rel} is outside the workspace`, 400)
  }
  if (!fs.existsSync(lexical)) throw new DocumentError(`${rel} does not exist`, 404)
  // Check again after links resolve: a junction or symlink inside the
  // workspace can point outside it, which the string check above cannot see.
  const real = fs.realpathSync.native(lexical)
  if (!isInside(baseReal, real)) throw new DocumentError(`${rel} is outside the workspace`, 400)
  return real
}

function isInside(base: string, target: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const b = norm(base)
  const t = norm(target)
  return t === b || t.startsWith(b.endsWith(path.sep) ? b : `${b}${path.sep}`)
}

/** The LibreOffice executable, when this machine has one. */
export function findSoffice(): string | undefined {
  const fromEnv = process.env.HY_SOFFICE
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
          'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        ]
      : ['/usr/bin/soffice', '/usr/local/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  // Also accept one on PATH (a shim is how the tests provide it).
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['soffice'], { encoding: 'utf8' })
  const first = probe.status === 0 ? probe.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : undefined
  return first
}

/** SHA-256 of a file, used as the conversion cache key. */
function fileHash(file: string): string {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/**
 * Returns what to serve for a path: the file itself for PDF/images, or a cached
 * PDF conversion for Office documents.
 */
export function previewDocument(input: {
  stateDir: string
  workspaceRoot: string
  roots: readonly { id: string; path: string }[]
  rel: string
  /** Overrides LibreOffice detection; an empty string forces "unavailable" (tests). */
  soffice?: string
}): PreviewResult {
  const file = resolvePreviewPath(input.workspaceRoot, input.roots, input.rel)
  const ext = path.extname(file).toLowerCase()
  if (ext === '.pdf') return { kind: 'pdf', file, contentType: 'application/pdf', cached: false }
  const imageType = IMAGE_TYPES[ext]
  if (imageType) return { kind: 'image', file, contentType: imageType, cached: false }
  if (!OFFICE_TYPES.has(ext)) throw new DocumentError(`${ext || 'this file'} cannot be previewed (PDF, images and Office documents only)`, 415)

  const soffice = input.soffice === undefined ? findSoffice() : input.soffice || undefined
  if (!soffice) {
    throw new DocumentError(
      'LibreOffice is not installed, so Office documents cannot be converted. Install it (or set HY_SOFFICE) to preview .docx/.xlsx/.pptx.',
      415,
    )
  }
  const cacheDir = path.join(input.stateDir, 'preview')
  fs.mkdirSync(cacheDir, { recursive: true })
  const cached = path.join(cacheDir, `${fileHash(file)}.pdf`)
  if (fs.existsSync(cached)) return { kind: 'pdf', file: cached, contentType: 'application/pdf', cached: true }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-preview-'))
  try {
    // A `.cmd`/`.bat` wrapper needs cmd.exe; a real executable is spawned
    // directly. Batch files get an explicitly quoted command line instead of
    // `shell: true` (which would concatenate the arguments unescaped).
    const args = ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, file]
    const result = /\.(cmd|bat)$/i.test(soffice)
      ? // A batch wrapper runs through cmd.exe; the arguments stay separate argv
        // entries, so nothing is concatenated into an unescaped shell string.
        spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', soffice, ...args], { encoding: 'utf8', timeout: 120_000 })
      : spawnSync(soffice, args, { encoding: 'utf8', timeout: 120_000 })
    const produced = fs.readdirSync(outDir).find((name) => name.toLowerCase().endsWith('.pdf'))
    const producedPath = produced ? path.join(outDir, produced) : undefined
    if (result.status !== 0 || !producedPath || !fs.existsSync(producedPath)) {
      const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split(/\r?\n/).slice(-3).join(' ')
      throw new DocumentError(`converting ${path.basename(file)} failed${detail ? `: ${detail}` : ''}`, 422)
    }
    fs.copyFileSync(producedPath, cached)
    return { kind: 'pdf', file: cached, contentType: 'application/pdf', cached: false }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
}
