import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import type { ExecResult, PatchApplyResult, SandboxMode } from './protocol.js'
import { ExecRpcClient, ExecRpcError } from './exec-rpc.js'
import { TOOLS_BY_NAME, TOOLS_BY_SDK, deferredTools, jsonSchemaToTs, validate, type ToolSpec } from './tool-registry.js'
import type { Ledger } from './ledger.js'
import { isIgnored, parseGitignore, type IgnoreRule } from './gitignore.js'
import { loadSkill, type SkillInfo } from './skills.js'
import type { McpManager } from './mcp.js'
import type { Hooks } from './hooks.js'
import { hostAllowed, webFetch, webSearch, type WebConfig } from './web.js'
import { parseLooseJsonObject } from './llm.js'
import { FOREGROUND_SHELL_DEFAULT_MS } from './tool-docs.js'
import type { LspManager, LspOp } from './lsp.js'
import type { LoadedPlugins } from './plugins.js'
import type { MemoryStore } from './memory.js'
import type { WorkspaceRootConfig } from './config.js'
import { gitCommit, gitPrepare, gitPush, gitStatus } from './git.js'
import {
  resolveGitHubToken,
  detectLocalGitHubRepo,
  githubGetRepo,
  githubEnablePages,
  githubListWorkflowRuns,
  githubCreatePullRequest,
  redactGitHubSecrets,
} from './github.js'

/** True when a tool schema itself declares an `args` property (e.g. mcp_call). */
function schemaAllowsArg(schema: ToolSpec['input'], key: string): boolean {
  if (schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, key)) return true
  return schema.anyOf?.some((child) => schemaAllowsArg(child, key)) ?? false
}

/**
 * Aliases for the edit tools, whose specs `@hy/cli` (`session-app.ts`) builds
 * outside this registry. Registry tools declare `aliases` on their spec;
 * `normalizeToolArgs` reads `spec.aliases ?? FILE_TOOL_ALIASES[spec.name]`.
 * Drop an entry once the host passes the aliases on the spec itself.
 */
export const FILE_TOOL_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  edit_file: { path: 'file', old_str: 'old', old_string: 'old', new_str: 'new', new_string: 'new' },
  write_file: { path: 'file' },
}

/**
 * G-12: rewrites alternate argument spellings (`old_str` for `old`) with one
 * generic pass. A canonical key the call already set wins, and an alias that
 * names a declared property is skipped, so a real argument is never moved.
 */
function applyArgumentAliases(spec: ToolSpec, args: Record<string, unknown>): void {
  const aliases = spec.aliases ?? FILE_TOOL_ALIASES[spec.name]
  if (!aliases) return
  const filled = new Set<string>()
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (args[canonical] !== undefined || schemaAllowsArg(spec.input, alias)) continue
    if (typeof args[alias] !== 'string') continue
    args[canonical] = args[alias]
    filled.add(canonical)
  }
  // Every spelling that fed the same key goes, as the per-tool code did.
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (filled.has(canonical) && !schemaAllowsArg(spec.input, alias)) delete args[alias]
  }
}

/**
 * Some models wrap the argument object twice (`{ args: { command } }`) or send
 * it as a JSON string. Unwrap that shape for tools that do not declare a real
 * `args` field. MCP routing fields can also be misplaced inside its payload.
 */
export function normalizeToolArgs(spec: ToolSpec, input: Record<string, unknown> | unknown): Record<string, unknown> {
  const baseInput =
    typeof input === 'string'
      ? (parseLooseJsonObject(input) ?? {})
      : input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
  let args = { ...baseInput }
  for (let depth = 0; depth < 3; depth += 1) {
    const wrapper = args.args !== undefined ? 'args' : 'arguments'
    if (args[wrapper] === undefined || schemaAllowsArg(spec.input, wrapper)) break
    let inner: unknown = args[wrapper]
    if (typeof inner === 'string') {
      const rawInner = inner
      try {
        inner = JSON.parse(rawInner)
      } catch {
        inner = parseLooseJsonObject(rawInner)
        if (!inner) break
      }
    }
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) break
    const merged: Record<string, unknown> = { ...(inner as Record<string, unknown>) }
    for (const [key, value] of Object.entries(args)) {
      // Keep outer options such as root/cwd/foregroundWaitMs; the inner object
      // carries the actual command/path/patch.
      if (key !== wrapper && value !== undefined) merged[key] = value
    }
    args = merged
  }
  applyArgumentAliases(spec, args)
  // Two tools need more than a rename, so they keep a step after the generic
  // aliasing: mcp_call recovers routing metadata buried in its payload, and
  // todo_write accepts the older `plan` list (`step` instead of `content`).
  if (spec.name === 'mcp_call' && args.server === undefined && args.args && typeof args.args === 'object' && !Array.isArray(args.args)) {
    const { server, tool, args: payload, ...inlinePayload } = args.args as Record<string, unknown>
    const routeTool = args.tool === undefined ? tool : args.tool
    // Recover only unambiguous routing metadata. A valid outer route owns its payload as-is.
    if (typeof server === 'string' && typeof routeTool === 'string' &&
        (tool === undefined || tool === routeTool) && (payload === undefined || Object.keys(inlinePayload).length === 0)) {
      args = { ...args, server, tool: routeTool, args: payload === undefined ? inlinePayload : payload }
    }
  } else if (spec.name === 'todo_write' && args.todos === undefined) {
    let plan = args.plan
    if (typeof plan === 'string') {
      try { plan = JSON.parse(plan) } catch { /* validation reports the required todos */ }
    }
    if (Array.isArray(plan)) {
      args.todos = plan.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !('step' in item) || 'content' in item) return item
        const { step, ...rest } = item
        return { ...rest, content: step }
      })
      delete args.plan
    }
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
 * True when a finished command failed because the confined token could not
 * start a child process that needs pipes (`spawn EPERM`) or a console
 * (`0xC0000142`). Stricter than `pipeChildGap`: a finished, non-zero command in
 * a confined mode, so the escalation offer cannot fire on a command that merely
 * printed such a string.
 */
