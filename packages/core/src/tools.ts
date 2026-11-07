import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ExecResult, PatchApplyResult, SandboxMode } from './protocol.js'
import { ExecRpcClient, ExecRpcError } from './exec-rpc.js'
import { TOOLS_BY_NAME, TOOLS_BY_SDK, deferredTools, jsonSchemaToTs, validate, type ToolSpec } from './tool-registry.js'
import type { Ledger } from './ledger.js'
import { isIgnored, parseGitignore, type IgnoreRule } from './gitignore.js'
import { loadSkill, type SkillInfo } from './skills.js'
import type { McpManager } from './mcp.js'
import type { Hooks } from './hooks.js'
import { hostAllowed, webFetch, webSearch, type WebConfig } from './web.js'
import type { LspManager, LspOp } from './lsp.js'
import type { LoadedPlugins } from './plugins.js'
import type { MemoryStore } from './memory.js'
import type { WorkspaceRootConfig } from './config.js'

/** True when a tool schema itself declares an `args` property (e.g. mcp_call). */
function schemaAllowsArg(schema: ToolSpec['input'], key: string): boolean {
  if (schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, key)) return true
  return schema.anyOf?.some((child) => schemaAllowsArg(child, key)) ?? false
}

/**
 * Some models wrap the argument object twice (`{ args: { command } }`) or send
 * it as a JSON string. Unwrap that shape for tools that do not declare a real
 * `args` field. `mcp_call` is left alone because `args` is meaningful there.
 */
export function normalizeToolArgs(spec: ToolSpec, input: Record<string, unknown>): Record<string, unknown> {
  let args = { ...input }
  for (let depth = 0; depth < 3; depth += 1) {
    if (args.args === undefined || schemaAllowsArg(spec.input, 'args')) break
    let inner: unknown = args.args
    if (typeof inner === 'string') {
      try {
        inner = JSON.parse(inner)
      } catch {
        break
      }
    }
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) break
    const merged: Record<string, unknown> = { ...(inner as Record<string, unknown>) }
    for (const [key, value] of Object.entries(args)) {
      // Keep outer options such as root/cwd/foregroundWaitMs; the inner object
      // carries the actual command/path/patch.
      if (key !== 'args' && value !== undefined) merged[key] = value
    }
    args = merged
  }
  return args
}

/**
 * Accepts the absolute cwd models often copy from the workspace banner, but
 * only when it resolves inside the primary workspace. The exec server still
 * receives a workspace-relative path.
 */
export function normalizeShellCwd(workspaceRoot: string, cwd: string): string {
  const value = cwd.trim()
  if (!value) return '.'
  if (!path.isAbsolute(value)) {
    if (value.includes(':')) {
      throw new Error(`cwd must be a path, not a root-qualified path: ${cwd}`)
    }
    return value
  }
  const root = path.resolve(workspaceRoot)
  const resolved = path.resolve(value)
  const rel = path.relative(root, resolved)
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`cwd must be inside the primary workspace: ${cwd}`)
  }
  return rel === '' ? '.' : rel
}

/**
 * Node child processes with pipes or IPC fail with `spawn EPERM` under the
 * write-restricted workspace-write token (ADR 0001 S-2). The default policy
 * runs plain test-runner commands in `low-integrity`, where they work, but a
 * pipeline or redirect is compound and keeps the session's sandbox. Says so,
 * so the model reruns the command plainly instead of trying workarounds.
 */
export function pipeChildGap(
  result: { stdout?: unknown; stderr?: unknown; exitCode?: unknown; sandbox?: unknown },
  command = '',
): string | undefined {
  const text = `${typeof result.stdout === 'string' ? result.stdout : ''}\n${typeof result.stderr === 'string' ? result.stderr : ''}`
  const seen = /spawn(Sync)? \S*\s*EPERM|EPERM[^\n]*spawn/i.test(text)
  // A filter (`| Select-String pass`) can hide the EPERM line: a failing test
  // runner that a pipe or redirect kept in workspace-write gets the hint too.
  const likely =
    result.sandbox === 'workspace-write' &&
    typeof result.exitCode === 'number' &&
    result.exitCode !== 0 &&
    /[|>;&]/.test(command) &&
    /\bnode(\.exe)?\s+--test\b|\b(npm|pnpm|yarn)(\.cmd)?\s+(run\s+)?(test|t)\b|\b(vitest|jest)\b/i.test(command)
  if (!seen && !likely) return undefined
  return 'named-pipe-children: Node child processes with pipes are blocked in this sandbox (spawn EPERM). Run the test command on its own, with no pipe or redirect (for example `npm test` or `node --test`): plain test-runner commands run in a sandbox where they work. Filter the output afterwards instead of piping it.'
}

/**
 * Windows PowerShell 5.1 serializes stderr as CLIXML when a command fails.
 * Return the human-readable error strings instead of XML noise.
 */
export function cleanPowerShellOutput(text: string): string {
  if (!text.includes('#< CLIXML') && !text.includes('<Objs')) return text
  const errors = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((match) => match[1] ?? '')
  const source = errors.length > 0 ? errors.join('') : text
  return source
    .replace(/_x000D__x000A_/g, '\n')
    .replace(/_x000D_/g, '\r')
    .replace(/_x000A_/g, '\n')
    .replace(/_x0009_/g, '\t')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/^#< CLIXML\s*/, '')
    .replace(/<\/?Objs[^>]*>/g, '')
    .replace(/<\/?S[^>]*>/g, '')
    .trim()
}

export interface ToolRuntimeOptions {
  /**
   * CP-38/CP-10: the `tool-search` feature flag. Off: every deferred tool is
   * loaded from the start (offered directly, no tool_search round trip).
   */
  toolSearch?: boolean
  /** The run's Rationale Ledger, for `tools.rationale.*` (design §8). */
  ledger?: Ledger
  /** `<stateDir>/spill`; `read_file({ path: "spill://<id>" })` reads from it. */
  spillDir?: string
  /** An objective (`hy ralph`) session: `claim_complete` is available (OQ-4). */
  objective?: boolean
  /** Tags shell jobs so a round's rollback kills them (design §6). */
  runId?: string
  /**
   * The session's live sandbox mode (WP-12). Read on every exec/patch call so a
   * mid-session switch applies to the next tool call, never retroactively.
   */
  sandboxMode?: () => SandboxMode
  /** Skills listed in the prompt; `skill_load` reads them. */
  skills?: readonly SkillInfo[]
  /** CP-21: counts a `skill_load` for prompt ordering. */
  onSkillLoad?: (name: string) => void
  /** Running MCP servers; `mcp_call` reaches them. */
  mcp?: McpManager
  /** Runs a subagent for `delegate`; absent in subagents (no recursion). */
  delegate?: (task: string, readOnly: boolean) => Promise<{ final: string; steps: number }>
  /**
   * Starts a background subagent for `delegate { background: true }` and returns
   * its agent id (WP-22). Absent outside the web host.
   */
  backgroundDelegate?: (task: string, readOnly: boolean) => string
  /** Default for `shell { persistent }` (WP-31): `--persistent-shell`. */
  persistentShell?: boolean
  /** Only these tools may run (read-only subagents, `hy review`); checked for run_code sub-calls too. */
  allowTools?: ReadonlySet<string>
  /** Bundle names for the error message when `allowTools` came from a bundle (WP-42). */
  bundleLabel?: string
  /** preToolUse / postToolUse hooks, for every call including run_code sub-calls. */
  hooks?: Hooks
  /** `web_fetch` settings; absent = no web access. */
  web?: WebConfig
  /** Answers `ask_user` (interactive sessions only). */
  askUser?: (question: string) => Promise<string>
  /** Language servers for `lsp`. */
  lsp?: LspManager
  /** Plugin tools (user configuration). */
  plugins?: LoadedPlugins['tools']
  /** Workspace memory for `memory`. */
  memory?: MemoryStore
  /** CP-12: the model context window, for `get_context_remaining`. */
  contextWindowTokens?: number
  /** CP-15: background subagent lifecycle (the web host provides these). */
  waitAgent?: (agentId: string, timeoutMs?: number) => Promise<{ final: string; status: string; timedOut?: boolean }>
  listAgents?: () => Array<{ agentId: string; task: string; status: string }>
  closeAgent?: (agentId: string) => { agentId: string; status: string }
  /** Worker scope: `apply_patch` may only touch these repository-relative directories. */
  writeScope?: readonly string[]
  /** Primary (`main`) plus explicitly added roots for this session. */
  roots?: readonly WorkspaceRootConfig[]
  /** Extra command check for orchestration workers (git and harness-state commands). */
  shellGuard?: (command: string) => void
  /** Serializes this session's shell commands against other workers. */
  shellLock?: { acquire(): Promise<() => void> }
  /** Long-running worker commands stay in the foreground so the shell lock is held. */
  noBackgroundShell?: boolean
  minForegroundWaitMs?: number
  shellTimeoutMs?: number
  /** Aborts in-flight `exec/command`, `ptc/run`, and `job/wait` RPCs on round timeout or Ctrl-C. */
  signal?: AbortSignal
}

