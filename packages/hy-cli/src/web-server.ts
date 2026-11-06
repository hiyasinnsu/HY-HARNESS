import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import {
  MemoryStore,
  HARNESS_VERSION,
  buildInfo,
  canonicalWorkspace,
  loadConfig,
  parseSandboxMode,
  readEvents,
  metricsSnapshot,
  describeHooks,
  elicitationContent,
  setElicitationHandler,
  discoverSkills,
  WorktreeManager,
  worktreesDir,
  roleSupportsImages,
  usesNativeTools,
  resolveServerPath,
  resolveSandboxMode,
  SessionLog,
  BUNDLES,
  MODEL_CATALOG,
  SessionIndex,
  sessionLogPath,
  spillFile,
  switchableSandboxModes,
  userConfigDir,
  workspaceRootsFor,
  configuredExtraRoots,
  workspaceRootsKey,
  type AgentEvent,
  type ApprovalRequest,
  type CliOverrides,
  type HarnessConfig,
  type ImageInput,
  type LoadedPlugins,
  type PluginTool,
  type ProviderKind,
  type RoleConfig,
  type SandboxMode,
  type Schema,
  type SessionEvent,
  type ToolSpec,
} from '../../core/dist/index.js'
import {
  Conversation,
  closeServices,
  listRuns,
  newRunId,
  openClient,
  reloadPlugins,
  sessionMcp,
  sessionPlugins,
  startServices,
  summarizeThinking,
} from './session-app.js'
import { applyAgentEvent, projectChat, stripPlanPrefix, type ChatEntry } from './chat-projection.js'
import { API_VERSION } from './api-schema.js'
import { matchContract, validateRequest } from './api-contract.js'
import { DocumentError, previewDocument } from './documents.js'
import { approvalKey, describeApproval, rememberAlways, type ApprovalScope } from './approval-view.js'
import { normalizePrefs, type UiPrefs } from './ui-prefs.js'
import { applyImport, importPlanView, planImport, type ImportKind } from './import.js'
import { buildDoctorReport, doctorSandbox, findSecretBinary } from './doctor.js'
import { applyOnboardingDefaults, OnboardingError, onboardingView, readOnboarding, writeOnboarding } from './onboarding.js'
import {
  UpdateFeedError,
  downloadRelease,
  loadFeed,
  pickRelease,
  readPublicKey,
  updateDownloadDir,
  updateKeyPath,
} from './update-feed.js'
import type { SubagentView } from './agents.js'
import { normalizeSessionTitle } from './session-title.js'
import { generateSessionTitle } from './session-title-gen.js'
import { ForkError, planFork } from './session-fork.js'
import { digestFor, expandSessionReferences } from './session-reference.js'
import { FeedbackError, FeedbackStore, feedbackFile, validateFeedback } from './feedback.js'
import { OpenInError, detectOpenIn, isLocalAddress, openInArgv } from './open-in.js'
import { createTelemetrySink, resolveTelemetryConfig, type TelemetrySink } from './telemetry.js'
import {
  applyAgentEvent as applyStatsEvent,
  emptyClock,
  emptyStats,
  finishTurn,
  statsFromEvents,
  statsView,
  type SessionStats,
  type StatsClock,
} from './session-stats.js'
import { usageOf, type UsageView } from './usage.js'
import { instantThinkingSummary } from './summary-text.js'
import { cronMatches, nextCronTime, parseCron } from './cron.js'
import { PersistentPty } from './pty.js'
import {
  DEFAULT_MAX_WORKERS,
  canSpawnWorker,
  loadOrchestrationState,
  markStaleWorkersInterrupted,
  normalizeScopes,
  parseWorkerReport,
  saveOrchestrationState,
  scopeOwners,
  scopesOverlap,
  workerAwaitingReview,
  workerHoldsScope,
  workerNeedsAttention,
  workerOwnsScope,
  workerStatusLabel,
  type OrchestrationRecord,
  type OrchestrationState,
  type SessionKind,
  type WorkerRecord,
  type WorkerStatus,
} from './orchestration.js'
import {
  beginTurn,
  clearQueuedTurns,
  commitTurn,
  enqueueTurn,
  loadTurnQueue,
  peekNextTurn,
  releaseTurn,
  resolveUncertain,
  resumeSession,
  saveTurnQueue,
  turnQueuePath,
  type QueuedTurn,
  type TurnQueueState,
} from './turn-queue.js'
import {
  parseCancelRequest,
  parseEnqueueRequest,
  parseResolveRequest,
  parseRunIdRequest,
  turnQueueView,
} from './turn-queue-view.js'

export interface WebServerOptions {
  overrides: CliOverrides
  execServer?: string | undefined
  host?: string | undefined
  port?: number | undefined
  open?: boolean | undefined
  desktop?: boolean | undefined
  token?: string | undefined
  log?: ((line: string) => void) | undefined
  /** PEM certificate chain; requires `tlsKey` (WP-10). */
  tlsCert?: string | undefined
  /** PEM private key; requires `tlsCert`. */
  tlsKey?: string | undefined
  /** Extra authorities (host or host:port) the Host/Origin fence accepts. */
  trustedHosts?: string[] | undefined
  /** Advertised browser root behind a prefix-stripping proxy, e.g. https://app.example/ui/ */
  publicUrl?: string | undefined
}

export interface WebServerHandle {
  /** Advertised launch URL (includes the token; `publicUrl` when configured). */
  url: string
  /** The listener's own origin, without a token: where the server really bound. */
  localUrl: string
  port: number
  token: string
  config: HarnessConfig
  close(): Promise<void>
}

interface Pending<T> {
  resolve: (value: T) => void
  timer: NodeJS.Timeout
  /** For approvals: what is being approved (decides who may approve it). */
  request?: ApprovalRequest
}

/** A parsed `Host`/authority: lowercase host plus an optional port. */
interface Authority {
  host: string
  port?: string
}

/**
 * Parses `host`, `host:port`, `[::1]` or `[::1]:3080`. Returns undefined for
 * input that is not an authority (a URL with a scheme, or an empty string).
 */
export function parseAuthority(raw: string): Authority | undefined {
  const value = raw.trim().toLowerCase()
  if (!value || value.includes('/') || value.includes('@') || value.includes('?')) return undefined
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end < 0) return undefined
    const host = value.slice(1, end)
    const rest = value.slice(end + 1)
    if (!host) return undefined
    if (rest === '') return { host }
    return rest.startsWith(':') && rest.length > 1 ? { host, port: rest.slice(1) } : undefined
  }
  const firstColon = value.indexOf(':')
  if (firstColon > 0 && firstColon === value.lastIndexOf(':')) {
    return { host: value.slice(0, firstColon), port: value.slice(firstColon + 1) }
  }
  // An IPv6 literal without brackets is not a valid HTTP authority.
  if (firstColon >= 0) return undefined
  return { host: value }
}

/**
 * The Host/Origin fence for the Web GUI (WP-10, DSH `connection` parity).
 *
 * Accepts loopback, the listener's own bind address and every `--trusted-host`
 * entry. An entry without a port matches any port; an entry with one is exact.
 * `Origin` is checked when present so a cross-site page cannot call the API
 * even with a leaked cookie (the cookie is SameSite=Strict, this is defence in
 * depth). A request without `Origin` is a non-browser client and is not
 * origin-checked, matching the token requirement.
 */
export function createHostFence(bindHost: string, trustedHosts: readonly string[] = []) {
  const entries: Authority[] = []
  const add = (raw: string): void => {
    const authority = parseAuthority(raw)
    if (authority) entries.push(authority)
  }
  for (const loopback of ['127.0.0.1', 'localhost', '::1']) add(loopback)
  if (bindHost !== '0.0.0.0' && bindHost !== '::') add(bindHost)
  for (const trusted of trustedHosts) add(trusted)
  const allows = (raw: string | undefined): boolean => {
    if (raw === undefined || raw === '') return false
    const authority = parseAuthority(raw)
    if (!authority) return false
    return entries.some(
      (entry) => entry.host === authority.host && (entry.port === undefined || entry.port === authority.port),
    )
  }
  const allowsOrigin = (origin: string | undefined): boolean => {
    if (origin === undefined) return true
    if (origin === 'null') return false
    try {
      const parsed = new URL(origin)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      return allows(parsed.host)
    } catch {
      return false
    }
  }
  return { allows, allowsOrigin }
}

/** Normalizes `--public-url` to a trailing-slash HTTP(S) root, or throws. */
export function normalizePublicUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`--public-url is not a valid URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('--public-url must start with http:// or https://')
  }
  if (parsed.search || parsed.hash) throw new Error('--public-url must not contain a query or fragment')
  const pathname = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`
  return `${parsed.origin}${pathname}`
}

/**
 * Sandbox modes only the user may approve (the same rule as Guardian's): the
 * orchestrator is a model and must not approve commands that would run
 * unconfined or low-integrity, MCP calls or web fetches.
 */
export function userOnlyApproval(request: ApprovalRequest | undefined): boolean {
  return request?.sandbox === 'unconfined' || request?.sandbox === 'low-integrity'
}

interface JobRecord {
  jobId: string
  command: string
  status: string
  started: number
  updated: number
}

interface RalphJob {
  id: string
  objective: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  output: string[]
  runId?: string | undefined
  started: number
  ended?: number | undefined
  child?: ReturnType<typeof spawn> | undefined
}

interface UiState {
  pinned: string[]
  archived: string[]
  /** User-assigned chat names; absent means "use the automatic title". */
  titles: Record<string, string>
  /** WP-60: model-proposed names; a manual `titles` entry always wins. */
  generatedTitles: Record<string, { title: string; at: number; source: string }>
  /** Runs whose transcript was deleted; late events must not bring them back. */
  deleted: string[]
  /** CP-36: statusline, code theme, Vim mode and shortcuts. */
  prefs?: UiPrefs
}

interface AutomationSchedule {
  id: string
  name: string
  cron: string
  cwd: string
  objective: string
  verifyCmds: string[]
  autoApprove: boolean
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  lastStatus?: 'running' | 'succeeded' | 'failed'
  lastRunId?: string
}

interface AutomationWebhook {
  id: string
  name: string
  secret: string
  cwd: string
  objective: string
  verifyCmds: string[]
  autoApprove: boolean
  enabled: boolean
  createdAt: number
  lastTriggeredAt?: number
  lastStatus?: 'running' | 'succeeded' | 'failed'
  lastRunId?: string
}

interface AutomationRun {
  id: string
  kind: 'schedule' | 'webhook' | 'manual'
  targetId: string
  name: string
  status: 'running' | 'succeeded' | 'failed'
  output: string[]
  started: number
  ended?: number
  runId?: string
  error?: string
}

interface AutomationStore {
  schedules: AutomationSchedule[]
  webhooks: AutomationWebhook[]
  runs: AutomationRun[]
}

function readAutomationStore(file: string): AutomationStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AutomationStore>
    return {
      schedules: Array.isArray(parsed.schedules) ? (parsed.schedules as AutomationSchedule[]) : [],
      webhooks: Array.isArray(parsed.webhooks) ? (parsed.webhooks as AutomationWebhook[]) : [],
      runs: Array.isArray(parsed.runs) ? (parsed.runs as AutomationRun[]).slice(-100) : [],
    }
  } catch {
    return { schedules: [], webhooks: [], runs: [] }
  }
}

interface WebSession {
  runId: string
  kind: SessionKind
  parentRunId?: string | undefined
  orchestrationId?: string | undefined
  workerStatus?: WorkerStatus | undefined
  workerTitle?: string | undefined
  /** User-assigned name for this chat, when one was set. */
  title?: string | undefined
  conv?: Conversation
  busy: boolean
  controller?: AbortController | undefined
  entries: ChatEntry[]
  subscribers: Set<http.ServerResponse>
  pendingApprovals: Map<string, Pending<boolean | { approved: boolean; reason?: string }>>
  pendingQuestions: Map<string, Pending<string>>
  planMode: boolean
  /** WP-12: the session's live sandbox mode (persisted in the session log). */
  sandboxMode: SandboxMode
  goal?: string | undefined
  turns: number
  /** Active provider/model for this session (orchestrator/worker/subagent roles). */
  model: { provider: string; model: string }
  usage: UsageView
  /** WP-60: measured timings, restored from the log and persisted per turn. */
  stats: SessionStats
  statsClock: StatsClock
  jobs: Map<string, JobRecord>
  effort?: string | undefined
  pty?: PersistentPty | undefined
  ptySubscribers?: Set<http.ServerResponse> | undefined
  pinned: boolean
  archived: boolean
  lastError?: string | undefined
  createdAt: number
  updatedAt: number
}

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

const TREE_SKIP = new Set(['.git', 'node_modules', '.hy-harness', 'target', 'dist', '.next', 'coverage'])
const MAX_FILE_BYTES = 512 * 1024
const MAX_BODY_BYTES = 32 * 1024 * 1024
const EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function logLine(options: WebServerOptions, line: string): void {
  ;(options.log ?? ((l) => console.error(l)))(`[hy web] ${line}`)
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

function text(res: http.ServerResponse, status: number, value: string, type = 'text/plain; charset=utf-8'): void {
  res.statusCode = status
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'no-store')
  res.end(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Never send a directly stored API key back to the browser. */
function redactUserConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
  const roles = copy.roles
  if (roles && typeof roles === 'object' && !Array.isArray(roles)) {
    for (const role of Object.values(roles as Record<string, unknown>)) {
      if (!role || typeof role !== 'object' || Array.isArray(role)) continue
      const r = role as Record<string, unknown>
      if (typeof r.apiKey === 'string' && r.apiKey.length > 0) {
        delete r.apiKey
        r.apiKeySet = true
      }
    }
  }
  return copy
}

interface ModelLimits {
  contextWindowTokens: number
  maxOutputTokens: number
}

/** The user's settings file, or an empty object when it does not exist yet. */
function readUserConfigFile(): { path: string; user: Record<string, unknown> } {
  const settingsPath = path.join(userConfigDir(), 'config.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { path: settingsPath, user: parsed as Record<string, unknown> }
    }
  } catch {
    // Missing or malformed: the caller treats it as an empty settings file.
  }
  return { path: settingsPath, user: {} }
}

/**
 * Looks up the limits recorded for a model in Settings → Models. Switching a
 * session with `/model` must carry these limits too; otherwise the new model
 * keeps the previous model's context/output budget (which once let a 128K
 * GPT-6.1 Terra profile run at 1M context and hit the expensive tier).
 */
function modelProfileLimits(
  user: Record<string, unknown>,
  provider: string,
  model: string,
): ModelLimits | undefined {
  const models = Array.isArray(user.models) ? user.models : []
  for (const entry of models) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const m = entry as Record<string, unknown>
    if (m.provider !== provider || m.model !== model) continue
    const contextWindowTokens = Number(m.contextWindowTokens)
    const maxOutputTokens = Number(m.maxOutputTokens)
    if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) continue
    if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) continue
    return { contextWindowTokens, maxOutputTokens }
  }
  return undefined
}

/** The provider currently configured for a role (used when a patch omits it). */
function roleProvider(config: HarnessConfig, role: string): string {
  switch (role) {
    case 'orchestrator':
      return config.orchestratorRole.provider
    case 'subagent':
      return config.subagentRole.provider
    case 'guardian':
      return config.guardianRole?.provider ?? config.role.provider
    case 'grader':
      return config.graderRole.provider
    case 'compactor':
      return config.compactorRole.provider
    case 'summarizer':
      return config.summarizerRole.provider
    default:
      return config.role.provider
  }
}

/**
 * The `hy run` / `hy ralph` arguments of an unattended automation run.
 *
 * * Trust is decided for the target directory, not for the server's
 *   workspace: `--trust` is passed only when the target is the server's own
 *   workspace and that one is trusted; otherwise the child decides from the
 *   user's `trustedProjects`. `--unattended-ok` is never passed, so a verifier
 *   loop on an untrusted repository is refused (OQ-3), as on the command line.
 * * A webhook run never gets `--yes`: its objective carries external payload
 *   text, and auto-approval would turn a prompt injection into unapproved
 *   commands. `prompt` decisions then go to Guardian when configured (it never
 *   approves unconfined commands) and are otherwise denied.
 */
export function automationArgs(
  kind: 'schedule' | 'webhook' | 'manual',
  target: { cwd: string; verifyCmds: string[]; autoApprove: boolean },
  objective: string,
  config: HarnessConfig,
): string[] {
  const ralph = target.verifyCmds.length > 0
  const args = [ralph ? 'ralph' : 'run', objective, '--cwd', target.cwd]
  for (const cmd of target.verifyCmds) args.push('--verify-cmd', cmd)
  if (config.role.provider === 'mock') args.push('--mock')
  else {
    args.push('--provider', config.role.provider, '--model', config.role.model)
    if (config.role.baseUrl) args.push('--base-url', config.role.baseUrl)
    if (config.role.apiKeyEnv) args.push('--api-key-env', config.role.apiKeyEnv)
  }
  args.push('--sandbox', config.sandbox)
  if (kind !== 'webhook' && (target.autoApprove || config.autoApprove)) args.push('--yes')
  if (config.guardianRole) args.push('--guardian')
  if (config.projectTrusted && canonicalWorkspace(target.cwd) === config.workspaceRoot) args.push('--trust')
  if (config.web) args.push('--web')
  if (config.ptc) args.push('--ptc')
  if (config.memory) args.push('--memory')
  args.push('--max-cost-usd', config.budget.maxCostUsd === undefined ? 'off' : String(config.budget.maxCostUsd))
  return args
}

/**
 * Constant-time comparison of a presented secret with the expected one, so the
 * response time does not reveal how much of the token matched (the server can
 * be reachable from a tailnet with `hy web --tailscale`).
 */