export function sandboxPipeFailure(
  result: { stdout?: unknown; stderr?: unknown; exitCode?: unknown; sandbox?: unknown },
  command = '',
): boolean {
  if (typeof result.exitCode !== 'number' || result.exitCode === 0) return false
  const text = `${typeof result.stdout === 'string' ? result.stdout : ''}\n${typeof result.stderr === 'string' ? result.stderr : ''}`
  // The Node error line itself, not a program that merely mentions the words.
  if (/(?:^|\n)\s*(?:Error:\s*)?spawn(?:Sync)?\b[^\n]*\bEPERM\b/i.test(text)) return true
  if (/\bcode: 'EPERM'[^\n]*syscall: 'spawn'|syscall: 'spawn'[^\n]*code: 'EPERM'/i.test(text)) return true
  if (/0xC0000142/.test(text)) return true
  // A pipe or redirect hid the error line: a confined Node test runner failed.
  return (
    result.sandbox === 'workspace-write' &&
    /[|>;&]/.test(command) &&
    /\bnode(\.exe)?\s+--test\b|\b(npm|pnpm|yarn)(\.cmd)?\s+(run\s+)?(test|t)\b|\b(vitest|jest)\b/i.test(command)
  )
}

/** The part of a command that identifies it for a one-time escalation ("pnpm desktop:package:next"). */
export function commandShape(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase()
}

/**
 * Windows PowerShell 5.1 serializes stderr as CLIXML when a command fails.
 * Return the human-readable error strings instead of XML noise.
 */
export function cleanPowerShellOutput(text: string): string {
  if (!text.includes('#< CLIXML') && !text.includes('<Objs')) return stripVTControlCharacters(text)
  const errors = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((match) => match[1] ?? '')
  const source = errors.length > 0 ? errors.join('') : text
  return stripVTControlCharacters(source
    .replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\r\n/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/^#< CLIXML\s*/, '')
    .replace(/<\/?Objs[^>]*>/g, '')
    .replace(/<\/?S[^>]*>/g, '')
    .trim())
}

export interface ToolRuntimeOptions {
  /**
   * `update_plan` may hold several steps in progress: the session runs work in
   * parallel (an orchestrator with several workers). Otherwise only one.
   */
  parallelPlan?: boolean
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
  /** Live ownership checks for a shared workspace (also used by write_file/edit_file). */
  writeGuard?: (path: string) => void
  verifyGuard?: (path: string) => void
  /** Rechecked before dispatch and after waiting for the shared shell. */
  beforeTool?: () => void
  /** Primary (`main`) plus explicitly added roots for this session. */
  roots?: readonly WorkspaceRootConfig[]
  /** Extra command check for orchestration workers (git and harness-state commands). */
  shellGuard?: (command: string) => void
  /** Serializes this session's shell commands against other workers. */
  shellLock?: { acquire(): Promise<() => void> }
  /** Long-running worker commands stay in the foreground so the shell lock is held. */
  noBackgroundShell?: boolean
  shellTimeoutMs?: number
  /** Aborts in-flight `exec/command`, `ptc/run`, and `job/wait` RPCs on round timeout or Ctrl-C. */
  signal?: AbortSignal
  /** GitHub Personal Access Token or App token for GitHub API & Git operations. */
  githubToken?: string
  /** Shared-workspace workers may inspect Git while the owner owns mutations. */
  gitReadOnly?: boolean
  /** Host Git cannot read or publish paths the exec sandbox denies. */
  gitDenyRead?: readonly string[]
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
  let real: string
  try {
    real = fs.realpathSync.native(lexical)
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw new Error(`path does not exist in the workspace: ${rel} (check the path; use search_glob/search_grep if available)`)
    }
    throw error
  }
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

/**
 * How long one search_glob / search_grep may run and how much grep may read
 * before it returns what it has. An unfiltered grep over a large workspace
 * (725 MB of small files) otherwise ran for minutes. Exposed for tests.
 */
export const searchBudget = {
  maxMs: 15_000,
  maxBytes: 256 * 1024 * 1024,
  // grep skips larger files and names them in the result. It was 1 MB,
  // silently: a 1.7 MB project.md came back as `filesSearched: 0`, and the
  // model concluded that glob was broken.
  maxFileBytes: 16 * 1024 * 1024,
}

type SearchStop = 'time' | 'bytes'

function searchBudgetFor(signal: AbortSignal | undefined): { spent: (bytes: number) => SearchStop | undefined } {
  const started = Date.now()
  let read = 0
  return {
    spent(bytes) {
      if (signal?.aborted) throw new AbortRunError('round aborted')
      read += bytes
      if (read > searchBudget.maxBytes) return 'bytes'
      if (Date.now() - started > searchBudget.maxMs) return 'time'
      return undefined
    },
  }
}

/** Files grep left out for size, and how to read them instead. */
function skippedLarge(files: readonly string[]): { skippedLarge: string[]; skippedNote: string } {
  return {
    skippedLarge: files.slice(0, 20),
    skippedNote: `${files.length} file(s) over ${searchBudget.maxFileBytes / (1024 * 1024)} MB were not searched; read them with read_file startLine / endLine.`,
  }
}

function budgetNote(stop: SearchStop): string {
  const limit = stop === 'time' ? `${Math.round(searchBudget.maxMs / 1000)} s` : `${Math.round(searchBudget.maxBytes / (1024 * 1024))} MB`
  return `The search stopped early (${limit} limit) and the results are partial. Narrow it: pass glob (e.g. "**/*.md") or a more specific pattern, or search a subdirectory.`
}

/** `read_image` limits (WP-30): a vision model cannot use more than this. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
// High-resolution document scans fit without an agent-created thumbnail; bytes stay capped at 8 MiB.
export const MAX_IMAGE_PX = 8192

/**
 * 5-4: an MCP server's description travels in every prompt and in each native
 * tool definition, so a long one is cut. The server/tool prefix stays intact.
 */
export const MAX_MCP_TOOL_DESCRIPTION = 400

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
 * T-4: `edit_file` matches with LF line endings. `read_file` returns LF, so a
 * CRLF file (Windows with `core.autocrlf=true`) never matched the text the
 * model copied from the read. `source`, `oldText` and `newText` are compared
 * and joined as LF; the result gets the file's dominant EOL back (the same
 * rule the patch daemon uses), while an LF-only file stays LF. `count` is the
 * number of non-overlapping matches in the LF form.
 */