export interface PlanStep {
  step: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** `spill://<session>/<call>` → file under the spill directory, or undefined. */
export function spillFile(spillDir: string | undefined, rel: string): string | undefined {
  const m = /^spill:\/\/([\w-]+\/[\w.-]+)$/.exec(rel)
  if (!m || !spillDir) return undefined
  return path.join(spillDir, `${m[1]}.txt`)
}

export interface ApprovalRequest {
  command: string
  justification?: string
  /** The sandbox mode the command would run in (from the server's `-32001` data). */
  sandbox?: SandboxMode
  matchedRule?: string
  cwd?: string
}

export interface ApprovalDecision {
  approved: boolean
  by: 'user' | 'guardian'
  /** Returned to the worker as the tool error when not approved. */
  reason?: string
  /** CP-44: the reviewer's justification, kept for the audit trail. */
  evidence?: string
}

export type ApprovalCallback = (request: ApprovalRequest) => Promise<boolean | ApprovalDecision>

/**
 * An error that ends the run (or the ralph round) instead of being returned to
 * the model as a tool error, e.g. Guardian's three-strike breaker.
 */
export class AbortRunError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AbortRunError'
  }
}

export interface ToolResult {
  [key: string]: unknown
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function normalizeRel(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join('/')
}

function resolveInside(root: string, rel: string): string {
  if (!rel || path.isAbsolute(rel) || rel.includes(':')) {
    throw new Error(`path must be relative to the workspace: ${rel}`)
  }
  const rootReal = fs.realpathSync.native(root)
  // Check the lexical path first: a missing file outside the workspace has to be
  // a containment error, not an ENOENT from realpath.
  const lexical = path.resolve(rootReal, rel)
  if (lexical !== rootReal && !lexical.startsWith(rootReal + path.sep)) {
    throw new Error(`path escapes the workspace: ${rel}`)
  }
  const real = fs.realpathSync.native(lexical)
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error(`path escapes the workspace: ${rel}`)
  }
  return real
}

/** Directories `tools.search.*` never enters. */
const SEARCH_SKIP = new Set(['.git', 'node_modules', '.hy-harness'])

/** A root's own ignore rules: `.git/info/exclude`, then its `.gitignore`. */
function rootIgnoreRules(root: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const file of [path.join(root, '.git', 'info', 'exclude'), path.join(root, '.gitignore')]) {
    try {
      rules.push(...parseGitignore(fs.readFileSync(file, 'utf8')))
    } catch {
      // Missing or unreadable: no rules from this file.
    }
  }
  return rules
}

/**
 * When a search found nothing and its pattern names a directory that search
 * never enters (.gitignore or the built-in skips), that directory, so the
 * result can say why instead of looking like the files do not exist.
 */
function ignoredTarget(roots: readonly { path: string }[], pattern: string): string | undefined {
  const segments: string[] = []
  for (const segment of pattern.split('/').slice(0, -1)) {
    if (/[*?[{]/.test(segment)) break
    segments.push(segment)
  }
  for (const root of roots) {
    const rules = rootIgnoreRules(root.path)
    for (let i = 1; i <= segments.length; i++) {
      const dir = segments.slice(0, i).join('/')
      if (SEARCH_SKIP.has(segments[i - 1]!) || isIgnored(rules, dir, true)) return dir
    }
  }
  return undefined
}

function withIgnoreNote<T extends object>(result: T, dir: string | undefined): T & { note?: string } {
  return dir ? { ...result, note: `${dir}/ is not searched (.gitignore or a built-in skip); read_file still opens files there by path.` } : result
}
const GREP_MAX_FILE_BYTES = 1024 * 1024

/** `read_image` limits (WP-30): a vision model cannot use more than this. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_IMAGE_PX = 4096

/** PNG / JPEG / WebP / GIF by magic bytes, or undefined. */
export function imageMimeType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  return undefined
}

/** Pixel size from the container headers (no decoding). */
export function imageSize(bytes: Buffer, mimeType: string): { width: number; height: number } | undefined {
  if (mimeType === 'image/png' && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (mimeType === 'image/gif' && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  }
  if (mimeType === 'image/webp' && bytes.length >= 30) {
    const chunk = bytes.subarray(12, 16).toString('latin1')
    if (chunk === 'VP8X') {
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
    }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    }
    return undefined
  }
  if (mimeType === 'image/jpeg') {
    // Walk the segments to the first SOFn frame header.
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1
        continue
      }
      const marker = bytes[i + 1]!
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) }
      }
      const length = bytes.readUInt16BE(i + 2)
      if (length < 2) return undefined
      i += 2 + length
    }
  }
  return undefined
}

/** Number of non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at >= 0) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * The lines of `source` that resemble `needle` (line numbers included), so an
 * `edit_file` miss can tell the model what the file actually says.
 */
export function nearbyLines(source: string, needle: string, limit = 5): string {
  const words = needle
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((word) => word.length >= 4)
    .slice(0, 3)
  if (words.length === 0) return ''
  const lines = source.split(/\r?\n/)
  const hits: string[] = []
  for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
    const line = lines[i]!
    if (words.every((word) => line.includes(word)) || words.some((word) => line.includes(word))) {
      hits.push(`  ${i + 1}: ${line.trim().slice(0, 160)}`)
    }
  }
  return hits.length > 0 ? `\nLines that look close:\n${hits.join('\n')}` : ''
}

/** Glob → RegExp for workspace-relative `/` paths: `**`, `*`, `?`, `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end < 0) re += '\\{'
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map((alt) => globToRegExp(alt).source.slice(1, -1))
          .join('|')})`
        i = end
      }
    } else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c
  }
  return new RegExp(`^${re}$`, 'i')
}

/** Many readers or one writer, in arrival order for writers. */
export class AsyncRwLock {
  private readers = 0
  private writer = false
  private readonly queue: Array<{ write: boolean; wake: () => void }> = []

  async read<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire(false)
    try {
      return await fn()
    } finally {
      this.readers -= 1
      this.drain()
    }
  }

  async write<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire(true)
    try {
      return await fn()
    } finally {
      this.writer = false
      this.drain()
    }
  }

  private acquire(write: boolean): Promise<void> {
    if (this.queue.length === 0 && !this.writer && (!write || this.readers === 0)) {
      if (write) this.writer = true
      else this.readers += 1
      return Promise.resolve()
    }
    return new Promise((wake) => this.queue.push({ write, wake }))
  }

  private drain(): void {
    while (this.queue.length > 0 && !this.writer) {
      const next = this.queue[0]!
      if (next.write) {
        if (this.readers > 0) return
        this.queue.shift()
        this.writer = true
        next.wake()
        return
      }
      this.queue.shift()
      this.readers += 1
      next.wake()
    }
  }
}

export class ToolRuntime {
  private readonly readHashes = new Map<string, string>()
  private readonly subCallLock = new AsyncRwLock()
  private claim: string | undefined
  private plan: PlanStep[] = []
  /** Images read by `read_image`, waiting for the agent to attach them (WP-30). */
  private pendingImages: Array<{ mimeType: string; data: string; label: string }> = []
  /** Session working directory, workspace-relative (`''` = the root), WP-30. */
  private cwd = ''
  /** The session's persistent shell (WP-31), opened on first use. */
  private shellHandle: { id?: string; gap?: string; mode?: string } | undefined
  /** Why the persistent shell was unavailable, reported once on the one-shot path. */
  private persistentGap: string | undefined
  /** Plan mode's read-only set, over `options.allowTools`. */
  private allowOverride: ReadonlySet<string> | undefined
  /** Per-turn cancellation, set by the conversation before each turn. */
  private activeSignal: AbortSignal | undefined
  private readonly roots: WorkspaceRootConfig[]

  constructor(
    private readonly exec: ExecRpcClient,
    private readonly workspaceRoot: string,
    private readonly approve?: ApprovalCallback,
    private readonly enforceProtectedPaths = false,
    private readonly options: ToolRuntimeOptions = {},
  ) {
    this.roots = options.roots?.length
      ? [...options.roots]
      : [{ id: 'main', path: workspaceRoot, label: path.basename(workspaceRoot), writable: true }]
    // Field initialisers have run, so `activated` exists here.
    if (options.toolSearch === false) for (const spec of this.deferredAvailable()) this.activated.add(spec.name)
  }