export function sameSecret(presented: string | null | undefined, expected: string): boolean {
  if (typeof presented !== 'string') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

function sseWrite(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function sseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
}

/**
 * A client error that must be reported as 4xx, not as a server fault. Thrown by
 * `readJson`, whose callers all sit in the single request-level catch; without
 * this marker a body of `[]` or broken JSON became a 500.
 */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += b.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body is too large')
    chunks.push(b)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new HttpError(400, 'body must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * WP-60: folder drill-down for `@` references. A query ending in `/` lists the
 * children of that directory (directories again with a trailing slash) instead
 * of searching the whole tree.
 */
function listDirectoryChildren(root: string, rel: string): string[] {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  const base = path.resolve(root)
  const dir = path.resolve(base, cleaned)
  if (dir !== base && !dir.startsWith(base + path.sep)) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (TREE_SKIP.has(entry.name) || entry.isSymbolicLink()) continue
    const child = cleaned ? `${cleaned}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(`${child}/`)
    else if (entry.isFile()) out.push(child)
    if (out.length >= 50) break
  }
  return out
}

function searchWorkspaceFiles(root: string, query: string, limit = 50): string[] {
  const needle = query.toLowerCase()
  const out: string[] = []
  let visited = 0
  const walk = (dir: string, rel: string): void => {
    if (out.length >= limit || visited > 10_000) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (out.length >= limit || visited > 10_000) return
      if (entry.isSymbolicLink()) continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!TREE_SKIP.has(entry.name)) walk(path.join(dir, entry.name), childRel)
      } else if (entry.isFile()) {
        visited += 1
        if (childRel.toLowerCase().includes(needle)) out.push(childRel)
      }
    }
  }
  walk(root, '')
  return out
}

function pluginFilesIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(mjs|js)$/i.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

function pluginCatalog(config: HarnessConfig) {
  return {
    configured: config.plugins,
    tools: [...(sessionPlugins?.tools.values() ?? [])].map((t) => ({
      name: t.name,
      description: t.spec.description,
      readOnly: t.spec.readOnly,
      plugin: t.plugin,
    })),
    errors: sessionPlugins?.errors ?? [],
    directories: [
      { path: path.join(userConfigDir(), 'plugins'), files: pluginFilesIn(path.join(userConfigDir(), 'plugins')) },
      { path: path.join(config.workspaceRoot, '.hy-harness', 'plugins'), files: pluginFilesIn(path.join(config.workspaceRoot, '.hy-harness', 'plugins')) },
    ],
  }
}

function safeWorkspacePath(root: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (cleaned.split('/').some((p) => p === '..')) throw new Error(`path escapes the workspace: ${rel}`)
  const full = path.resolve(root, cleaned)
  const rootResolved = path.resolve(root)
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new Error(`path escapes the workspace: ${rel}`)
  }
  if (fs.existsSync(full)) {
    const real = fs.realpathSync.native(full)
    const realRoot = fs.realpathSync.native(rootResolved)
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error(`path escapes the workspace: ${rel}`)
    }
    return real
  }
  return full
}

function roleSummary(role: RoleConfig) {
  return {
    provider: role.provider,
    model: role.model,
    ...(role.baseUrl !== undefined ? { baseUrl: role.baseUrl } : {}),
    ...(role.apiKeyEnv !== undefined ? { apiKeyEnv: role.apiKeyEnv } : {}),
    ...(role.effort !== undefined ? { effort: role.effort } : {}),
    contextWindowTokens: role.contextWindowTokens,
    maxOutputTokens: role.maxOutputTokens,
    ...(role.temperature !== undefined ? { temperature: role.temperature } : {}),
    ...(role.pricing !== undefined ? { pricing: role.pricing } : {}),
    nativeTools: role.nativeTools,
    // CP-35: what the model picker shows for the role in use.
    toolMode: usesNativeTools(role) ? 'native' : 'text',
    vision: roleSupportsImages(role),
  }
}

/** `workspaceRootsByWorkspace` from a raw user config, as a fresh mutable object. */
function rootsByWorkspace(user: Record<string, unknown>): Record<string, Array<{ id?: string; path: string; label?: string; writable?: boolean }>> {
  const value = user.workspaceRootsByWorkspace
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, Array<{ id?: string; path: string; label?: string; writable?: boolean }>> = {}
  for (const [key, list] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(list)) out[key] = list.filter((entry) => entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string')
  }
  return out
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

function configSummary(config: HarnessConfig) {
  return {
    workspace: config.workspaceRoot,
    roots: config.workspaceRoots.map((root) => ({
      id: root.id,
      path: root.path,
      label: root.label ?? path.basename(root.path),
      writable: root.writable === true,
      ...(root.scope ? { scope: root.scope } : {}),
    })),
    stateDir: config.stateDir,
    sandbox: config.sandbox,
    // WP-42: which bundles this server's sessions use; the GUI can offer presets.
    bundles: { names: config.bundles.names, panels: config.bundles.panels, commands: config.bundles.commands },
    bundleCatalog: Object.values(BUNDLES).map((bundle) => ({ name: bundle.name, description: bundle.description })),
    worker: roleSummary(config.role),
    orchestrator: roleSummary(config.orchestratorRole),
    subagent: roleSummary(config.subagentRole),
    guardian: config.guardianRole ? roleSummary(config.guardianRole) : null,
    grader: roleSummary(config.graderRole),
    compactor: roleSummary(config.compactorRole),
    summarizer: roleSummary(config.summarizerRole),
    guardianApproveBelow: config.guardianApproveBelow,
    ptc: config.ptc,
    autoApprove: config.autoApprove,
    fullAuto: config.fullAuto,
    trusted: config.projectTrusted,
    limits: config.limits,
    budget: config.budget,
    features: {
      web: config.web !== undefined,
      search: config.web?.searchUrl !== undefined,
      memory: config.memory,
      mcp: Object.keys(config.mcpServers),
      plugins: config.plugins.length,
      lsp: Object.keys(config.lsp),
      guardian: config.guardianRole !== undefined,
    },
    settingsPath: path.join(userConfigDir(), 'config.json'),
  }
}

function sessionSummary(
  config: HarnessConfig,
  events: readonly SessionEvent[],
  sessions: Map<string, WebSession>,
  uiState: UiState,
  orchestration?: OrchestrationState,
  deleted: ReadonlySet<string> = new Set(),
) {
  const active = orchestration?.active
  return listRuns(events)
    .filter((run) => !deleted.has(run.runId))
    .map((r) => {
      const live = sessions.get(r.runId)
      const worker = active?.workers.find((w) => w.runId === r.runId)
      const kind: SessionKind = live?.kind ?? (active?.orchestratorRunId === r.runId ? 'orchestrator' : worker ? 'worker' : 'chat')
      return {
        ...r,
        busy: live?.busy === true,
        planMode: live?.planMode === true,
        sandboxMode: live?.sandboxMode ?? resolveSandboxMode(events, r.runId, config.sandbox),
        kind,
        ...(live?.parentRunId ?? worker ? { parentRunId: live?.parentRunId ?? active?.orchestratorRunId } : {}),
        ...(active?.id !== undefined && kind !== 'chat' ? { orchestrationId: active.id } : {}),
        ...(worker ? { workerStatus: worker.status } : {}),
        ...(worker ? { workerTitle: worker.title } : {}),
        pinned: uiState.pinned.includes(r.runId),
        archived: uiState.archived.includes(r.runId),
        // Absent when the user never named the chat: the client then falls
        // back to the automatic title derived from the first message.
        ...(uiState.titles[r.runId] ? { title: uiState.titles[r.runId] } : {}),
        // WP-60: a generated name, used when there is no manual one.
        ...(uiState.generatedTitles[r.runId] ? { generatedTitle: uiState.generatedTitles[r.runId]!.title } : {}),
        lastError: live?.lastError ?? worker?.blocker ?? worker?.lastError,
      }
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last - a.last)
}

function startOfRun(events: readonly SessionEvent[], runId: string): number {
  const first = events.find((e) => e.runId === runId)
  return first?.ts ?? Date.now()
}

function planModeOf(events: readonly SessionEvent[], runId: string): boolean {
  let on = false
  for (const e of events) {
    if (e.runId !== runId || e.type !== 'plan-mode') continue
    on = (e.payload as { on?: unknown }).on === true
  }
  return on
}

function runExists(events: readonly SessionEvent[], runId: string): boolean {
  return events.some((e) => e.runId === runId && !e.runId.includes('.sub'))
}

function goalOf(events: readonly SessionEvent[], runId: string): string | undefined {
  let goal: string | undefined
  for (const e of events) {
    if (e.runId !== runId) continue
    if (e.type === 'goal/set') {
      const value = (e.payload as { goal?: unknown }).goal
      goal = typeof value === 'string' && value.trim() ? value : undefined
    } else if (e.type === 'goal/change') {
      const value = (e.payload as { goal?: unknown }).goal
      const objective = value && typeof value === 'object' && !Array.isArray(value) ? (value as { objective?: unknown }).objective : undefined
      goal = typeof objective === 'string' && objective.trim() ? objective : undefined
    }
  }
  return goal
}

function jobsOf(entries: readonly ChatEntry[]): Map<string, JobRecord> {
  const jobs = new Map<string, JobRecord>()
  for (const entry of entries) {
    if (entry.kind !== 'tool' || !entry.result || typeof entry.result !== 'object') continue
    const result = entry.result as Record<string, unknown>
    if (typeof result.jobId !== 'string') continue
    const args = (entry.args ?? {}) as Record<string, unknown>
    jobs.set(result.jobId, {
      jobId: result.jobId,
      command: typeof args.command === 'string' ? args.command : entry.name,
      status: typeof result.status === 'string' ? result.status : 'unknown',
      started: entry.ts,
      updated: entry.ts,
    })
  }
  return jobs
}

function parseImages(raw: unknown): ImageInput[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is { mimeType?: unknown; data?: unknown } => !!item && typeof item === 'object')
    .filter((item) => typeof item.mimeType === 'string' && item.mimeType.startsWith('image/') && typeof item.data === 'string' && item.data.length > 0)
    .slice(0, 8)
    .map((item) => ({ mimeType: String(item.mimeType), data: String(item.data) }))
}

function sessionState(session: WebSession) {
  return {
    runId: session.runId,
    kind: session.kind,
    ...(session.parentRunId !== undefined ? { parentRunId: session.parentRunId } : {}),
    ...(session.orchestrationId !== undefined ? { orchestrationId: session.orchestrationId } : {}),
    ...(session.workerStatus !== undefined ? { workerStatus: session.workerStatus } : {}),
    ...(session.workerTitle !== undefined ? { workerTitle: session.workerTitle } : {}),
    busy: session.busy,
    turns: session.conv?.turns ?? session.turns,
    planMode: session.conv?.isPlanMode() ?? session.planMode,
    sandboxMode: session.conv?.sandboxMode() ?? session.sandboxMode,
    goal: session.conv?.currentGoal() ?? session.goal ?? null,
    goalState: session.conv?.goalView() ?? null,
    usage: session.conv?.usageSnapshot() ?? session.usage,
    stats: statsView(session.stats),
    effort: session.conv?.currentEffort() ?? session.effort ?? '',
    model: session.model,
    ...(session.lastError !== undefined ? { lastError: session.lastError } : {}),
  }
}

function broadcast(session: WebSession, event: unknown): void {
  const payload = `event: session\ndata: ${JSON.stringify(event)}\n\n`
  for (const res of [...session.subscribers]) {
    try {
      res.write(payload)
    } catch {
      session.subscribers.delete(res)
    }
  }
}

function refreshTranscript(session: WebSession, stateDir: string): void {
  session.entries = projectChat(readEvents(sessionLogPath(stateDir)), session.runId)
}

function markdownExport(session: WebSession): string {
  const lines: string[] = [`# HY-HARNESS run ${session.runId}`, '']
  for (const entry of session.entries) {
    if (entry.kind === 'user') lines.push('## You', '', entry.text, '')
    else if (entry.kind === 'assistant') lines.push('## HY-HARNESS', '', entry.text, '')
    else if (entry.kind === 'notice') lines.push(`> ${entry.text}`, '')
    else if (entry.kind === 'tool') {
      lines.push(`<details><summary>${entry.name}${entry.status === 'error' ? ' (error)' : ''}</summary>`, '', '```', entry.output ?? '', '```', '', '</details>', '')
    } else if (entry.kind === 'plan') {
      lines.push('### Plan', '', ...entry.plan.map((p) => `- [${p.status === 'completed' ? 'x' : ' '}] ${p.step}`), '')
    }
  }
  return lines.join('\n')
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  // Validate the TLS pair and the advertised URL *before* opening the exec
  // daemon: a bad flag must fail fast without leaving a child process behind.
  const host = options.host ?? '127.0.0.1'
  /** The server's log sink (the nested `options` names shadow the outer one). */
  const serverLog = (message: string): void => {
    try {
      options.log?.(message)
    } catch {
      // A broken log sink must not break a turn.
    }
  }
  // WP-10: TLS material and the Host/Origin fence. Both TLS files are required
  // together; an unreadable or invalid pair stops startup instead of silently
  // serving plain HTTP (the same fail-closed rule as DSH).
  if ((options.tlsCert === undefined) !== (options.tlsKey === undefined)) {
    throw new Error('hy web: --tls-cert and --tls-key must be given together')
  }
  const secure = options.tlsCert !== undefined
  const tlsOptions: https.ServerOptions = {}
  if (options.tlsCert !== undefined && options.tlsKey !== undefined) {
    try {
      tlsOptions.cert = fs.readFileSync(options.tlsCert)
      tlsOptions.key = fs.readFileSync(options.tlsKey)
    } catch (error) {
      throw new Error(`hy web: cannot read TLS material: ${errorMessage(error)}`)
    }
    if (tlsOptions.cert.length === 0 || tlsOptions.key.length === 0) {
      throw new Error('hy web: the TLS certificate or key file is empty')
    }
    tlsOptions.minVersion = 'TLSv1.2'
  }
  const publicUrl = options.publicUrl === undefined ? undefined : normalizePublicUrl(options.publicUrl)
  const fence = createHostFence(host, options.trustedHosts ?? [])
  const scheme = secure ? 'https' : 'http'
  const { config, client } = await openClient(options.overrides, options.execServer)
  // WP-62: opt-in tracing. `HY_OTEL_ENDPOINT` is the quick switch; the user
  // config's `telemetry` block is the durable one. Default is off.
  let telemetry: TelemetrySink = createTelemetrySink(resolveTelemetryConfig(undefined))
  try {
    const { user } = readUserConfigFile()
    telemetry = createTelemetrySink(
      resolveTelemetryConfig(process.env.HY_OTEL_ENDPOINT ? { enabled: true, endpoint: process.env.HY_OTEL_ENDPOINT } : user.telemetry),
    )
  } catch (error) {
    serverLog(`telemetry disabled: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (telemetry.enabled) serverLog('telemetry: OTLP spans enabled (identifiers and timings only)')
  // WP-53: a completed first-run wizard supplies the sandbox and worker model,
  // unless the command line already named them (explicit flags always win).
  const onboarding = applyOnboardingDefaults(config, options.overrides)
  /** Where `/api/update` looks for the feed and key (explicit query wins). */
  const updateTarget = (feedParam?: string | null, channelParam?: string | null) => ({
    feed: feedParam || config.update?.feed,
    channel: channelParam || config.update?.channel || 'stable',
    keySource:
      config.update?.publicKey ??
      process.env.HY_UPDATE_PUBLIC_KEY ??
      (fs.existsSync(updateKeyPath(config.stateDir)) ? updateKeyPath(config.stateDir) : undefined),
  })
  await startServices(config)
  if (onboarding.applied.length > 0) options.log?.(`onboarding: applied ${onboarding.applied.join(', ')}`)
  const logFile = sessionLogPath(config.stateDir)
  const token = options.token ?? randomBytes(24).toString('hex')
  const sessions = new Map<string, WebSession>()
  const deletedRuns = new Set<string>()
  const ralphJobs = new Map<string, RalphJob>()
  const globalSubscribers = new Set<http.ServerResponse>()
  // The durable turn queue is loaded once and owned by this closure: every
  // mutation goes through saveTurnQueue first, so memory never gets ahead of
  // the file (a failed save keeps the user's message queued on disk).
  const turnQueueFile = turnQueuePath(config.stateDir)
  let turnQueue: TurnQueueState = loadTurnQueue(turnQueueFile)
  const uiStatePath = path.join(config.stateDir, 'ui-state.json')
  let uiState: UiState = { pinned: [], archived: [], deleted: [], titles: {}, generatedTitles: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(uiStatePath, 'utf8')) as Partial<UiState>
    uiState = {
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned.filter((x): x is string => typeof x === 'string') : [],
      archived: Array.isArray(parsed.archived) ? parsed.archived.filter((x): x is string => typeof x === 'string') : [],
      deleted: Array.isArray(parsed.deleted) ? parsed.deleted.filter((x): x is string => typeof x === 'string') : [],
      titles:
        parsed.titles && typeof parsed.titles === 'object' && !Array.isArray(parsed.titles)
          ? Object.fromEntries(
              Object.entries(parsed.titles as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0,
              ),
            )
          : {},
      generatedTitles:
        parsed.generatedTitles && typeof parsed.generatedTitles === 'object' && !Array.isArray(parsed.generatedTitles)
          ? Object.fromEntries(
              Object.entries(parsed.generatedTitles as Record<string, unknown>).flatMap(([runId, value]) => {
                if (!value || typeof value !== 'object' || Array.isArray(value)) return []
                const record = value as Record<string, unknown>
                if (typeof record.title !== 'string' || !record.title.trim()) return []
                return [
                  [
                    runId,
                    {
                      title: record.title.trim(),
                      at: typeof record.at === 'number' ? record.at : 0,
                      source: typeof record.source === 'string' ? record.source : 'heuristic',
                    },
                  ] as [string, { title: string; at: number; source: string }],
                ]
              }),
            )
          : {},
      prefs: normalizePrefs(parsed.prefs),
    }
  } catch {
    // First launch or an unreadable file: start with no pins/archives.
  }
  for (const id of uiState.deleted.slice(-200)) deletedRuns.add(id)
  const saveUiState = (): void => {
    fs.mkdirSync(path.dirname(uiStatePath), { recursive: true })
    const tmp = `${uiStatePath}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(uiState, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, uiStatePath)
  }
  /**
   * Persists a new queue state and only then makes it current. A failed save
   * (the size cap, a read-only state directory) leaves the in-memory queue as
   * it was, so the caller can answer with an error instead of dropping a turn.
   */
  const applyTurnQueue = (next: TurnQueueState): void => {
    saveTurnQueue(turnQueueFile, next)
    turnQueue = next
  }
  const orchestrationPath = path.join(config.stateDir, 'orchestration.json')
  let orchestration = loadOrchestrationState(orchestrationPath)
  let orchestratorInbox: string[] = []
  let orchestratorStarting = false
  let orchestratorTimer: NodeJS.Timeout | undefined
  /** Pending automatic goal rounds, one timer per session. */
  const goalTimers = new Map<string, NodeJS.Timeout>()
  /** Last worker-state signature already shown as a host notice for an orchestrator run. */
  const lastWorkerNotice = new Map<string, string>()
  const shellQueue = (() => {
    let tail: Promise<void> = Promise.resolve()
    return {
      acquire(): Promise<() => void> {
        let release!: () => void
        const next = new Promise<void>((resolve) => {
          release = resolve
        })
        const wait = tail
        tail = next
        return wait.then(() => release)
      },
    }
  })()
  const automationPath = path.join(userConfigDir(), 'automation.json')
  let automation = readAutomationStore(automationPath)
  const automationRuns = new Map<string, AutomationRun>()
  const automationChildren = new Map<string, ReturnType<typeof spawn>>()
  const activeAutomationTargets = new Set<string>()
  const saveAutomation = (): void => {
    fs.mkdirSync(path.dirname(automationPath), { recursive: true })
    automation.runs = automation.runs.slice(-100)
    const tmp = `${automationPath}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(automation, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, automationPath)
  }
  const cliMain = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js')

  const startAutomationRun = (
    kind: AutomationRun['kind'],
    target: AutomationSchedule | AutomationWebhook,
    trigger?: unknown,
  ): AutomationRun => {
    if (activeAutomationTargets.has(target.id)) throw new Error('this automation target is already running')
    const ralph = target.verifyCmds.length > 0
    const objective =
      trigger && typeof trigger === 'object' && typeof (trigger as { objective?: unknown }).objective === 'string'
        ? String((trigger as { objective: string }).objective)
        : target.objective
    const args = [cliMain, ...automationArgs(kind, target, objective, config)]

    const id = `auto-${randomBytes(5).toString('hex')}`
    const run: AutomationRun = {
      id,
      kind,
      targetId: target.id,
      name: target.name,
      status: 'running',
      output: [],
      started: Date.now(),
    }
    automationRuns.set(id, run)
    activeAutomationTargets.add(target.id)
    target.lastStatus = 'running'
    target.lastRunId = id
    if (kind === 'webhook') (target as AutomationWebhook).lastTriggeredAt = Date.now()
    else (target as AutomationSchedule).lastRunAt = Date.now()
    saveAutomation()

    const child = spawn(process.execPath, args, {
      cwd: target.cwd,
      env: process.env,
      windowsHide: true,
    })
    automationChildren.set(id, child)
    const append = (line: string): void => {
      if (!line.trim()) return
      run.output.push(line)
      if (run.output.length > 2000) run.output.splice(0, run.output.length - 2000)
      const match = /\[hy\] (?:run|ralph) (run-[a-z0-9]+)/.exec(line)
      if (match?.[1]) run.runId = match[1]
    }
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = ''
      stream?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) append(line)
      })
      stream?.on('end', () => {
        if (buffer) append(buffer)
        buffer = ''
      })
    }
    child.on('error', (error) => {
      append(`[automation] ${errorMessage(error)}`)
      run.status = 'failed'
      run.error = errorMessage(error)
      run.ended = Date.now()
      target.lastStatus = 'failed'
      activeAutomationTargets.delete(target.id)
      automationChildren.delete(id)
      saveAutomation()
    })
    child.on('close', (code) => {
      if (run.status === 'running') {
        run.status = code === 0 ? 'succeeded' : 'failed'
        run.ended = Date.now()
        target.lastStatus = run.status
      }
      activeAutomationTargets.delete(target.id)
      automationChildren.delete(id)
      automation.runs.push({ ...run, output: run.output.slice(-200) })
      saveAutomation()
    })
    return run
  }

  const tickAutomation = (): void => {
    if (closing) return
    const now = new Date()
    for (const schedule of automation.schedules) {
      if (!schedule.enabled || activeAutomationTargets.has(schedule.id)) continue
      if (!cronMatches(schedule.cron, now)) continue
      if (schedule.lastRunAt !== undefined && new Date(schedule.lastRunAt).toDateString() === now.toDateString()) {
        const last = new Date(schedule.lastRunAt)
        if (last.getHours() === now.getHours() && last.getMinutes() === now.getMinutes()) continue
      }
      try {
        startAutomationRun('schedule', schedule)
      } catch (error) {
        console.error(`[hy web] schedule ${schedule.id}: ${errorMessage(error)}`)
      }
    }
  }
  const automationTimer = setInterval(tickAutomation, 20_000)
  if (typeof automationTimer.unref === 'function') automationTimer.unref()

  let closing = false
  let sandbox: unknown
  try {
    sandbox = await client.sandboxStatus()
  } catch (error) {
    sandbox = { error: errorMessage(error) }
  }

  const startRalphJob = (body: Record<string, unknown>): RalphJob => {
    const objective = typeof body.objective === 'string' ? body.objective.trim() : ''
    const verifyCmds = Array.isArray(body.verifyCmds)
      ? body.verifyCmds.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      : typeof body.verifyCmd === 'string' && body.verifyCmd.trim()
        ? [body.verifyCmd.trim()]
        : []
    if (!objective) throw new Error('objective is required')
    if (verifyCmds.length === 0) throw new Error('at least one verify command is required')
    const id = `ralph-${randomBytes(5).toString('hex')}`
    const job: RalphJob = {
      id,
      objective,
      status: 'running',
      output: [],
      started: Date.now(),
    }
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js')
    const args = [cli, 'ralph', objective, '--cwd', config.workspaceRoot, '--state-dir', config.stateDir, '--unattended-ok']
    for (const cmd of verifyCmds) args.push('--verify-cmd', cmd)
    if (config.role.provider === 'mock') args.push('--mock')
    else {
      args.push('--provider', config.role.provider, '--model', config.role.model)
      if (config.role.baseUrl) args.push('--base-url', config.role.baseUrl)
      if (config.role.apiKeyEnv) args.push('--api-key-env', config.role.apiKeyEnv)
    }
    args.push('--sandbox', config.sandbox)
    if (config.autoApprove || body.autoApprove === true) args.push('--yes')
    if (config.guardianRole || body.guardian === true) args.push('--guardian')
    if (config.projectTrusted) args.push('--trust')
    if (config.web) args.push('--web')
    if (config.ptc) args.push('--ptc')
    if (config.memory) args.push('--memory')
    const number = (key: string, fallback?: number): number | undefined => {
      const raw = body[key]
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : fallback
      return value !== undefined && Number.isFinite(value) ? value : undefined
    }
    const maxRounds = number('maxRounds')
    const maxTokens = number('maxTotalTokens')
    const maxWall = number('maxWallClockMs')
    const roundTimeout = number('roundTimeoutMs')
    if (maxRounds !== undefined) args.push('--max-rounds', String(maxRounds))
    if (maxTokens !== undefined) args.push('--max-total-tokens', String(maxTokens))
    if (maxWall !== undefined) args.push('--max-wall-clock-ms', String(maxWall))
    if (roundTimeout !== undefined) args.push('--round-timeout-ms', String(roundTimeout))
    const maxCost = body.maxCostUsd === 'off' ? 'off' : number('maxCostUsd')
    args.push('--max-cost-usd', maxCost === undefined ? (config.budget.maxCostUsd === undefined ? 'off' : String(config.budget.maxCostUsd)) : String(maxCost))
    if (body.noGrader === true) args.push('--no-grader')
    if (body.allowProtectedEdits === true) args.push('--allow-protected-edits')

    const child = spawn(process.execPath, args, {
      cwd: config.workspaceRoot,
      env: process.env,
      windowsHide: true,
    })
    job.child = child
    const append = (line: string): void => {
      if (!line.trim()) return
      job.output.push(line)
      if (job.output.length > 2000) job.output.splice(0, job.output.length - 2000)
      const run = /\[hy\] ralph (run-[a-z0-9]+):/.exec(line)
      if (run?.[1]) job.runId = run[1]
    }
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = ''
      stream?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) append(line)
      })
      stream?.on('end', () => {
        if (buffer) append(buffer)
        buffer = ''
      })
    }
    child.on('error', (error) => {
      append(`[desktop] ${errorMessage(error)}`)
      job.status = 'failed'
      job.ended = Date.now()
    })
    child.on('close', (code) => {
      if (job.status !== 'cancelled') job.status = code === 0 ? 'succeeded' : 'failed'
      job.ended = Date.now()
      job.child = undefined
      broadcastSessions()
    })
    ralphJobs.set(id, job)
    return job
  }

  const orchestrationView = () => ({
    active: orchestration.active
      ? { ...orchestration.active, workers: orchestration.active.workers.map((worker) => workerCard(worker)) }
      : null,
  })
  const broadcastOrchestration = (): void => {
    const payload = { type: 'orchestration', orchestration: orchestrationView() }
    for (const res of [...globalSubscribers]) {
      try {
        sseWrite(res, 'orchestration', payload)
      } catch {
        globalSubscribers.delete(res)
      }
    }
  }
  const persistOrchestration = (): void => {
    saveOrchestrationState(orchestrationPath, orchestration)
    broadcastOrchestration()
  }
  const dropRunFromLog = (runId: string): void => {
    const kept = readEvents(logFile).filter((event) => event.runId !== runId && !event.runId?.startsWith(`${runId}.sub`))
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.writeFileSync(logFile, kept.length > 0 ? `${kept.map((event) => JSON.stringify(event)).join('\n')}\n` : '', 'utf8')
  }

  /**
   * Deleting a running chat aborts its turn, but the agent can still append a
   * final event after the first rewrite. Keep the run tombstoned and rewrite
   * once the turn has actually stopped, so it cannot reappear in the sidebar.
   */
  const cleanUpDeletedRun = (runId: string, session: WebSession): void => {
    let attempts = 0
    const tick = (): void => {
      if (session.busy && attempts < 120) {
        attempts += 1
        setTimeout(tick, 250)
        return
      }
      try {
        dropRunFromLog(runId)
      } catch (error) {
        console.error(`[hy] deleting run log failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      broadcastSessions()
    }
    setTimeout(tick, 250)
  }

  const rootById = (id: string | null | undefined) =>
    config.workspaceRoots.find((root) => root.id === id) ?? config.workspaceRoots[0]!
  const qualifyRootPath = (id: string, rel: string): string => (id === 'main' ? rel : `${id}:${rel}`)

  const broadcastSessions = (): void => {
    const payload = { type: 'sessions', sessions: sessionSummary(config, readEvents(logFile), sessions, uiState, orchestration, deletedRuns) }
    for (const res of [...globalSubscribers]) {
      try {
        sseWrite(res, 'sessions', payload)
      } catch {
        globalSubscribers.delete(res)
      }
    }
  }

  const kindOfRun = (runId: string): SessionKind => {
    const active = orchestration.active?.status === 'active' ? orchestration.active : undefined
    if (active?.orchestratorRunId === runId) return 'orchestrator'
    return active?.workers.some((w) => w.runId === runId) ? 'worker' : 'chat'
  }
  const workerOfRun = (runId: string): WorkerRecord | undefined =>
    orchestration.active?.status === 'active' ? orchestration.active.workers.find((w) => w.runId === runId) : undefined

  const modelForKind = (kind: SessionKind): { provider: string; model: string } => {
    const role = kind === 'orchestrator' ? config.orchestratorRole : config.role
    return { provider: role.provider, model: role.model }
  }
  const ensureSession = (runId: string): WebSession | undefined => {
    if (deletedRuns.has(runId)) return undefined
    const existing = sessions.get(runId)
    if (existing) return existing
    const events = readEvents(logFile)
    if (!runExists(events, runId)) return undefined
    const entries = projectChat(events, runId)
    const worker = workerOfRun(runId)
    const kind = kindOfRun(runId)
    const session: WebSession = {
      runId,
      kind,
      ...(worker && orchestration.active ? { parentRunId: orchestration.active.orchestratorRunId } : {}),
      ...(worker && orchestration.active ? { orchestrationId: orchestration.active.id } : {}),
      ...(worker ? { workerStatus: worker.status, workerTitle: worker.title } : {}),
      busy: false,
      entries,
      subscribers: new Set(),
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      planMode: kind === 'orchestrator' ? true : planModeOf(events, runId),
      sandboxMode: resolveSandboxMode(events, runId, config.sandbox),
      model: modelForKind(kind),
      goal: goalOf(events, runId),
      stats: statsFromEvents(events.filter((event) => event.runId === runId)),
      statsClock: emptyClock(),
      turns:
        events.filter((e) => e.runId === runId && (e.type === 'turn/start' || e.type === 'round/start')).length -
        events.filter((e) => e.runId === runId && e.type === 'turn/undo').length,
      usage: usageOf(events, runId),
      jobs: jobsOf(entries),
      pinned: uiState.pinned.includes(runId),
      archived: uiState.archived.includes(runId),
      createdAt: startOfRun(events, runId),
      updatedAt: Date.now(),
    }
    sessions.set(runId, session)
    return session
  }

  const newSession = (kind: SessionKind = 'chat', meta?: { parentRunId?: string; orchestrationId?: string }): WebSession => {
    const runId = newRunId()
    const session: WebSession = {
      runId,
      kind,
      ...(meta?.parentRunId !== undefined ? { parentRunId: meta.parentRunId } : {}),
      ...(meta?.orchestrationId !== undefined ? { orchestrationId: meta.orchestrationId } : {}),
      busy: false,
      entries: [],
      subscribers: new Set(),
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      planMode: kind === 'orchestrator',
      sandboxMode: config.sandbox,
      turns: 0,
      model: modelForKind(kind),
      stats: emptyStats(),
      statsClock: emptyClock(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        lastCacheHitTokens: 0,
        lastCacheMissTokens: 0,
      },
      jobs: new Map(),
      pinned: false,
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    sessions.set(runId, session)
    try {
      // Persist the empty chat immediately so it appears in the session list
      // before the first answer and survives a restart.
      const log = new SessionLog(sessionLogPath(config.stateDir))
      log.setRun(runId)
      log.append('session/start', { createdAt: session.createdAt, kind })
    } catch {
      // The in-memory session still works when the state directory is read-only.
    }
    broadcastSessions()
    return session
  }

  const ensureConversation = (session: WebSession): Conversation => {
    if (session.conv) return session.conv
    const options = conversationOptions(session)
    session.conv = Conversation.create(
      config,
      client,
      session.runId,
      false,
      (request) => requestApproval(session, request),
      session.kind === 'worker' ? undefined : (question) => requestQuestion(session, question),
      (event) => onAgentEvent(session, event),
      options,
    )
    session.turns = session.conv.turns
    session.planMode = session.conv.isPlanMode()
    session.sandboxMode = session.conv.sandboxMode()
    session.goal = session.conv.currentGoal()
    session.model = session.conv.currentModel()
    return session.conv
  }

  const promptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts')
  const promptText = (name: string, fallback: string): string => {
    try {
      return fs.readFileSync(path.join(promptDir, name), 'utf8').trim()
    } catch {
      return fallback
    }
  }
  const orchestratorPrompt = (): string =>
    promptText(
      'orchestrator.md',
      'You are the orchestrator. Stay in plan mode, never edit files, and manage worker sessions with the orchestrator tools.',
    )
  // Role guidance appended after orchestrator.md. Keep additions here additive
  // so the authored prompt file stays the base and the two never disagree.
  const orchestratorGuidance = [
    'Think about the project as a whole, not only the task in front of you. Before you hand out each task, work out how the change lands in the wider ' +
      'codebase: which modules, contracts and other running tasks it can affect, and what it makes obsolete. Read the existing documents when they bear on ' +
      'the decision, such as `docs/designs/`, `project.md` and `docs/implementation_status.md`, instead of inferring the design from one file. When several ' +
      'workers report, reconcile their changes against each other and against the plan, and say so when two of them pull in different directions. Prefer ' +
      'whole-project consistency - types, API contracts, naming, no duplicated tests - over a locally tidy answer. Keep asking what the user actually wanted ' +
      'from the finished change, and cut the tasks so that answer stays true.',
    'Reuse workers before you create new ones. Check `orchestrator_workers` before every `orchestrator_spawn`; it lists only open workers by default, with the exact status and scope. When an existing worker already owns the same scope or an overlapping one, continue with `orchestrator_send`: it has already read those files and its prompt cache is warm, so a follow-up is cheaper and less error-prone than a fresh briefing. Spawn a new worker only when the scope does not overlap an active one, when the existing worker is stopped on a blocker it cannot clear, or when its conversation is so tangled that correcting it costs more than restarting. Closing a worker releases its scope and lets that cache go cold. A worker that finished with `STATUS: done` is `waiting for review` but still holds its scope: review its diff and close it, or send the next concrete step in the same turn. Do not leave a waiting worker open across turns unless you are reusing it immediately; that is how scopes get stranded.',
  ].join('\n\n')
  const workerPrompt = (record: WorkerRecord | undefined): string => {
    const base = promptText('worker.md', 'You are a worker managed by an orchestrator. Work only inside your assigned scope.')
    return `${base}\n\nAssigned title: ${record?.title ?? '(unknown)'}\nAssigned scope: ${record?.scope.join(', ') ?? '(unknown)'}\nThis is a shared workspace. The host refuses git and creates/owns checkpoints; do not try to work around those restrictions.`
  }

  function pluginTool(
    name: string,
    description: string,
    input: Schema,
    readOnly: boolean,
    run: PluginTool['run'],
  ): [string, PluginTool & { spec: ToolSpec; plugin: string }] {
    return [
      name,
      {
        name,
        description,
        input,
        readOnly,
        run,
        spec: { name, wire: true, readOnly, description, input, output: {} },
        plugin: 'orchestration',
      },
    ]
  }
  const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
    type: 'object',
    properties,
    required,
  })

  function orchestrationTooling(): {
    plugins: LoadedPlugins['tools']
    specs: ToolSpec[]
    allowed: Set<string>
  } {
    const plugins: LoadedPlugins['tools'] = new Map()
    const add = (name: string, description: string, input: Schema, readOnly: boolean, run: PluginTool['run']) => {
      const [key, tool] = pluginTool(name, description, input, readOnly, run)
      plugins.set(key, tool)
    }
    add(
      'orchestrator_spawn',
      'Create an ordinary worker session for a runnable task. Start work as soon as the task is clear; do not wait for plan approval. Scope is one or more disjoint repository-relative directories, or `file:` scopes for single files. The worker may write only below those directories or exactly at those files. The host rejects overlapping scopes and too many workers.',
      object(
        {
          title: { type: 'string', description: 'Short task title.' },
          task: { type: 'string', description: 'Self-contained task, including acceptance checks and verification.' },
          scope: {
            type: 'array',
            items: { type: 'string' },
            description: 'Repository-relative directories the worker may edit, or `file:` scopes for one file. Never . or **.',
          },
        },
        ['title', 'task', 'scope'],
      ),
      false,
      async (args) => spawnWorker(String(args.title ?? ''), String(args.task ?? ''), Array.isArray(args.scope) ? args.scope.map(String) : []),
    )
    add(
      'orchestrator_send',
      'Send a correction or follow-up to an existing open worker. The worker keeps its scope. A waiting worker starts a new turn immediately; a running worker queues the message for after its current turn. The result reports delivered, queued, status and scope, so never treat queued:false as "closed".',
      object(
        {
          workerId: { type: 'string' },
          message: { type: 'string', description: 'Concrete change, evidence needed, or decision.' },
        },
        ['workerId', 'message'],
      ),
      false,
      async (args) => sendWorker(String(args.workerId ?? ''), String(args.message ?? '')),
    )
    add(
      'orchestrator_workers',
      'List workers in a compact form. By default only open workers (everything except closed) are returned, one line each with the exact status, report status, held scope and a report preview. Set includeClosed to see recently closed workers, or full to include the original task and the full report. A waiting worker is finished but not reviewed and still holds its scope.',
      object({
        includeClosed: { type: 'boolean', description: 'Include recently closed workers.' },
        full: { type: 'boolean', description: 'Include each task and the full report preview.' },
      }),
      true,
      async (args) => workerList(args.includeClosed === true, args.full === true),
    )
    add(
      'orchestrator_diff',
      'Read the current git status and diff for one worker scope, plus changes outside every active scope.',
      object(
        {
          workerId: { type: 'string' },
          maxBytes: { type: 'integer', minimum: 1024 },
        },
        ['workerId'],
      ),
      true,
      async (args) => workerDiff(String(args.workerId ?? ''), typeof args.maxBytes === 'number' ? args.maxBytes : undefined),
    )
    add(
      'orchestrator_stop',
      'Stop a worker turn. Its scope stays reserved until you close it, so partial changes cannot collide with new work.',
      object({ workerId: { type: 'string' }, reason: { type: 'string' } }, ['workerId']),
      false,
      async (args) => stopWorker(String(args.workerId ?? ''), typeof args.reason === 'string' ? args.reason : undefined),
    )
    add(
      'orchestrator_approve',
      'Approve or deny a worker command after asking the user when needed. This resolves that worker approval request.',
      object(
        {
          workerId: { type: 'string' },
          requestId: { type: 'string' },
          approved: { type: 'boolean' },
          reason: { type: 'string' },
        },
        ['workerId', 'requestId', 'approved'],
      ),
      false,
      async (args) =>
        approveWorker(
          String(args.workerId ?? ''),
          String(args.requestId ?? ''),
          args.approved === true,
          typeof args.reason === 'string' ? args.reason : undefined,
        ),
    )
    add(
      'orchestrator_close',
      'Close a reviewed worker and release its scope. A running worker must be stopped first so its in-flight edits cannot race a new owner. A blocked/partial/failed/interrupted worker needs a summary explaining how the blocker was handled; otherwise closing is refused.',
      object({ workerId: { type: 'string' }, summary: { type: 'string' } }, ['workerId']),
      false,
      async (args) => closeWorker(String(args.workerId ?? ''), typeof args.summary === 'string' ? args.summary : undefined),
    )
    const specs = [...plugins.values()].map((tool) => tool.spec)
    return { plugins, specs, allowed: new Set(plugins.keys()) }
  }

  function conversationOptions(session: WebSession): Parameters<typeof Conversation.create>[7] {
    if (session.kind === 'orchestrator') {
      return {
        roleInstruction: orchestratorPrompt() + orchestratorGuidance,
        role: config.orchestratorRole,
        planOnly: true,
        initialPlanMode: true,
        checkpoints: false,
        delegate: false,
        tooling: orchestrationTooling(),
      }
    }
    if (session.kind === 'worker') {
      const record = workerOfRun(session.runId) ?? orchestration.active?.workers.find((w) => w.runId === session.runId)
      return {
        roleInstruction: workerPrompt(record),
        checkpoints: false,
        delegate: true,
        ...(record ? { writeScope: record.scope } : {}),
        shellGuard: (command: string) => {
          if (/(^|[\s;&|()])git(?:\s|$)/i.test(command)) {
            throw new Error('workers must not run git; the orchestrator owns repository state and reviews the diff')
          }
          if (/(^|[\s;&|()])hy\s+(?:undo|checkpoint|sandbox|ralph|run|resume|review)\b/i.test(command)) {
            throw new Error('workers must not run harness state-changing commands')
          }
        },
        shellLock: shellQueue,
        noBackgroundShell: true,
        minForegroundWaitMs: 10 * 60_000,
        shellTimeoutMs: 10 * 60_000,
      }
    }
    return {
      ...(session.planMode ? { initialPlanMode: true } : {}),
      // WP-22: a chat can start background subagents it keeps talking to.
      backgroundAgents: true,
      onAgentChange: (view, event) => onAgentChange(session, view, event),
    }
  }

  /**
   * WP-22: background subagent state changes reach the GUI twice — as a state
   * event (the panel refreshes) and, when a turn ends, as a notice in the chat
   * that started it, so a finished agent is not silent.
   */
  const onAgentChange = (session: WebSession, view: SubagentView, event: 'spawn' | 'running' | 'idle' | 'interrupt' | 'close'): void => {
    broadcast(session, { type: 'agent/state', event, agent: view })
    if (event !== 'idle') return
    const text = view.error
      ? `subagent ${view.agentId} failed: ${view.error}`
      : `subagent ${view.agentId} finished: ${(view.final ?? '').replace(/\s+/g, ' ').slice(0, 300)}`
    broadcast(session, { type: 'notice', level: view.error ? 'warn' : 'info', text })
  }

  // CP-11: an MCP server asking for input becomes a question card in the chat
  // whose turn is running; with none (or several) it is declined.
  setElicitationHandler(async (request) => {
    const running = [...sessions.values()].filter((s) => s.busy)
    if (running.length !== 1) return { action: 'decline' }
    const reply = await requestQuestion(running[0]!, `MCP ${request.server}: ${request.message}`)
    return elicitationContent(request.requestedSchema, reply)
  })

  /** CP-34: commands approved "for this session", per chat, until the server stops. */
  const sessionApprovals = new Map<string, Set<string>>()

  const requestApproval = (session: WebSession, request: ApprovalRequest): Promise<boolean | { approved: boolean; reason?: string }> => {
    const key = approvalKey(request)
    if (sessionApprovals.get(session.runId)?.has(key)) {
      const entry: ChatEntry = { id: `approval-auto-${randomBytes(4).toString('hex')}`, kind: 'notice', runId: session.runId, text: `approved for this session: ${request.command}`, ts: Date.now() }
      session.entries.push(entry)
      broadcast(session, { type: 'entry', entry })
      return Promise.resolve(true)
    }
    const requestId = `apr-${randomBytes(6).toString('hex')}`
    // CP-34: cwd, sandbox effect, paths and hosts travel with the request.
    const details = describeApproval(request, config.workspaceRoot)
    session.entries.push({ id: `approval-${requestId}`, kind: 'approval', runId: session.runId, requestId, request, details, ts: Date.now() })
    broadcast(session, { type: 'approval/request', requestId, request, details })
    return new Promise<boolean | { approved: boolean; reason?: string }>((resolve) => {
      const timer = setTimeout(() => {
        session.pendingApprovals.delete(requestId)
        session.entries.push({ id: `approval-timeout-${requestId}`, kind: 'notice', runId: session.runId, text: `approval timed out: ${request.command}`, ts: Date.now(), level: 'warn' })
        broadcast(session, { type: 'approval/timeout', requestId })
        resolve(false)
      }, 5 * 60_000)
      session.pendingApprovals.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v) }, timer, request })
      if (session.kind === 'worker') {
        const record = workerOfRun(session.runId)
        if (record) onWorkerApproval(record, requestId, request)
      }
    })
  }

  const requestQuestion = (session: WebSession, question: string): Promise<string> => {
    const requestId = `ask-${randomBytes(6).toString('hex')}`
    session.entries.push({ id: `question-${requestId}`, kind: 'question', runId: session.runId, requestId, question, ts: Date.now() })
    broadcast(session, { type: 'question/request', requestId, question })
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        session.pendingQuestions.delete(requestId)
        broadcast(session, { type: 'question/timeout', requestId })
        resolve('')
      }, 10 * 60_000)
      session.pendingQuestions.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v) }, timer })
    })
  }

  const onAgentEvent = (session: WebSession, event: AgentEvent): void => {
    if (session.kind === 'worker') {
      const record = workerOfRun(session.runId)
      if (record) onWorkerEvent(record)
    }
    // A subagent's internal stream belongs to its own transcript, not the parent.
    if (typeof event.subagent === 'string') {
      broadcast(session, { type: 'subagent/event', subagent: event.subagent, event })
      return
    }
    let instantSummary: string | undefined
    if (event.type === 'thinking' && typeof event.seq === 'number') {
      const seq = Number(event.seq)
      const text = String(event.content ?? '').trim()
      if (text) {
        instantSummary = instantThinkingSummary(text) || undefined
        void summarizeThinking(config, text, session.runId)
          .then((summary) => {
            const entry = session.entries.find((candidate) => candidate.id === `think-${seq}`)
            if (entry?.kind !== 'thinking') return
            entry.summary = summary
            entry.summaryProvisional = false
            session.conv?.log.append('thinking/summary', { thinkingSeq: seq, summary })
            session.updatedAt = Date.now()
            broadcast(session, { type: 'thinking/summary', entryId: entry.id, summary })
          })
          .catch((error: unknown) => {
            // A missing or broken summarizer must not break the worker turn.
            console.error(`[hy] thinking summary failed: ${error instanceof Error ? error.message : String(error)}`)
          })
      }
    }
    if (event.type === 'tool') {
      const result = event.result
      if (result && typeof result === 'object' && typeof (result as { jobId?: unknown }).jobId === 'string') {
        const args = (event.args ?? {}) as Record<string, unknown>
        const jobId = String((result as { jobId: string }).jobId)
        session.jobs.set(jobId, {
          jobId,
          command: typeof args.command === 'string' ? args.command : String(event.name ?? 'shell'),
          status: typeof (result as { status?: unknown }).status === 'string' ? String((result as { status: string }).status) : 'unknown',
          started: Date.now(),
          updated: Date.now(),
        })
      }
    }
    applyAgentEvent(session.entries, session.runId, event)
    // WP-62: spans close here, before the stats clock forgets the start times.
    if (telemetry.enabled) {
      const now = Date.now()
      if (event.type === 'step-end') {
        const start = session.statsClock.stepStart ?? now
        telemetry.record({
          name: 'hy.step',
          startMs: start,
          endMs: now,
          attributes: {
            'hy.run_id': session.runId,
            'hy.model': `${session.model.provider}:${session.model.model}`,
            'hy.steps': session.stats.steps + 1,
          },
          status: 'ok',
        })
      } else if (event.type === 'tool' || event.type === 'tool-error') {
        const callId = String(event.callId ?? '')
        const start = session.statsClock.toolStarts.get(callId) ?? now
        telemetry.record({
          name: 'hy.tool',
          startMs: start,
          endMs: now,
          // No arguments and no output: the tool name, the outcome, the time.
          attributes: {
            'hy.run_id': session.runId,
            'hy.tool': String(event.name ?? 'unknown'),
            'hy.ok': event.type === 'tool',
          },
          status: event.type === 'tool' ? 'ok' : 'error',
        })
      }
    }
    // WP-60: timing follows the same events the chat renders.
    session.stats = applyStatsEvent(session.stats, session.statsClock, event, Date.now())
    session.updatedAt = Date.now()
    broadcast(session, { type: 'agent', event })
    if (instantSummary) {
      const entry = session.entries.find((candidate) => candidate.id === `think-${event.seq}`)
      if (entry?.kind === 'thinking') {
        broadcast(session, { type: 'thinking/summary', entryId: entry.id, summary: entry.summary ?? instantSummary, provisional: true })
      }
    }
    if (event.type === 'step-end' || event.type === 'final') broadcast(session, { type: 'state', state: sessionState(session) })
  }

  const resolvePending = (session: WebSession): void => {
    for (const [id, pending] of session.pendingApprovals) {
      clearTimeout(pending.timer)
      pending.resolve(false)
      session.pendingApprovals.delete(id)
      broadcast(session, { type: 'approval/decision', requestId: id, approved: false, reason: 'run cancelled' })
    }
    for (const [id, pending] of session.pendingQuestions) {
      clearTimeout(pending.timer)
      pending.resolve('')
      session.pendingQuestions.delete(id)
      broadcast(session, { type: 'question/answer', requestId: id, answer: '' })
    }
  }

  const workerInbox = new Map<string, string[]>()

  function activeOrchestration(): OrchestrationRecord | undefined {
    return orchestration.active?.status === 'active' ? orchestration.active : undefined
  }

  /**
   * Adds a compact, ephemeral status block to an orchestrator turn. Every open
   * worker is listed, not only blockers: a worker that reported done but is
   * still `waiting` keeps its scope reserved, and hiding it from the digest was
   * how scopes got stranded. The block is one bracketed section so the offline
   * mock provider's stripContext() still sees the original message.
   */
  function withOrchestrationDigest(message: string): string {
    const active = activeOrchestration()
    if (!active || message.startsWith('[orchestration status:')) return message
    const open = active.workers.filter(workerHoldsScope)
    if (open.length === 0) return message
    const clean = (value: string, limit = 240): string =>
      value
        .replace(/[\r\n]+/g, ' ')
        .replace(/[[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit)
    const lines = open.map((worker) => {
      const reason = worker.blocker ?? worker.lastError
      return [
        `- ${clean(worker.title, 80)} (${worker.runId}): ${workerStatusLabel(worker.status)}`,
        `scope ${clean(worker.scope.join(', '), 160)}`,
        ...(worker.lastReportStatus ? [`report ${worker.lastReportStatus}`] : []),
        ...(reason ? [clean(reason)] : []),
      ].join('; ')
    })
    const awaiting = open.filter(workerAwaitingReview)
    const unresolved = open.filter(
      (worker) => workerNeedsAttention(worker.status) || worker.status === 'stopped',
    )
    const rules = [
      ...(awaiting.length > 0
        ? [
            `Awaiting review: ${awaiting.map((worker) => worker.runId).join(', ')}. ` +
              'Run orchestrator_diff, then orchestrator_close; or send the next concrete step with orchestrator_send. ' +
              'Their scope stays reserved until they are closed.',
          ]
        : []),
      ...(unresolved.length > 0
        ? ['Do not claim the overall task is complete while a worker is blocked, partial, failed, interrupted or stopped.']
        : []),
    ]
    return [`[orchestration status: ${open.length} open worker(s)`, ...lines, ...rules, ']'].join('\n') + `\n\n${message}`
  }

  function orchestratorSession(): WebSession | undefined {
    const active = activeOrchestration()
    return active ? ensureSession(active.orchestratorRunId) : undefined
  }

  /**
   * Last-resort guard: after an orchestrator turn, surface unresolved workers
   * (blocked/partial/failed/interrupted/stopped) and workers whose done report
   * still awaits review. Without this the scope stays reserved but nothing in
   * the chat says why. Emitted once per worker-state signature.
   */
  function reportUnmentionedWorkers(session: WebSession, text: string): void {
    const active = activeOrchestration()
    if (!active) {
      lastWorkerNotice.delete(session.runId)
      return
    }
    const open = active.workers.filter(workerHoldsScope)
    const blockers = open.filter((worker) => workerNeedsAttention(worker.status))
    const awaiting = open.filter(workerAwaitingReview)
    if (blockers.length === 0 && awaiting.length === 0) {
      lastWorkerNotice.delete(session.runId)
      return
    }
    const signature = open
      .map((worker) => `${worker.runId}:${worker.status}:${worker.blocker ?? worker.lastError ?? ''}`)
      .join('|')
    if (lastWorkerNotice.get(session.runId) === signature) return
    // A blocker the model explicitly discussed is not repeated as a host
    // notice. Awaiting review is a scope fact, so it is always shown.
    const lowered = text.toLowerCase()
    const mentioned = blockers.some((worker) => {
      const reason = (worker.blocker ?? worker.lastError ?? '').toLowerCase()
      return (
        (worker.title.length > 0 && lowered.includes(worker.title.toLowerCase())) ||
        (reason.length > 0 && lowered.includes(reason)) ||
        /blocked|partial|not done|incomplete|cannot|can't|できません|未完了|ブロック|一部完了|无法|未完成|阻塞/.test(lowered)
      )
    })
    if (mentioned && awaiting.length === 0) {
      lastWorkerNotice.delete(session.runId)
      return
    }
    const lines: string[] = []
    if (blockers.length > 0 && !mentioned) {
      lines.push(
        '[unresolved blockers]',
        ...blockers.map((worker) => {
          const reason =
            worker.blocker ??
            worker.lastError ??
            (worker.status === 'blocked' ? 'waiting for approval' : 'no reason recorded')
          return `- ${worker.title} (${worker.runId}): ${workerStatusLabel(worker.status)} — ${reason}`
        }),
        'The task is not complete until these are resolved or the user accepts them.',
      )
    }
    if (awaiting.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push(
        '[workers awaiting review]',
        ...awaiting.map(
          (worker) =>
            `- ${worker.title} (${worker.runId}): ${workerStatusLabel(worker.status)}; ` +
            `scope ${worker.scope.join(', ')} stays reserved until orchestrator_close.`,
        ),
        'Review each diff, then close it or send the next concrete step.',
      )
    }
    if (lines.length === 0) return
    const entry: ChatEntry = {
      id: `event-${Date.now()}`,
      kind: 'notice',
      runId: session.runId,
      text: lines.join('\n'),
      ts: Date.now(),
    }
    session.entries.push(entry)
    broadcast(session, { type: 'entry', entry })
    lastWorkerNotice.set(session.runId, signature)
  }

  function workerCard(record: WorkerRecord) {
    return {
      workerId: record.runId,
      title: record.title,
      task: record.task,
      scope: record.scope,
      status: record.status,
      scopeHeld: workerHoldsScope(record),
      awaitingReview: workerAwaitingReview(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastEventAt: record.lastEventAt,
      lastSummary: record.lastSummary ?? null,
      lastError: record.lastError ?? null,
      reportStatus: record.lastReportStatus ?? null,
      blocker: record.blocker ?? null,
      closedAt: record.closedAt ?? null,
    }
  }

  /**
   * Model-facing worker summary. The old card included the full task and an
   * 8,000-character report for every worker, so a long-lived orchestration
   * overflowed the tool result and the model lost the very workers it needed
   * to review. Keep this small by default; `full` is opt-in.
   */
  function workerSummary(record: WorkerRecord, full: boolean) {
    const summary = record.lastSummary?.trim() ?? ''
    return {
      workerId: record.runId,
      title: record.title,
      status: record.status,
      statusLabel: workerStatusLabel(record.status),
      reportStatus: record.lastReportStatus ?? null,
      scopeHeld: workerHoldsScope(record),
      awaitingReview: workerAwaitingReview(record),
      scope: record.scope,
      ...(record.blocker ? { blocker: record.blocker.slice(0, 1_000) } : {}),
      ...(record.lastError ? { lastError: record.lastError.slice(0, full ? 4_000 : 300) } : {}),
      updatedAt: record.updatedAt,
      ...(summary ? { reportPreview: summary.slice(0, full ? 8_000 : 400) } : {}),
      ...(full ? { task: record.task } : {}),
      ...(record.closedAt ? { closedAt: record.closedAt } : {}),
    }
  }

  function workerList(includeClosed: boolean, full: boolean) {
    const active = orchestration.active
    const all = active?.workers ?? []
    const open = all.filter(workerHoldsScope)
    const closed = all.filter((worker) => !workerHoldsScope(worker))
    // Closed workers are historical. Keep a short tail so the response stays
    // bounded even after hundreds of tasks; the counts explain the omission.
    const shownClosed = includeClosed ? closed.slice(-10) : []
    return {
      workers: [...open, ...shownClosed].map((worker) => workerSummary(worker, full)),
      total: all.length,
      open: open.length,
      awaitingReview: open.filter(workerAwaitingReview).map((worker) => worker.runId),
      hiddenClosed: includeClosed ? Math.max(0, closed.length - shownClosed.length) : closed.length,
      maxWorkers: active?.maxWorkers ?? 0,
      ...(open.length === 0 && !includeClosed
        ? { hint: 'No open workers. Pass includeClosed to inspect recently closed work.' }
        : {}),
    }
  }

  function updateWorker(record: WorkerRecord, patch: Partial<WorkerRecord>): void {
    // A new run or a successful review must not keep showing the previous
    // failure/blocker. Blocked, partial, failed and interrupted states keep it.
    const next =
      patch.status !== undefined && ['running', 'queued', 'waiting', 'done'].includes(patch.status)
        ? { ...patch, lastError: undefined, blocker: undefined }
        : patch
    Object.assign(record, next, { updatedAt: Date.now() })
    const session = sessions.get(record.runId)
    if (session) {
      session.workerStatus = record.status
      session.workerTitle = record.title
      session.updatedAt = Date.now()
      broadcast(session, { type: 'state', state: sessionState(session) })
    }
    if (orchestration.active) orchestration.active.updatedAt = Date.now()
    persistOrchestration()
    broadcastSessions()
  }

  function workerForId(workerId: string): WorkerRecord {
    const record = activeOrchestration()?.workers.find((w) => w.runId === workerId)
    if (!record) throw new Error(`unknown worker ${workerId}`)
    return record
  }

  function workerTaskMessage(record: WorkerRecord): string {
    return [
      record.task,
      '',
      '[orchestrator assignment]',
      `Title: ${record.title}`,
      `Worker: ${record.runId}`,
      `Scope: ${record.scope.join(', ')}`,
      'The workspace is shared with other workers. Edit only inside the scope above.',
      'Do not run git, undo, checkpoint, branch, merge, rebase, stash or worktree commands.',
      'The host serializes shell commands; keep them in the foreground.',
      'You may use delegate subagents. They inherit your scope and restrictions.',
      'Report what changed, the exact verification you ran, and anything left undone. Do not ask the user directly.',
      'Finish with a STATUS: done, STATUS: partial, or STATUS: blocked line. For partial/blocked, add BLOCKED_BY: <one line>. The host parses these lines.',
    ].join('\n')
  }

  function workerReportMessage(record: WorkerRecord, text: string): string {
    const status = workerStatusLabel(record.status)
    const lines = [
      '[worker report]',
      `worker: ${record.title} (${record.runId})`,
      `status: ${status}`,
      `scope: ${record.scope.join(', ')}`,
      ...(record.blocker ? [`blocker: ${record.blocker}`] : []),
      record.status === 'failed' || record.status === 'stopped'
        ? `error:\n${text.slice(0, 4000)}`
        : `report:\n${text.slice(0, 8000)}`,
    ]
    if (record.status === 'blocked' || record.status === 'partial') {
      lines.push(
        'This task is not complete. Tell the user what is blocked and what is needed; do not present it as done.',
      )
    } else {
      lines.push(
        'Review with orchestrator_diff before accepting or closing this worker. ' +
          'It still owns its scope until you call orchestrator_close, so a new worker cannot take that scope.',
      )
    }
    return lines.join('\n')
  }

  function queueOrchestratorNotice(text: string): void {
    if (!activeOrchestration()) return
    orchestratorInbox.push(text)
    if (orchestratorInbox.length > 20) orchestratorInbox = orchestratorInbox.slice(-20)
    flushOrchestratorInbox()
  }

  function flushOrchestratorInbox(): void {
    if (orchestratorStarting || orchestratorInbox.length === 0) return
    const active = activeOrchestration()
    if (!active) {
      orchestratorInbox = []
      return
    }
    const session = ensureSession(active.orchestratorRunId)
    if (!session) {
      orchestratorInbox = []
      return
    }
    if (session.busy) return
    const text = orchestratorInbox.splice(0).join('\n\n').slice(0, 16_000)
    orchestratorStarting = true
    void runTurn(session, text, [], { synthetic: true, source: 'worker', from: 'orchestrator' })
      .catch((error: unknown) => {
        session.lastError = errorMessage(error)
      })
      .finally(() => {
        orchestratorStarting = false
        if (orchestratorInbox.length > 0) setTimeout(() => flushOrchestratorInbox(), 0)
      })
  }

  function onTurnFinished(session: WebSession, outcome: 'completed' | 'aborted' | 'error', text: string): void {
    if (session.kind === 'orchestrator') {
      if (outcome === 'completed') reportUnmentionedWorkers(session, text)
      return
    }
    if (session.kind !== 'worker') return
    if (orchestration.active?.status !== 'active') return
    const record = workerOfRun(session.runId)
    if (!record || record.status === 'done') return
    const parsed = outcome === 'completed' ? parseWorkerReport(text) : undefined
    const status: WorkerStatus =
      outcome === 'completed'
        ? parsed?.status === 'blocked'
          ? 'blocked'
          : parsed?.status === 'partial'
            ? 'partial'
            : 'waiting'
        : outcome === 'aborted'
          ? 'stopped'
          : 'failed'
    const blocker =
      parsed && parsed.status !== 'done'
        ? parsed.reason ?? `worker reported ${parsed.status} without BLOCKED_BY`
        : undefined
    updateWorker(record, {
      status,
      lastEventAt: Date.now(),
      ...(parsed ? { lastReportStatus: parsed.status } : {}),
      ...(blocker ? { blocker } : { blocker: undefined }),
      ...(outcome === 'completed' ? { lastSummary: text.slice(0, 8_000) } : { lastError: text.slice(0, 4_000) }),
    })
    queueOrchestratorNotice(workerReportMessage(record, text))
    if (outcome === 'completed') {
      const queued = workerInbox.get(record.runId)?.shift()
      if (queued) {
        const worker = ensureSession(record.runId)
        if (worker && !worker.busy) setTimeout(() => void runTurn(worker, queued, [], { synthetic: true, source: 'orchestrator', from: 'orchestrator' }), 0)
      }
    }
  }

  async function startOrchestration(): Promise<OrchestrationRecord> {
    if (orchestration.active?.status === 'active') return orchestration.active
    const previous = orchestration.active
    if (previous) {
      const previousIds = [previous.orchestratorRunId, ...previous.workers.map((worker) => worker.runId)]
      uiState.archived = [...new Set([...uiState.archived, ...previousIds])]
      saveUiState()
      for (const id of previousIds) {
        const old = sessions.get(id)
        if (old) {
          old.kind = 'chat'
          old.workerStatus = undefined
          old.workerTitle = undefined
        }
      }
    }
    const session = newSession('orchestrator')
    const now = Date.now()
    const record: OrchestrationRecord = {
      id: `orc-${randomBytes(6).toString('hex')}`,
      orchestratorRunId: session.runId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      maxWorkers: DEFAULT_MAX_WORKERS,
      workers: [],
    }
    session.orchestrationId = record.id
    orchestration = { version: 1, active: record }
    persistOrchestration()
    broadcastSessions()
    return record
  }

  async function stopOrchestration(): Promise<OrchestrationRecord | null> {
    const active = orchestration.active
    if (!active) return null
    const stoppedIds = [active.orchestratorRunId, ...active.workers.map((worker) => worker.runId)]
    const orchestrator = sessions.get(active.orchestratorRunId)
    orchestrator?.controller?.abort()
    for (const worker of active.workers) {
      if (worker.status === 'running' || worker.status === 'queued' || worker.status === 'blocked') {
        const session = sessions.get(worker.runId)
        session?.controller?.abort()
        worker.status = 'stopped'
        worker.updatedAt = Date.now()
        if (session) {
          session.workerStatus = 'stopped'
          broadcast(session, { type: 'state', state: sessionState(session) })
        }
      }
    }
    active.status = 'stopped'
    active.updatedAt = Date.now()
    orchestratorInbox = []
    lastWorkerNotice.clear()
    // Closing the orchestration also closes its chats: archive them and turn
    // the old orchestrator session back into an ordinary, non-plan-only chat.
    uiState.archived = [...new Set([...uiState.archived, ...stoppedIds])]
    saveUiState()
    for (const id of stoppedIds) {
      const session = sessions.get(id)
      if (!session) continue
      session.kind = 'chat'
      session.workerStatus = undefined
      session.workerTitle = undefined
      session.planMode = false
      session.model = modelForKind('chat')
      session.effort = config.role.effort
      delete session.conv
      broadcast(session, { type: 'state', state: sessionState(session) })
    }
    persistOrchestration()
    broadcastSessions()
    return active
  }

  async function spawnWorker(title: string, task: string, rawScope: string[]) {
    const active = activeOrchestration()
    if (!active) throw new Error('orchestration is not active')
    const cleanTitle = title.trim()
    const cleanTask = task.trim()
    if (!cleanTitle) throw new Error('title is required')
    if (!cleanTask) throw new Error('task is required')
    const scope = normalizeScopes(rawScope)
    if (!canSpawnWorker(active)) {
      throw new Error(`worker limit reached (${active.maxWorkers}); close a finished worker first`)
    }
    for (const owner of scopeOwners(active)) {
      for (const next of scope) {
        for (const current of owner.scope) {
          if (scopesOverlap(next, current)) {
            throw new Error(
              `scope ${next} overlaps ${current} owned by ${owner.title} (${owner.runId}), ` +
                `which is ${workerStatusLabel(owner.status)}. ` +
                (workerHoldsScope(owner)
                  ? 'Continue with orchestrator_send in that scope, or review and orchestrator_close it first.'
                  : 'Close it first.'),
            )
          }
        }
      }
    }
    const session = newSession('worker', { parentRunId: active.orchestratorRunId, orchestrationId: active.id })
    const now = Date.now()
    const record: WorkerRecord = {
      runId: session.runId,
      title: cleanTitle,
      task: cleanTask,
      scope,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      lastEventAt: now,
    }
    session.workerTitle = cleanTitle
    session.workerStatus = 'queued'
    active.workers.push(record)
    updateWorker(record, { status: 'queued' })
    const message = workerTaskMessage(record)
    setTimeout(() => {
      const worker = ensureSession(record.runId)
      if (!worker) return
      updateWorker(record, { status: 'running' })
      void runTurn(worker, message, [], { synthetic: true, source: 'orchestrator', from: 'orchestrator' }).catch((error: unknown) => {
        updateWorker(record, { status: 'failed', lastError: errorMessage(error) })
        queueOrchestratorNotice(workerReportMessage(record, errorMessage(error)))
      })
    }, 0)
    return workerCard(record)
  }

  async function sendWorker(workerId: string, message: string) {
    const record = workerForId(workerId)
    const text = message.trim()
    if (!text) throw new Error('message is required')
    if (record.status === 'done') throw new Error('worker is closed')
    const worker = ensureSession(workerId)
    if (!worker) throw new Error(`worker session not found: ${workerId}`)
    const scope = record.scope
    if (worker.busy) {
      const inbox = workerInbox.get(workerId) ?? []
      inbox.push(text)
      workerInbox.set(workerId, inbox)
      updateWorker(record, { lastEventAt: Date.now() })
      return {
        workerId,
        delivered: false,
        queued: true,
        status: record.status,
        scopeHeld: workerHoldsScope(record),
        scope,
        message: 'The worker is running; the message is queued for after its current turn.',
      }
    }
    // Starting a new turn invalidates the previous report: keeping it made a
    // running worker look as if it had already reported done.
    delete record.lastReportStatus
    updateWorker(record, { status: 'running', lastEventAt: Date.now() })
    void runTurn(worker, text, [], { synthetic: true, source: 'orchestrator', from: 'orchestrator' }).catch((error: unknown) => {
      updateWorker(record, { status: 'failed', lastError: errorMessage(error) })
      queueOrchestratorNotice(workerReportMessage(record, errorMessage(error)))
    })
    return {
      workerId,
      delivered: true,
      queued: false,
      status: 'running' as const,
      scopeHeld: workerHoldsScope(record),
      scope,
      message: 'The worker started a new turn now. Its report will arrive as a new message.',
    }
  }

  async function stopWorker(workerId: string, reason?: string) {
    const record = workerForId(workerId)
    const worker = sessions.get(workerId)
    worker?.controller?.abort()
    updateWorker(record, {
      status: 'stopped',
      blocker: undefined,
      ...(reason !== undefined ? { lastError: reason } : {}),
    })
    return workerCard(record)
  }

  async function closeWorker(workerId: string, summary?: string) {
    const record = workerForId(workerId)
    // Closing releases the scope immediately. Letting a still-running turn
    // write afterwards would race whoever takes the scope next, so the
    // orchestrator must stop it first.
    if (record.status === 'running' || record.status === 'queued') {
      throw new Error(
        `worker is still ${workerStatusLabel(record.status)}; stop it with orchestrator_stop before closing, ` +
          'so its in-flight edits cannot race a new owner of the scope',
      )
    }
    if (workerNeedsAttention(record.status) && !summary?.trim()) {
      const reason = record.blocker ?? record.lastError
      throw new Error(
        `worker is ${workerStatusLabel(record.status)}${reason ? `: ${reason}` : ''}; ` +
          'send a correction, stop it, or close it with a summary that explains how the blocker is handled',
      )
    }
    sessions.get(workerId)?.controller?.abort()
    workerInbox.delete(workerId)
    updateWorker(record, {
      status: 'done',
      closedAt: Date.now(),
      blocker: undefined,
      ...(summary?.trim() ? { lastSummary: summary.trim().slice(0, 8_000) } : {}),
    })
    return workerCard(record)
  }

  /**
   * Resolves a worker's approval request. The orchestrator may approve only
   * requests that would run confined; the user may approve any (from the
   * worker's chat in the GUI).
   */
  async function approveWorker(
    workerId: string,
    requestId: string,
    approved: boolean,
    reason?: string,
    by: 'orchestrator' | 'user' = 'orchestrator',
  ) {
    const record = workerForId(workerId)
    const worker = sessions.get(workerId)
    if (!worker) throw new Error(`worker session not found: ${workerId}`)
    const pending = worker.pendingApprovals.get(requestId)
    if (!pending) throw new Error(`no pending approval ${requestId} for ${workerId}`)
    if (approved && by === 'orchestrator' && userOnlyApproval(pending.request)) {
      throw new Error(
        `request ${requestId} would run ${pending.request?.sandbox ?? 'unconfined'}; only the user can approve it. ` +
          'Ask the user to approve or deny it in the worker chat, or deny it.',
      )
    }
    clearTimeout(pending.timer)
    worker.pendingApprovals.delete(requestId)
    pending.resolve(approved)
    const entry = worker.entries.find((e) => e.kind === 'approval' && e.requestId === requestId)
    if (entry?.kind === 'approval') entry.decision = approved ? 'approved' : 'denied'
    worker.entries.push({
      id: `approval-decision-${requestId}`,
      kind: 'notice',
      runId: workerId,
      text: `${approved ? 'approved' : 'denied'} by ${by}${reason ? `: ${reason}` : ''}`,
      ts: Date.now(),
      level: approved ? 'info' : 'warn',
    })
    broadcast(worker, { type: 'approval/decision', requestId, approved, reason: reason ?? by })
    updateWorker(record, { status: 'running', lastEventAt: Date.now() })
    return { workerId, requestId, approved }
  }

  async function workerDiff(workerId: string, maxBytes = 64 * 1024) {
    const record = workerForId(workerId)
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: config.workspaceRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 })
    const diff = spawnSync('git', ['diff', '--no-ext-diff', '--', ...record.scope], { cwd: config.workspaceRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 })
    const changed: string[] = []
    const outside: string[] = []
    if (!status.error) {
      for (const line of (status.stdout ?? '').split(/\r?\n/)) {
        if (line.length < 4) continue
        const pathText = line.slice(3).trim()
        const paths = pathText.includes(' -> ') ? pathText.split(' -> ') : [pathText]
        for (const p of paths) {
          const normalized = p.replace(/\\/g, '/').replace(/^"|"$/g, '')
          if (workerOwnsScope(record, normalized)) changed.push(normalized)
          else if (!(activeOrchestration()?.workers ?? []).some((w) => workerOwnsScope(w, normalized))) outside.push(normalized)
        }
      }
    }
    const body = diff.error ? `git diff failed: ${diff.error.message}` : diff.stdout ?? ''
    return {
      workerId,
      title: record.title,
      scope: record.scope,
      status: record.status,
      changed,
      outOfScope: outside,
      diff: body.slice(0, Math.max(1024, Math.min(maxBytes, 256 * 1024))),
      truncated: body.length > maxBytes,
    }
  }

  function onWorkerEvent(record: WorkerRecord): void {
    record.lastEventAt = Date.now()
    if (record.status === 'queued') record.status = 'running'
    const session = sessions.get(record.runId)
    if (session) session.workerStatus = record.status
  }

  function onWorkerApproval(record: WorkerRecord, requestId: string, request: ApprovalRequest): void {
    updateWorker(record, {
      status: 'blocked',
      lastEventAt: Date.now(),
      blocker: `approval required: ${request.command}`.slice(0, 500),
    })
    queueOrchestratorNotice(
      [
        '[worker approval request]',
        `worker: ${record.title} (${record.runId})`,
        `requestId: ${requestId}`,
        `command: ${request.command}`,
        ...(request.justification ? [`justification: ${request.justification}`] : []),
        userOnlyApproval(request)
          ? `This would run ${request.sandbox}: only the user can approve it (in the worker chat). You may deny it with orchestrator_approve.`
          : 'Ask the user if needed, then call orchestrator_approve.',
      ].join('\n'),
    )
  }

  function heartbeatCheck(): void {
    const active = activeOrchestration()
    if (!active) return
    const now = Date.now()
    for (const worker of active.workers) {
      if (worker.status !== 'running') continue
      if (now - worker.lastEventAt < 5 * 60_000) continue
      if (worker.lastHeartbeatAt !== undefined && now - worker.lastHeartbeatAt < 5 * 60_000) continue
      worker.lastHeartbeatAt = now
      queueOrchestratorNotice(
        [
          '[worker heartbeat]',
          `worker: ${worker.title} (${worker.runId})`,
          `status: running`,
          `last event: ${Math.round((now - worker.lastEventAt) / 60_000)} minute(s) ago`,
          `scope: ${worker.scope.join(', ')}`,
          'Check for a stall with orchestrator_workers; do not claim completion from this heartbeat.',
        ].join('\n'),
      )
    }
    persistOrchestration()
  }

  /**
   * Drops one waiting turn from a session's FIFO. The turn that is running is
   * kept: its later commit must still find it, and dropping it would lose the
   * record of work that is still in flight.
   */
  function cancelOneQueuedTurn(state: TurnQueueState, runId: string, id: string): TurnQueueState {
    if (state.running[runId] === id) return state
    const turns = (state.sessions[runId] ?? []).filter((turn) => turn.id !== id)
    const sessions = { ...state.sessions }
    if (turns.length > 0) sessions[runId] = turns
    else delete sessions[runId]
    const stillPaused = turns.length > 0 || (state.uncertain[runId] ?? []).length > 0
    const paused = stillPaused ? state.paused : state.paused.filter((pausedId) => pausedId !== runId)
    return { ...state, sessions, paused }
  }

  /**
   * Marks a queued turn as running and starts it. A refusal from `beginTurn`
   * (a paused session, a different head, an uncertain id) is returned instead
   * of thrown so an HTTP caller can answer 4xx and leave the turn queued.
   */
  function beginQueuedTurn(session: WebSession, turn: QueuedTurn): { ok: true } | { ok: false; error: string } {
    let begun: TurnQueueState
    try {
      begun = beginTurn(turnQueue, session.runId, turn.id)
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
    try {
      applyTurnQueue(begun)
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
    void runTurn(session, turn.message, turn.images, { queuedId: turn.id }).catch((error: unknown) => {
      session.busy = false
      session.controller = undefined
      session.lastError = errorMessage(error)
      // runTurn rejects before its own try block when the session turned busy
      // in between; release here so the `running` marker never sticks.
      finishQueuedTurn(session, turn.id, false)
    })
    return { ok: true }
  }

  /**
   * Forgets every reservation of a chat that no longer exists. A deleted chat
   * must not keep images and ids in the queue file, and its `running` marker
   * would otherwise never be cleared once the aborted turn reports back. The
   * completed-history window is kept: it still blocks a reused id.
   */
  function forgetQueuedSession(runId: string): void {
    const sessions = { ...turnQueue.sessions }
    delete sessions[runId]
    const running = { ...turnQueue.running }
    delete running[runId]
    const uncertain = { ...turnQueue.uncertain }
    delete uncertain[runId]
    const paused = turnQueue.paused.filter((id) => id !== runId)
    try {
      applyTurnQueue({ ...turnQueue, sessions, running, uncertain, paused })
    } catch (error) {
      console.error(`[hy] could not clear the queue of deleted run ${runId}: ${errorMessage(error)}`)
    }
  }

  /**
   * Starts the head of a session's queue when it is idle and not paused.
   * Returns the failure instead of throwing so an HTTP caller can answer 4xx;
   * a turn that could not be marked running is never executed.
   */
  function startNextQueuedTurn(session: WebSession): { ok: true } | { ok: false; error: string } {
    if (deletedRuns.has(session.runId)) return { ok: true }
    if (session.busy) return { ok: true }
    const next = peekNextTurn(turnQueue, session.runId)
    if (!next) return { ok: true }
    const started = beginQueuedTurn(session, next)
    if (!started.ok) console.error(`[hy] could not start a queued turn: ${started.error}`)
    return started
  }

  /**
   * Records the end of a turn that went through the queue.
   *
   * A completed turn is removed from the FIFO and its id remembered, then the
   * next turn starts once this call stack unwinds. A failed or cancelled one
   * is released, which clears the `running` marker and pauses the session: the
   * user decides whether to run it again. A failed save is logged and leaves
   * the queue exactly as the last successful save wrote it.
   */
  function finishQueuedTurn(session: WebSession, id: string, completed: boolean): void {
    if (deletedRuns.has(session.runId)) {
      forgetQueuedSession(session.runId)
      return
    }
    try {
      applyTurnQueue(completed ? commitTurn(turnQueue, session.runId, id) : releaseTurn(turnQueue, session.runId))
    } catch (error) {
      console.error(`[hy] could not record the end of queued turn ${id}: ${errorMessage(error)}`)
      // The save failed, but keeping the in-flight marker in memory would leave
      // the session permanently un-runnable: every start needs no running turn.
      // Releasing keeps the message queued and asks for an explicit resume; the
      // next successful save writes this state out.
      turnQueue = releaseTurn(turnQueue, session.runId)
      return
    }
    if (!completed) return
    setTimeout(() => startNextQueuedTurn(session), 0)
  }

  /**
   * A plain (non-queued) turn that failed or was cancelled must not silently
   * drain the queue that piled up behind it: the user interrupted or hit an
   * error, and the next message may no longer be wanted. The queue is paused
   * so the GUI shows Resume. A session with nothing waiting is left alone, so
   * an empty queue never grows a pause marker.
   */
  function pauseQueueAfterFailure(session: WebSession): void {
    if (deletedRuns.has(session.runId)) {
      forgetQueuedSession(session.runId)
      return
    }
    if ((turnQueue.sessions[session.runId] ?? []).length === 0) return
    try {
      applyTurnQueue(releaseTurn(turnQueue, session.runId))
    } catch (error) {
      console.error(`[hy] could not pause the queue for ${session.runId}: ${errorMessage(error)}`)
      turnQueue = releaseTurn(turnQueue, session.runId)
    }
  }
  /**
   * DSH `dsh-goal-round-driver` equivalent. Starts the next autonomous goal
   * round only when the session is idle, no user turn is queued, plan mode is
   * off, and the goal is active and armed. Every turn re-checks the durable
   * goal state, so completion, pause, blocking and a round-cap stop all win.
   */
  function scheduleGoalRound(session: WebSession): void {
    if (session.kind === 'worker' || deletedRuns.has(session.runId)) return
    if (goalTimers.has(session.runId)) return
    const timer = setTimeout(() => {
      goalTimers.delete(session.runId)
      if (session.busy || session.planMode || deletedRuns.has(session.runId)) return
      if (session.kind === 'orchestrator' && (orchestratorInbox.length > 0 || orchestratorStarting)) return
      if (peekNextTurn(turnQueue, session.runId)) return
      const conv = session.conv
      const goal = conv?.goalView()
      if (!conv || !goal || goal.phase !== 'active' || goal.activation !== 'armed') return
      if (goal.roundsStarted >= goal.maxGoalRounds) {
        try {
          conv.blockGoal('round-limit')
        } catch {
          // The state changed between the read and the write; the next check wins.
        }
        broadcast(session, { type: 'notice', text: `goal blocked: round limit (${goal.maxGoalRounds})` })
        broadcast(session, { type: 'state', state: sessionState(session) })
        return
      }
      void runTurn(session, `Goal round ${goal.roundsStarted + 1}/${goal.maxGoalRounds}`, [], {
        synthetic: true,
        source: 'goal',
      }).catch((error: unknown) => {
        session.lastError = errorMessage(error)
      })
    }, 50)
    goalTimers.set(session.runId, timer)
  }

  async function runTurn(
    session: WebSession,
    message: string,
    images: ImageInput[],
    options: {
      synthetic?: boolean
      source?: 'orchestrator' | 'worker' | 'system' | 'goal'
      from?: 'user' | 'orchestrator'
      /** Set when this turn came from the durable queue; it is committed or released at the end. */
      queuedId?: string
    } = {},
  ): Promise<void> {
    if (session.kind === 'worker' && options.from !== 'orchestrator') {
      throw new Error('worker chats are read-only; send instructions through the orchestrator')
    }
    const conv = ensureConversation(session)
    if (session.busy) throw new Error('this session is already running')
    const controller = new AbortController()
    session.controller = controller
    session.busy = true
    session.lastError = undefined
    const turn = conv.turns + 1
    session.turns = turn
    // WP-60: `@session:<id>` becomes clearly marked, untrusted context in front
    // of the user's own words (the projection strips it from the transcript).
    const withReferences = options.synthetic
      ? { message, referenced: [], missing: [] }
      : expandSessionReferences(message, (id) => digestFor(readEvents(logFile), id))
    if (withReferences.missing.length > 0) {
      broadcast(session, {
        type: 'notice',
        level: 'warn',
        text: `session reference not found: ${withReferences.missing.join(', ')}`,
      })
    }
    if (withReferences.referenced.length > 0) {
      serverLog(`session ${session.runId}: referenced ${withReferences.referenced.join(', ')}`)
    }
    const modelMessage =
      session.kind === 'orchestrator' ? withOrchestrationDigest(withReferences.message) : withReferences.message
    if (options.synthetic) {
      const entry: ChatEntry = { id: `event-${Date.now()}`, kind: 'notice', runId: session.runId, text: message, ts: Date.now() }
      session.entries.push(entry)
      broadcast(session, { type: 'entry', entry })
    } else {
      // The live card must hide the same context the projection strips, or a
      // prefixed turn would look different before and after a reload.
      const entry: ChatEntry = { id: `user-${Date.now()}`, kind: 'user', runId: session.runId, text: stripPlanPrefix(message), ts: Date.now(), ...(images.length > 0 ? { images: images.length } : {}), turn }
      session.entries.push(entry)
      broadcast(session, { type: 'entry', entry })
    }
    broadcast(session, { type: 'turn/start', turn })
    broadcast(session, { type: 'state', state: sessionState(session) })
    broadcastSessions()
    let final = ''
    try {
      final = await conv.turn(modelMessage, images, controller.signal, options.source ? { source: options.source } : undefined)
      session.planMode = conv.isPlanMode()
      broadcast(session, { type: 'turn/end', outcome: 'completed', final })
      onTurnFinished(session, 'completed', final)
      if (options.queuedId !== undefined) finishQueuedTurn(session, options.queuedId, true)
    } catch (error) {
      const aborted = controller.signal.aborted
      const text = aborted ? 'run cancelled' : errorMessage(error)
      session.lastError = text
      // A cancelled or failed goal must not auto-continue. DSH pauses the
      // durable goal on cancellation; an explicit resume re-arms it.
      if (session.conv?.goalView()?.phase === 'active') {
        try {
          session.conv.pauseGoal()
        } catch {
          // The goal changed while the turn was ending; leave it alone.
        }
      }
      broadcast(session, { type: 'turn/end', outcome: aborted ? 'aborted' : 'error', error: text })
      onTurnFinished(session, aborted ? 'aborted' : 'error', text)
      // A failed or cancelled turn pauses the session instead of retrying on
      // its own: the user decides whether to run it again.
      if (options.queuedId !== undefined) finishQueuedTurn(session, options.queuedId, false)
      else pauseQueueAfterFailure(session)
    } finally {
      resolvePending(session)
      // WP-60: close the turn's timing and persist the snapshot with the log, so
      // the numbers survive a restart (`session/stats`).
      const turnStartedAt = session.statsClock.turnStart
      const finished = finishTurn(session.stats, session.statsClock, Date.now())
      session.stats = finished.stats
      // WP-62: one turn span, then one flush (a down collector never blocks).
      if (telemetry.enabled) {
        telemetry.record({
          name: 'hy.turn',
          startMs: turnStartedAt ?? Date.now(),
          endMs: Date.now(),
          attributes: {
            'hy.run_id': session.runId,
            'hy.kind': session.kind,
            'hy.turns': finished.stats.turns,
            'hy.steps': finished.stats.steps,
            'hy.llm_ms': finished.stats.llmMs,
            'hy.tool_ms': finished.stats.toolMs,
            'hy.first_response_ms': finished.stats.firstResponseMs,
            'hy.model': `${session.model.provider}:${session.model.model}`,
            'hy.ok': session.lastError === undefined,
          },
          status: session.lastError === undefined ? 'ok' : 'error',
        })
        void telemetry.flush()
      }
      try {
        session.conv?.log.append('session/stats', finished.stats)
      } catch {
        // A read-only state directory still keeps the live numbers.
      }
      session.busy = false
      session.controller = undefined
      session.turns = conv.turns
      session.planMode = conv.isPlanMode()
      session.updatedAt = Date.now()
      // WP-21: a steer that arrived after the last step boundary is in the log
      // and in the history, but the model never acted on it in this turn.
      const late = conv.takeUndeliveredSteers()
      if (late.length > 0) {
        broadcast(session, {
          type: 'notice',
          level: 'warn',
          text: `steering message arrived after the last step (${late.length}); it will be answered in the next turn`,
        })
      }
      broadcast(session, { type: 'state', state: sessionState(session) })
      broadcastSessions()
      if (session.kind === 'orchestrator') {
        setTimeout(() => {
          flushOrchestratorInbox()
          scheduleGoalRound(session)
        }, 0)
      } else if (session.kind !== 'worker') {
        scheduleGoalRound(session)
      }
      // A normal (non-queued) turn can hand over to the residue of a queue
      // that was filled while it ran. A queued turn schedules its own handover
      // in finishQueuedTurn, and a released one stays paused on purpose.
      if (options.queuedId === undefined) setTimeout(() => startNextQueuedTurn(session), 0)
    }
  }

  const validateTarget = (body: Record<string, unknown>, existing?: AutomationSchedule | AutomationWebhook) => {
    const cwd = path.resolve(typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd : existing?.cwd ?? config.workspaceRoot)
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`workspace does not exist: ${cwd}`)
    const objective = typeof body.objective === 'string' ? body.objective.trim() : existing?.objective ?? ''
    if (!objective) throw new Error('objective is required')
    const cron = typeof body.cron === 'string' ? body.cron.trim() : existing && 'cron' in existing ? existing.cron : ''
    if (cron && !parseCron(cron)) throw new Error(`invalid cron expression: ${cron}`)
    const rawCmds = Array.isArray(body.verifyCmds)
      ? body.verifyCmds
      : typeof body.verifyCmd === 'string'
        ? [body.verifyCmd]
        : existing?.verifyCmds ?? []
    const verifyCmds = rawCmds.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
    return {
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing?.name ?? 'Automation',
      cwd,
      objective,
      cron,
      verifyCmds,
      autoApprove: typeof body.autoApprove === 'boolean' ? body.autoApprove : existing?.autoApprove ?? false,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : existing?.enabled ?? true,
    }
  }

  /**
   * Settings → Models/Effort and the other runtime options apply without
   * restarting the server or the exec client. The sandbox is fixed when the
   * exec client starts, so only that change still requires a restart.
   */
  const applyRuntimeSettings = async (): Promise<{ hot: boolean; sandboxPending: boolean }> => {
    try {
      const fresh = loadConfig(options.overrides)
      const sandboxPending = fresh.sandbox !== config.sandbox
      config.role = fresh.role
      config.graderRole = fresh.graderRole
      config.orchestratorRole = fresh.orchestratorRole
      config.subagentRole = fresh.subagentRole
      if (fresh.guardianRole === undefined) delete config.guardianRole
      else config.guardianRole = fresh.guardianRole
      config.compactorRole = fresh.compactorRole
      config.summarizerRole = fresh.summarizerRole
      config.guardianApproveBelow = fresh.guardianApproveBelow
      config.autoApprove = fresh.autoApprove
      config.fullAuto = fresh.fullAuto
      config.ptc = fresh.ptc
      config.mcpServers = fresh.mcpServers
      config.hooks = fresh.hooks
      config.plugins = fresh.plugins
      config.memory = fresh.memory
      if (fresh.web === undefined) delete config.web
      else config.web = fresh.web
      try {
        // Reuse the existing plugin/MCP managers; they compare the new keys
        // and only restart what actually changed.
        await startServices(config)
      } catch (error) {
        console.error(`[hy] settings services reload failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      for (const session of sessions.values()) {
        // An idle conversation rebuilds its tools, approvals and MCP catalog
        // on the next turn; a running turn keeps its current agent.
        if (!session.busy) {
          delete session.conv
          const role = session.kind === 'orchestrator' ? config.orchestratorRole : config.role
          session.effort = role.effort
          session.model = { provider: role.provider, model: role.model }
        }
        broadcast(session, { type: 'state', state: sessionState(session) })
      }
      return { hot: true, sandboxPending }
    } catch (error) {
      console.error(`[hy] settings reload failed: ${error instanceof Error ? error.message : String(error)}`)
      return { hot: false, sandboxPending: false }
    }
  }

  const refreshWorkspaceRoots = (extras: ReturnType<typeof configuredExtraRoots>): void => {
    config.workspaceRoots = workspaceRootsFor(config.workspaceRoot, extras)
    for (const session of sessions.values()) {
      if (session.busy) continue
      delete session.conv
      const role = session.kind === 'orchestrator' ? config.orchestratorRole : config.role
      session.model = { provider: role.provider, model: role.model }
      broadcast(session, { type: 'state', state: sessionState(session) })
    }
  }

  const requestHandler: http.RequestListener = (req, res) => {
    void (async () => {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src http: https:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
      // Host/Origin fence (WP-10): a browser that reaches the deployment under
      // an authority the operator did not name gets 403 for every route, even
      // with a correct launch token, so a leaked URL cannot be replayed from a
      // different host name.
      const requestHost = req.headers.host
      if (!fence.allows(requestHost)) {
        json(res, 403, { error: `host not accepted: ${String(requestHost ?? '(none)')}` })
        return
      }
      if (!fence.allowsOrigin(req.headers.origin)) {
        json(res, 403, { error: `origin not accepted: ${String(req.headers.origin ?? '(none)')}` })
        return
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      let pathname: string
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        json(res, 400, { error: 'invalid path' })
        return
      }
      const method = req.method ?? 'GET'
      // WP-43: the API contract is checked once per request, so a body of the
      // wrong shape is a typed 400 instead of a 500 deeper in the handler.
      const contractRoute = matchContract(method, pathname)
      const readBody = async (): Promise<Record<string, unknown>> => {
        const body = await readJson(req)
        if (!contractRoute) return body
        const problems = validateRequest(contractRoute, body)
        if (problems.length > 0) throw new HttpError(400, `invalid request: ${problems.join('; ')}`)
        return body
      }
      const authorized = (): boolean => {
        const cookies = parseCookies(req.headers.cookie)
        if (sameSecret(cookies.hy_web_token, token)) return true
        const bearer = req.headers.authorization
        return bearer?.startsWith('Bearer ') === true && sameSecret(bearer.slice(7), token)
      }
      const requireAuth = (): boolean => {
        if (authorized()) return true
        json(res, 401, { error: 'unauthorized: open the URL printed by hy web / the desktop app' })
        return false
      }

      // Launch URL: exchange the token for an HttpOnly same-site cookie.
      if (method === 'GET' && pathname === '/' && url.searchParams.has('token')) {
        if (!sameSecret(url.searchParams.get('token'), token)) {
          text(res, 403, 'invalid or expired launch token')
          return
        }
        res.statusCode = 302
        res.setHeader('Set-Cookie', `hy_web_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}; Max-Age=31536000`)
        res.setHeader('Location', '/')
        res.end()
        return
      }

      // Authenticated webhooks are not browser sessions: the per-webhook secret
      // is the credential. They are still loopback-only by default.
      const webhookPath = /^\/api\/webhooks\/([^/]+)$/.exec(pathname)
      if (webhookPath && method === 'POST') {
        const target = automation.webhooks.find((w) => w.id === webhookPath[1])
        if (!target || !target.enabled) {
          json(res, 404, { error: 'unknown or disabled webhook' })
          return
        }
        const provided = Buffer.from(String(req.headers['x-hy-webhook-secret'] ?? ''))
        const expected = Buffer.from(target.secret)
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
          json(res, 401, { error: 'invalid webhook secret' })
          return
        }
        try {
          const body = await readBody()
          const payload = JSON.stringify(body).slice(0, 4000)
          const objective = `${typeof body.objective === 'string' ? body.objective : target.objective}\n\n<webhook_payload>\n${payload}\n</webhook_payload>`
          const run = startAutomationRun('webhook', target, { objective })
          json(res, 202, { accepted: true, runId: run.id })
        } catch (error) {
          json(res, 409, { error: errorMessage(error) })
        }
        return
      }

      if (pathname.startsWith('/api/')) {
        if (!requireAuth()) return

        if (pathname === '/api/metrics' && method === 'GET') {
          json(res, 200, metricsSnapshot({ uptimeSeconds: process.uptime(), sessions: sessions.size, rssBytes: process.memoryUsage().rss }))
          return
        }
        // CP-31: the import wizard. GET shows the plan (with diffs); POST writes
        // the kinds the user ticked, recomputing the plan so it matches disk.
        if (pathname === '/api/import' && method === 'GET') {
          const source = url.searchParams.get('source')
          if (source !== 'claude' && source !== 'dsh') {
            json(res, 400, { error: 'source must be claude or dsh' })
            return
          }
          const items = planImport(source, { workspaceRoot: config.workspaceRoot, stateDir: config.stateDir, userConfigDir: userConfigDir() })
          json(res, 200, { source, items: importPlanView(items) })
          return
        }
        if (pathname === '/api/import' && method === 'POST') {
          const body = await readBody()
          const source = body.source
          if (source !== 'claude' && source !== 'dsh') {
            json(res, 400, { error: 'source must be claude or dsh' })
            return
          }
          const kinds = Array.isArray(body.kinds) ? new Set(body.kinds.filter((k): k is ImportKind => typeof k === 'string') as ImportKind[]) : undefined
          const items = planImport(source, { workspaceRoot: config.workspaceRoot, stateDir: config.stateDir, userConfigDir: userConfigDir() })
          const result = applyImport(items, kinds)
          broadcastSessions()
          json(res, result.failed.length > 0 ? 207 : 200, result)
          return
        }

        // CP-36: GUI preferences, kept in ui-state.json across restarts.
        if (pathname === '/api/ui-prefs' && method === 'GET') {
          json(res, 200, { prefs: normalizePrefs(uiState.prefs) })
          return
        }
        if (pathname === '/api/ui-prefs' && method === 'PUT') {
          const body = await readBody()
          // A partial update keeps the fields it does not name.
          const prefs = normalizePrefs({ ...normalizePrefs(uiState.prefs), ...body })
          uiState.prefs = prefs
          saveUiState()
          json(res, 200, { prefs })
          return
        }

        // CP-35: git worktrees from the GUI (the same manager as `hy worktree`).
        if (pathname === '/api/worktrees' && method === 'GET') {
          const manager = new WorktreeManager(config.workspaceRoot, config.stateDir)
          if (!manager.isRepo()) {
            json(res, 200, { repo: false, dir: worktreesDir(config.stateDir), worktrees: [] })
            return
          }
          const dir = worktreesDir(config.stateDir)
          const own = (p: string) => path.resolve(p).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep)
          json(res, 200, { repo: true, dir, worktrees: manager.list().filter((w) => own(w.path)) })
          return
        }
        if (
          (pathname === '/api/worktrees' && method === 'POST') ||
          (pathname === '/api/worktrees/apply' && method === 'POST') ||
          (pathname === '/api/worktrees/remove' && method === 'POST')
        ) {
          const body = await readBody()
          const name = typeof body.name === 'string' ? body.name.trim() : ''
          if (!name) {
            json(res, 400, { error: 'name is required' })
            return
          }
          const manager = new WorktreeManager(config.workspaceRoot, config.stateDir)
          try {
            if (pathname === '/api/worktrees') {
              json(res, 201, manager.create(name, typeof body.base === 'string' && body.base.trim() ? { base: body.base.trim() } : {}))
            } else if (pathname === '/api/worktrees/apply') {
              const result = manager.apply(name, { threeWay: body.threeWay !== false })
              json(res, result.conflicts.length > 0 ? 409 : 200, result)
            } else {
              manager.remove(name, { force: body.force === true })
              json(res, 200, { removed: name })
            }
          } catch (error) {
            json(res, 400, { error: errorMessage(error) })
          }
          return
        }

        // CP-32: `/hooks` and `/doctor` in the GUI.
        if (pathname === '/api/hooks' && method === 'GET') {
          json(res, 200, { hooks: describeHooks(config.hooks) })
          return
        }
        if (pathname === '/api/doctor' && method === 'GET') {
          let doctorSandboxInput: Parameters<typeof buildDoctorReport>[0]['sandbox']
          try {
            doctorSandboxInput = doctorSandbox(await client.sandboxStatus())
          } catch (error) {
            doctorSandboxInput = { enforcement: 'unknown', available: false, error: errorMessage(error) }
          }
          const secretBin = findSecretBinary()
          json(
            res,
            200,
            buildDoctorReport({
              version: HARNESS_VERSION,
              node: process.version,
              platform: `${process.platform} ${process.arch}`,
              workspace: config.workspaceRoot,
              config,
              execServerPath: options.execServer ?? resolveServerPath(),
              sandbox: doctorSandboxInput,
              mcpServers: Object.keys(config.mcpServers),
              ...(secretBin ? { secretBin } : {}),
            }),
          )
          return
        }
        if (pathname === '/api/health' && method === 'GET') {
          json(res, 200, { ok: true, version: 1, apiVersion: API_VERSION, desktop: options.desktop === true })
          return
        }

        // Turn queue: the durable reservations the composer collects while a
        // turn is running. Every mutation is saved before it becomes current,
        // and each response is the whole view so the GUI never merges.
        if (pathname === '/api/turn-queue' && method === 'GET') {
          const parsed = parseRunIdRequest({ runId: url.searchParams.get('runId') ?? undefined })
          if (!parsed.ok) {
            json(res, parsed.status, { error: parsed.error })
            return
          }
          json(res, 200, turnQueueView(turnQueue, parsed.runId))
          return
        }

        if (pathname === '/api/turn-queue' && method === 'POST') {
          const parsed = parseEnqueueRequest(await readBody())
          if (!parsed.ok) {
            json(res, parsed.status, { error: parsed.error })
            return
          }
          // An unknown run would leave a reservation that can never run, and
          // the same read-only rule as a live send applies to a worker chat:
          // it is driven by the orchestrator, so a user turn would never start.
          const queueTarget = ensureSession(parsed.request.runId)
          if (!queueTarget) {
            json(res, 404, { error: `unknown run ${parsed.request.runId}` })
            return
          }
          if (queueTarget.kind === 'worker') {
            json(res, 403, { error: 'worker chats are read-only; send instructions through the orchestrator' })
            return
          }
          const enqueued = enqueueTurn(turnQueue, parsed.request.runId, parsed.request.turn)
          if (!enqueued.ok) {
            json(res, 409, { error: enqueued.error })
            return
          }
          try {
            applyTurnQueue(enqueued.state)
          } catch (error) {
            // The turn was not saved, so the caller must not think it is queued.
            json(res, 413, { error: errorMessage(error) })
            return
          }
          // A send can race with the end of the running turn; starting here
          // only happens when the session is idle, never while it is busy.
          startNextQueuedTurn(queueTarget)
          json(res, 200, turnQueueView(turnQueue, parsed.request.runId))
          return
        }

        if (pathname === '/api/turn-queue/cancel' && method === 'POST') {
          const parsed = parseCancelRequest(await readBody())
          if (!parsed.ok) {
            json(res, parsed.status, { error: parsed.error })
            return
          }
          try {
            applyTurnQueue(
              parsed.id === undefined
                ? clearQueuedTurns(turnQueue, parsed.runId)
                : cancelOneQueuedTurn(turnQueue, parsed.runId, parsed.id),
            )
          } catch (error) {
            json(res, 413, { error: errorMessage(error) })
            return
          }
          json(res, 200, turnQueueView(turnQueue, parsed.runId))
          return
        }

        if (pathname === '/api/turn-queue/resume' && method === 'POST') {
          const parsed = parseRunIdRequest(await readBody())
          if (!parsed.ok) {
            json(res, parsed.status, { error: parsed.error })
            return
          }
          try {
            applyTurnQueue(resumeSession(turnQueue, parsed.runId))
          } catch (error) {
            json(res, 413, { error: errorMessage(error) })
            return
          }
          // Resuming is the explicit user action that starts the waiting turn;
          // nothing resumes a paused queue on its own. A turn that cannot be
          // marked running is reported instead of being executed anyway.
          const resumedSession = ensureSession(parsed.runId)
          if (resumedSession) {
            const started = startNextQueuedTurn(resumedSession)
            if (!started.ok) {
              json(res, 409, { error: started.error })
              return
            }
          }
          json(res, 200, turnQueueView(turnQueue, parsed.runId))
          return
        }

        if (pathname === '/api/turn-queue/resolve' && method === 'POST') {
          const parsed = parseResolveRequest(await readBody())
          if (!parsed.ok) {
            json(res, parsed.status, { error: parsed.error })
            return
          }
          try {
            applyTurnQueue(resolveUncertain(turnQueue, parsed.runId, parsed.id, parsed.decision))
          } catch (error) {
            json(res, 409, { error: errorMessage(error) })
            return
          }
          // `resend` is the user asking for the turn to run; an uncertain id
          // that is still unresolved keeps the session paused, so peek returns
          // nothing and this is a no-op in that case.
          const resolvedSession = ensureSession(parsed.runId)
          if (resolvedSession) startNextQueuedTurn(resolvedSession)
          json(res, 200, turnQueueView(turnQueue, parsed.runId))
          return
        }
        if (pathname === '/api/bootstrap' && method === 'GET') {
          const events = readEvents(logFile)
          json(res, 200, {
            version: HARNESS_VERSION,
            // Which build this is (commit, build time), so two local builds of
            // the same version can be told apart in the sidebar.
            build: buildInfo(),
            desktop: options.desktop === true,
            web: {
              tls: secure,
              publicUrl: publicUrl ?? null,
              trustedHosts: [...(options.trustedHosts ?? [])],
            },
            onboarding: onboardingView(config, readOnboarding(config.stateDir)),
            workspace: {
              root: config.workspaceRoot,
              name: path.basename(config.workspaceRoot),
              stateDir: config.stateDir,
              roots: config.workspaceRoots.map((root) => ({
                id: root.id,
                path: root.path,
                label: root.label ?? path.basename(root.path),
                writable: root.writable === true,
              })),
            },
            config: configSummary(config),
            sessions: sessionSummary(config, events, sessions, uiState, orchestration, deletedRuns),
            orchestration: orchestrationView(),
            sandbox,
            capabilities: sandbox,
          })
          return
        }

        if (pathname === '/api/orchestration' && method === 'GET') {
          json(res, 200, {
            orchestration: orchestrationView(),
            workers: orchestration.active?.workers.map(workerCard) ?? [],
          })
          return
        }

        if (pathname === '/api/orchestration/start' && method === 'POST') {
          try {
            const record = await startOrchestration()
            const session = ensureSession(record.orchestratorRunId)
            json(res, 201, { runId: record.orchestratorRunId, orchestration: orchestrationView(), state: session ? sessionState(session) : undefined })
          } catch (error) {
            json(res, 409, { error: errorMessage(error) })
          }
          return
        }

        if (pathname === '/api/orchestration/stop' && method === 'POST') {
          try {
            const record = await stopOrchestration()
            json(res, 200, { orchestration: orchestrationView(), stopped: record !== null })
          } catch (error) {
            json(res, 409, { error: errorMessage(error) })
          }
          return
        }

        const orchestrationWorkerMatch = /^\/api\/orchestration\/workers\/([^/]+)\/(stop|close)$/.exec(pathname)
        if (orchestrationWorkerMatch && method === 'POST') {
          const workerId = orchestrationWorkerMatch[1]!
          try {
            const result = orchestrationWorkerMatch[2] === 'stop' ? await stopWorker(workerId, 'stopped from the panel') : await closeWorker(workerId)
            json(res, 200, { worker: result, orchestration: orchestrationView() })
          } catch (error) {
            json(res, 409, { error: errorMessage(error) })
          }
          return
        }

        if (pathname === '/api/automation' && method === 'GET') {
          json(res, 200, {
            schedules: automation.schedules.map((s) => ({ ...s, nextRun: nextCronTime(s.cron)?.toISOString() })),
            webhooks: automation.webhooks.map((w) => ({ ...w, endpoint: `/api/webhooks/${w.id}` })),
            runs: [...automationRuns.values()].slice(-20).map((r) => ({ ...r, output: r.output.slice(-200) })),
            active: [...activeAutomationTargets],
          })
          return
        }

        if (pathname === '/api/automation/schedules' && method === 'POST') {
          try {
            const fields = validateTarget(await readBody())
            if (!fields.cron) throw new Error('cron is required')
            const schedule: AutomationSchedule = {
              ...fields,
              id: `sch-${randomBytes(5).toString('hex')}`,
              createdAt: Date.now(),
            }
            automation.schedules.push(schedule)
            saveAutomation()
            json(res, 201, schedule)
          } catch (error) {
            json(res, 400, { error: errorMessage(error) })
          }
          return
        }

        if (pathname === '/api/automation/webhooks' && method === 'POST') {
          try {
            const fields = validateTarget(await readBody())
            const webhook: AutomationWebhook = {
              ...fields,
              id: `wh-${randomBytes(5).toString('hex')}`,
              secret: `whsec-${randomBytes(18).toString('hex')}`,
              createdAt: Date.now(),
            }
            automation.webhooks.push(webhook)
            saveAutomation()
            json(res, 201, { ...webhook, endpoint: `/api/webhooks/${webhook.id}` })
          } catch (error) {
            json(res, 400, { error: errorMessage(error) })
          }
          return
        }

        const automationMatch = /^\/api\/automation\/(schedules|webhooks)\/([^/]+)(?:\/(run|enabled))?$/.exec(pathname)
        if (automationMatch) {
          const kind = automationMatch[1] === 'schedules' ? 'schedules' : 'webhooks'
          const id = automationMatch[2]!
          const action = automationMatch[3]
          const list: Array<AutomationSchedule | AutomationWebhook> = kind === 'schedules' ? automation.schedules : automation.webhooks
          const target = list.find((t) => t.id === id)
          if (!target) {
            json(res, 404, { error: 'unknown automation target' })
            return
          }
          if (method === 'DELETE') {
            const index = list.findIndex((t) => t.id === id)
            list.splice(index, 1)
            saveAutomation()
            json(res, 200, { deleted: id })
            return
          }
          if (method === 'PUT') {
            try {
              const fields = validateTarget(await readBody(), target)
              if (kind === 'schedules' && !fields.cron) throw new Error('cron is required')
              Object.assign(target, fields)
              saveAutomation()
              json(res, 200, target)
            } catch (error) {
              json(res, 400, { error: errorMessage(error) })
            }
            return
          }
          if (action === 'enabled' && method === 'POST') {
            const body = await readBody()
            target.enabled = body.enabled === true
            saveAutomation()
            json(res, 200, target)
            return
          }
          if (action === 'run' && method === 'POST') {
            try {
              const run = startAutomationRun('manual', target)
              json(res, 202, run)
            } catch (error) {
              json(res, 409, { error: errorMessage(error) })
            }
            return
          }
          json(res, 405, { error: 'method not allowed' })
          return
        }

        const automationRunMatch = /^\/api\/automation\/runs\/([^/]+)$/.exec(pathname)
        if (automationRunMatch && method === 'GET') {
          const id = automationRunMatch[1]!
          const run = automationRuns.get(id) ?? automation.runs.find((r) => r.id === id)
          if (!run) {
            json(res, 404, { error: 'unknown automation run' })
            return
          }
          json(res, 200, { ...run, output: run.output.slice(-200) })
          return
        }

        if (pathname === '/api/plugins' && method === 'GET') {
          json(res, 200, pluginCatalog(config))
          return
        }

        if (pathname === '/api/plugins/reload' && method === 'POST') {
          await reloadPlugins(config)
          json(res, 200, { ...pluginCatalog(config), note: 'New sessions use the reloaded tools; existing conversations keep their loaded plugin map.' })
          return
        }

        if (pathname === '/api/sessions' && method === 'GET') {
          const search = (url.searchParams.get('search') ?? '').toLowerCase()
          const events = readEvents(logFile)
          let runs = sessionSummary(config, events, sessions, uiState, orchestration, deletedRuns)
          if (search) {
            const hits = new Set(
              events
                .filter((e) => (e.type === 'user/message' || e.type === 'assistant/message') && e.runId)
                .filter((e) => String((e.payload as { content?: unknown }).content ?? '').toLowerCase().includes(search))
                .map((e) => e.runId!.split('.sub')[0]),
            )
            runs = runs.filter((r) => hits.has(r.runId))
          }
          if (url.searchParams.get('archived') !== '1') runs = runs.filter((r) => !r.archived)
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100)))
          json(res, 200, { sessions: runs.slice(0, limit) })
          return
        }

        // WP-32: full-text search across this state dir's session log.
        // WP-41: the built-in model catalog plus the roles this server uses.
        if (pathname === '/api/models' && method === 'GET') {
          const roles: Record<string, { provider: string; model: string }> = {
            worker: { provider: config.role.provider, model: config.role.model },
            orchestrator: { provider: config.orchestratorRole.provider, model: config.orchestratorRole.model },
            subagent: { provider: config.subagentRole.provider, model: config.subagentRole.model },
            grader: { provider: config.graderRole.provider, model: config.graderRole.model },
            compactor: { provider: config.compactorRole.provider, model: config.compactorRole.model },
            summarizer: { provider: config.summarizerRole.provider, model: config.summarizerRole.model },
          }
          json(res, 200, { models: MODEL_CATALOG, roles })
          return
        }
        if (pathname === '/api/onboarding' && method === 'GET') {
          json(res, 200, { onboarding: onboardingView(config, readOnboarding(config.stateDir)) })
          return
        }

        // WP-53: the first-run wizard. It writes `<stateDir>/onboarding.json` and
        // applies the choices to this process (and to live chats) right away, so
        // the user does not have to restart before the model takes effect.
        if (pathname === '/api/onboarding/complete' && method === 'POST') {
          const body = await readBody()
          let state
          try {
            state = writeOnboarding(config.stateDir, {
              complete: body.complete === true || body.skip === true,
              ...(body.skip === true ? { skip: true } : {}),
              ...(typeof body.sandbox === 'string' ? { sandbox: body.sandbox } : {}),
              ...(typeof body.provider === 'string' ? { provider: body.provider } : {}),
              ...(typeof body.model === 'string' ? { model: body.model } : {}),
              ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
              workspace: config.workspaceRoot,
            })
          } catch (error) {
            json(res, error instanceof OnboardingError ? 400 : 500, { error: errorMessage(error) })
            return
          }
          // `applyOnboardingDefaults` reads the file again, so one code path owns
          // the "flags win / catalog limits / provider defaults" rules.
          const applied = applyOnboardingDefaults(config, {}).applied
          for (const session of sessions.values()) {
            if (session.kind === 'worker') continue
            if (state.sandbox !== undefined && config.sandbox === state.sandbox) session.sandboxMode = state.sandbox
            if (state.model !== undefined && session.conv) {
              const { user } = readUserConfigFile()
              const limits = modelProfileLimits(user, session.conv.currentModel().provider, state.model)
              session.conv.setModel(state.model, limits)
              session.model = session.conv.currentModel()
            }
            broadcast(session, { type: 'state', state: sessionState(session) })
          }
          json(res, 200, { onboarding: onboardingView(config, state), applied })
          return
        }

        // WP-53: an explicit release check. Nothing here runs unless asked.
        if (pathname === '/api/update' && method === 'GET') {
          const target = updateTarget(url.searchParams.get('feed'), url.searchParams.get('channel'))
          const base = { currentVersion: HARNESS_VERSION, channel: target.channel, feed: target.feed ?? null }
          if (!target.feed || !target.keySource) {
            json(res, 200, {
              ...base,
              configured: false,
              release: null,
              reason: 'not-configured',
              hint: 'set update.feed and update.publicKey in config.json, or run `hy update keygen`',
            })
            return
          }
          try {
            const parsed = await loadFeed(target.feed, readPublicKey(target.keySource))
            const selection = pickRelease(parsed, HARNESS_VERSION, { channel: target.channel })
            json(res, 200, {
              ...base,
              configured: true,
              release: selection.release ?? null,
              reason: selection.reason ?? 'available',
            })
          } catch (error) {
            json(res, 502, { ...base, configured: true, release: null, error: errorMessage(error) })
          }
          return
        }

        if (pathname === '/api/update/fetch' && method === 'POST') {
          const body = await readBody()
          const target = updateTarget(
            typeof body.feed === 'string' ? body.feed : null,
            typeof body.channel === 'string' ? body.channel : null,
          )
          if (!target.feed || !target.keySource) {
            json(res, 409, { error: 'no release feed is configured (update.feed / update.publicKey)' })
            return
          }
          try {
            const parsed = await loadFeed(target.feed, readPublicKey(target.keySource))
            const selection = pickRelease(parsed, HARNESS_VERSION, { channel: target.channel })
            if (!selection.release) {
              json(res, 409, { error: `nothing to install (${selection.reason ?? 'up to date'})` })
              return
            }
            const result = await downloadRelease(selection.release, updateDownloadDir(config.stateDir))
            json(res, 200, { ...result, version: selection.release.version, mandatory: selection.release.mandatory === true })
          } catch (error) {
            json(res, error instanceof UpdateFeedError ? 502 : 500, { error: errorMessage(error) })
          }
          return
        }

        if (pathname === '/api/search' && method === 'GET') {
          const query = (url.searchParams.get('q') ?? '').trim()
          if (!query) {
            json(res, 400, { error: 'q is required' })
            return
          }
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)))
          const cwd = url.searchParams.get('cwd') ?? undefined
          try {
            const index = SessionIndex.open(config.stateDir, config.workspaceRoot)
            try {
              index.sync(logFile)
              json(res, 200, {
                query,
                hits: index.search(query, { limit, ...(cwd ? { cwd } : {}) }),
                status: index.status(),
              })
            } finally {
              index.close()
            }
          } catch (error) {
            json(res, 500, { error: errorMessage(error) })
          }
          return
        }

        if (pathname === '/api/sessions' && method === 'POST') {
          const session = newSession()
          json(res, 201, { runId: session.runId, state: sessionState(session) })
          return
        }

        if (pathname === '/api/ralph' && method === 'POST') {
          const job = startRalphJob(await readBody())
          json(res, 201, { id: job.id, status: job.status, objective: job.objective })
          return
        }

        const ralphMatch = /^\/api\/ralph\/([^/]+)(?:\/(cancel))?$/.exec(pathname)
        if (ralphMatch) {
          const job = ralphJobs.get(ralphMatch[1]!)
          if (!job) {
            json(res, 404, { error: 'unknown ralph job' })
            return
          }
          if (ralphMatch[2] === 'cancel' && method === 'POST') {
            job.status = 'cancelled'
            job.ended = Date.now()
            job.child?.kill()
            json(res, 200, { id: job.id, status: job.status })
            return
          }
          if (method === 'GET') {
            json(res, 200, {
              id: job.id,
              status: job.status,
              objective: job.objective,
              ...(job.runId !== undefined ? { runId: job.runId } : {}),
              output: job.output.join('\n'),
              started: job.started,
              ...(job.ended !== undefined ? { ended: job.ended } : {}),
            })
            return
          }
        }

        if (pathname === '/api/events' && method === 'GET') {
          sseHeaders(res)
          globalSubscribers.add(res)
          sseWrite(res, 'sessions', { type: 'sessions', sessions: sessionSummary(config, readEvents(logFile), sessions, uiState, orchestration, deletedRuns) })
          sseWrite(res, 'orchestration', { type: 'orchestration', orchestration: orchestrationView() })
          const keepalive = setInterval(() => {
            try {
              res.write(': keepalive\n\n')
            } catch {
              clearInterval(keepalive)
            }
          }, 15_000)
          req.on('close', () => {
            clearInterval(keepalive)
            globalSubscribers.delete(res)
          })
          return
        }

        const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(.*))?$/.exec(pathname)
        if (sessionMatch) {
          const runId = sessionMatch[1]!
          const sub = sessionMatch[2] ?? ''
          const session = ensureSession(runId)
          if (!session) {
            json(res, 404, { error: `unknown run ${runId}` })
            return
          }

          if (sub === '' && method === 'GET') {
            json(res, 200, { runId, entries: session.entries, state: sessionState(session) })
            return
          }

          if (sub === '' && method === 'DELETE') {
            if (session.kind !== 'chat') {
              json(res, 409, { error: 'orchestrator and worker chats are managed by orchestration; stop orchestration or archive the chat instead' })
              return
            }
            session.controller?.abort()
            resolvePending(session)
            session.pty?.dispose()
            for (const sse of session.ptySubscribers ?? []) {
              try {
                sse.end()
              } catch {
                // already closed
              }
            }
            session.ptySubscribers?.clear()
            for (const sse of session.subscribers) {
              try {
                sse.end()
              } catch {
                // already closed
              }
            }
            session.subscribers.clear()
            void session.conv?.end()
            deletedRuns.add(runId)
            sessions.delete(runId)
            uiState.pinned = uiState.pinned.filter((id) => id !== runId)
            uiState.archived = uiState.archived.filter((id) => id !== runId)
            delete uiState.titles[runId]
            uiState.deleted = [...new Set([...uiState.deleted, runId])].slice(-200)
            saveUiState()
            dropRunFromLog(runId)
            forgetQueuedSession(runId)
            broadcastSessions()
            if (session.busy) cleanUpDeletedRun(runId, session)
            json(res, 200, { deleted: true, runId })
            return
          }

          if (sub === 'pty' && method === 'GET') {
            json(
              res,
              200,
              session.pty?.status() ?? {
                running: false,
                shell: '',
                cwd: config.workspaceRoot,
                cols: 120,
                rows: 30,
                output: '',
              },
            )
            return
          }

          if (sub === 'pty/start' && method === 'POST') {
            const body = await readBody()
            const cols = typeof body.cols === 'number' ? body.cols : undefined
            const rows = typeof body.rows === 'number' ? body.rows : undefined
            session.pty ??= new PersistentPty(config.workspaceRoot)
            try {
              json(res, 200, session.pty.start({ cols, rows }))
            } catch (error) {
              json(res, 500, { error: errorMessage(error) })
            }
            return
          }

          if (sub === 'pty/input' && method === 'POST') {
            const pty = session.pty
            if (!pty) {
              json(res, 409, { error: 'the persistent shell is not running' })
              return
            }
            const body = await readBody()
            const data = typeof body.data === 'string' ? body.data : ''
            try {
              pty.write(data)
              json(res, 200, { ok: true })
            } catch (error) {
              json(res, 409, { error: errorMessage(error) })
            }
            return
          }

          if (sub === 'pty/resize' && method === 'POST') {
            const pty = session.pty
            if (!pty) {
              json(res, 409, { error: 'the persistent shell is not running' })
              return
            }
            const body = await readBody()
            const cols = typeof body.cols === 'number' ? body.cols : undefined
            const rows = typeof body.rows === 'number' ? body.rows : undefined
            json(res, 200, pty.resize(cols, rows))
            return
          }

          if (sub === 'pty/clear' && method === 'POST') {
            const pty = session.pty
            if (!pty) {
              json(res, 409, { error: 'the persistent shell is not running' })
              return
            }
            json(res, 200, pty.clear())
            return
          }

          if (sub === 'pty/stop' && method === 'POST') {
            json(res, 200, session.pty?.stop() ?? { running: false })
            return
          }

          if (sub === 'pty/events' && method === 'GET') {
            const pty = session.pty
            if (!pty) {
              json(res, 409, { error: 'start the persistent shell first' })
              return
            }
            sseHeaders(res)
            const subscribers = (session.ptySubscribers ??= new Set())
            subscribers.add(res)
            sseWrite(res, 'pty', { type: 'snapshot', status: pty.status() })
            const unsubscribe = pty.onEvent((event) => {
              try {
                sseWrite(res, 'pty', event)
              } catch {
                // The browser went away; req close removes the listener.
              }
            })
            const keepalive = setInterval(() => {
              try {
                res.write(': keepalive\n\n')
              } catch {
                clearInterval(keepalive)
              }
            }, 15_000)
            req.on('close', () => {
              clearInterval(keepalive)
              subscribers.delete(res)
              unsubscribe()
            })
            return
          }

          if (sub === 'events' && method === 'GET') {
            sseHeaders(res)
            session.subscribers.add(res)
            sseWrite(res, 'snapshot', { runId, entries: session.entries, state: sessionState(session) })
            const keepalive = setInterval(() => {
              try {
                res.write(': keepalive\n\n')
              } catch {
                clearInterval(keepalive)
              }
            }, 15_000)
            req.on('close', () => {
              clearInterval(keepalive)
              session.subscribers.delete(res)
            })
            return
          }

          if (sub === 'turn' && method === 'POST') {
            if (session.kind === 'worker') {
              json(res, 403, { error: 'worker chats are read-only; send instructions through the orchestrator' })
              return
            }
            if (session.busy) {
              // A running turn answers 409 as before, unless the client asked
              // to reserve the message with `queue: true`. The body is read
              // only to see that flag, and an unparsable body keeps the
              // historical 409 instead of turning into a 500.
              let queuedBody: Record<string, unknown>
              try {
                queuedBody = await readBody()
              } catch {
                json(res, 409, { error: 'this session is already running' })
                return
              }
              if (queuedBody.queue !== true) {
                json(res, 409, { error: 'this session is already running' })
                return
              }
              // This path has no client id, so the server mints one: it is the
              // cancel and de-duplication key the queue view exposes.
              const parsed = parseEnqueueRequest({
                runId,
                id:
                  typeof queuedBody.id === 'string' && queuedBody.id.trim()
                    ? queuedBody.id
                    : `queued-${randomBytes(16).toString('hex')}`,
                message: queuedBody.message,
                images: queuedBody.images,
              })
              if (!parsed.ok) {
                json(res, parsed.status, { error: parsed.error })
                return
              }
              const enqueued = enqueueTurn(turnQueue, parsed.request.runId, parsed.request.turn)
              if (!enqueued.ok) {
                json(res, 409, { error: enqueued.error })
                return
              }
              try {
                applyTurnQueue(enqueued.state)
              } catch (error) {
                json(res, 413, { error: errorMessage(error) })
                return
              }
              const waiting = turnQueue.sessions[runId] ?? []
              const index = waiting.findIndex((queued) => queued.id === parsed.request.turn.id)
              // 1-based; the new turn is always present because the save above
              // succeeded, so the fallback only guards against a stale read.
              const position = index >= 0 ? index + 1 : waiting.length
              json(res, 202, { queued: true, position, view: turnQueueView(turnQueue, runId) })
              return
            }
            const body = await readBody()
            const message = typeof body.message === 'string' ? body.message : ''
            if (!message.trim()) {
              json(res, 400, { error: 'message is required' })
              return
            }
            const images = parseImages(body.images)
            const nextTurn = (session.conv?.turns ?? session.turns) + 1
            void runTurn(session, message, images).catch((error: unknown) => {
              session.busy = false
              session.controller = undefined
              session.lastError = errorMessage(error)
              broadcast(session, { type: 'turn/end', outcome: 'error', error: session.lastError })
            })
            json(res, 202, { accepted: true, runId, turn: nextTurn })
            return
          }

          // WP-21: steer a running turn instead of starting (or queueing) one.
          // The message joins the conversation at the next step boundary, so the
          // model still sees tool results and can adjust mid-run.
          if (sub === 'steer' && method === 'POST') {
            if (session.kind === 'worker') {
              json(res, 403, { error: 'worker chats are read-only; send instructions through the orchestrator' })
              return
            }
            if (!session.busy) {
              // Nothing to steer: the caller sends a normal turn instead. The
              // hint is machine-readable so the composer can retry by itself.
              json(res, 400, { error: 'no turn is running', hint: 'turn' })
              return
            }
            const body = await readBody()
            const message = typeof body.message === 'string' ? body.message : ''
            if (!message.trim()) {
              json(res, 400, { error: 'message is required' })
              return
            }
            const images = parseImages(body.images)
            let queued: number
            try {
              queued = ensureConversation(session).steer(message, images).queued
            } catch (error) {
              // The turn ended between the busy check and the call.
              json(res, 409, { error: errorMessage(error), hint: 'turn' })
              return
            }
            const entry: ChatEntry = {
              id: `steer-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
              kind: 'user',
              runId,
              text: message,
              ts: Date.now(),
              steering: true,
              ...(images.length > 0 ? { images: images.length } : {}),
            }
            session.entries.push(entry)
            broadcast(session, { type: 'entry', entry })
            broadcast(session, { type: 'steer', runId, entryId: entry.id, queued })
            json(res, 202, { accepted: true, runId, turn: session.turns, entryId: entry.id, queued })
            return
          }

          if (sub === 'cancel' && method === 'POST') {
            session.controller?.abort()
            resolvePending(session)
            broadcast(session, { type: 'turn/cancelling', runId })
            json(res, 200, { cancelling: true })
            return
          }

          if (sub === 'approval' && method === 'POST') {
            const body = await readBody()
            const requestId = typeof body.requestId === 'string' ? body.requestId : ''
            const approved = body.approved === true
            const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined
            const scope: ApprovalScope = body.scope === 'session' || body.scope === 'always' ? body.scope : 'once'
            if (body.scope !== undefined && body.scope !== 'once' && body.scope !== 'session' && body.scope !== 'always') {
              json(res, 400, { error: 'scope must be once, session or always' })
              return
            }
            if (session.kind === 'worker') {
              // The user is the final authority, also for worker requests the
              // orchestrator may not approve.
              try {
                json(res, 200, { ok: true, ...(await approveWorker(session.runId, requestId, approved, reason, 'user')) })
              } catch (error) {
                json(res, 404, { error: errorMessage(error) })
              }
              return
            }
            const pending = session.pendingApprovals.get(requestId)
            if (!pending) {
              json(res, 404, { error: `no pending approval ${requestId}` })
              return
            }
            // CP-34: remember the approval before resolving, so a refused
            // "always" (user-only sandbox) leaves the request pending.
            let remembered: { scope: ApprovalScope; rule?: string } | undefined
            if (approved && scope !== 'once' && pending.request) {
              if (scope === 'always') {
                try {
                  const policyPath = config.userPolicyPath ?? path.join(userConfigDir(), 'policy.star')
                  remembered = { scope, rule: rememberAlways(policyPath, pending.request) }
                } catch (error) {
                  json(res, 400, { error: errorMessage(error) })
                  return
                }
              } else {
                remembered = { scope }
              }
              const keys = sessionApprovals.get(session.runId) ?? new Set<string>()
              keys.add(approvalKey(pending.request))
              sessionApprovals.set(session.runId, keys)
            }
            session.pendingApprovals.delete(requestId)
            pending.resolve(approved ? true : { approved: false, ...(reason ? { reason: `denied by the user: ${reason}` } : {}) })
            const entry = session.entries.find((e) => e.kind === 'approval' && e.requestId === requestId)
            if (entry?.kind === 'approval') {
              entry.decision = approved ? 'approved' : 'denied'
              if (reason) entry.reason = reason
              if (remembered) entry.scope = remembered.scope
            }
            broadcast(session, { type: 'approval/decision', requestId, approved, ...(reason ? { reason } : {}), ...(remembered ? { scope: remembered.scope } : {}) })
            json(res, 200, { ok: true, ...(remembered ? { remembered: remembered.scope } : {}), ...(remembered?.rule ? { rule: remembered.rule } : {}) })
            return
          }

          if (sub === 'answer' && method === 'POST') {
            const body = await readBody()
            const requestId = typeof body.requestId === 'string' ? body.requestId : ''
            const answer = typeof body.answer === 'string' ? body.answer : ''
            const pending = session.pendingQuestions.get(requestId)
            if (!pending) {
              json(res, 404, { error: `no pending question ${requestId}` })
              return
            }
            session.pendingQuestions.delete(requestId)
            pending.resolve(answer)
            const entry = session.entries.find((e) => e.kind === 'question' && e.requestId === requestId)
            if (entry?.kind === 'question') entry.answer = answer
            broadcast(session, { type: 'question/answer', requestId, answer })
            json(res, 200, { ok: true })
            return
          }

          if (sub === 'undo' && method === 'POST') {
            if (session.kind !== 'chat') {
              json(res, 409, { error: 'undo is unavailable for orchestration sessions; a shared workspace has one checkpoint owner' })
              return
            }
            const conv = ensureConversation(session)
            // CP-33: `{ toTurn }` rewinds several turns at once (Esc Esc).
            const undoBody = await readBody()
            if (undoBody.toTurn !== undefined && (!Number.isInteger(undoBody.toTurn) || Number(undoBody.toTurn) < 1)) {
              json(res, 400, { error: 'toTurn must be a turn number (1 or more)' })
              return
            }
            if (session.busy) {
              json(res, 409, { error: 'a turn is running; stop it before rewinding' })
              return
            }
            const result = undoBody.toTurn !== undefined ? await conv.rewind(Number(undoBody.toTurn)) : await conv.undo()
            refreshTranscript(session, config.stateDir)
            broadcast(session, { type: 'transcript', entries: session.entries })
            broadcast(session, { type: 'notice', text: result })
            broadcast(session, { type: 'state', state: sessionState(session) })
            json(res, 200, { result, entries: session.entries })
            return
          }

          if (sub === 'compact' && method === 'POST') {
            const result = await ensureConversation(session).compact()
            broadcast(session, { type: 'notice', text: result })
            json(res, 200, { result })
            return
          }

          if (sub === 'plan-mode' && method === 'POST') {
            const body = await readBody()
            if (session.kind === 'orchestrator' && body.on !== true) {
              json(res, 409, { error: 'the orchestrator is permanently in plan mode' })
              return
            }
            const conv = ensureConversation(session)
            const on = body.on === true
            const result = conv.setPlanMode(on)
            session.planMode = conv.isPlanMode()
            broadcast(session, { type: 'notice', text: result })
            broadcast(session, { type: 'state', state: sessionState(session) })
            if (!on) scheduleGoalRound(session)
            json(res, 200, { result, planMode: session.planMode })
            return
          }

          // WP-12: switch the sandbox mode for this session. The switch is a
          // user action (never a model tool), applies to the next tool call and
          // is recorded in the session log so a resume replays it.
          if (sub === 'sandbox' && method === 'POST') {
            if (session.kind === 'worker') {
              json(res, 403, { error: 'worker chats are read-only; the orchestrator owns their sandbox mode' })
              return
            }
            const body = await readBody()
            const requested = typeof body.mode === 'string' ? body.mode : ''
            let mode: SandboxMode
            try {
              mode = parseSandboxMode(requested)
            } catch {
              json(res, 400, { error: 'mode must be read-only, workspace-write or unconfined' })
              return
            }
            if (!switchableSandboxModes().includes(mode)) {
              json(res, 400, { error: 'low-integrity is a user-policy mode; it cannot be selected per session' })
              return
            }
            // A confined mode needs the workspace grant. The user's explicit
            // switch is the consent to grant it (the same action as
            // `hy sandbox grant`); a failure is reported instead of silently
            // running the mode unconfined.
            if (mode !== 'unconfined') {
              try {
                const capabilities = await client.sandboxStatus()
                if (!capabilities.workspaceWriteAvailable) await client.sandboxGrant()
              } catch (error) {
                json(res, 409, { error: `cannot enable ${mode}: ${errorMessage(error)}` })
                return
              }
            }
            const conv = ensureConversation(session)
            const applied = conv.setSandboxMode(mode)
            session.sandboxMode = applied
            broadcast(session, { type: 'notice', text: `sandbox mode: ${applied}` })
            broadcast(session, { type: 'state', state: sessionState(session) })
            json(res, 200, { mode: applied, state: sessionState(session) })
            return
          }

          if (sub === 'effort' && method === 'POST') {
            const body = await readBody()
            const requested = typeof body.effort === 'string' ? body.effort.trim() : ''
            if (requested !== '' && !EFFORT_VALUES.has(requested)) {
              json(res, 400, { error: `effort must be one of ${[...EFFORT_VALUES].join(', ')}` })
              return
            }
            const result = ensureConversation(session).setEffort(requested || undefined)
            session.effort = requested || undefined
            broadcast(session, { type: 'notice', text: result })
            broadcast(session, { type: 'state', state: sessionState(session) })
            json(res, 200, { result, effort: session.conv?.currentEffort() ?? '' })
            return
          }

          if (sub === 'model' && method === 'POST') {
            const body = await readBody()
            const model = typeof body.model === 'string' ? body.model.trim() : ''
            if (!model) {
              json(res, 400, { error: 'model is required' })
              return
            }
            const current = session.conv?.currentModel() ?? session.model
            const { user } = readUserConfigFile()
            const limits = modelProfileLimits(user, current.provider, model)
            const result = ensureConversation(session).setModel(model, limits)
            session.model = session.conv?.currentModel() ?? session.model
            broadcast(session, { type: 'notice', text: result })
            broadcast(session, { type: 'state', state: sessionState(session) })
            json(res, 200, { result })
            return
          }

          if (sub === 'pin' && method === 'POST') {
            const body = await readBody()
            const pinned = body.pinned === true
            uiState.pinned = pinned ? [...new Set([...uiState.pinned, runId])] : uiState.pinned.filter((id) => id !== runId)
            session.pinned = pinned
            saveUiState()
            broadcastSessions()
            json(res, 200, { runId, pinned })
            return
          }

          if (sub === 'archive' && method === 'POST') {
            const body = await readBody()
            const archived = body.archived === true
            uiState.archived = archived ? [...new Set([...uiState.archived, runId])] : uiState.archived.filter((id) => id !== runId)
            session.archived = archived
            saveUiState()
            broadcastSessions()
            json(res, 200, { runId, archived })
            return
          }

          if (sub === 'title/generate' && method === 'POST') {
            // WP-60: an explicit "name this chat" action. The model proposes;
            // a heuristic answers when it is offline, slow or empty-handed.
            const body = await readBody()
            const from = body.from === 'all' ? 'all' : 'first'
            const entries = session.entries.length > 0 ? session.entries : projectChat(readEvents(logFile), runId)
            const userMessages = entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []))
            const first = userMessages[0] ?? ''
            if (!first.trim()) {
              json(res, 409, { error: 'this chat has no messages to name yet' })
              return
            }
            const generated = await generateSessionTitle(config, {
              first,
              ...(from === 'all' ? { userMessages } : {}),
            })
            uiState.generatedTitles[runId] = { title: generated.title, at: Date.now(), source: generated.source }
            saveUiState()
            broadcastSessions()
            json(res, 200, {
              runId,
              title: generated.title,
              source: generated.source,
              ...(generated.reason ? { reason: generated.reason } : {}),
              // A manual name wins in the list; the caller can say so in the UI.
              effective: uiState.titles[runId] ?? generated.title,
            })
            return
          }

          if (sub === 'title' && method === 'POST') {
            // One rule for every surface: session-title.ts strips control
            // characters, collapses whitespace and rejects over-long names.
            const result = normalizeSessionTitle((await readBody()).title)
            if ('error' in result) {
              json(res, 400, { error: result.error })
              return
            }
            if (result.title) uiState.titles[runId] = result.title
            else delete uiState.titles[runId]
            saveUiState()
            broadcastSessions()
            json(res, 200, { runId, title: result.title })
            return
          }

          if (sub === 'goal' && method === 'GET') {
            const state = session.conv?.goalView() ?? null
            json(res, 200, { goal: state?.objective ?? session.goal ?? null, state })
            return
          }

          if (sub === 'goal' && method === 'POST') {
            const body = await readBody()
            const conv = ensureConversation(session)
            const action = typeof body.action === 'string' ? body.action : ''
            let result = ''
            if (action === 'clear') {
              conv.clearGoal()
              session.goal = undefined
              result = 'goal cleared'
            } else if (action === 'pause') {
              const state = conv.pauseGoal()
              session.goal = state?.objective
              result = state ? 'goal paused' : 'no goal is set'
            } else if (action === 'resume') {
              const state = conv.resumeGoal()
              session.goal = state.objective
              result = 'goal resumed'
            } else {
              const goal =
                typeof body.goal === 'string'
                  ? body.goal.trim()
                  : typeof body.objective === 'string'
                    ? body.objective.trim()
                    : ''
              const max = typeof body.maxGoalRounds === 'number' ? body.maxGoalRounds : undefined
              if (!goal) {
                conv.clearGoal()
                session.goal = undefined
                result = 'goal cleared'
              } else if (action === 'edit' && conv.goalView()) {
                const state = conv.editGoal(goal, max)
                session.goal = state.objective
                result = 'goal updated'
              } else {
                result = conv.setGoal(goal, max)
                session.goal = conv.currentGoal()
              }
            }
            const state = conv.goalView() ?? null
            broadcast(session, { type: 'notice', text: result })
            broadcast(session, { type: 'state', state: sessionState(session) })
            if (state?.phase === 'active' && state.activation === 'armed') scheduleGoalRound(session)
            json(res, 200, { result, goal: state?.objective ?? null, state })
            return
          }

          if (sub === 'jobs' && method === 'GET') {
            const jobs = await Promise.all(
              [...session.jobs.values()].map(async (job) => {
                try {
                  const info = await client.jobStatus(job.jobId)
                  job.status = info.state
                  job.updated = Date.now()
                } catch {
                  // keep the last known status
                }
                return { ...job }
              }),
            )
            json(res, 200, { jobs: jobs.sort((a, b) => b.started - a.started) })
            return
          }

          const jobMatch = /^jobs\/([^/]+)(?:\/(output|kill))?$/.exec(sub)
          if (jobMatch) {
            const jobId = jobMatch[1]!
            const action = jobMatch[2]
            if (action === 'output' && method === 'GET') {
              // A non-numeric offset used to become NaN, which JSON-encodes as
              // null and makes the daemon reject the RPC (a 500 for a caller
              // typo). Validate the query string instead.
              const rawOffset = url.searchParams.get('offset')
              const offset = rawOffset === null || rawOffset === '' ? 0 : Number(rawOffset)
              if (!Number.isSafeInteger(offset) || offset < 0) {
                json(res, 400, { error: 'offset must be a non-negative integer' })
                return
              }
              const output = await client.jobOutput(jobId, offset)
              json(res, 200, output)
              return
            }
            if (action === 'kill' && method === 'POST') {
              const info = await client.jobKill(jobId)
              const job = session.jobs.get(jobId)
              if (job) {
                job.status = info.state
                job.updated = Date.now()
              }
              broadcast(session, { type: 'notice', text: `job ${jobId}: ${info.state}` })
              json(res, 200, info)
              return
            }
            json(res, 404, { error: `unknown jobs endpoint ${sub}` })
            return
          }

          if (sub === 'subagents' && method === 'GET') {
            const events = readEvents(logFile)
            const ids = [...new Set(events.filter((e) => e.runId?.startsWith(`${runId}.sub`)).map((e) => e.runId!))]
            const subagents = ids.map((id) => {
              const entries = projectChat(events, id)
              const start = events.find((e) => e.runId === id && e.type === 'subagent/start')
              const lastAssistant = [...entries].reverse().find((e) => e.kind === 'assistant')
              return {
                runId: id,
                readOnly: (start?.payload as { readOnly?: unknown } | undefined)?.readOnly === true,
                started: start?.ts ?? entries[0]?.ts ?? Date.now(),
                entries: entries.length,
                preview: lastAssistant?.kind === 'assistant' ? lastAssistant.text.slice(0, 240) : '',
              }
            })
            json(res, 200, { subagents: subagents.sort((a, b) => a.started - b.started) })
            return
          }

          const subAgentMatch = /^subagents\/([^/]+)$/.exec(sub)
          if (subAgentMatch && method === 'GET') {
            const child = subAgentMatch[1]!
            if (child !== `${runId}.sub` && !child.startsWith(`${runId}.sub`)) {
              json(res, 400, { error: 'not a subagent of this run' })
              return
            }
            const events = readEvents(logFile)
            json(res, 200, { runId: child, entries: projectChat(events, child), events: events.filter((e) => e.runId === child) })
            return
          }

          // WP-22: continuable background subagents. They are the same
          // `<parent>.subN` children as above, but registered: the list carries
          // state, and a message starts a follow-up turn (or steers a running one).
          if (sub === 'agents' && method === 'GET') {
            const agents = ensureConversation(session).agents
            json(res, 200, { agents: agents ? agents.list() : [] })
            return
          }

          const agentMatch = /^agents\/([^/]+)(?:\/(message|interrupt|close))?$/.exec(sub)
          if (agentMatch) {
            const agentId = decodeURIComponent(agentMatch[1]!)
            const action = agentMatch[2]
            const agents = ensureConversation(session).agents
            if (!agents) {
              json(res, 404, { error: 'this session has no background subagents' })
              return
            }
            if (action === undefined && method === 'GET') {
              const agent = agents.get(agentId)
              if (!agent) {
                json(res, 404, { error: `unknown subagent ${agentId}` })
                return
              }
              json(res, 200, { agent })
              return
            }
            if (method !== 'POST') {
              json(res, 405, { error: 'use POST for subagent actions' })
              return
            }
            const body = await readBody()
            try {
              if (action === 'message') {
                const message = typeof body.message === 'string' ? body.message : ''
                if (!message.trim()) {
                  json(res, 400, { error: 'message is required' })
                  return
                }
                json(res, 202, { agent: agents.send(agentId, message) })
                return
              }
              if (action === 'interrupt') {
                const view = agents.interrupt(agentId)
                session.conv?.reportSubagentStopped(view.agentId, view.status)
                json(res, 200, { agent: view })
                return
              }
              if (action === 'close') {
                const view = agents.close(agentId)
                session.conv?.reportSubagentStopped(view.agentId, view.status)
                json(res, 200, { agent: view })
                return
              }
              json(res, 404, { error: `unknown subagent action ${action}` })
            } catch (error) {
              const message = errorMessage(error)
              json(res, /unknown subagent/.test(message) ? 404 : 409, { error: message })
            }
            return
          }

          // WP-52: document previews. PDFs and images are served as they are;
          // Office files are converted with an installed LibreOffice and cached.
          if (sub === 'document' && method === 'GET') {
            const rel = url.searchParams.get('path') ?? ''
            try {
              const preview = previewDocument({
                stateDir: config.stateDir,
                workspaceRoot: config.workspaceRoot,
                roots: config.workspaceRoots,
                rel,
              })
              const bytes = fs.readFileSync(preview.file)
              res.statusCode = 200
              res.setHeader('Content-Type', preview.contentType)
              res.setHeader('Content-Length', String(bytes.length))
              res.setHeader('X-Content-Type-Options', 'nosniff')
              res.setHeader('Content-Disposition', 'inline')
              res.setHeader('X-HY-Preview-Cached', preview.cached ? '1' : '0')
              res.end(bytes)
            } catch (error) {
              if (error instanceof DocumentError) json(res, error.status, { error: error.message })
              else json(res, 500, { error: errorMessage(error) })
            }
            return
          }
          // WP-23: reveal a presented file in the OS file manager. The server
          // runs on the user's own machine, so this opens their Explorer (macOS
          // and Linux use their equivalents); the path must stay inside a root.
          if (sub === 'reveal' && method === 'POST') {
            const body = await readBody()
            const rel = typeof body.path === 'string' ? body.path.replace(/\\/g, '/') : ''
            if (!rel) {
              json(res, 400, { error: 'path is required' })
              return
            }
            const rootMatch = /^root:([^/]+)\/(.+)$/.exec(rel)
            const root = rootMatch ? config.workspaceRoots.find((candidate) => candidate.id === rootMatch[1]) : { id: 'main', path: config.workspaceRoot }
            if (!root) {
              json(res, 404, { error: `unknown root in ${rel}` })
              return
            }
            const base = path.resolve(root.path)
            const full = path.resolve(base, rootMatch ? rootMatch[2]! : rel)
            if (!full.startsWith(`${base}${path.sep}`) || !fs.existsSync(full)) {
              json(res, 400, { error: 'not a file inside this workspace' })
              return
            }
            const [exe, args] =
              process.platform === 'win32'
                ? (['explorer.exe', ['/select,', full]] as const)
                : process.platform === 'darwin'
                  ? (['open', ['-R', full]] as const)
                  : (['xdg-open', [path.dirname(full)]] as const)
            try {
              const child = spawn(exe, [...args], { detached: true, stdio: 'ignore' })
              child.unref()
              json(res, 200, { revealed: true, path: full })
            } catch (error) {
              json(res, 500, { error: errorMessage(error) })
            }
            return
          }

          if (sub === 'trajectory' && method === 'GET') {
            const events = readEvents(logFile).filter((e) => e.runId === runId)
            json(res, 200, { runId, events: events.slice(-2000) })
            return
          }

          if (sub === 'mcp-call' && method === 'POST') {
            const body = await readBody()
            const server = typeof body.server === 'string' ? body.server : ''
            const tool = typeof body.tool === 'string' ? body.tool : ''
            if (server !== 'playwright' && server !== 'agent-desktop') {
              json(res, 403, { error: 'direct GUI calls are limited to the playwright and agent-desktop automation servers' })
              return
            }
            if (!sessionMcp || !sessionMcp.find(server, tool)) {
              json(res, 400, { error: `MCP tool ${server}/${tool} is not available; enable it in Settings and restart` })
              return
            }
            try {
              const result = await sessionMcp.call(server, tool, body.args ?? {})
              json(res, 200, { result })
            } catch (error) {
              json(res, 400, { error: errorMessage(error) })
            }
            return
          }

          if (sub === 'mcp' && method === 'GET') {
            json(res, 200, { tools: sessionMcp?.tools ?? [], errors: sessionMcp?.errors ?? [] })
            return
          }

          if (sub === 'plugins' && method === 'GET') {
            json(res, 200, {
              tools: [...(sessionPlugins?.tools.values() ?? [])].map((t) => ({
                name: t.name,
                description: t.spec.description,
                readOnly: t.spec.readOnly,
                plugin: t.plugin,
              })),
              errors: sessionPlugins?.errors ?? [],
            })
            return
          }

          if (sub === 'memory' && method === 'GET') {
            json(res, 200, { entries: MemoryStore.forStateDir(config.stateDir).list() })
            return
          }

          if (sub === 'terminal' && method === 'POST') {
            const body = await readBody()
            const command = typeof body.command === 'string' ? body.command.trim() : ''
            if (!command) {
              json(res, 400, { error: 'command is required' })
              return
            }
            try {
              const result = await client.exec({
                command,
                mode: 'gate',
                hardTimeoutMs: 120_000,
                approval: { by: 'user', callId: `terminal-${Date.now()}` },
              })
              json(res, 200, { result })
            } catch (error) {
              json(res, 400, { error: errorMessage(error) })
            }
            return
          }

          if (sub === 'diff' && method === 'GET') {
            try {
              const diff = await ensureConversation(session).diff()
              json(res, 200, { diff })
            } catch (error) {
              json(res, 200, { diff: '', error: errorMessage(error) })
            }
            return
          }

          if (sub === 'feedback' && method === 'POST') {
            // WP-61: local-only feedback. Nothing leaves this machine.
            try {
              const entry = validateFeedback(await readBody(), runId, { model: `${session.model.provider}:${session.model.model}` })
              new FeedbackStore(feedbackFile(config.stateDir)).append(entry)
              json(res, 201, { entry, summary: new FeedbackStore(feedbackFile(config.stateDir)).summary(runId) })
            } catch (error) {
              json(res, error instanceof FeedbackError ? 400 : 500, { error: errorMessage(error) })
            }
            return
          }

          if (sub === 'feedback' && method === 'GET') {
            const store = new FeedbackStore(feedbackFile(config.stateDir))
            json(res, 200, { summary: store.summary(runId), entries: store.list({ runId }) })
            return
          }

          if (sub === 'fork' && method === 'POST') {
            // WP-60: copy this run's history into a new run and continue there.
            const body = await readBody()
            const upToSeq =
              typeof body.upToSeq === 'number' && Number.isFinite(body.upToSeq) ? Math.trunc(body.upToSeq) : undefined
            const forkRunId = newRunId()
            try {
              const plan = planFork(readEvents(logFile), runId, forkRunId, {
                ...(upToSeq !== undefined ? { upToSeq } : {}),
              })
              const log = new SessionLog(sessionLogPath(config.stateDir))
              log.setRun(forkRunId)
              log.importEvents(plan.events)
              log.append('session/fork', {
                from: runId,
                upToSeq: plan.upToSeq,
                copied: plan.events.length,
                skippedSubagents: plan.skippedSubagents,
              })
              const created = ensureSession(forkRunId)
              broadcastSessions()
              json(res, 201, {
                runId: forkRunId,
                forkedFrom: runId,
                upToSeq: plan.upToSeq,
                turns: plan.turns,
                state: created ? sessionState(created) : undefined,
              })
            } catch (error) {
              json(res, error instanceof ForkError ? 400 : 500, { error: errorMessage(error) })
            }
            return
          }

          if (sub === 'stats' && method === 'GET') {
            // WP-60: measured session timings; the snapshot is written per turn.
            json(res, 200, { runId, stats: statsView(session.stats) })
            return
          }

          if (sub === 'plan' && method === 'GET') {
            // ensureConversation restores the list a restart left in the log.
            json(res, 200, { plan: ensureConversation(session).plan(), planMode: sessionState(session).planMode })
            return
          }

          if (sub === 'notes' && method === 'GET') {
            json(res, 200, { notes: session.conv?.notes() ?? 'no notes' })
            return
          }

          if (sub === 'status' && method === 'GET') {
            json(res, 200, { status: session.conv?.status() ?? `run: ${session.runId}\nworkspace: ${config.workspaceRoot}`, state: sessionState(session) })
            return
          }

          if (sub === 'skills' && method === 'GET') {
            json(res, 200, { skills: session.conv?.skillList() ?? 'no skills loaded' })
            return
          }

          if (sub === 'export' && method === 'GET') {
            const format = url.searchParams.get('format') ?? 'md'
            if (format === 'json') {
              json(res, 200, { runId, entries: session.entries, events: readEvents(logFile).filter((e) => e.runId === runId) })
            } else {
              text(res, 200, markdownExport(session), 'text/markdown; charset=utf-8')
            }
            return
          }

          if (sub === 'review' && method === 'POST') {
            const conv = ensureConversation(session)
            const review = await conv.delegate(
              'Review the uncommitted changes in this workspace for correctness. Look for bugs, regressions, security problems and missing tests; read surrounding code when the diff is not enough. Report each finding as: severity (high/medium/low), file:line, what is wrong, and why it matters. If you find nothing that needs fixing, say so plainly.',
              true,
            )
            session.entries.push({ id: `review-${Date.now()}`, kind: 'assistant', runId: session.runId, text: review.final, ts: Date.now(), final: true })
            broadcast(session, { type: 'entry', entry: session.entries.at(-1) })
            json(res, 200, { final: review.final })
            return
          }

          json(res, 404, { error: `unknown endpoint ${pathname}` })
          return
        }

        if (pathname === '/api/workspace/roots' && method === 'GET') {
          json(res, 200, { roots: configSummary(config).roots })
          return
        }

        if (pathname === '/api/workspace/roots' && method === 'POST') {
          if ([...sessions.values()].some((session) => session.busy)) {
            json(res, 409, { error: 'wait for running turns to finish before adding a root' })
            return
          }
          const body = await readBody()
          const input = typeof body.path === 'string' ? body.path.trim() : ''
          if (!input || !path.isAbsolute(input)) {
            json(res, 400, { error: 'an absolute folder path is required' })
            return
          }
          let real: string
          try {
            if (!fs.statSync(input).isDirectory()) throw new Error('not a directory')
            real = fs.realpathSync.native(input)
          } catch (error) {
            json(res, 400, { error: errorMessage(error) })
            return
          }
          if (config.workspaceRoots.some((root) => path.resolve(root.path).toLowerCase() === path.resolve(real).toLowerCase())) {
            json(res, 409, { error: 'this folder is already a workspace root' })
            return
          }
          const settingsPath = path.join(userConfigDir(), 'config.json')
          let user: Record<string, unknown> = {}
          try {
            const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) user = parsed as Record<string, unknown>
          } catch {
            user = {}
          }
          try {
            if (body.writable === true) await client.sandboxAddRoot(real)
          } catch (error) {
            json(res, 500, { error: errorMessage(error) })
            return
          }
          // Roots added here belong to this workspace only. They used to be
          // written to the global `workspaceRoots`, which every other workspace
          // also loads, so an added folder followed the user everywhere.
          const key = workspaceRootsKey(config.workspaceRoot)
          const byWorkspace = rootsByWorkspace(user)
          byWorkspace[key] = [
            ...(byWorkspace[key] ?? []),
            { path: real, ...(typeof body.label === 'string' ? { label: body.label } : {}), writable: body.writable === true },
          ]
          user.workspaceRootsByWorkspace = byWorkspace
          fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
          fs.writeFileSync(settingsPath, `${JSON.stringify(user, null, 2)}\n`, 'utf8')
          refreshWorkspaceRoots(configuredExtraRoots(user, config.workspaceRoot))
          broadcastSessions()
          json(res, 201, { roots: configSummary(config).roots })
          return
        }

        const rootMatch = /^\/api\/workspace\/roots\/([^/]+)$/.exec(pathname)
        if (rootMatch && method === 'DELETE') {
          if ([...sessions.values()].some((session) => session.busy)) {
            json(res, 409, { error: 'wait for running turns to finish before removing a root' })
            return
          }
          const id = decodeURIComponent(rootMatch[1]!)
          if (id === 'main') {
            json(res, 400, { error: 'the primary root cannot be removed' })
            return
          }
          const settingsPath = path.join(userConfigDir(), 'config.json')
          let user: Record<string, unknown> = {}
          try {
            const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) user = parsed as Record<string, unknown>
          } catch {
            user = {}
          }
          const root = config.workspaceRoots.find((candidate) => candidate.id === id)
          if (!root) {
            json(res, 404, { error: `unknown workspace root: ${id}` })
            return
          }
          try {
            if (root.writable === true) await client.sandboxRemoveRoot(root.path)
          } catch (error) {
            json(res, 500, { error: errorMessage(error) })
            return
          }
          // Remove only this path from the list it came from. Rebuilding the list
          // from the resolved roots would also drop entries that are merely
          // skipped here (missing folder, same as this workspace's main root)
          // but still apply to other workspaces.
          const samePath = (entry: unknown): boolean =>
            !!entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string' &&
            workspaceRootsKey(realOrSelf((entry as { path: string }).path)) === workspaceRootsKey(root.path)
          if (root.scope === 'global') {
            const kept = (Array.isArray(user.workspaceRoots) ? user.workspaceRoots : []).filter((entry) => !samePath(entry))
            if (kept.length > 0) user.workspaceRoots = kept
            else delete user.workspaceRoots
          } else {
            const key = workspaceRootsKey(config.workspaceRoot)
            const byWorkspace = rootsByWorkspace(user)
            const kept = (byWorkspace[key] ?? []).filter((entry) => !samePath(entry))
            if (kept.length > 0) byWorkspace[key] = kept
            else delete byWorkspace[key]
            if (Object.keys(byWorkspace).length > 0) user.workspaceRootsByWorkspace = byWorkspace
            else delete user.workspaceRootsByWorkspace
          }
          fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
          fs.writeFileSync(settingsPath, `${JSON.stringify(user, null, 2)}\n`, 'utf8')
          refreshWorkspaceRoots(configuredExtraRoots(user, config.workspaceRoot))
          broadcastSessions()
          json(res, 200, { roots: configSummary(config).roots })
          return
        }

        if (pathname === '/api/files/search' && method === 'GET') {
          const query = (url.searchParams.get('q') ?? '').trim()
          const root = rootById(url.searchParams.get('root'))
          // WP-60: `docs/` drills into the folder instead of searching everything.
          const found = query ? (query.endsWith('/') ? listDirectoryChildren(root.path, query) : searchWorkspaceFiles(root.path, query)) : []
          const files = found.map((file) => qualifyRootPath(root.id, file))
          json(res, 200, { root: root.id, files })
          return
        }

        // WP-60: `@` reference candidates — files and earlier chats in one call.
        // WP-61: "Open In" for files and folders. Launching is allowed only for
        // a request from this machine and only for a detected program.
        if (pathname === '/api/open-in' && method === 'GET') {
          const local = isLocalAddress(req.socket.remoteAddress)
          json(res, 200, { local, targets: local ? detectOpenIn() : [] })
          return
        }

        if (pathname === '/api/open-in' && method === 'POST') {
          if (!isLocalAddress(req.socket.remoteAddress)) {
            json(res, 403, { error: 'opening applications is only available from this machine' })
            return
          }
          const body = await readBody()
          const targetId = typeof body.target === 'string' ? body.target : ''
          const rel = typeof body.path === 'string' ? body.path.replace(/\\/g, '/') : ''
          if (!rel) {
            json(res, 400, { error: 'path is required' })
            return
          }
          const root = rootById(typeof body.root === 'string' ? body.root : null)
          try {
            const file = safeWorkspacePath(root.path, rel.replace(/^[^:]+:/, ''))
            const argv = openInArgv(targetId, file)
            spawn(argv.command, argv.args, { detached: true, stdio: 'ignore', windowsHide: false }).unref()
            json(res, 200, { started: true, target: targetId, command: argv.command })
          } catch (error) {
            json(res, error instanceof OpenInError ? 400 : 404, { error: errorMessage(error) })
          }
          return
        }

        if (pathname === '/api/references' && method === 'GET') {
          const query = (url.searchParams.get('q') ?? '').trim()
          const root = rootById(url.searchParams.get('root'))
          const exclude = url.searchParams.get('exclude') ?? ''
          const found = query ? (query.endsWith('/') ? listDirectoryChildren(root.path, query) : searchWorkspaceFiles(root.path, query)) : []
          const files = found.map((file) => qualifyRootPath(root.id, file))
          const needle = query.toLowerCase()
          const sessions = listRuns(readEvents(logFile))
            .filter((run) => !deletedRuns.has(run.runId) && run.runId !== exclude)
            .map((run) => {
              const title = uiState.titles[run.runId] ?? uiState.generatedTitles[run.runId]?.title ?? ''
              const label = title || run.first || run.runId
              const score = needle
                ? label.toLowerCase().includes(needle)
                  ? 2
                  : `${label} ${run.first}`.toLowerCase().includes(needle)
                    ? 1
                    : 0
                : 0
              return { runId: run.runId, title: title || null, first: run.first, turns: run.turns, last: run.last, score, label }
            })
            .filter((run) => !needle || run.score > 0)
            .sort((a, b) => b.score - a.score || b.last - a.last)
            .slice(0, 10)
            .map(({ score, ...run }) => run)
          // CP-21: `@skill:` candidates (by name, then description).
          const skillNeedle = needle.replace(/^skill:/, '')
          const skills = discoverSkills(config.workspaceRoot)
            .filter((s) => !skillNeedle || s.name.toLowerCase().includes(skillNeedle) || s.description.toLowerCase().includes(skillNeedle))
            .slice(0, 8)
            .map((s) => ({ name: s.name, description: s.description, scope: s.scope }))
          json(res, 200, { root: root.id, files, sessions, skills })
          return
        }

        if (pathname === '/api/files/tree' && method === 'GET') {
          const rel = url.searchParams.get('path') ?? ''
          const showHidden = url.searchParams.get('hidden') === '1'
          const root = rootById(url.searchParams.get('root'))
          const full = safeWorkspacePath(root.path, rel)
          const stat = fs.statSync(full)
          if (!stat.isDirectory()) {
            json(res, 400, { error: 'not a directory' })
            return
          }
          const entries = fs.readdirSync(full, { withFileTypes: true })
            .filter((e) => showHidden || !TREE_SKIP.has(e.name))
            .map((e) => {
              const child = path.posix.join(rel.replace(/\\/g, '/'), e.name)
              let size: number | undefined
              try {
                size = e.isFile() ? fs.statSync(path.join(full, e.name)).size : undefined
              } catch {
                size = undefined
              }
              return { name: e.name, path: child, type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file', ...(size !== undefined ? { size } : {}) }
            })
            .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
            .slice(0, 1000)
          json(res, 200, { root: root.id, path: rel, entries })
          return
        }

        if (pathname === '/api/files' && method === 'GET') {
          const rel = url.searchParams.get('path') ?? ''
          const root = rootById(url.searchParams.get('root'))
          const spill = root.id === 'main' ? spillFile(path.join(config.stateDir, 'spill'), rel) : undefined
          const full = spill ?? safeWorkspacePath(root.path, rel)
          const stat = fs.statSync(full)
          if (!stat.isFile()) {
            json(res, 400, { error: 'not a file' })
            return
          }
          if (stat.size > MAX_FILE_BYTES) {
            json(res, 413, { error: `file is too large (${stat.size} bytes; limit ${MAX_FILE_BYTES})` })
            return
          }
          const bytes = fs.readFileSync(full)
          if (bytes.subarray(0, 8192).includes(0)) {
            json(res, 415, { error: 'binary file' })
            return
          }
          const content = bytes.toString('utf8')
          json(res, 200, {
            root: root.id,
            path: qualifyRootPath(root.id, rel),
            size: stat.size,
            lines: content.split(/\r?\n/).length,
            content,
            truncated: false,
          })
          return
        }

        if (pathname === '/api/settings' && method === 'GET') {
          const settingsPath = path.join(userConfigDir(), 'config.json')
          let user: unknown = {}
          try {
            user = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as unknown
          } catch {
            user = {}
          }
          json(res, 200, { path: settingsPath, user: redactUserConfig(user), active: configSummary(config) })
          return
        }

        if (pathname === '/api/settings' && method === 'PUT') {
          const body = await readBody()
          const settingsPath = path.join(userConfigDir(), 'config.json')
          let user: Record<string, unknown> = {}
          try {
            const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) user = parsed as Record<string, unknown>
          } catch {
            user = {}
          }
          if (body.roles && typeof body.roles === 'object' && !Array.isArray(body.roles)) {
            const roles = (user.roles && typeof user.roles === 'object' && !Array.isArray(user.roles) ? user.roles : {}) as Record<string, unknown>
            for (const [role, value] of Object.entries(body.roles as Record<string, unknown>)) {
              if (!['worker', 'orchestrator', 'subagent', 'guardian', 'grader', 'compactor', 'summarizer'].includes(role)) continue
              if (!value || typeof value !== 'object' || Array.isArray(value)) continue
              const incoming = { ...(value as Record<string, unknown>) }
              if (typeof incoming.apiKey === 'string') {
                const key = incoming.apiKey.trim()
                if (key) incoming.apiKey = key
                else delete incoming.apiKey
              }
              delete incoming.apiKeySet
              const merged = {
                ...(roles[role] && typeof roles[role] === 'object' && !Array.isArray(roles[role]) ? roles[role] : {}),
                ...incoming,
              }
              // A `/model`-style partial save sends only the model name. Apply
              // the matching Settings → Models limits so the new model does not
              // inherit the previous model's context/output budget.
              if (
                typeof incoming.model === 'string' &&
                incoming.contextWindowTokens === undefined &&
                incoming.maxOutputTokens === undefined
              ) {
                const provider = typeof merged.provider === 'string' ? merged.provider : roleProvider(config, role)
                const limits = modelProfileLimits(user, provider, incoming.model)
                if (limits) {
                  merged.contextWindowTokens = limits.contextWindowTokens
                  merged.maxOutputTokens = limits.maxOutputTokens
                }
              }
              if (merged.effort === null || merged.effort === '' || (typeof merged.effort === 'string' && !EFFORT_VALUES.has(merged.effort))) {
                delete merged.effort
              }
              roles[role] = merged
            }
            user.roles = roles
          }
          if (typeof body.autoApprove === 'boolean') user.autoApprove = body.autoApprove
          if (typeof body.fullAuto === 'boolean') user.fullAuto = body.fullAuto
          if (Array.isArray(body.models)) {
            user.models = body.models.filter(
              (model): model is Record<string, unknown> =>
                !!model &&
                typeof model === 'object' &&
                !Array.isArray(model) &&
                typeof (model as Record<string, unknown>).id === 'string' &&
                typeof (model as Record<string, unknown>).name === 'string' &&
                typeof (model as Record<string, unknown>).provider === 'string' &&
                typeof (model as Record<string, unknown>).model === 'string',
            )
          }
          if (typeof body.sandboxMode === 'string' && ['unconfined', 'workspace-write', 'read-only'].includes(body.sandboxMode)) {
            user.sandboxMode = body.sandboxMode
          }
          if (Array.isArray(body.plugins)) {
            user.plugins = body.plugins.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          }
          if (typeof body.memoryEnabled === 'boolean') {
            user.memory = { ...(typeof user.memory === 'object' && user.memory !== null && !Array.isArray(user.memory) ? user.memory : {}), enabled: body.memoryEnabled }
          }
          if (typeof body.webEnabled === 'boolean') {
            user.web = { ...(typeof user.web === 'object' && user.web !== null && !Array.isArray(user.web) ? user.web : {}), enabled: body.webEnabled }
          }
          if (body.automation && typeof body.automation === 'object' && !Array.isArray(body.automation)) {
            user.automation = body.automation
          }
          fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
          fs.writeFileSync(settingsPath, `${JSON.stringify(user, null, 2)}\n`, 'utf8')
          const reloaded = await applyRuntimeSettings()
          json(res, 200, {
            saved: true,
            path: settingsPath,
            restartRequired: !reloaded.hot || reloaded.sandboxPending,
            hotReloaded: reloaded.hot,
            sandboxRestartRequired: reloaded.sandboxPending,
          })
          return
        }

        json(res, 404, { error: `unknown endpoint ${pathname}` })
        return
      }

      // Static client. The page is public; every API call above is authenticated.
      if (method !== 'GET' && method !== 'HEAD') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
      const full = path.resolve(WEB_ROOT, relative)
      if (full !== WEB_ROOT && !full.startsWith(`${WEB_ROOT}${path.sep}`)) {
        text(res, 403, 'forbidden')
        return
      }
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        text(res, 404, 'not found')
        return
      }
      if (!stat.isFile()) {
        text(res, 404, 'not found')
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream')
      res.setHeader('Cache-Control', 'no-cache')
      if (method === 'HEAD') {
        res.end()
        return
      }
      fs.createReadStream(full).pipe(res)
    })().catch((error: unknown) => {
      // A malformed or oversized body is the caller's mistake: answer 4xx from
      // `HttpError` and reserve 500 for genuine server faults.
      if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 500, { error: errorMessage(error) })
      else res.end()
    })
  }

  // A TLS listener is created only when a certificate and key were supplied;
  // otherwise the server keeps the loopback HTTP behavior of earlier versions.
  const server = secure ? https.createServer(tlsOptions, requestHandler) : http.createServer(requestHandler)

  const listen = (port: number): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve((server.address() as AddressInfo).port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })

  let port = options.port ?? 3080
  if (port !== 0) {
    for (let attempt = 0; ; attempt++) {
      try {
        port = await listen(port)
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE' || attempt >= 10) throw error
        port += 1
      }
    }
  } else {
    port = await listen(0)
  }

  const heartbeatTimer = setInterval(() => heartbeatCheck(), 60_000)
  heartbeatTimer.unref()
  if (orchestration.active?.status === 'active') {
    const active = orchestration.active
    // A restart kills every in-flight worker turn. Leaving the persisted status
    // as `running` made the UI show work that no process was doing and kept the
    // scope reserved forever. A blocked worker keeps its blocker: it was not
    // running, so a restart did not interrupt it.
    const changed = markStaleWorkersInterrupted(active)
    if (changed) persistOrchestration()
    const open = active.workers.filter(workerHoldsScope)
    const unresolved = open.filter(
      (worker) => workerNeedsAttention(worker.status) || workerAwaitingReview(worker) || worker.status === 'stopped',
    )
    if (unresolved.length > 0) {
      broadcastSessions()
      setTimeout(() => {
        queueOrchestratorNotice(
          [
            '[host restart]',
            ...(changed ? ['Workers that were running or queued are now interrupted.'] : []),
            ...unresolved.map(
              (worker) =>
                `- ${worker.title} (${worker.runId}): ${workerStatusLabel(worker.status)}; scope ${worker.scope.join(', ')}`,
            ),
            'Inspect them with orchestrator_workers. Review and close finished work, retry interrupted work, or send a correction. ' +
              'A finished worker stays open only until you review it; it holds its scope until orchestrator_close.',
          ].join('\n'),
        )
      }, 1_000).unref()
    }
  }

  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const urlHost = displayHost.includes(':') ? `[${displayHost}]` : displayHost
  const advertisedRoot = publicUrl ?? `${scheme}://${urlHost}:${port}/`
  const url = `${advertisedRoot}?token=${encodeURIComponent(token)}`
  logLine(options, `listening on ${advertisedRoot}`)
  logLine(options, `workspace: ${config.workspaceRoot}`)
  logLine(options, `sandbox: ${config.sandbox}`)
  if (secure) logLine(options, 'tls: enabled')
  if (publicUrl !== undefined) logLine(options, `public url: ${publicUrl} (name it with --trusted-host to accept it)`)
  if ((options.trustedHosts ?? []).length > 0) logLine(options, `trusted hosts: ${(options.trustedHosts ?? []).join(', ')}`)
  if (options.open) openBrowser(url)

  return {
    url,
    localUrl: `${scheme}://${urlHost}:${port}/`,
    port,
    token,
    config,
    close: async () => {
      if (closing) return
      closing = true
      clearInterval(heartbeatTimer)
      clearInterval(automationTimer)
      for (const child of automationChildren.values()) child.kill()
      automationChildren.clear()
      for (const job of ralphJobs.values()) {
        job.status = 'cancelled'
        job.child?.kill()
      }
      for (const session of sessions.values()) {
        session.controller?.abort()
        // WP-22: background subagent turns belong to this process as well.
        void session.conv?.end()
        session.conv?.agents?.dispose()
        resolvePending(session)
        session.pty?.dispose()
        for (const res of session.ptySubscribers ?? []) {
          try {
            res.end()
          } catch {
            // already closed
          }
        }
        session.ptySubscribers?.clear()
        for (const res of session.subscribers) {
          try {
            res.end()
          } catch {
            // already closed
          }
        }
        session.subscribers.clear()
      }
      for (const res of globalSubscribers) {
        try {
          res.end()
        } catch {
          // already closed
        }
      }
      globalSubscribers.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await client.stop()
      await closeServices()
    },
  }
}

/** Opens a URL in the user's default browser. */
export function openBrowser(url: string): void {
  const platform = process.platform
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}