export function replaceIgnoringEol(source: string, oldText: string, newText: string): { count: number; text: string } {
  const before = source.replace(/\r\n/g, '\n')
  const needle = oldText.replace(/\r\n/g, '\n')
  const count = countOccurrences(before, needle)
  if (count === 0) return { count, text: source }
  const replaced = before.split(needle).join(newText.replace(/\r\n/g, '\n'))
  const crlf = countOccurrences(source, '\r\n')
  const lf = countOccurrences(source, '\n')
  const dominantCrlf = crlf > 0 && crlf * 2 > lf
  return { count, text: dominantCrlf ? replaced.replace(/\n/g, '\r\n') : replaced }
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
  private mcpRoutes = new Map<string, { server: string; tool: string; spec: ToolSpec }>()
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
  /** Command shapes already offered the low-integrity token (asked at most once each). */
  private readonly escalationAsked = new Set<string>()
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
      this.cwd && root.id === 'main' && input === rel && raw && !path.posix.isAbsolute(raw) && !raw.split('/').includes('..')
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
  toolFeatures(): Set<string> {
    const features = new Set<string>()
    if ((this.options.skills ?? []).length > 0) features.add('skills')
    if (this.options.mcp && this.options.mcp.tools.length > 0) features.add('mcp')
    if (this.options.delegate) features.add('delegate')
    if (this.options.backgroundDelegate) features.add('background-agents')
    if (this.options.web) features.add('web')
    if (this.options.web?.searchUrl) features.add('search')
    if (this.options.lsp?.configured) features.add('lsp')
    if (this.options.memory) features.add('memory')
    if (this.options.askUser) features.add('ask')
    if (!this.options.gitReadOnly) features.add('git-write')
    if (this.resolveGitHubToken()) {
      features.add('github')
      if (!this.options.gitReadOnly) features.add('github-write')
    }
    // 5-2: `job_*` is offered beside `shell`, the tool that backgrounds a
    // command. A read-only session (no shell in `allowTools`) has no jobs, and
    // a foreground-only shell (`noBackgroundShell`) never leaves one running.
    if (!this.options.noBackgroundShell && (!this.options.allowTools || this.options.allowTools.has('shell'))) {
      features.add('shell')
    }
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
        const result = await this.dispatch(name, args, viaSdk)
        const text = JSON.stringify(result)
        const redacted = redactGitHubSecrets(text, this.options.githubToken)
        return text === redacted ? result : JSON.parse(redacted) as ToolResult
      } catch (error) {
        if (this.signal?.aborted) throw new AbortRunError('round aborted')
        if (error instanceof Error) error.message = redactGitHubSecrets(error.message, this.options.githubToken)
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
    if (rootArg) {
      const root = this.root(rootArg)
      if (root.id !== 'main') throw new Error(`edit_file is only available in the primary root; use write_file for ${root.id}`)
    }
    // 5-3: resolve like `read_file` / `write_file`, so the session's
    // `working_directory` prefixes an unqualified path and a `root:` prefix is
    // understood. `allowMissing` keeps the "does not exist" wording below.
    const alreadyQualified = this.roots.some((root) => file.startsWith(`${root.id}:`))
    const input = rootArg && !alreadyQualified ? `${rootArg}:${file}` : file
    const resolved = this.resolveRootPath(input, true)
    if (resolved.root.id !== 'main') {
      throw new Error(`edit_file is only available in the primary root; use write_file for ${resolved.root.id}`)
    }
    const full = resolved.full
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`${file} does not exist`)
    // 5-3: decode with the same rules as `read_file` and keep the encoding for
    // the write-back; a UTF-16LE file (PowerShell `>` / `Out-File`) used to be
    // read as UTF-8 and the patch daemon then rejected the result.
    const decoded = decodeTextFile(fs.readFileSync(full))
    if (!decoded) throw new Error(`edit_file: ${file} is not a text file`)
    const before = decoded.text
    const { count: occurrences, text: after } = replaceIgnoringEol(before, oldText, newText)
    const want = args.count === undefined ? 1 : Number(args.count)
    if (occurrences === 0) throw new Error(`edit_file: the text to replace was not found in ${file}.${nearbyLines(before, oldText)}`)
    if (occurrences !== want) {
      throw new Error(`edit_file: the text occurs ${occurrences} times in ${file} but count=${want}.${nearbyLines(before, oldText)}`)
    }
    // The daemon re-adds the BOM from `encoding`, so it must not be in the text
    // (a UTF-8 BOM stayed in `before`; UTF-16 decoding already removed it).
    const content = decoded.encoding === 'utf8bom' && after.startsWith('\uFEFF') ? after.slice(1) : after
    // The resolved, root-qualified path is passed on: `applyPatch` resolves
    // diff paths from the root (not the session cwd), so the raw path would
    // name a different file when `working_directory` is set.
    return this.applyPatch({ file: this.qualified(resolved.root, resolved.rel), content }, decoded.encoding)
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
    return TOOLS_BY_NAME.get(name) ?? this.options.plugins?.get(name)?.spec ?? this.mcpRoutes.get(name)?.spec
  }

  mcpToolSpecs(): ToolSpec[] {
    for (const tool of this.options.mcp?.tools ?? []) {
      const label = `${tool.server}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 43)
      const suffix = createHash('sha256').update(JSON.stringify([tool.server, tool.name])).digest('hex').slice(0, 12)
      const name = `mcp_${label}_${suffix}`
      if (this.spec(name)) continue
      const description = `${tool.server}/${tool.name}. ${tool.description}`
      this.mcpRoutes.set(name, {
        server: tool.server,
        tool: tool.name,
        spec: {
          name, permission: 'mcp_call', wire: true, requires: 'mcp',
          // 5-4: the server's `annotations.readOnlyHint` is captured as
          // `McpTool.readOnly`; only an explicit `true` counts (a missing or
          // false hint stays on the serial, approval-gated path). Read-only
          // tools then run in parallel inside `run_code` (`isReadOnly`).
          readOnly: tool.readOnly === true,
          description: description.length > MAX_MCP_TOOL_DESCRIPTION
            ? `${description.slice(0, MAX_MCP_TOOL_DESCRIPTION - 1)}…`
            : description,
          input: tool.inputSchema, output: {},
        },
      })
    }
    return [...this.mcpRoutes.values()].map(({ spec }) => spec)
  }

  isReadOnly(name: string): boolean {
    return this.spec(name)?.readOnly === true
  }

  private async dispatch(name: string, args: unknown, viaSdk: boolean): Promise<ToolResult> {
    this.options.beforeTool?.()
    const spec = this.spec(name)
    if (!spec) throw new Error(`unknown tool: ${name}`)
    const permission = spec.permission ?? name
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
    if (spec.requires === 'background-agents' && !this.options.backgroundDelegate) throw new Error(`${name} needs a background subagent from spawn_agent. Orchestration workers report automatically.`)
    if ((spec.requires === 'git-write' || spec.requires === 'github-write') && this.options.gitReadOnly) {
      throw new Error('Repository changes belong to the orchestrator. Use git_status to inspect it.')
    }
    if (spec.requires === 'github-write' && !this.resolveGitHubToken()) {
      throw new Error('Connect GitHub in Settings before publishing.')
    }
    // CP-10: a deferred tool must be loaded before it can be called.
    if (spec.exposure === 'deferred' && !this.activated.has(name)) {
      throw new Error(`${name} is not loaded; call tool_search with words from its description first`)
    }
    if (this.allowOverride && !this.allowOverride.has(permission)) {
      // Plan mode keeps every tool in the prompt (a stable, cached prefix) and
      // refuses the changing ones here.
      throw new Error(`${name} is not available while plan mode is on: only reading and planning tools run. Propose the change in your plan instead.`)
    }
    const allow = this.options.allowTools
    if (allow && !allow.has(permission)) {
      // A bundle narrows the session's tools; say so, because "read-only" would
      // be misleading when another tool could still write.
      throw new Error(
        this.options.bundleLabel
          ? `${name} is not allowed here (this session's bundles: ${this.options.bundleLabel})`
          : `${name} is not allowed in this read-only session`,
      )
    }
    const route = this.mcpRoutes.get(name)
    const a = route && args !== null && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : normalizeToolArgs(spec, (args ?? {}) as Record<string, unknown>)
    // Accepted alias, kept out of the schema to save prompt tokens.
    if (name === 'apply_patch' && a.file === undefined && typeof a.path === 'string') a.file = a.path
    const problems = validate(spec.input, a)
    if (problems.length > 0) {
      const hint =
        name === 'shell' && problems.some((problem) => problem.includes('command'))
          ? ' (expected {"tool":"shell","args":{"command":"..."}}; do not nest args)'
          : name === 'mcp_call'
            ? ' Pass server and tool alongside args, for example {"server":"playwright","tool":"browser_navigate","args":{"url":"http://localhost:3000"}}.'
            : ` Expected arguments: ${jsonSchemaToTs(spec.input)}. In JSON tool calls, put arguments inside "args", not beside "tool".`
      throw new Error(`invalid arguments for ${name}: ${problems.join('; ')}${hint}`)
    }
    if (route) return this.mcpCall(route.server, route.tool, a)
    const plugin = this.options.plugins?.get(name)
    if (plugin) {
      const value = await plugin.run(a, { workspaceRoot: this.workspaceRoot })
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ToolResult) : { value }
    }
    switch (name) {
      case 'read_file':
        return this.readFile(a)
      case 'verify_file':
        return this.verifyFile(a)
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
        if (!this.options.parallelPlan && plan.filter((s) => s.status === 'in_progress').length > 1) throw new Error('at most one step may be in_progress')
        this.plan = plan.map((s) => ({ step: s.step, status: s.status }))
        return { ok: true, remaining: plan.filter((s) => s.status !== 'completed').length }
      }
      case 'delegate': {
        this.checkSubagentCapabilities(a)
        if (a.background === true) {
          if (!this.options.backgroundDelegate) throw new Error('background subagents are only available in the web session')
          const agentId = this.options.backgroundDelegate(String(a.task), a.readOnly !== false)
          return { agentId, status: 'running', hint: 'list_agents / send_message / interrupt_agent' }
        }
        const r = await this.options.delegate!(String(a.task), a.readOnly !== false)
        return { final: r.final, steps: r.steps }
      }
      case 'spawn_agent': {
        this.checkSubagentCapabilities(a)
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
      case 'web_search': {
        const query = String(a.query)
        const limit = a.maxResults === undefined ? 5 : Number(a.maxResults)
        if (this.options.web?.searchUrl) {
          return webSearch(query, this.options.web, limit)
        }
        if (this.options.mcp && this.options.mcp.tools.some((t) => t.server === 'rustxng' && t.name === 'search')) {
          const res = await this.options.mcp.call('rustxng', 'search', { query, limit })
          if (res.isError) throw new Error(res.text)
          if (res.structured && typeof res.structured === 'object') return res.structured as ToolResult
          try {
            return JSON.parse(res.text) as ToolResult
          } catch {
            return { result: res.text }
          }
        }
        if (this.options.web) {
          return webSearch(query, this.options.web, limit)
        }
        throw new Error('web_search requires web.searchUrl or the rustxng MCP server')
      }
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
      case 'git_status':
        return {
          ...await gitStatus(this.workspaceRoot, this.signal),
          githubCredentialConfigured: Boolean(this.resolveGitHubToken()),
        }
      case 'git_prepare': {
        const ref = this.resolveRepoRef(a)
        const token = this.resolveGitHubToken()
        const branch = typeof a.branch === 'string' ? a.branch : (await githubGetRepo(ref.owner, ref.repo, token)).defaultBranch
        return this.gitMutation(`Prepare Git workspace for ${ref.owner}/${ref.repo} (${branch})`, () =>
          gitPrepare(this.workspaceRoot, ref, branch, token, this.signal))
      }
      case 'git_commit':
        return this.gitMutation(`Commit files: ${(a.paths as string[]).join(', ').slice(0, 800)}`, () =>
          gitCommit(this.workspaceRoot, a.paths as string[], String(a.message), this.resolveGitHubToken(), this.signal))
      case 'git_push': {
        const status = await gitStatus(this.workspaceRoot, this.signal)
        const ref = status.origin
        if (!ref) throw new Error('This workspace has no GitHub origin. Use git_prepare first.')
        const branch = typeof a.branch === 'string' ? a.branch : status.branch
        if (!branch) throw new Error('HEAD is detached; specify the destination branch.')
        return this.gitMutation(`Push current commit to ${ref.owner}/${ref.repo} (${branch})`, () =>
          gitPush(this.workspaceRoot, ref, branch, this.resolveGitHubToken()!, this.signal), false)
      }
      case 'github_repo_info': {
        const { owner, repo } = this.resolveRepoRef(a)
        const token = this.resolveGitHubToken()
        const res = await githubGetRepo(owner, repo, token)
        return { ...res }
      }
      case 'github_pages_enable': {
        const { owner, repo } = this.resolveRepoRef(a)
        const token = this.resolveGitHubToken()
        if (!token) throw new Error('GitHub token is required to configure GitHub Pages.')
        const buildType = a.buildType === 'legacy' ? 'legacy' : 'workflow'
        return this.gitMutation(`Configure GitHub Pages for ${owner}/${repo} (${buildType})`, async () =>
          ({ ...await githubEnablePages(owner, repo, buildType, token) }), false)
      }
      case 'github_actions_status': {
        const { owner, repo } = this.resolveRepoRef(a)
        const token = this.resolveGitHubToken()
        const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.min(20, Math.floor(a.limit)) : 5
        const runs = await githubListWorkflowRuns(owner, repo, token, limit)
        return { runs }
      }
      case 'github_create_pr': {
        const { owner, repo } = this.resolveRepoRef(a)
        const token = this.resolveGitHubToken()
        if (!token) throw new Error('GitHub token is required to create a pull request.')
        const title = String(a.title ?? '').trim()
        const head = String(a.head ?? '').trim()
        if (!title) throw new Error('title is required for github_create_pr')
        if (!head) throw new Error('head branch is required for github_create_pr')
        let base = typeof a.base === 'string' ? a.base.trim() : ''
        if (!base) {
          const info = await githubGetRepo(owner, repo, token).catch(() => undefined)
          base = info?.defaultBranch || 'main'
        }
        const body = typeof a.body === 'string' ? a.body : undefined
        return this.gitMutation(`Create a pull request in ${owner}/${repo} (${head} → ${base})`, async () =>
          ({ ...await githubCreatePullRequest(owner, repo, { title, head, base, ...(body !== undefined ? { body } : {}) }, token) }), false)
      }
      default:
        throw new Error(`unknown tool: ${name}`)
    }
  }

  private checkSubagentCapabilities(args: Record<string, unknown>): void {
    const required = args.requires as string[] | undefined
    if (!required) return
    if (args.readOnly !== false && required.some((capability) => capability !== 'read')) {
      throw new Error('This subagent is read-only. Set readOnly=false to request edit or shell capability.')
    }
    if (required.includes('edit') && this.options.sandboxMode?.() === 'read-only') {
      throw new Error('The session sandbox is read-only. This subagent cannot edit.')
    }
  }

  private resolveRepoRef(args: Record<string, unknown>): { owner: string; repo: string } {
    let owner = typeof args.owner === 'string' ? args.owner.trim() : ''
    let repo = typeof args.repo === 'string' ? args.repo.trim() : ''
    if (!owner || !repo) {
      const detected = detectLocalGitHubRepo(this.workspaceRoot)
      if (detected) {
        if (!owner) owner = detected.owner
        if (!repo) repo = detected.repo
      }
    }
    if (!owner || !repo) {
      throw new Error('Could not determine GitHub owner/repo. Please specify owner and repo explicitly, or configure a git remote origin.')
    }
    return { owner, repo }
  }

  private resolveGitHubToken(): string | undefined {
    return this.options.githubToken || resolveGitHubToken()
  }

  private async gitMutation<T extends ToolResult>(command: string, run: () => Promise<T>, local = true): Promise<T> {
    if (this.options.sandboxMode?.() === 'read-only') throw new Error('Git changes are disabled in the read-only sandbox.')
    const root = path.resolve(this.workspaceRoot)
    const overlaps = this.options.gitDenyRead?.some((denied) => {
      const dir = path.resolve(denied)
      const inside = (base: string, file: string) => {
        const rel = path.relative(base, file)
        return rel === '' || !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)
      }
      return inside(root, dir) || inside(dir, root)
    })
    if (overlaps) throw new Error('Native Git changes are disabled because this workspace has paths denied to the session.')
    const answer = await this.approve?.({ command: redactGitHubSecrets(command, this.options.githubToken), justification: 'Git repository operation', sandbox: 'unconfined' })
    if (typeof answer === 'boolean' ? !answer : !answer?.approved) throw new Error('Git operation was not approved.')
    const release = local ? await this.options.shellLock?.acquire() : undefined
    try {
      this.options.beforeTool?.()
      if (this.signal?.aborted) throw new AbortRunError('round aborted')
      return await run()
    } finally {
      release?.()
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
  /**
   * Asynchronous on purpose: in the desktop app and `hy web` the tools run in
   * the same process as the UI server, and a synchronous walk of a large tree
   * (18,000 files, no .gitignore) froze the window until it finished.
   */
  private async *walk(root: string): AsyncGenerator<string> {
    yield* this.walkDir(root, '', rootIgnoreRules(root))
  }

  /**
   * `.gitignore` rules apply as git applies them: the root file (plus
   * `.git/info/exclude`), then each nested `.gitignore` below its directory.
   * An ignored directory is not entered at all.
   */
  private async *walkDir(dir: string, rel: string, inherited: readonly IgnoreRule[]): AsyncGenerator<string> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    let rules = inherited
    if (rel !== '' && entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      try {
        rules = [...inherited, ...parseGitignore(await fs.promises.readFile(path.join(dir, '.gitignore'), 'utf8'), rel)]
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

  private async searchGlob(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(args.pattern)
    const re = globToRegExp(pattern)
    const max = Number(args.maxResults ?? 200)
    const selected = args.root === '*' ? this.roots : [this.root(typeof args.root === 'string' ? args.root : undefined)]
    const files: string[] = []
    const budget = searchBudgetFor(this.signal)
    for (const root of selected) {
      for await (const rel of this.walk(root.path)) {
        const stop = budget.spent(0)
        if (stop) return { files, truncated: true, stoppedEarly: stop, note: budgetNote(stop) }
        if (!re.test(rel)) continue
        if (files.length >= max) return { files, truncated: true }
        files.push(this.qualified(root, rel))
      }
    }
    return withIgnoreNote({ files, truncated: false }, files.length === 0 ? ignoredTarget(selected, pattern) : undefined)
  }

  private async searchGrep(args: Record<string, unknown>): Promise<ToolResult> {
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
    const tooLarge: string[] = []
    const budget = searchBudgetFor(this.signal)
    for (const root of selected) {
      for await (const rel of this.walk(root.path)) {
        if (only && !only.test(rel)) continue
        const full = path.join(root.path, rel)
        let bytes: Buffer
        try {
          const size = (await fs.promises.stat(full)).size
          if (size > searchBudget.maxFileBytes) {
            tooLarge.push(`${this.qualified(root, rel)} (${(size / (1024 * 1024)).toFixed(1)} MB)`)
            continue
          }
          bytes = await fs.promises.readFile(full)
        } catch {
          continue
        }
        // Checked after the read, so a search always gets through at least
        // the first file however small the budget.
        const stop = budget.spent(bytes.length)
        const decoded = decodeTextBuffer(bytes)
        if (decoded === undefined) {
          if (stop) return { matches, truncated: true, filesSearched, stoppedEarly: stop, note: budgetNote(stop), ...(tooLarge.length > 0 ? { skippedLarge: tooLarge.slice(0, 20) } : {}) }
          continue
        }
        filesSearched += 1
        const lines = decoded.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i]!)) continue
          if (matches.length >= max) return { matches, truncated: true, filesSearched }
          matches.push({ path: this.qualified(root, rel), line: i + 1, text: lines[i]!.slice(0, 300) })
        }
        if (stop) return { matches, truncated: true, filesSearched, stoppedEarly: stop, note: budgetNote(stop), ...(tooLarge.length > 0 ? { skippedLarge: tooLarge.slice(0, 20) } : {}) }
      }
    }
    const target = matches.length === 0 && typeof args.glob === 'string' ? ignoredTarget(selected, args.glob) : undefined
    const result = withIgnoreNote({ matches, truncated: false, filesSearched }, target)
    return tooLarge.length > 0 ? { ...result, ...skippedLarge(tooLarge) } : result
  }

  private verifyFile(args: Record<string, unknown>): ToolResult {
    const { root, rel, full } = this.resolveRootPath(String(args.path))
    if (root.id !== 'main') throw new Error('verify_file only checks files in the primary workspace.')
    this.options.verifyGuard?.(rel)
    const blocked = this.options.gitDenyRead?.some((dir) => {
      const denied = fs.existsSync(dir) ? fs.realpathSync.native(dir) : path.resolve(dir)
      const relative = path.relative(denied, full)
      return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    })
    if (blocked) throw new Error('This path is denied to the session.')
    const stat = fs.statSync(full)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('verify_file requires a regular file of at most 2 MiB.')
    const bytes = fs.readFileSync(full)
    const content = decodeTextBuffer(bytes)
    if (content === undefined) throw new Error('verify_file requires a text file.')
    let passed: boolean
    if (args.check === 'json') {
      try {
        JSON.parse(content)
        passed = true
      } catch {
        passed = false
      }
    } else {
      if (typeof args.text !== 'string' || !args.text) throw new Error('The contains check requires nonempty text.')
      passed = content.includes(args.text)
    }
    return { path: rel, passed, sha256: sha256(bytes), detail: args.check === 'json'
      ? (passed ? 'Valid JSON.' : 'Invalid JSON.')
      : (passed ? 'Text found.' : 'Text not found.') }
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
      throw new Error(message.includes('does not exist') ? `${message} (check the path; use search_glob/search_grep if available)` : message)
    }
    const full = spilled ?? resolved!.full
    const stat = fs.statSync(full)
    if (!stat.isFile()) throw new Error(`not a file: ${input}`)
    const bytes = fs.readFileSync(full)
    const text = decodeTextBuffer(bytes)
    if (text === undefined) throw new Error(`binary file: ${input}`)
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
    this.options.writeGuard?.(rootId === 'main' ? rel : `${rootId}:${rel}`)
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

  /**
   * `writeEncoding` is internal to `editFile` (5-3): the file's own encoding,
   * forwarded to `patch/apply`, which re-encodes its output with it. It is not
   * a schema argument, so `apply_patch` / `write_file` calls never set it.
   */
  private async applyPatch(args: Record<string, unknown>, writeEncoding?: TextEncoding): Promise<ToolResult> {
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
    const canonicalPath = (input: string): string => {
      const { root, rel } = this.splitRoot(input)
      if (root.id !== 'main') throw new Error('diff paths must stay in the primary workspace; use file + content for an extra root')
      return this.resolveRootPath(`main:${rel}`, true).rel
    }
    if (patch.startsWith('*** Begin Patch') || /^@@\s*$/m.test(patch)) {
      const converted = convertNonStandardPatch(this.workspaceRoot, patch, canonicalPath)
      if (converted !== undefined) patch = converted
    }
    if (patch.startsWith('*** Begin Patch')) {
      throw new Error('Unsupported patch format: use a unified diff with ---/+++ file headers and numbered @@ hunks, or use file + content. Read existing files first.')
    }
    if (/^@@\s*$/m.test(patch)) {
      throw new Error('Unified diff hunks need line numbers, for example @@ -1,3 +1,3 @@. Alternatively use file + content.')
    }
    if (!patch.includes('@@') && !patch.startsWith('---')) {
      const file = typeof args.file === 'string' ? args.file : typeof args.path === 'string' ? args.path : undefined
      const content = typeof args.content === 'string' ? args.content : undefined
      if (file && content !== undefined) {
        patch = wholeFilePatch(this.workspaceRoot, canonicalPath(file), content)
      }
    }
    if (!patch) throw new Error('patch is empty')
    for (const rel of patchPaths(patch)) {
      const canonical = canonicalPath(rel)
      if (canonical !== rel) throw new Error(`use the repository-relative diff path ${canonical} instead of ${rel}`)
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
    // `encoding` is not in the generated `PatchApplyParams` yet; a variable
    // keeps the extra field assignable while the daemon type catches up (F4 /
    // the Rust side add it for 5-3). Absent keeps the daemon's UTF-8 default.
    const params = {
      patch,
      dryRun: false,
      enforceProtectedPaths: this.enforceProtectedPaths,
      ...(this.options.sandboxMode !== undefined ? { sandboxMode: this.options.sandboxMode() } : {}),
      ...(writeEncoding !== undefined ? { encoding: writeEncoding } : {}),
    }
    const result = await this.exec.patch(params)
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
    if (wanted && !this.options.shellLock && (!shellRoot || shellRoot.id === 'main')) {
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
    const hardTimeoutMs = args.hardTimeoutMs !== undefined
      ? Number(args.hardTimeoutMs)
      : this.options.noBackgroundShell ? FOREGROUND_SHELL_DEFAULT_MS : undefined
    if (this.options.noBackgroundShell && (!Number.isSafeInteger(hardTimeoutMs) || hardTimeoutMs! < 1 || hardTimeoutMs! > 2_147_448_647)) {
      throw new Error('hardTimeoutMs must be between 1 and 2147448647 milliseconds')
    }
    // Keep the scope lock until the command finishes or the exec server kills it.
    const foregroundWaitMs = this.options.noBackgroundShell ? hardTimeoutMs! + 5_000 : requestedWait
    const base = {
      command,
      mode: 'agent' as const,
      ...(this.options.runId !== undefined ? { runId: this.options.runId } : {}),
      ...(requestedCwd !== undefined ? { cwd: requestedCwd } : {}),
      ...(foregroundWaitMs !== undefined ? { foregroundWaitMs } : {}),
      ...(hardTimeoutMs !== undefined ? { hardTimeoutMs } : {}),
      ...(args.stdinPipe === true ? { stdinPipe: true } : {}),
      // CP-09: a pseudo console for programs that need a terminal.
      ...(args.tty === true ? { tty: true } : {}),
      // WP-12: the session may switch modes mid-conversation.
      ...(this.options.sandboxMode !== undefined ? { sandboxMode: this.options.sandboxMode() } : {}),
    }
    const release = this.options.shellLock ? await this.options.shellLock.acquire() : undefined
    try {
      this.options.beforeTool?.()
      this.options.shellGuard?.(command)
      let result: ExecResult
      /** Set when the command was retried with a looser sandbox token. */
      let escalated: 'low-integrity' | undefined
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
        this.options.beforeTool?.()
        this.options.shellGuard?.(command)
        result = await this.exec.exec(
          {
            ...base,
            approval: { by: decision.by, callId: `tool-${Date.now()}` },
          },
          this.signal,
          this.options.shellTimeoutMs,
        )
      }
      // The sandbox, not the command, caused the failure: offer the
      // low-integrity token once per command shape. Only the user can grant it
      // (design §5), so a Guardian approval is not enough.
      if (
        this.approve &&
        result.sandbox === 'workspace-write' &&
        sandboxPipeFailure(result, command) &&
        !this.escalationAsked.has(commandShape(command))
      ) {
        this.escalationAsked.add(commandShape(command))
        const answer = await this.approve({
          command,
          justification:
            'The confined sandbox could not start a child process that needs pipes (spawn EPERM). Run this command with the low-integrity token instead? It can write to the session\u2019s grant routes and %LOCALAPPDATA%\\LocalLow.',
          sandbox: 'low-integrity',
        })
        const decision: ApprovalDecision = typeof answer === 'boolean' ? { approved: answer, by: 'user' } : answer
        if (decision.approved && decision.by === 'user') {
          this.options.beforeTool?.()
          this.options.shellGuard?.(command)
          result = await this.exec.exec(
            { ...base, sandboxMode: 'low-integrity', approval: { by: 'user', callId: `tool-${Date.now()}` } },
            this.signal,
            this.options.shellTimeoutMs,
          )
          escalated = 'low-integrity'
        }
      }
      if (this.options.noBackgroundShell && result.status === 'backgrounded') {
        if (result.jobId) await this.exec.jobKill(result.jobId).catch(() => undefined)
        throw new Error('worker shell commands must finish in the foreground; run a shorter command or ask the orchestrator to split the task')
      }
      if (this.options.noBackgroundShell && result.exitCode == null) {
        throw new Error('Shell command ended without an exit code. Check its outputs and hardTimeoutMs before retrying.')
      }
      const gap = [this.persistentGap, escalated ? undefined : pipeChildGap(result, command)].filter(Boolean).join('; ')
      this.persistentGap = undefined
      return {
        ...result,
        ...(escalated ? { escalated } : {}),
        ...(typeof result.stdout === 'string' ? { stdout: cleanPowerShellOutput(result.stdout) } : {}),
        ...(typeof result.stderr === 'string' ? { stderr: cleanPowerShellOutput(result.stderr) } : {}),
        ...(gap ? { gap } : {}),
      }
    } finally {
      release?.()
    }
  }

  foregroundShell(): boolean {
    return this.options.noBackgroundShell === true
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
    const problems = validate(spec.inputSchema, args)
    if (problems.length) throw new Error(`invalid input for ${server}/${tool}: ${problems.join('; ')}`)
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

/** The encodings `decodeTextFile` reports and `patch/apply` writes back (5-3). */
export type TextEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be'

export interface DecodedText {
  text: string
  encoding: TextEncoding
}

/**
 * Decodes UTF-8, UTF-16LE, or UTF-16BE text files, returning `undefined` when
 * the buffer contains binary data. PowerShell 5.1 redirection (`>` /
 * `Out-File`) writes UTF-16LE with a `0xFF 0xFE` BOM by default.
 */
export function decodeTextBuffer(bytes: Buffer): string | undefined {
  return decodeTextFile(bytes)?.text
}

/**
 * `decodeTextBuffer` plus the encoding that produced the text, so `edit_file`
 * can write the file back in its own encoding (5-3): the patch RPC takes the
 * encoding and re-adds the BOM. A UTF-8 BOM stays in `text` (what `read_file`
 * has always returned); the writer drops it so the BOM is not written twice.
 */
export function decodeTextFile(bytes: Buffer): DecodedText | undefined {
  if (bytes.length === 0) return { text: '', encoding: 'utf8' }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    if (bytes.length >= 4 && bytes[2] === 0x00 && bytes[3] === 0x00) return undefined
    if ((bytes.length - 2) % 2 !== 0) return undefined
    const text = bytes.subarray(2).toString('utf16le')
    return text.includes('\0') ? undefined : { text, encoding: 'utf16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    if ((bytes.length - 2) % 2 !== 0) return undefined
    const body = Buffer.from(bytes.subarray(2))
    body.swap16()
    const text = body.toString('utf16le')
    return text.includes('\0') ? undefined : { text, encoding: 'utf16be' }
  }
  if (bytes.length >= 4 && bytes.length % 2 === 0 && bytes[1] === 0x00) {
    const sampleLen = Math.min(bytes.length, 8192) & ~1
    let asciiUnits = 0
    let valid = true
    const totalUnits = sampleLen / 2
    for (let i = 0; i < sampleLen; i += 2) {
      const lo = bytes[i]!
      const hi = bytes[i + 1]!
      if (lo === 0 && hi === 0) {
        valid = false
        break
      }
      if (hi === 0) {
        if (lo === 0x09 || lo === 0x0a || lo === 0x0d || (lo >= 0x20 && lo <= 0x7e)) {
          asciiUnits += 1
        } else if (lo < 0x20 || lo === 0x7f) {
          valid = false
          break
        }
      }
    }
    if (valid && totalUnits > 0 && asciiUnits / totalUnits >= 0.8) {
      const text = bytes.toString('utf16le')
      return text.includes('\0') ? undefined : { text, encoding: 'utf16le' }
    }
  }
  if (bytes.subarray(0, 8192).includes(0)) return undefined
  const text = bytes.toString('utf8')
  if (text.includes('\0')) return undefined
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  return { text, encoding: bom ? 'utf8bom' : 'utf8' }
}

function applyHunksToFile(fullPath: string, hunks: string[][]): string | undefined {
  if (!fs.existsSync(fullPath)) return undefined
  try {
    if (!fs.statSync(fullPath).isFile()) return undefined
  } catch {
    return undefined
  }
  const raw = decodeTextBuffer(fs.readFileSync(fullPath))
  if (raw === undefined) return undefined
  const clean = raw.replace(/^\uFEFF/, '')
  const hadTrailingNewline = clean.endsWith('\n')
  const lines = clean.split(/\r?\n/)
  if (hadTrailingNewline) lines.pop()
  let cursor = 0
  for (const hunk of hunks) {
    const oldChunk: string[] = []
    const newChunk: string[] = []
    for (const line of hunk) {
      if (line.startsWith('\\ No newline at end of file')) continue
      if (line.startsWith('-')) oldChunk.push(line.slice(1))
      else if (line.startsWith('+')) newChunk.push(line.slice(1))
      else if (line.startsWith(' ')) {
        oldChunk.push(line.slice(1))
        newChunk.push(line.slice(1))
      } else if (line === '') {
        oldChunk.push('')
        newChunk.push('')
      } else {
        return undefined
      }
    }
    if (oldChunk.length === 0 && newChunk.length === 0) continue
    if (oldChunk.length === 0) {
      if (lines.length === 0) {
        lines.push(...newChunk)
        cursor = lines.length
        continue
      }
      return undefined
    }
    const findMatches = (from: number, trimRight: boolean): number[] => {
      const out: number[] = []
      const limit = lines.length - oldChunk.length
      for (let i = from; i <= limit; i++) {
        let ok = true
        for (let j = 0; j < oldChunk.length; j++) {
          const a = trimRight ? lines[i + j]!.trimEnd() : lines[i + j]!
          const b = trimRight ? oldChunk[j]!.trimEnd() : oldChunk[j]!
          if (a !== b) {
            ok = false
            break
          }
        }
        if (ok) out.push(i)
      }
      return out
    }
    let matches = findMatches(cursor, false)
    if (matches.length === 0) matches = findMatches(0, false)
    if (matches.length === 0) matches = findMatches(cursor, true)
    if (matches.length === 0) matches = findMatches(0, true)
    if (matches.length !== 1) return undefined
    const at = matches[0]!
    lines.splice(at, oldChunk.length, ...newChunk)
    cursor = at + newChunk.length
  }
  return `${lines.join('\n')}${hadTrailingNewline || lines.length > 0 ? '\n' : ''}`
}

/**
 * Converts `*** Begin Patch` (`*** Update File:` / `*** Add File:`) or unified
 * diffs with unnumbered `@@` hunks into numbered unified diffs when every
 * referenced file exists on disk and every hunk matches uniquely. Falls back to
 * `undefined` when any file is missing or ambiguous so the caller's diagnostic
 * error still fires.
 */
function convertNonStandardPatch(workspaceRoot: string, patch: string, canonicalPath: (input: string) => string): string | undefined {
  const rawLines = patch.split(/\r?\n/)
  const outPatches: string[] = []
  if (patch.startsWith('*** Begin Patch')) {
    let i = 0
    if (rawLines[i]?.trim() === '*** Begin Patch') i += 1
    while (i < rawLines.length) {
      const header = rawLines[i]!.trim()
      if (!header || header === '*** End Patch') {
        i += 1
        continue
      }
      if (header.startsWith('*** Add File:')) {
        const rel = canonicalPath(header.slice('*** Add File:'.length).trim())
        if (!rel) return undefined
        const full = path.resolve(workspaceRoot, rel)
        if (fs.existsSync(full)) return undefined
        i += 1
        const body: string[] = []
        while (i < rawLines.length && !rawLines[i]!.startsWith('*** ')) {
          const l = rawLines[i]!
          body.push(l.startsWith('+') ? l.slice(1) : l)
          i += 1
        }
        outPatches.push(wholeFilePatch(workspaceRoot, rel, `${body.join('\n')}\n`))
        continue
      }
      if (header.startsWith('*** Update File:')) {
        const rel = canonicalPath(header.slice('*** Update File:'.length).trim())
        if (!rel) return undefined
        i += 1
        if (rawLines[i]?.startsWith('*** Move to:')) return undefined
        const hunks: string[][] = []
        let current: string[] = []
        while (i < rawLines.length && !rawLines[i]!.startsWith('*** ')) {
          const l = rawLines[i]!
          if (l.startsWith('@@')) {
            if (current.length > 0) hunks.push(current)
            current = []
          } else {
            current.push(l)
          }
          i += 1
        }
        if (current.length > 0) hunks.push(current)
        if (hunks.length === 0) return undefined
        const updated = applyHunksToFile(path.resolve(workspaceRoot, rel), hunks)
        if (updated === undefined) return undefined
        outPatches.push(wholeFilePatch(workspaceRoot, rel, updated))
        continue
      }
      return undefined
    }
    return outPatches.length > 0 ? outPatches.join('') : undefined
  }
  if (/^@@\s*$/m.test(patch)) {
    let i = 0
    while (i < rawLines.length) {
      while (i < rawLines.length && !rawLines[i]!.startsWith('--- ')) i += 1
      if (i >= rawLines.length) break
      const oldHeader = rawLines[i]!
      const newHeader = rawLines[i + 1]
      if (!newHeader || !newHeader.startsWith('+++ ')) return undefined
      const m = /^\+\+\+ (?:b\/)?(.+)$/.exec(newHeader)
      if (!m) return undefined
      const input = m[1]!.split('\t')[0]!.trim().replace(/^"|"$/g, '')
      if (!input || input === '/dev/null' || oldHeader.includes('/dev/null')) return undefined
      const rel = canonicalPath(input)
      i += 2
      const hunks: string[][] = []
      let current: string[] = []
      while (i < rawLines.length && !rawLines[i]!.startsWith('--- ')) {
        const l = rawLines[i]!
        if (l.startsWith('@@')) {
          if (current.length > 0) hunks.push(current)
          current = []
        } else if (hunks.length > 0 || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          current.push(l)
        }
        i += 1
      }
      if (current.length > 0) hunks.push(current)
      if (hunks.length === 0) return undefined
      const updated = applyHunksToFile(path.resolve(workspaceRoot, rel), hunks)
      if (updated === undefined) return undefined
      outPatches.push(wholeFilePatch(workspaceRoot, rel, updated))
    }
    return outPatches.length > 0 ? outPatches.join('') : undefined
  }
  return undefined
}

function wholeFilePatch(root: string, file: string, content: string): string {
  const rel = file.split(path.sep).join('/')
  const full = path.resolve(root, rel)
  // 5-3: decode the old side the way `read_file` does, so a UTF-16 file's
  // hunks quote its real lines (the daemon decodes and re-encodes it with the
  // `encoding` the edit passes). The BOM is never part of the lines.
  const oldBytes = fs.existsSync(full) ? fs.readFileSync(full) : undefined
  const oldText = oldBytes === undefined
    ? undefined
    : (decodeTextFile(oldBytes)?.text ?? oldBytes.toString('utf8')).replace(/^\uFEFF/, '')
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