  private root(ref: string | undefined): WorkspaceRootConfig {
    if (!ref) return this.roots[0]!
    const match = this.roots.find((root) => root.id.toLowerCase() === ref.toLowerCase())
    if (!match) throw new Error(`unknown workspace root: ${ref}`)
    return match
  }

  /** `main:src/a.ts` selects a root; a bare path always uses the primary root. */
  private splitRoot(input: string): { root: WorkspaceRootConfig; rel: string } {
    if (path.isAbsolute(input)) {
      const normalized = path.resolve(input)
      const match = this.roots.find((root) => {
        const base = path.resolve(root.path)
        return normalized === base || normalized.startsWith(base + path.sep)
      })
      if (!match) throw new Error(`absolute path is outside every configured root: ${input}`)
      return { root: match, rel: path.relative(match.path, normalized).split(path.sep).join('/') }
    }
    const colon = input.indexOf(':')
    if (colon > 0) {
      const id = input.slice(0, colon)
      const match = this.roots.find((root) => root.id.toLowerCase() === id.toLowerCase())
      if (match) return { root: match, rel: input.slice(colon + 1) }
    }
    return { root: this.roots[0]!, rel: input }
  }

  private resolveRootPath(input: string, allowMissing = false): { root: WorkspaceRootConfig; rel: string; full: string } {
    const { root, rel } = this.splitRoot(input)
    const raw = rel.replace(/\\/g, '/').replace(/^\.\/+/, '')
    // WP-30: a session working directory prefixes unqualified paths in the
    // primary root. Explicit `root:` paths and `spill://` are never rewritten.
    const clean =
      this.cwd && root.id === 'main' && raw && !path.posix.isAbsolute(raw) && !raw.split('/').includes('..')
        ? path.posix.join(this.cwd, raw)
        : raw
    if (!clean || path.posix.isAbsolute(clean) || clean.split('/').includes('..')) {
      throw new Error(`path must be relative to ${root.id}: ${input}`)
    }
    const full = path.resolve(root.path, clean)
    const rootReal = fs.realpathSync.native(root.path)
    const existing = fs.existsSync(full)
    if (existing) {
      const real = fs.realpathSync.native(full)
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new Error(`path escapes ${root.id}: ${input}`)
      }
      return { root, rel: normalizeRel(rootReal, real), full: real }
    }
    if (!allowMissing) throw new Error(`path does not exist in ${root.id}: ${input}`)
    // Check the nearest existing ancestor so a junction cannot redirect a new file.
    let ancestor = path.dirname(full)
    while (ancestor !== rootReal && ancestor !== path.dirname(ancestor)) {
      if (fs.existsSync(ancestor)) {
        const real = fs.realpathSync.native(ancestor)
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
          throw new Error(`path escapes ${root.id}: ${input}`)
        }
        break
      }
      ancestor = path.dirname(ancestor)
    }
    return { root, rel: normalizeRel(rootReal, full), full }
  }

  private qualified(root: WorkspaceRootConfig, rel: string): string {
    return root.id === 'main' ? rel : `${root.id}:${rel}`
  }

  /**
   * Dispatches one call after checking it against the registry's JSON Schema
   * (design §2). SDK-only tools (`search_*`, `job_*`) exist only inside
   * `run_code` (`viaSdk`).
   */
  /** Sets (or clears) the cancellation signal for the current turn. */
  setSignal(signal: AbortSignal | undefined): void {
    this.activeSignal = signal
  }

  private get signal(): AbortSignal | undefined {
    return this.activeSignal ?? this.options.signal
  }

  /** CP-09: per-job output offsets for `write_stdin`. */
  private readonly jobOffsets = new Map<string, number>()

  /** CP-12: the last provider-reported usage (set by the agent each step). */
  private lastUsage: { inputTokens: number; outputTokens: number } | undefined

  setUsage(usage: { inputTokens: number; outputTokens: number } | undefined): void {
    this.lastUsage = usage
  }
  /** CP-10: deferred tools loaded with `tool_search` in this session. */
  private activated = new Set<string>()

  activatedTools(): ReadonlySet<string> {
    return this.activated
  }

  /** The optional tool families this session offers (mirrors the prompt). */
  private toolFeatures(): Set<string> {
    const features = new Set<string>()
    if ((this.options.skills ?? []).length > 0) features.add('skills')
    if (this.options.mcp && this.options.mcp.tools.length > 0) features.add('mcp')
    if (this.options.delegate) features.add('delegate')
    if (this.options.web) features.add('web')
    if (this.options.web?.searchUrl) features.add('search')
    if (this.options.lsp?.configured) features.add('lsp')
    if (this.options.memory) features.add('memory')
    if (this.options.askUser) features.add('ask')
    return features
  }

  /** Deferred tools the model may load now. */
  private deferredAvailable(): ToolSpec[] {
    return deferredTools(this.toolFeatures(), undefined, this.allowOverride ?? this.options.allowTools)
  }
  /** CP-44: the last few model-visible calls, for Guardian's review context. */
  private recentCalls: string[] = []

  private noteCall(name: string, args: unknown): void {
    let detail = ''
    try {
      detail = JSON.stringify(args ?? {})
    } catch {
      detail = '{…}'
    }
    const clipped = detail.length > 180 ? `${detail.slice(0, 180)}…` : detail
    this.recentCalls.push(`${name}(${clipped})`)
    if (this.recentCalls.length > 8) this.recentCalls.shift()
  }

  /** A bounded, one-line-per-call digest of recent tool calls (CP-44). */
  recentActivity(): string {
    return this.recentCalls.join('\n')
  }

  async execute(name: string, args: unknown, viaSdk = false): Promise<ToolResult> {
    this.noteCall(name, args)
    if (this.signal?.aborted) throw new AbortRunError('round aborted')
    const run = async () => {
      try {
        return await this.dispatch(name, args, viaSdk)
      } catch (error) {
        if (this.signal?.aborted) throw new AbortRunError('round aborted')
        throw error
      }
    }
    const hooks = this.options.hooks
    if (!hooks) return run()
    const blocked = await hooks.preToolUse(name, args)
    if (blocked !== undefined) throw new Error(`${name} blocked by a preToolUse hook: ${blocked}`)
    try {
      const result = await run()
      await hooks.postToolUse(name, args, { result })
      return result
    } catch (error) {
      await hooks.postToolUse(name, args, { error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  /**
   * `write_file` (plugin tool, WP-30): create or replace a whole file. It runs
   * through `apply_patch`, so read-before-edit, the write scope, the sandbox
   * mode and the daemon's checks are all the same.
   */
  async writeFile(args: Record<string, unknown>): Promise<ToolResult> {
    const file = String(args.file ?? args.path ?? '').trim()
    if (!file) throw new Error('write_file needs a file')
    if (typeof args.content !== 'string') throw new Error('write_file needs content')
    return this.applyPatch({ file, content: args.content, ...(args.root !== undefined ? { root: args.root } : {}) })
  }

  /**
   * `edit_file` (plugin tool, WP-30): replace `old` with `new`, requiring the
   * text to occur exactly `count` times (default 1). A miss reports the lines
   * that look close, so the model can correct itself instead of guessing.
   */
  async editFile(args: Record<string, unknown>): Promise<ToolResult> {
    const file = String(args.file ?? args.path ?? '').trim()
    const oldText = typeof args.old === 'string' ? args.old : ''
    const newText = typeof args.new === 'string' ? args.new : undefined
    if (!file) throw new Error('edit_file needs a file')
    if (!oldText) throw new Error('edit_file needs the text to replace (old)')
    if (newText === undefined) throw new Error('edit_file needs the replacement (new)')
    const rootArg = typeof args.root === 'string' ? args.root.trim() : ''
    const root = rootArg ? this.root(rootArg) : undefined
    if (root && root.id !== 'main') throw new Error(`edit_file is only available in the primary root; use write_file for ${root.id}`)
    const full = resolveInside(this.workspaceRoot, file)
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`${file} does not exist`)
    const before = fs.readFileSync(full, 'utf8')
    const occurrences = countOccurrences(before, oldText)
    const want = args.count === undefined ? 1 : Number(args.count)
    if (occurrences === 0) throw new Error(`edit_file: the text to replace was not found in ${file}.${nearbyLines(before, oldText)}`)
    if (occurrences !== want) {
      throw new Error(`edit_file: the text occurs ${occurrences} times in ${file} but count=${want}.${nearbyLines(before, oldText)}`)
    }
    const after = before.split(oldText).join(newText)
    return this.applyPatch({ file, content: after })
  }

  /**
   * `read_image` (plugin tool, WP-30). The bytes are handed to the provider as
   * an attachment (never as base64 text, which would cost a fortune in tokens),
   * so the agent drains them right after the tool result.
   */
  readImage(args: Record<string, unknown>, supportsImages: boolean): ToolResult {
    const file = String(args.path ?? args.file ?? '').trim()
    if (!file) throw new Error('read_image needs a path')
    if (!supportsImages) {
      throw new Error('this model has no image input; use a vision-capable model (role.vision) or read the image metadata only')
    }
    const full = resolveInside(this.workspaceRoot, file)
    const stat = fs.statSync(full)
    if (!stat.isFile()) throw new Error(`${file} is not a file`)
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(`${file} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MiB`)
    const bytes = fs.readFileSync(full)
    const mimeType = imageMimeType(bytes)
    if (!mimeType) throw new Error(`${file} is not a PNG, JPEG, WebP or GIF image`)
    const size = imageSize(bytes, mimeType)
    if (size && (size.width > MAX_IMAGE_PX || size.height > MAX_IMAGE_PX)) {
      throw new Error(`${file} is ${size.width}x${size.height}; the limit is ${MAX_IMAGE_PX} px on a side`)
    }
    const data = bytes.toString('base64')
    this.pendingImages.push({ mimeType, data, label: file })
    return {
      path: file,
      mimeType,
      bytes: stat.size,
      ...(size ? { width: size.width, height: size.height } : {}),
      attached: true,
    }
  }

  /** Images read since the last call (the agent attaches them to the history). */
  takeImages(): Array<{ mimeType: string; data: string; label: string }> {
    const images = this.pendingImages
    this.pendingImages = []
    return images
  }

  /** The session's working directory (`''` = workspace root), WP-30. */
  currentCwd(): string {
    return this.cwd
  }
  /**
   * WP-31: runs one command through the session's persistent shell. Returns
   * `undefined` when persistence is unavailable, so the caller falls back to the
   * one-shot path with `gap` explaining why.
   */
  private async shellPersistent(command: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
    const mode = this.options.sandboxMode?.() ?? 'unconfined'
    // The shell runs with the token of the mode it was opened in. After a mode
    // change (unconfined → read-only, say) it must not take another command:
    // close it and open one in the current mode.
    if (this.shellHandle && this.shellHandle.mode !== mode) {
      if (this.shellHandle.id) await this.exec.shellClose(this.shellHandle.id).catch(() => undefined)
      this.shellHandle = undefined
    }
    if (!this.shellHandle) {
      const opened = await this.exec.shellOpen({
        ...(this.options.runId !== undefined ? { runId: this.options.runId } : {}),
        ...(this.cwd ? { cwd: this.cwd } : {}),
        sandboxMode: mode,
      })
      this.shellHandle = {
        ...(opened.shellId ? { id: opened.shellId } : {}),
        ...(opened.gap ? { gap: opened.gap } : {}),
        mode,
      }
    }
    const shellId = this.shellHandle?.id
    if (!shellId) {
      this.persistentGap = this.shellHandle?.gap ?? 'the persistent shell is unavailable'
      return undefined
    }
    // The shell itself was started without evaluating this command, so the
    // policy and the approval prompts run here, exactly like `exec/command`.
    const evaluation = await this.exec.policyEvaluate(command)
    if (evaluation.decision === 'deny') {
      throw new Error(`command denied by policy${evaluation.justification ? `: ${evaluation.justification}` : ''}`)
    }
    if (evaluation.decision === 'prompt') {
      if (!this.approve) throw new Error('command requires approval')
      const answer = await this.approve({
        command,
        ...(evaluation.justification ? { justification: evaluation.justification } : {}),
        ...(evaluation.matchedRule ? { matchedRule: evaluation.matchedRule } : {}),
        sandbox: mode,
      })
      const decision: ApprovalDecision = typeof answer === 'boolean' ? { approved: answer, by: 'user' } : answer
      if (!decision.approved) {
        throw new Error(`command not approved: ${command}${decision.reason ? ` (${decision.by}: ${decision.reason})` : ''}`)
      }
    }
    const timeout =
      this.options.shellTimeoutMs ?? (args.hardTimeoutMs !== undefined ? Number(args.hardTimeoutMs) : 120_000)
    // Stop: closing the shell ends the running command and its children (the
    // read then returns), and the next call opens a fresh shell.
    const signal = this.signal
    if (signal?.aborted) throw new Error('turn cancelled')
    let stopped = false
    const onAbort = () => {
      stopped = true
      this.shellHandle = undefined
      void this.exec.shellClose(shellId).catch(() => undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let read: Awaited<ReturnType<typeof this.exec.shellRead>>
    try {
      await this.exec.shellWrite(shellId, command)
      read = await this.exec.shellRead(shellId, timeout)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    if (stopped) throw new Error('turn cancelled: the persistent shell was closed')
    if (read.timedOut || read.eof) {
      // A timed-out or exited shell cannot be trusted with the next command.
      await this.exec.shellClose(shellId).catch(() => undefined)
      this.shellHandle = undefined
    }
    return {
      status: 'completed' as const,
      stdout: cleanPowerShellOutput(read.data),
      stderr: '',
      ...(read.exitCode !== undefined ? { exitCode: read.exitCode } : {}),
      ...(read.truncated ? { truncated: true } : {}),
      ...(read.timedOut ? { timedOut: true, note: 'the persistent shell was discarded after the timeout' } : {}),
      shell: 'persistent',
    }
  }

  /** Restores the cwd a resumed session last set. */
  restoreCwd(rel: string): void {
    this.cwd = rel.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  }

  /**
   * `working_directory`: without `path` it reports the current directory; with
   * one it switches the session (relative to the primary root, inside it).
   */
  workingDirectory(args: Record<string, unknown>): { cwd: string; path: string } {
    if (args.path === undefined || args.path === null || String(args.path).trim() === '') {
      return { cwd: this.cwd || '.', path: path.resolve(this.workspaceRoot, this.cwd) }
    }
    const raw = String(args.path).trim().replace(/\\/g, '/')
    // Resolve against the root, not against the current cwd, so `.` goes back to
    // the top of the workspace.
    const saved = this.cwd
    this.cwd = ''
    let resolved: { root: WorkspaceRootConfig; rel: string; full: string }
    try {
      resolved = this.resolveRootPath(raw)
    } finally {
      this.cwd = saved
    }
    if (resolved.root.id !== 'main') throw new Error('working_directory is only available in the primary root')
    if (!fs.statSync(resolved.full).isDirectory()) throw new Error(`${raw} is not a directory`)
    this.cwd = resolved.rel === '.' ? '' : resolved.rel
    return { cwd: this.cwd || '.', path: resolved.full }
  }

  /** A built-in or plugin tool's spec. */
  spec(name: string): ToolSpec | undefined {
    return TOOLS_BY_NAME.get(name) ?? this.options.plugins?.get(name)?.spec
  }

  isReadOnly(name: string): boolean {
    return this.spec(name)?.readOnly === true
  }

  private async dispatch(name: string, args: unknown, viaSdk: boolean): Promise<ToolResult> {
    const spec = this.spec(name)
    if (!spec) throw new Error(`unknown tool: ${name}`)
    if (spec.objectiveOnly && !this.options.objective) throw new Error(`${name} is only available in hy ralph sessions`)
    if (!spec.wire && !viaSdk) throw new Error(`${name} is only available inside run_code as tools.${spec.sdk}`)
    if (spec.requires === 'skills' && !this.options.skills?.length) throw new Error(`${name}: this session has no skills`)
    if (spec.requires === 'mcp' && !this.options.mcp?.tools.length) throw new Error(`${name}: this session has no MCP tools`)
    if (spec.requires === 'ask' && !this.options.askUser) throw new Error(`${name}: no user is available (not an interactive session)`)
    if (spec.requires === 'memory' && !this.options.memory) throw new Error(`${name}: workspace memory is off (--memory or memory.enabled)`)
    if (spec.requires === 'lsp' && !this.options.lsp?.configured) throw new Error(`${name}: no language server is configured (lsp in the user config)`)
    if (spec.requires === 'search' && !this.options.web?.searchUrl) throw new Error(`${name}: no search endpoint (web.searchUrl) is configured`)
    if (spec.requires === 'web' && !this.options.web) throw new Error(`${name}: web access is off (hy --web or web.enabled)`)
    if (spec.requires === 'delegate' && !this.options.delegate) throw new Error(`${name} is not available here (subagents cannot delegate)`)
    // CP-10: a deferred tool must be loaded before it can be called.
    if (spec.exposure === 'deferred' && !this.activated.has(name)) {
      throw new Error(`${name} is not loaded; call tool_search with words from its description first`)
    }
    if (this.allowOverride && !this.allowOverride.has(name)) {
      // Plan mode keeps every tool in the prompt (a stable, cached prefix) and
      // refuses the changing ones here.
      throw new Error(`${name} is not available while plan mode is on: only reading and planning tools run. Propose the change in your plan instead.`)
    }
    const allow = this.options.allowTools
    if (allow && !allow.has(name)) {
      // A bundle narrows the session's tools; say so, because "read-only" would
      // be misleading when another tool could still write.
      throw new Error(
        this.options.bundleLabel
          ? `${name} is not allowed here (this session's bundles: ${this.options.bundleLabel})`
          : `${name} is not allowed in this read-only session`,
      )
    }
    const a = normalizeToolArgs(spec, (args ?? {}) as Record<string, unknown>)
    // Accepted alias, kept out of the schema to save prompt tokens.
    if (name === 'apply_patch' && a.file === undefined && typeof a.path === 'string') a.file = a.path
    const problems = validate(spec.input, a)
    if (problems.length > 0) {
      const hint =
        name === 'shell' && problems.some((problem) => problem.includes('command'))
          ? ' (expected {"tool":"shell","args":{"command":"..."}}; do not nest args)'
          : ''
      throw new Error(`invalid arguments for ${name}: ${problems.join('; ')}${hint}`)
    }
    const plugin = this.options.plugins?.get(name)
    if (plugin) {
      const value = await plugin.run(a, { workspaceRoot: this.workspaceRoot })
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ToolResult) : { value }
    }
    switch (name) {
      case 'read_file':
        return this.readFile(a)
      case 'apply_patch':
        return this.applyPatch(a)
      case 'shell':
        return this.shell(a)
      case 'run_code':
        return this.runCode(a)
      case 'search_glob':
        return this.searchGlob(a)
      case 'search_grep':
        return this.searchGrep(a)
      case 'job_status':
        return { ...(await this.exec.jobStatus(String(a.jobId))) }
      case 'job_output':
        return {
          ...(await this.exec.jobOutput(
            String(a.jobId),
            a.offset === undefined ? 0 : Number(a.offset),
            a.maxBytes === undefined ? undefined : Number(a.maxBytes),
          )),
        }
      case 'job_wait':
        return {
          ...(await this.exec.jobWait(
            String(a.jobId),
            a.timeoutMs === undefined ? undefined : Number(a.timeoutMs),
            this.signal,
          )),
        }
      case 'job_kill':
        return { ...(await this.exec.jobKill(String(a.jobId))) }
      case 'claim_complete':
        this.claim = String(a.summary)
        return { accepted: true, note: 'The claim ends this round; independent gates will now verify it.' }
      case 'rationale_upsert':
        return this.ledger().upsert(a as { key: string; rule: string; rationale?: string })
      case 'rationale_supersede':
        return this.ledger().supersede(a as { oldKey: string; newKey: string; rule: string; rationale?: string })
      case 'rationale_remove':
        return this.ledger().remove(a as { key: string })
      case 'current_time': {
        const now = new Date()
        return {
          iso: now.toISOString(),
          local: now.toLocaleString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          weekday: now.toLocaleDateString(undefined, { weekday: 'long' }),
        }
      }
      case 'sleep': {
        const ms = Math.max(0, Math.min(60_000, Number(a.ms ?? 0)))
        const signal = this.signal
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new AbortRunError('turn cancelled'))
            return
          }
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          }, ms)
          const onAbort = () => {
            clearTimeout(timer)
            reject(new AbortRunError('turn cancelled'))
          }
          signal?.addEventListener('abort', onAbort, { once: true })
        })
        return { sleptMs: ms }
      }
      case 'get_context_remaining': {
        const window = this.options.contextWindowTokens ?? 0
        const used = this.lastUsage?.inputTokens ?? 0
        return {
          window,
          used,
          remaining: window > 0 ? Math.max(0, window - used) : 0,
          percentUsed: window > 0 ? Math.round((used / window) * 1000) / 10 : 0,
          source: this.lastUsage ? 'provider' : 'none',
        }
      }      case 'update_plan': {
        const plan = a.plan as PlanStep[]
        if (plan.filter((s) => s.status === 'in_progress').length > 1) throw new Error('at most one step may be in_progress')
        this.plan = plan.map((s) => ({ step: s.step, status: s.status }))
        return { ok: true, remaining: plan.filter((s) => s.status !== 'completed').length }
      }
      case 'delegate': {
        if (a.background === true) {
          if (!this.options.backgroundDelegate) throw new Error('background subagents are only available in the web session')
          const agentId = this.options.backgroundDelegate(String(a.task), a.readOnly !== false)
          return { agentId, status: 'running', hint: 'list_agents / send_message / interrupt_agent' }
        }
        const r = await this.options.delegate!(String(a.task), a.readOnly !== false)
        return { final: r.final, steps: r.steps }
      }
      case 'spawn_agent': {
        if (!this.options.backgroundDelegate) throw new Error('spawn_agent is only available in the web session')
        const agentId = this.options.backgroundDelegate(String(a.task), a.readOnly !== false)
        return { agentId, status: 'running' }
      }
      case 'wait_agent': {
        if (!this.options.waitAgent) throw new Error('wait_agent is only available in the web session')
        const timeout = a.timeoutMs === undefined ? undefined : Math.max(0, Math.min(3_600_000, Number(a.timeoutMs)))
        return { ...(await this.options.waitAgent(String(a.agentId), timeout)) }
      }
      case 'list_agents': {
        if (!this.options.listAgents) throw new Error('list_agents is only available in the web session')
        return { agents: this.options.listAgents() }
      }
      case 'close_agent': {
        if (!this.options.closeAgent) throw new Error('close_agent is only available in the web session')
        return { ...this.options.closeAgent(String(a.agentId)) }
      }      case 'list_mcp_resources': {
        if (!this.options.mcp) throw new Error('mcp tools are not configured')
        const listed = await this.options.mcp.resources()
        return {
          resources: listed.resources.map((resource) => ({
            server: resource.server,
            uri: resource.uri,
            name: resource.name,
            ...(resource.description ? { description: resource.description } : {}),
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          })),
          errors: listed.errors,
        }
      }
      case 'list_mcp_prompts': {
        if (!this.options.mcp) throw new Error('mcp tools are not configured')
        return { ...(await this.options.mcp.prompts()) }
      }
      case 'get_mcp_prompt': {
        if (!this.options.mcp) throw new Error('mcp tools are not configured')
        const raw = (a.arguments ?? {}) as Record<string, unknown>
        const args = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]))
        return { ...(await this.options.mcp.getPrompt(String(a.server), String(a.name), args)) }
      }
      case 'read_mcp_resource': {
        if (!this.options.mcp) throw new Error('mcp tools are not configured')
        const resource = await this.options.mcp.readResource(String(a.server), String(a.uri))
        const limit = 100_000
        return {
          uri: resource.uri,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          text: resource.text.slice(0, limit),
          truncated: resource.text.length > limit,
        }
      }      case 'write_stdin': {
        const jobId = String(a.jobId)
        await this.exec.jobWrite(jobId, String(a.chars ?? ''))
        const timeout = a.timeoutMs === undefined ? 2_000 : Math.max(0, Math.min(30_000, Number(a.timeoutMs)))
        const deadline = Date.now() + timeout
        let output = ''
        for (;;) {
          const offset = this.jobOffsets.get(jobId) ?? 0
          const page = await this.exec.jobOutput(jobId, offset, 65_536)
          this.jobOffsets.set(jobId, page.nextOffset)
          if (page.data) output += page.data
          const status = await this.exec.jobStatus(jobId)
          const exited = status.state !== 'running'
          if (exited || output.length > 0) {
            return {
              output,
              exited,
              exitCode: exited ? (status.exitCode ?? null) : null,
              timedOut: false,
            }
          }
          if (Date.now() >= deadline) {
            return { output, exited: false, exitCode: null, timedOut: true }
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }      case 'request_permissions': {
        const requested = (Array.isArray(a.write) ? a.write : []).map(String).filter(Boolean)
        if (requested.length === 0) throw new Error('request_permissions needs at least one write path')
        if (!this.approve) throw new Error('request_permissions needs a user who can approve it')
        const granted: string[] = []
        const rejected: string[] = []
        for (const raw of requested) {
          const abs = path.resolve(this.workspaceRoot, raw)
          if (!fs.existsSync(abs)) {
            rejected.push(`${raw} (does not exist)`)
            continue
          }
          const answer = await this.approve({
            command: `request_permissions: write ${abs}`,
            sandbox: 'unconfined',
            matchedRule: 'request_permissions',
            justification: String(a.reason ?? 'the task needs this path'),
          })
          const approved = typeof answer === 'boolean' ? answer : answer.approved
          if (!approved) {
            rejected.push(abs)
            continue
          }
          await this.exec.sandboxAddRoot(abs)
          granted.push(abs)
        }
        return {
          granted,
          rejected,
          note:
            granted.length > 0
              ? 'writes under these roots are allowed for the rest of this session'
              : 'no additional roots were granted',
        }
      }      case 'ask_user': {
        const answer = await this.options.askUser!(String(a.question))
        // Silence is not an answer (OpenClaw): a question that timed out or got
        // an empty reply must not read as consent to go ahead.
        return answer.trim()
          ? { answer }
          : {
              answer: '',
              note: 'No answer from the user (the question timed out or the reply was empty). This is not approval: continue only with work that does not depend on their decision, or stop and say what you need from them.',
            }
      }
      case 'memory':
        if (a.action === 'forget') return this.options.memory!.forget(String(a.key))
        if (typeof a.text !== 'string') throw new Error('memory save needs text')
        return this.options.memory!.save(String(a.key), a.text)
      case 'lsp': {
        const rel = String(a.path)
        const full = resolveInside(this.workspaceRoot, rel)
        return this.options.lsp!.query(
          a.op as LspOp,
          normalizeRel(this.workspaceRoot, full),
          full,
          a.line === undefined ? undefined : Number(a.line),
          a.column === undefined ? undefined : Number(a.column),
        )
      }
      case 'web_search':
        return webSearch(String(a.query), this.options.web!, a.maxResults === undefined ? undefined : Number(a.maxResults))
      case 'web_fetch':
        return this.webFetch(String(a.url))
      case 'mcp_call':
        return this.mcpCall(String(a.server), String(a.tool), a.args ?? {})
      case 'tool_search': {
        const query = String(a.query ?? '').trim().toLowerCase()
        const available = this.deferredAvailable()
        const limit = a.limit === undefined ? 5 : Math.max(1, Math.min(10, Number(a.limit)))
        const words = query.split(/\s+/).filter(Boolean)
        const scored = available.map((t) => ({
          tool: t,
          score:
            words.length === 0
              ? 1
              : words.filter((w) => `${t.name} ${t.description}`.toLowerCase().includes(w)).length,
        }))
        const matches = scored
          .filter((m) => m.score > 0)
          .sort((x, y) => y.score - x.score || x.tool.name.localeCompare(y.tool.name))
          .slice(0, limit)
        for (const m of matches) this.activated.add(m.tool.name)
        return {
          tools: matches.map((m) => ({
            name: m.tool.name,
            description: m.tool.description,
            signature: jsonSchemaToTs(m.tool.input),
          })),
          activated: matches.map((m) => m.tool.name),
          available: available.length,
        }
      }      case 'skill_load': {
        const loaded = loadSkill(this.options.skills ?? [], String(a.name), a.file === undefined ? undefined : String(a.file))
        this.options.onSkillLoad?.(String(a.name))
        return loaded
      }
      default:
        throw new Error(`unknown tool: ${name}`)
    }
  }

  /** Restricts the tools (plan mode) or lifts the restriction (undefined). */
  setAllowTools(allow: ReadonlySet<string> | undefined): void {
    this.allowOverride = allow
  }

  /** The latest `update_plan` / `todo_write` list. */
  currentPlan(): readonly PlanStep[] {
    return this.plan
  }

  /** Restores the list a resumed session last set (`hy resume`, WP-23). */
  restorePlan(steps: readonly PlanStep[]): void {
    this.plan = steps.map((s) => ({ step: s.step, status: s.status }))
  }

  /**
   * `todo_write`: the full list every time. Items may use `content` (DSH's
   * wording) or `step`; several in-progress items need `allowParallelInProgress`.
   */
  todoWrite(args: Record<string, unknown>): { ok: true; remaining: number; inProgress: number } {
    const raw = Array.isArray(args.todos) ? args.todos : Array.isArray(args.plan) ? args.plan : []
    const statuses = new Set(['pending', 'in_progress', 'completed'])
    const steps: PlanStep[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const text = String(record.content ?? record.step ?? '').trim()
      if (!text) continue
      const status = statuses.has(String(record.status)) ? (String(record.status) as PlanStep['status']) : 'pending'
      steps.push({ step: text, status })
    }
    if (steps.length === 0) throw new Error('todo_write needs at least one todo with content')
    const inProgress = steps.filter((s) => s.status === 'in_progress').length
    if (inProgress > 1 && args.allowParallelInProgress !== true) {
      throw new Error('at most one todo may be in_progress; pass allowParallelInProgress to run several')
    }
    this.plan = steps
    return { ok: true, remaining: steps.filter((s) => s.status !== 'completed').length, inProgress }
  }

  /** The claim made since the last call, if any (read once by the agent). */
  takeClaim(): string | undefined {
    const c = this.claim
    this.claim = undefined
    return c
  }

  private ledger(): Ledger {
    if (!this.options.ledger) throw new Error('the rationale ledger is not available in this session')
    return this.options.ledger
  }

  /**
   * Workspace files relative to `base` (the root), `/`-separated, in stable
   * order; no links followed. The path must be relative to the root, not to the
   * directory being listed: otherwise every result collapses to its basename,
   * `docs/*.md` never matches, and grep re-reads `<root>/<basename>`.
   */
  private *walk(root: string): Generator<string> {
    yield* this.walkDir(root, '', rootIgnoreRules(root))
  }

  /**
   * `.gitignore` rules apply as git applies them: the root file (plus
   * `.git/info/exclude`), then each nested `.gitignore` below its directory.
   * An ignored directory is not entered at all.
   */
  private *walkDir(dir: string, rel: string, inherited: readonly IgnoreRule[]): Generator<string> {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    let rules = inherited
    if (rel !== '' && entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      try {
        rules = [...inherited, ...parseGitignore(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), rel)]
      } catch {
        // An unreadable nested .gitignore only means its rules do not apply.
      }
    }
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (!SEARCH_SKIP.has(e.name) && !isIgnored(rules, childRel, true)) yield* this.walkDir(path.join(dir, e.name), childRel, rules)
      } else if (e.isFile() && !isIgnored(rules, childRel, false)) {
        yield childRel
      }
    }
  }

  private searchGlob(args: Record<string, unknown>): ToolResult {
    const pattern = String(args.pattern)
    const re = globToRegExp(pattern)
    const max = Number(args.maxResults ?? 200)
    const selected = args.root === '*' ? this.roots : [this.root(typeof args.root === 'string' ? args.root : undefined)]
    const files: string[] = []
    for (const root of selected) {
      for (const rel of this.walk(root.path)) {
        if (!re.test(rel)) continue
        if (files.length >= max) return { files, truncated: true }
        files.push(this.qualified(root, rel))
      }
    }
    return withIgnoreNote({ files, truncated: false }, files.length === 0 ? ignoredTarget(selected, pattern) : undefined)
  }

  private searchGrep(args: Record<string, unknown>): ToolResult {
    let re: RegExp
    try {
      re = new RegExp(String(args.pattern), args.ignoreCase === true ? 'i' : '')
    } catch (error) {
      throw new Error(`invalid regex: ${error instanceof Error ? error.message : String(error)}`)
    }
    const only = typeof args.glob === 'string' ? globToRegExp(args.glob) : undefined
    const max = Number(args.maxResults ?? 100)
    const selected = args.root === '*' ? this.roots : [this.root(typeof args.root === 'string' ? args.root : undefined)]
    const matches: Array<{ path: string; line: number; text: string }> = []
    let filesSearched = 0
    for (const root of selected) {
      for (const rel of this.walk(root.path)) {
        if (only && !only.test(rel)) continue
        const full = path.join(root.path, rel)
        let bytes: Buffer
        try {
          if (fs.statSync(full).size > GREP_MAX_FILE_BYTES) continue
          bytes = fs.readFileSync(full)
        } catch {
          continue
        }
        if (bytes.subarray(0, 8192).includes(0)) continue
        filesSearched += 1
        const lines = bytes.toString('utf8').split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i]!)) continue
          if (matches.length >= max) return { matches, truncated: true, filesSearched }
          matches.push({ path: this.qualified(root, rel), line: i + 1, text: lines[i]!.slice(0, 300) })
        }
      }
    }
    const target = matches.length === 0 && typeof args.glob === 'string' ? ignoredTarget(selected, args.glob) : undefined
    return withIgnoreNote({ matches, truncated: false, filesSearched }, target)
  }

  private readFile(args: Record<string, unknown>): ToolResult {
    const rawInput = String(args.path ?? '')
    const rootArg = typeof args.root === 'string' ? args.root.trim() : ''
    const alreadyQualified = this.roots.some((root) => rawInput.startsWith(`${root.id}:`))
    const input = rawInput.startsWith('spill://')
      ? rawInput
      : rootArg && !alreadyQualified
        ? `${rootArg}:${rawInput}`
        : rawInput
    // Spilled tool output (design §8): readable, never editable.
    const spilled = spillFile(this.options.spillDir, input)
    if (input.startsWith('spill://') && !spilled) throw new Error(`unknown spill reference: ${input}`)
    let resolved: { root: WorkspaceRootConfig; rel: string; full: string } | undefined
    try {
      resolved = spilled ? undefined : this.resolveRootPath(input)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(message.includes('does not exist') ? `${message} (use search_glob/search_grep to locate it)` : message)
    }
    const full = spilled ?? resolved!.full
    const stat = fs.statSync(full)
    if (!stat.isFile()) throw new Error(`not a file: ${input}`)
    const bytes = fs.readFileSync(full)
    const text = bytes.toString('utf8')
    if (text.includes('\0')) throw new Error(`binary file: ${input}`)
    const allLines = text.split(/\r?\n/)
    if (text.endsWith('\n')) allLines.pop()
    const totalLines = allLines.length
    const start = Math.max(1, Number(args.startLine ?? 1))
    const end = Math.min(totalLines, Number(args.endLine ?? totalLines))
    const selected = allLines.slice(start - 1, Math.max(start - 1, end))
    let content = selected.join('\n')
    let truncated = false
    if (selected.length > 400) {
      content = selected.slice(0, 400).join('\n')
      truncated = true
    }
    if (content.length > 50_000) {
      content = content.slice(0, 50_000)
      truncated = true
    }
    const hash = sha256(bytes)
    const normalized = spilled ? input : this.qualified(resolved!.root, resolved!.rel)
    if (!spilled) this.readHashes.set(normalized, hash)
    return {
      path: normalized,
      content,
      totalLines,
      truncated,
      sha256: hash,
      ...(truncated ? { note: 'content truncated; use startLine/endLine to read more' } : {}),
    }
  }

  /** Checks a repository-relative path against the worker's scope. */
  private assertWriteScope(rel: string, rootId = 'main'): void {
    const scopes = this.options.writeScope
    if (!scopes || scopes.length === 0) return
    const value = rel.replace(/\\/g, '/').replace(/^\.\/+/, '')
    if (path.posix.isAbsolute(value) || /^[a-zA-Z]:/.test(value) || value.split('/').includes('..')) {
      throw new Error(`worker write outside its scope: ${rel}`)
    }
    const qualified = rootId === 'main' ? value : `${rootId}:${value}`
    const owns = (scope: string): boolean => {
      const normalized = scope.replace(/\\/g, '/').replace(/\/+$/, '')
      if (normalized.startsWith('file:')) return qualified === normalized.slice(5)
      return qualified === normalized || qualified.startsWith(`${normalized}/`)
    }
    if (!scopes.some(owns)) {
      throw new Error(`worker write outside its scope: ${qualified} (allowed: ${scopes.join(', ')})`)
    }
  }

  /**
   * Extra roots are written directly as the user. They are outside the
   * primary git checkpoint/sandbox, so only whole-file writes are allowed and
   * the caller must have opted the root in as writable.
   */
  private writeExtraFile(root: WorkspaceRootConfig, relInput: string, content: string): ToolResult {
    if (root.writable !== true) throw new Error(`workspace root ${root.id} is read-only; enable writes for it first`)
    const rel = relInput.replace(/\\/g, '/').replace(/^\.\/+/, '')
    this.assertWriteScope(rel, root.id)
    const resolved = this.resolveRootPath(`${root.id}:${rel}`, true)
    const qualified = `${root.id}:${resolved.rel}`
    const existed = fs.existsSync(resolved.full)
    if (existed) {
      const expected = this.readHashes.get(qualified)
      if (!expected) throw new Error(`read_file is required before editing ${qualified}`)
      const current = sha256(fs.readFileSync(resolved.full))
      if (current !== expected) throw new Error(`file changed since read_file: ${qualified} (read the file again)`)
    }
    fs.mkdirSync(path.dirname(resolved.full), { recursive: true })
    const temp = `${resolved.full}.hy-tmp-${process.pid}`
    fs.writeFileSync(temp, content, 'utf8')
    fs.renameSync(temp, resolved.full)
    const hash = sha256(Buffer.from(content))
    this.readHashes.set(qualified, hash)
    return {
      appliedFiles: [qualified],
      created: existed ? [] : [qualified],
      deleted: [],
      hashes: { [qualified]: hash },
      warnings: [
        `writes to ${root.id} are outside the primary workspace sandbox and git checkpoints; /undo does not restore them`,
      ],
    }
  }

  private async applyPatch(args: Record<string, unknown>): Promise<ToolResult> {
    // WP-12: a read-only session may read its way around but never write. The
    // daemon enforces the same rule; this keeps the error close to the tool.
    if (this.options.sandboxMode?.() === 'read-only') {
      throw new Error('read-only sandbox forbids file writes; switch the session mode to write')
    }
    const rootArg = typeof args.root === 'string' ? args.root.trim() : undefined
    const root = rootArg ? this.root(rootArg) : undefined
    if (root && root.id !== 'main') {
      if (typeof args.patch === 'string' && args.patch.trim()) {
        throw new Error(`unified diffs are only supported in the primary root; use file + content for ${root.id}`)
      }
      const file = typeof args.file === 'string' ? args.file : typeof args.path === 'string' ? args.path : undefined
      const content = typeof args.content === 'string' ? args.content : undefined
      if (!file || content === undefined) throw new Error(`writing ${root.id} needs file + content`)
      const rel = file.startsWith(`${root.id}:`) ? file.slice(root.id.length + 1) : file
      return this.writeExtraFile(root, rel, content)
    }
    let patch = typeof args.patch === 'string' ? args.patch.trim() : ''
    if (!patch.includes('@@') && !patch.startsWith('---')) {
      const file = typeof args.file === 'string' ? args.file : typeof args.path === 'string' ? args.path : undefined
      const content = typeof args.content === 'string' ? args.content : undefined
      if (file && content !== undefined) {
        patch = wholeFilePatch(this.workspaceRoot, file, content)
      }
    }
    if (!patch) throw new Error('patch is empty')
    for (const rel of patchPaths(patch)) {
      this.assertWriteScope(rel)
      const full = path.resolve(this.workspaceRoot, rel)
      if (!fs.existsSync(full)) continue
      const expected = this.readHashes.get(rel)
      if (!expected) {
        throw new Error(`read_file is required before editing ${rel}`)
      }
      const current = sha256(fs.readFileSync(full))
      if (current !== expected) {
        throw new Error(`file changed since read_file: ${rel} (read the file again)`)
      }
    }
    const result = await this.exec.patch({
      patch,
      dryRun: false,
      enforceProtectedPaths: this.enforceProtectedPaths,
      ...(this.options.sandboxMode !== undefined ? { sandboxMode: this.options.sandboxMode() } : {}),
    })
    this.rememberHashes(result)
    return { ...result }
  }

  private rememberHashes(result: PatchApplyResult): void {
    for (const [rel, hash] of Object.entries(result.hashes)) {
      if (typeof hash === 'string') this.readHashes.set(rel.split(path.sep).join('/'), hash)
    }
    for (const rel of result.deleted) {
      this.readHashes.delete(rel.split(path.sep).join('/'))
    }
  }

  private async shell(args: Record<string, unknown>): Promise<ToolResult> {
    const command = String(args.command ?? '')
    if (!command.trim()) throw new Error('command is empty')
    this.options.shellGuard?.(command)
    // The exec server accepts cwd under the primary workspace or under a
    // configured extra writable root. Added roots are only usable when the
    // user explicitly enabled writes for them.
    const shellRoot = typeof args.root === 'string' ? this.root(args.root) : undefined
    if (shellRoot && shellRoot.id !== 'main' && shellRoot.writable !== true) {
      throw new Error(`shell cannot run in the read-only root "${shellRoot.id}"; enable writes for it first`)
    }
    // WP-31: the persistent shell keeps `cd`, environment variables and
    // functions between calls. It is unconfined-only; a confined session gets
    // the one-shot path plus the reason.
    const wanted = args.persistent === undefined ? this.options.persistentShell === true : args.persistent === true
    if (wanted && (!shellRoot || shellRoot.id === 'main')) {
      const persistent = await this.shellPersistent(command, args)
      if (persistent) return persistent
    }
    let requestedCwd: string | undefined
    if (shellRoot && shellRoot.id !== 'main') {
      const base = path.resolve(shellRoot.path)
      const rawCwd = args.cwd === undefined ? '.' : String(args.cwd)
      if (!path.isAbsolute(rawCwd) && rawCwd.includes(':')) {
        throw new Error(`cwd must be a path relative to root "${shellRoot.id}": ${rawCwd}`)
      }
      const resolved = path.resolve(base, rawCwd)
      const rel = path.relative(base, resolved)
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new Error(`cwd must be inside the added root "${shellRoot.id}": ${rawCwd}`)
      }
      requestedCwd = resolved
    } else {
      // WP-30: the session working directory is the shell's default cwd.
      requestedCwd =
        args.cwd === undefined
          ? this.cwd
            ? normalizeShellCwd(this.workspaceRoot, this.cwd)
            : undefined
          : normalizeShellCwd(this.workspaceRoot, String(args.cwd))
    }
    const requestedWait = args.foregroundWaitMs !== undefined ? Number(args.foregroundWaitMs) : undefined
    const minWait = this.options.minForegroundWaitMs
    const foregroundWaitMs =
      requestedWait !== undefined && minWait !== undefined
        ? Math.max(requestedWait, minWait)
        : requestedWait ?? minWait
    const base = {
      command,
      mode: 'agent' as const,
      ...(this.options.runId !== undefined ? { runId: this.options.runId } : {}),
      ...(requestedCwd !== undefined ? { cwd: requestedCwd } : {}),
      ...(foregroundWaitMs !== undefined ? { foregroundWaitMs } : {}),
      ...(args.hardTimeoutMs !== undefined ? { hardTimeoutMs: Number(args.hardTimeoutMs) } : {}),
      ...(args.stdinPipe === true ? { stdinPipe: true } : {}),
      // CP-09: a pseudo console for programs that need a terminal.
      ...(args.tty === true ? { tty: true } : {}),
      // WP-12: the session may switch modes mid-conversation.
      ...(this.options.sandboxMode !== undefined ? { sandboxMode: this.options.sandboxMode() } : {}),
    }
    const release = this.options.shellLock ? await this.options.shellLock.acquire() : undefined
    try {
      let result: ExecResult
      try {
        result = await this.exec.exec(base, this.signal, this.options.shellTimeoutMs)
      } catch (error) {
        if (!(error instanceof ExecRpcError) || error.code !== -32001) throw error
        const data = (error.data ?? {}) as {
          decision?: string
          justification?: string
          matchedRule?: string
          sandbox?: SandboxMode
        }
        if (data.decision !== 'prompt' || !this.approve) throw error
        const answer = await this.approve({
          command,
          ...(data.justification ? { justification: data.justification } : {}),
          ...(data.matchedRule ? { matchedRule: data.matchedRule } : {}),
          ...(data.sandbox ? { sandbox: data.sandbox } : {}),
          ...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
        })
        const decision: ApprovalDecision = typeof answer === 'boolean' ? { approved: answer, by: 'user' } : answer
        if (!decision.approved) {
          throw new Error(`command not approved: ${command}${decision.reason ? ` (${decision.by}: ${decision.reason})` : ''}`)
        }
        result = await this.exec.exec(
          {
            ...base,
            approval: { by: decision.by, callId: `tool-${Date.now()}` },
          },
          this.signal,
          this.options.shellTimeoutMs,
        )
      }
      if (this.options.noBackgroundShell && result.status === 'backgrounded') {
        if (result.jobId) await this.exec.jobKill(result.jobId).catch(() => undefined)
        throw new Error('worker shell commands must finish in the foreground; run a shorter command or ask the orchestrator to split the task')
      }
      const gap = [this.persistentGap, pipeChildGap(result, command)].filter(Boolean).join('; ')
      this.persistentGap = undefined
      return {
        ...result,
        ...(typeof result.stderr === 'string' ? { stderr: cleanPowerShellOutput(result.stderr) } : {}),
        ...(gap ? { gap } : {}),
      }
    } finally {
      release?.()
    }
  }

  private async webFetch(rawUrl: string): Promise<ToolResult> {
    const web = this.options.web!
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new Error(`invalid URL: ${rawUrl}`)
    }
    // Every host the request reaches, the first and each redirect, must be
    // allowed or approved.
    const authorize = async (target: URL, redirect: boolean): Promise<void> => {
      if (hostAllowed(target, web.allowDomains)) return
      // A redirect within the origin the user already approved needs no new prompt.
      if (redirect && target.origin === url.origin) return
      // The request leaves the sandbox's control, so Guardian never approves it.
      const answer = this.approve
        ? await this.approve({
            command: `web_fetch ${target.href}`,
            justification: redirect ? `network request (redirected from ${url.href})` : 'network request',
            sandbox: 'unconfined',
          })
        : false
      const decision: ApprovalDecision = typeof answer === 'boolean' ? { approved: answer, by: 'user' } : answer
      if (!decision.approved) throw new Error(`web_fetch not approved: ${target.href}${redirect ? ` (redirected from ${url.href})` : ''}`)
    }
    await authorize(url, false)
    return { ...(await webFetch(url.href, web, (next) => authorize(next, true))) }
  }

  private async mcpCall(server: string, tool: string, args: unknown): Promise<ToolResult> {
    const mcp = this.options.mcp!
    const spec = mcp.find(server, tool)
    if (!spec) throw new Error(`unknown MCP tool ${server}/${tool}; use one from the MCP tools list`)
    if (mcp.needsApproval(spec)) {
      // MCP servers run unconfined as the user, so Guardian never approves them.
      const command = `mcp ${server}/${tool} ${JSON.stringify(args).slice(0, 500)}`
      const answer = this.approve ? await this.approve({ command, justification: 'MCP tool call', sandbox: 'unconfined' }) : false
      const decision: ApprovalDecision = typeof answer === 'boolean' ? { approved: answer, by: 'user' } : answer
      if (!decision.approved) throw new Error(`MCP call not approved: ${server}/${tool}${decision.reason ? ` (${decision.by}: ${decision.reason})` : ''}`)
    }
    const r = await mcp.call(server, tool, args)
    if (r.isError) throw new Error(`${server}/${tool} failed: ${r.text}`)
    return { text: r.text, ...(r.structured !== undefined ? { structured: r.structured } : {}) }
  }

  private async runCode(args: Record<string, unknown>): Promise<ToolResult> {
    const code = String(args.code ?? '')
    if (!code.trim()) throw new Error('code is empty')
    const timeoutMs = Number(args.timeoutMs ?? 120_000)
    const maxSubCalls = Number(args.maxSubCalls ?? 200)
    // A run-ending error inside a sub-call (Guardian's breaker) must end the
    // run, not just reject one promise inside the script.
    let abort: AbortRunError | undefined
    const result = await this.exec.ptcRun(
      { jsCode: code, timeoutMs, maxSubCalls },
      async (sdkPath, subArgs) => {
        const spec = TOOLS_BY_SDK.get(sdkPath) ?? (sdkPath.startsWith('plugins.') ? this.options.plugins?.get(sdkPath.slice(8))?.spec : undefined)
        if (sdkPath === 'runCode' || spec?.name === 'run_code') throw new Error('run_code cannot nest')
        if (!spec) throw new Error(`tools.${sdkPath} does not exist`)
        // Reads in parallel, everything else one at a time (design §2). A
        // read-only subagent only reads, so it may run beside other reads.
        const parallel = spec.readOnly || (spec.name === 'delegate' && (subArgs as { readOnly?: unknown })?.readOnly !== false)
        try {
          return parallel
            ? await this.subCallLock.read(() => this.execute(spec.name, subArgs, true))
            : await this.subCallLock.write(() => this.execute(spec.name, subArgs, true))
        } catch (error) {
          if (error instanceof AbortRunError) abort = error
          throw error
        }
      },
      this.signal,
    )
    if (abort) throw abort
    if (result.status !== 'ok') throw new Error(result.error ?? 'run_code failed')
    return { status: 'ok', value: result.value, logs: result.logs, subCalls: result.subCalls }
  }
}

function wholeFilePatch(root: string, file: string, content: string): string {
  const rel = file.split(path.sep).join('/')
  const full = path.resolve(root, rel)
  const oldText = fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '') : undefined
  const oldLines = oldText === undefined ? [] : oldText.split(/\r?\n/)
  if (oldText !== undefined && oldText.endsWith('\n')) oldLines.pop()
  const newLines = content.split(/\r?\n/)
  if (content.endsWith('\n')) newLines.pop()
  const oldHeader = oldText === undefined ? '/dev/null' : `a/${rel}`
  const newHeader = `b/${rel}`
  const oldStart = oldLines.length === 0 ? 0 : 1
  const lines: string[] = [
    `--- ${oldHeader}`,
    `+++ ${newHeader}`,
    `@@ -${oldStart},${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ]
  if (!content.endsWith('\n') && newLines.length > 0) lines.push('\\ No newline at end of file')
  return `${lines.join('\n')}\n`
}

function patchPaths(patch: string): string[] {
  const out = new Set<string>()
  for (const line of patch.split('\n')) {
    const m = /^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/.exec(line)
    if (!m) continue
    const raw = m[1]!.split('\t')[0]!.trim().replace(/^"|"$/g, '')
    if (raw === '/dev/null') continue
    out.add(raw.split(path.sep).join('/'))
  }
  return [...out]
}
