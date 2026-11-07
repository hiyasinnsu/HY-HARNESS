import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { catalogVision } from './model-catalog.js'
import { resolveBundles, type ResolvedBundles } from './bundles.js'
import type { SandboxMode } from './protocol.js'
import type { McpServerConfig } from './mcp.js'
import type { HookSpec, HooksConfig } from './hooks.js'
import type { WebConfig } from './web.js'
import type { LspServerConfig } from './lsp.js'
import { isSecretRef, resolveSecretRef } from './secrets.js'
import { resolveFeatures } from './features.js'

export type ProviderKind =
  | 'ollama'
  | 'deepseek'
  | 'openai-compatible'
  | 'openai-responses'
  | 'opencode'
  | 'gemini'
  | 'anthropic'
  | 'mock'

/** CP-02: a named permission profile. `denyRead` and `readOnly` are enforced today. */
export interface PermissionProfile {
  description?: string
  /** Inherit another profile's lists (base first, then this profile's). */
  extends?: string
  /** Paths the confined token must not read (files or directories). */
  denyRead?: string[]
  /** Workspace subdirectories the confined token may read but not write. */
  readOnly?: string[]
  /** Extra writable roots (reserved). */
  write?: string[]
}

/** CP-05: how `prompt` decisions are handled. `untrusted` asks (the default). */
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'on-failure' | 'never'

export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = [
  'untrusted',
  'on-request',
  'on-failure',
  'never',
]

export interface RoleConfig {
  provider: ProviderKind
  model: string
  baseUrl?: string
  apiKeyEnv?: string
  /** Directly stored key; takes precedence over apiKeyEnv. Prefer an env var. */
  apiKey?: string
  /** `secrets.<name>` with a DPAPI reference; resolved into `apiKey` at load (CP-08). */
  apiKeySecret?: string
  /** Provider reasoning effort (`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`). */
  effort?: string
  contextWindowTokens: number
  maxOutputTokens: number
  temperature?: number
  /** Responses API `text.verbosity` (CP-24). */
  verbosity?: 'low' | 'medium' | 'high'
  /** Responses API `reasoning.summary` (CP-24). */
  reasoningSummary?: 'auto' | 'concise' | 'detailed' | 'none'
  /** Responses API `service_tier` (CP-24). */
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority'
  /** USD per million tokens; required for every role in use when a USD budget is set. */
  pricing?: { inputPerMTokUsd: number; cachedInputPerMTokUsd?: number; outputPerMTokUsd: number }
  /** Native function calling; default on for Ollama and OpenAI-compatible APIs (see `usesNativeTools`). */
  nativeTools?: boolean
  /**
   * Whether the model accepts image input (`read_image`, WP-30). Defaults to a
   * provider/model heuristic; set it explicitly when the guess is wrong.
   */
  vision?: boolean
}

/** Whether a role offers tools through native function calling. */
export function usesNativeTools(role: RoleConfig): boolean {
  if (role.nativeTools !== undefined) return role.nativeTools
  return role.provider === 'ollama' || role.provider === 'openai-compatible' || role.provider === 'openai-responses' || role.provider === 'deepseek' || role.provider === 'opencode' || role.provider === 'anthropic'
}

/**
 * Whether the model can see images (WP-30). The mock does, so `--mock` runs can
 * exercise `read_image`; Ollama only for a model whose name says it is a vision
 * model; the hosted APIs are assumed to be multimodal. `role.vision` overrides.
 */
export function roleSupportsImages(role: RoleConfig): boolean {
  if (role.vision !== undefined) return role.vision
  // WP-41: a catalog entry that knows the model wins over the heuristic.
  const listed = catalogVision(role.provider, role.model)
  if (listed !== undefined) return listed
  if (role.provider === 'mock') return true
  if (role.provider === 'gemini' || role.provider === 'openai-compatible' || role.provider === 'deepseek' || role.provider === 'anthropic' || role.provider === 'openai-responses') return true
  if (role.provider === 'ollama' || role.provider === 'opencode') {
    return /(llava|vision|-vl\b|vl:|gemma3|minicpm-v|pixtral|qwen2?\.?5-vl)/i.test(role.model)
  }
  return false
}

/** Budget4D (design §7): rounds, tokens, USD (undefined = no cap), wall-clock. */
export interface BudgetLimits {
  maxRounds: number
  maxTotalTokens: number
  maxCostUsd: number | undefined
  maxWallClockMs: number
}

export interface WorkspaceRootConfig {
  id: string
  path: string
  label?: string
  /** Extra roots are read-only unless explicitly made writable. */
  writable?: boolean
  /**
   * Where an extra root is configured: `workspace` (added for this workspace,
   * `workspaceRootsByWorkspace`) or `global` (the legacy `workspaceRoots`,
   * applied to every workspace). Unset for `main`.
   */
  scope?: 'workspace' | 'global'
}

export type ExtraRootInput = { id?: string; path: string; label?: string; writable?: boolean; scope?: 'workspace' | 'global' }

/** Key of `workspaceRootsByWorkspace`: the resolved primary root, case-folded on Windows. */
export function workspaceRootsKey(primary: string): string {
  const resolved = path.resolve(primary)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * The extra roots configured for `primary`: the legacy global `workspaceRoots`
 * (every workspace), then the ones added for this workspace. Roots added from
 * the GUI used to be written to the global list, so they followed the user into
 * every other workspace; they are now stored per workspace.
 */
export function configuredExtraRoots(
  user: { workspaceRoots?: unknown; workspaceRootsByWorkspace?: unknown } | undefined,
  primary: string,
): ExtraRootInput[] {
  const list = (value: unknown): Array<{ id?: string; path: string; label?: string; writable?: boolean }> =>
    Array.isArray(value) ? value.filter((root) => root && typeof root === 'object' && typeof (root as { path?: unknown }).path === 'string') : []
  const byWorkspace = user?.workspaceRootsByWorkspace
  const own =
    byWorkspace && typeof byWorkspace === 'object' && !Array.isArray(byWorkspace)
      ? list((byWorkspace as Record<string, unknown>)[workspaceRootsKey(primary)])
      : []
  return [...list(user?.workspaceRoots).map((root) => ({ ...root, scope: 'global' as const })), ...own.map((root) => ({ ...root, scope: 'workspace' as const }))]
}

/** Whether the model's reasoning stays in the conversation it is sent. */
export type ReasoningHistory = 'none' | 'full'

export interface HarnessConfig {
  workspaceRoot: string
  /** Primary (`main`) plus explicitly added roots. */
  workspaceRoots: WorkspaceRootConfig[]
  stateDir: string
  sandbox: SandboxMode
  /** How `sandbox` was chosen; `default` means nothing set it (CP-01). */
  sandboxSource: 'cli' | 'full-auto' | 'env' | 'config' | 'default'
  /** Absolute paths the confined token must not read (CP-02, resolved). */
  denyRead: string[]
  /** Workspace subdirectories the confined token may read but not write (CP-02). */
  readOnlySubpaths: string[]
  /** Name of the permission profile that contributed `denyRead`. */
  permissionProfile?: string
  role: RoleConfig
  graderRole: RoleConfig
  /** Model used by orchestrator sessions; defaults to the worker role. */
  orchestratorRole: RoleConfig
  /** Model used by `delegate` subagents; defaults to the worker role. */
  subagentRole: RoleConfig
  /** Present when Guardian reviews `prompt` decisions (design §5). */
  guardianRole?: RoleConfig
  guardianApproveBelow: number
  /** Summarizes older turns in compaction tier 2 (design §8); defaults to the worker. */
  compactorRole: RoleConfig
  /** Summarizes visible thinking in Japanese; defaults to the worker. */
  summarizerRole: RoleConfig
  /** `--rule` texts, pinned next to AGENTS.md (design §8). */
  rules: string[]
  limits: ContextLimits
  budget: BudgetLimits
  autoApprove: boolean
  /** CP-05: approval policy (default `untrusted`: every prompt decision asks). */
  approvalPolicy: ApprovalPolicy
  /** `--full-auto`: workspace-write, and prompts that would run confined are approved. */
  fullAuto: boolean
  /**
   * Keep the model's reasoning in the conversation and send it back with each
   * assistant message (DeepSeek `reasoning_content`), so later steps can see
   * why an earlier one did what it did (default). `none` sends only the
   * replies and calls.
   */
  reasoningHistory: ReasoningHistory
  /** System-prompt variant: `default`, or `lean` (a benchmark experiment). */
  promptVariant: 'default' | 'lean'
  ptc: boolean
  projectTrusted: boolean
  protectedPaths: string[]
  envPassthrough: string[]
  /** From user config only; an untrusted project cannot widen writes. */
  extraWritableRoots: string[]
  userPolicyPath?: string
  projectPolicyPath?: string
  /** MCP servers: the user's, plus a trusted project's (spawned processes run as the user). */
  mcpServers: Record<string, McpServerConfig>
  /** The user's hooks, then a trusted project's. */
  hooks: HooksConfig
  /** Codex-style notify command: the turn-end JSON is its last argument. */
  notify?: string[]
  /** web_fetch; on with `--web` or the user's `web.enabled`. */
  web?: WebConfig
  /** Language servers for the `lsp` tool (user config only: they are spawned processes). */
  lsp: Record<string, LspServerConfig>
  /** Plugin modules: the user's, plus a trusted project's (resolved against the workspace). */
  plugins: string[]
  /** Workspace memory across runs (`--memory` or `memory.enabled`). */
  memory: boolean
  /** CP-20: extract workspace memories automatically after each turn. */
  memoryAuto: boolean
  /** CP-38: resolved feature flags. */
  features: Record<string, boolean>
  /** `session_query`: search earlier sessions through the FTS5 index (WP-32). */
  sessionQuery?: boolean
  /** `shell { persistent: true }` by default (`--persistent-shell`, WP-31). */
  persistentShell?: boolean
  /** The resolved bundles: names, tool allowlist, prompt sections, panels (WP-42). */
  bundles: ResolvedBundles
  /** The signed desktop release feed (WP-53); unset means updates are manual. */
  update?: UpdateConfig
}

/** The signed release feed and the key that signs it (WP-53). */
export interface UpdateConfig {
  /** An HTTPS URL, or a local path for an air-gapped install. */
  feed?: string
  /** `stable` unless the feed says otherwise. */
  channel?: string
  /** Ed25519 public key (PEM) or a path to one. */
  publicKey?: string
  /** Check once at start; installing is always an explicit action. */
  autoCheck?: boolean
}

/** Optional first-party automation MCP presets (Playwright / agent-desktop). */
export interface AutomationConfig {
  browser?: {
    enabled?: boolean
    browser?: 'msedge' | 'chrome' | 'chromium' | 'firefox' | 'webkit'
    headless?: boolean
    isolated?: boolean
  }
  desktop?: {
    enabled?: boolean
  }
}

/** Project `limits` for the ledger, spill and compaction (design §1, §8). */
export interface ContextLimits {
  rationaleMaxEntries: number
  rationaleMaxTokens: number
  spillThresholdBytes: number
  compactionTriggerRatio: number
  keepRecentTurns: number
}

export interface CliOverrides {
  cwd?: string
  stateDir?: string
  provider?: ProviderKind
  model?: string
  baseUrl?: string
  apiKeyEnv?: string
  sandbox?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  autoApprove?: boolean
  fullAuto?: boolean
  /** `--text-tools`: the JSON text protocol even where native function calling exists. */
  textTools?: boolean
  memory?: boolean
  /** `--profile`: a named overlay from the user config's `profiles`. */
  profile?: string
  ptc?: boolean
  mock?: boolean
  web?: boolean
  /** `--session-query`: offer the `session_query` tool (FTS5 session search). */
  sessionQuery?: boolean
  /** `--persistent-shell`: `shell` keeps one PowerShell alive (WP-31). */
  persistentShell?: boolean
  /** `--bundle` (repeatable): typed bundles layered on `core` (WP-42). */
  bundle?: string[]
  projectTrusted?: boolean
  /** `--guardian`: review prompts with Guardian, using the worker's provider unless configured. */
  guardian?: boolean
  rules?: string[]
  maxRounds?: number
  maxTotalTokens?: number
  /** `'off'` removes the USD cap. */
  maxCostUsd?: number | 'off'
  maxWallClockMs?: number
}

interface UserConfigFile {
  /** Named overlays selected with `--profile` (Codex config profiles). */
  profiles?: Record<string, Omit<UserConfigFile, 'profiles' | 'trustedProjects'>>
  /** Additional roots for every workspace; the workspace root is always `main`. */
  workspaceRoots?: Array<{ id?: string; path: string; label?: string; writable?: boolean }>
  /** Additional roots per workspace, keyed by `workspaceRootsKey(primary)` (the GUI writes here). */
  workspaceRootsByWorkspace?: Record<string, Array<{ id?: string; path: string; label?: string; writable?: boolean }>>
  roles?: {
    worker?: Partial<RoleConfig>
    orchestrator?: Partial<RoleConfig>
    subagent?: Partial<RoleConfig>
    grader?: Partial<RoleConfig>
    compactor?: Partial<RoleConfig>
    summarizer?: Partial<RoleConfig>
    guardian?: Partial<RoleConfig>
  }
  guardian?: {
    approveBelow?: number
  }
  sandbox?: {
    envPassthrough?: string[]
    extraWritableRoots?: string[]
    /** Opt back into the pre-0.5 default (`unconfined`) without a CLI flag. */
    legacyUnconfined?: boolean
    /** Paths the confined token must not read (CP-02). */
    denyRead?: string[]
    /** Workspace subdirectories that stay read-only for the confined token (CP-02). */
    readOnly?: string[]
  }
  /** Named permission profiles (CP-02). Only the user config may define them. */
  permissions?: Record<string, PermissionProfile>
  /** Profile applied when `--permissions` is absent. */
  defaultPermissions?: string
  /** DPAPI references by name, written by `hy secret set` (CP-08). */
  secrets?: Record<string, string>
  /** CP-38: feature overrides (`streaming: false`). */
  features?: Record<string, boolean>
  userPolicyPath?: string
  trustedProjects?: Array<{ path: string; configSha256?: string }>
  mcpServers?: Record<string, McpServerConfig>
  hooks?: HooksConfig
  notify?: string[]
  web?: WebConfig
  /** Default sandbox mode (a profile can set it). */
  sandboxMode?: SandboxMode
  /** CP-05: how prompt decisions are handled (default untrusted). */
  approvalPolicy?: ApprovalPolicy
  lsp?: Record<string, LspServerConfig>
  plugins?: string[]
  memory?: { enabled?: boolean; auto?: boolean }
  /** `session_query`: full-text search over earlier sessions (WP-32). */
  sessionQuery?: { enabled?: boolean }
  /** Keep one PowerShell alive for the session (`shell { persistent }`). */
  persistentShell?: { enabled?: boolean }
  /** Typed bundles selected by name (WP-42); `--bundle` adds to them. */
  bundles?: string[]
  /** Desktop release feed and the Ed25519 key that signs it (WP-53). */
  update?: UpdateConfig
  /**
   * WP-62: opt-in OTLP tracing. Read by the web server (the exporter lives in
   * `@hy/cli`), so the shape is validated there.
   */
  telemetry?: {
    enabled?: boolean
    endpoint?: string
    serviceName?: string
    sampleRatio?: number
    allowRemote?: boolean
  }
  automation?: AutomationConfig
  /** User-level approval defaults; CLI flags still override them. */
  autoApprove?: boolean
  fullAuto?: boolean
  /** See HarnessConfig.reasoningHistory. */
  reasoningHistory?: ReasoningHistory
  /** See HarnessConfig.promptVariant. */
  promptVariant?: 'default' | 'lean'
  /** Reusable model definitions shown in Settings. */
  models?: Array<{
    id: string
    name: string
    provider: ProviderKind
    model: string
    baseUrl?: string
    apiKeyEnv?: string
    contextWindowTokens?: number
    maxOutputTokens?: number
  }>
}

interface ProjectConfigFile {
  protectedPaths?: string[]
  limits?: Partial<ContextLimits>
  budget4D?: Partial<{ maxRounds: number; maxTotalTokens: number; maxCostUsd: number; maxWallClockMs: number }>
  /** Used only when the project is trusted. */
  mcpServers?: Record<string, McpServerConfig>
  /** Used only when the project is trusted. */
  hooks?: HooksConfig
  /** Used only when the project is trusted; paths relative to the workspace. */
  plugins?: string[]
}

const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'low-integrity', 'unconfined']

/** Validates an approval policy from the CLI or user config (CP-05). */
export function parseApprovalPolicy(value: string): ApprovalPolicy {
  if ((APPROVAL_POLICIES as readonly string[]).includes(value)) return value as ApprovalPolicy
  throw new Error(`unknown approval policy ${JSON.stringify(value)}; expected one of ${APPROVAL_POLICIES.join('`, ')}`)
}

/** Validates a sandbox mode from the CLI or `HY_SANDBOX`. */
export function parseSandboxMode(value: string): SandboxMode {
  if ((SANDBOX_MODES as readonly string[]).includes(value)) return value as SandboxMode
  throw new Error(`unknown sandbox mode ${JSON.stringify(value)}; expected one of ${SANDBOX_MODES.join(', ')}`)
}

/**
 * The user's HY-HARNESS directory: `config.json`, `policy.star`, `AGENTS.md`
 * and `skills/` (`%APPDATA%\hy-harness`; `HY_CONFIG_DIR` overrides it).
 */
export function userConfigDir(): string {
  return process.env.HY_CONFIG_DIR ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'hy-harness')
}

/**
 * CP-08: rewrites the user `config.json` through `mutate` (atomic replace).
 * Used by `hy secret set/remove`; unrelated keys and formatting are preserved
 * as JSON (comments are not supported by the config format).
 */
export function writeUserConfig(mutate: (config: Record<string, unknown>) => void): string {
  const file = path.join(userConfigDir(), 'config.json')
  let config: Record<string, unknown> = {}
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mutate(config)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return file
}

export function canonicalWorkspace(cwd?: string): string {
  const root = path.resolve(cwd ?? process.cwd())
  return fs.realpathSync.native(root)
}

/** Validates user-added roots: absolute, existing, unique and outside the primary root. */
export function workspaceRootsFor(
  primary: string,
  extras: ReadonlyArray<ExtraRootInput> = [],
): WorkspaceRootConfig[] {
  const roots: WorkspaceRootConfig[] = [
    { id: 'main', path: primary, label: path.basename(primary) || primary, writable: true },
  ]
  const ids = new Set(['main'])
  const paths = new Set([path.resolve(primary)])
  for (const extra of extras) {
    if (!extra || typeof extra.path !== 'string' || !path.isAbsolute(extra.path)) continue
    let real: string
    try {
      const stat = fs.statSync(extra.path)
      if (!stat.isDirectory()) continue
      real = fs.realpathSync.native(extra.path)
    } catch {
      continue
    }
    if (paths.has(path.resolve(real))) continue
    let id = (extra.id ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!id || ids.has(id)) id = `root-${roots.length + 1}`
    while (ids.has(id)) id = `${id}-${roots.length + 1}`
    ids.add(id)
    paths.add(path.resolve(real))
    roots.push({
      id,
      path: real,
      label: (extra.label ?? path.basename(real) ?? id).trim() || id,
      writable: extra.writable === true,
      ...(extra.scope ? { scope: extra.scope } : {}),
    })
  }
  return roots
}

export function stateDirFor(workspaceRoot: string): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  const id = workspaceId(workspaceRoot)
  return path.join(base, 'hy-harness', 'state', id)
}

export function workspaceId(workspaceRoot: string): string {
  return createHash('sha256').update(workspaceRoot.toLowerCase()).digest('hex').slice(0, 16)
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * Old OpenCode Go profiles used the DeepSeek-direct model name. The gateway
 * rejects it with HTTP 400 "Model is unavailable", so map it while loading.
 */
const OPENCODE_MODEL_ALIASES: Record<string, string> = {
  'deepseek-flash': 'deepseek-v4.1-flash',
  'deepseek-v4-flash': 'deepseek-v4.1-flash',
}

function isOpenCodeBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'opencode.ai' || host.endsWith('.opencode.ai')
  } catch {
    return false
  }
}

function normalizeOpenCodeRole(role: RoleConfig): void {
  if (role.provider !== 'opencode' && !isOpenCodeBaseUrl(role.baseUrl)) return
  role.model = OPENCODE_MODEL_ALIASES[role.model] ?? role.model
}

function defaultRole(provider: ProviderKind): RoleConfig {
  switch (provider) {
    case 'ollama':
      return {
        provider,
        model: 'qwen2.5:3b',
        baseUrl: 'http://127.0.0.1:11434',
        contextWindowTokens: 32_768,
        maxOutputTokens: 8_192,
        temperature: 0,
        pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
      }
    case 'deepseek':
      return {
        provider,
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        // Native: 1,048,576 context / 393,216 output. The client caps output
        // at the 25% left by compactionTriggerRatio so input + max_tokens
        // cannot exceed the context window.
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 262_144,
        temperature: 0,
      }
    case 'openai-compatible':
      return {
        provider,
        model: 'gpt-4.1-mini',
        baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        // GPT-4.1 mini: 1,047,576 context, 32,768 max output.
        contextWindowTokens: 1_047_576,
        maxOutputTokens: 32_768,
        temperature: 0,
      }
    case 'openai-responses':
      return {
        provider,
        model: 'gpt-4.1-mini',
        baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        contextWindowTokens: 1_047_576,
        maxOutputTokens: 32_768,
        temperature: 0,
      }
    case 'anthropic':
      // The Messages API; `extra` reasoning effort maps to `thinking` budgets.
      return {
        provider,
        model: 'claude-sonnet-4-5',
        baseUrl: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_768,
        temperature: 0,
      }
    case 'opencode':
      return {
        provider,
        model: 'deepseek-v4.1-flash',
        baseUrl: 'https://opencode.ai/inference/go/openai/v1',
        apiKeyEnv: 'OPENCODE_API_KEY',
        contextWindowTokens: 1_000_000,
        // Native max output is 384K; OpenCode Go caps completion tokens at
        // 131,072. Thinking mode can spend most of a small budget on
        // reasoning, which truncated tool calls at the old 8K default.
        maxOutputTokens: 131_072,
        temperature: 0,
      }
    case 'gemini':
      // The Interactions API (verification/sources/gemini_thinking.txt).
      return {
        provider,
        model: 'gemini-3.8-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKeyEnv: 'GEMINI_API_KEY',
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 65_536,
        temperature: 0,
      }
    case 'mock':
      return {
        provider,
        model: 'mock',
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
        temperature: 0,
        pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
      }
  }
}

function envProvider(): ProviderKind | undefined {
  const v = process.env.HY_PROVIDER
  const kinds: readonly ProviderKind[] = ['ollama', 'deepseek', 'openai-compatible', 'openai-responses', 'opencode', 'gemini', 'anthropic', 'mock']
  return kinds.find((kind) => kind === v)
}

/** First-party automation presets are ordinary MCP servers, opt-in from the user config. */
function automationServers(user: UserConfigFile | undefined): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  const automation = user?.automation
  if (!automation) return out
  const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

  if (automation.browser?.enabled === true) {
    const browser = automation.browser.browser ?? 'chrome'
    const cli = path.join(harnessRoot, 'node_modules', '@playwright', 'mcp', 'cli.js')
    const flags = [
      '--browser',
      browser,
      ...(automation.browser.headless === true ? ['--headless'] : []),
      ...(automation.browser.isolated === true ? ['--isolated'] : []),
    ]
    out.playwright = fs.existsSync(cli)
      ? {
          command: process.execPath,
          args: [cli, ...flags],
          // Electron's executable is the Node runtime for stdio MCP servers.
          env: { ELECTRON_RUN_AS_NODE: '1' },
          timeoutMs: 120_000,
          trusted: false,
        }
      : {
          command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
          args: ['-y', '@playwright/mcp@latest', ...flags],
          timeoutMs: 120_000,
          trusted: false,
        }
  }

  if (automation.desktop?.enabled === true) {
    const dist = path.join(harnessRoot, 'packages', 'core', 'dist', 'agent-desktop-mcp.mjs')
    const src = path.join(harnessRoot, 'packages', 'core', 'src', 'agent-desktop-mcp.mjs')
    const wrapper = fs.existsSync(dist) ? dist : src
    const bin = path.join(harnessRoot, 'node_modules', 'agent-desktop', 'bin', 'agent-desktop')
    out['agent-desktop'] = {
      command: process.execPath,
      args: [wrapper],
      env: { ELECTRON_RUN_AS_NODE: '1', AGENT_DESKTOP_BIN: bin },
      timeoutMs: 120_000,
      trusted: false,
    }
  }
  return out
}

export function loadConfig(overrides: CliOverrides = {}): HarnessConfig {
  const workspaceRoot = canonicalWorkspace(overrides.cwd)
  const userConfigPath = path.join(userConfigDir(), 'config.json')
  const user = applyProfile(readJson<UserConfigFile>(userConfigPath), overrides.profile)
  const workspaceRoots = workspaceRootsFor(workspaceRoot, configuredExtraRoots(user, workspaceRoot))
  const projectConfigPath = path.join(workspaceRoot, '.hy-harness', 'config.json')
  const project = readJson<ProjectConfigFile>(projectConfigPath)

  // WP-42: `core` first, then the profile's/user's bundles, then `--bundle`.
  const bundles = resolveBundles([...(user?.bundles ?? []), ...(overrides.bundle ?? [])])

  const provider: ProviderKind =
    overrides.mock === true
      ? 'mock'
      : overrides.provider ?? envProvider() ?? user?.roles?.worker?.provider ?? 'ollama'

  const role: RoleConfig = {
    ...defaultRole(provider),
    ...bundles.roleDefaults,
    ...(user?.roles?.worker ?? {}),
  }
  if (overrides.model !== undefined) role.model = overrides.model
  if (overrides.baseUrl !== undefined) role.baseUrl = overrides.baseUrl
  if (overrides.apiKeyEnv !== undefined) role.apiKeyEnv = overrides.apiKeyEnv
  if (overrides.textTools === true) role.nativeTools = false
  role.provider = provider

  const graderProvider: ProviderKind = overrides.mock === true ? 'mock' : user?.roles?.grader?.provider ?? provider
  const graderRole: RoleConfig = {
    ...defaultRole(graderProvider),
    ...(overrides.mock === true ? {} : user?.roles?.grader ?? {}),
  }
  graderRole.provider = graderProvider

  // These roles inherit the worker until the user gives them their own model.
  const orchestratorProvider: ProviderKind = overrides.mock === true ? 'mock' : user?.roles?.orchestrator?.provider ?? provider
  const orchestratorRole: RoleConfig =
    overrides.mock === true || user?.roles?.orchestrator === undefined
      ? role
      : {
          ...(orchestratorProvider === provider ? role : defaultRole(orchestratorProvider)),
          ...user.roles.orchestrator,
          provider: orchestratorProvider,
        }
  const subagentProvider: ProviderKind = overrides.mock === true ? 'mock' : user?.roles?.subagent?.provider ?? provider
  const subagentRole: RoleConfig =
    overrides.mock === true || user?.roles?.subagent === undefined
      ? role
      : {
          ...(subagentProvider === provider ? role : defaultRole(subagentProvider)),
          ...user.roles.subagent,
          provider: subagentProvider,
        }

  let guardianRole: RoleConfig | undefined
  if (overrides.guardian === true || user?.roles?.guardian !== undefined) {
    const guardianProvider: ProviderKind = overrides.mock === true ? 'mock' : user?.roles?.guardian?.provider ?? provider
    guardianRole = { ...defaultRole(guardianProvider), ...(overrides.mock === true ? {} : user?.roles?.guardian ?? {}) }
    guardianRole.provider = guardianProvider
  }

  const compactorProvider: ProviderKind = overrides.mock === true ? 'mock' : user?.roles?.compactor?.provider ?? provider
  const compactorRole: RoleConfig = {
    ...(compactorProvider === provider ? role : defaultRole(compactorProvider)),
    ...(overrides.mock === true ? {} : user?.roles?.compactor ?? {}),
  }
  compactorRole.provider = compactorProvider

  const summarizerProvider: ProviderKind = overrides.mock === true ? 'mock' : user?.roles?.summarizer?.provider ?? provider
  const summarizerRole: RoleConfig = {
    ...(summarizerProvider === provider ? role : defaultRole(summarizerProvider)),
    ...(overrides.mock === true ? {} : user?.roles?.summarizer ?? {}),
  }
  summarizerRole.provider = summarizerProvider
  for (const roleConfig of [role, graderRole, orchestratorRole, subagentRole, guardianRole, compactorRole, summarizerRole]) {
    if (roleConfig) normalizeOpenCodeRole(roleConfig)
  }

  // CP-08: resolve `apiKeySecret` (and `dpapi:` apiKey values) through the
  // DPAPI helper. The plaintext exists only in memory; `hy config dump`
  // redacts `apiKey` unless --show-secrets is given.
  const namedSecrets = user?.secrets ?? {}
  const resolveRoleSecrets = (roleConfig: RoleConfig, label: string): void => {
    if (roleConfig.apiKeySecret !== undefined) {
      const ref = namedSecrets[roleConfig.apiKeySecret]
      if (ref === undefined) {
        throw new Error(
          `${label}: unknown secret ${roleConfig.apiKeySecret}; run: hy secret set ${roleConfig.apiKeySecret}`,
        )
      }
      roleConfig.apiKey = resolveSecretRef(ref, undefined, `${label} secret ${roleConfig.apiKeySecret}`)
      delete roleConfig.apiKeySecret
    } else if (roleConfig.apiKey !== undefined && isSecretRef(roleConfig.apiKey)) {
      roleConfig.apiKey = resolveSecretRef(roleConfig.apiKey, undefined, `${label} apiKey`)
    }
  }
  resolveRoleSecrets(role, 'worker')
  resolveRoleSecrets(graderRole, 'grader')
  resolveRoleSecrets(orchestratorRole, 'orchestrator')
  resolveRoleSecrets(subagentRole, 'subagent')
  resolveRoleSecrets(compactorRole, 'compactor')
  resolveRoleSecrets(summarizerRole, 'summarizer')
  if (guardianRole !== undefined) resolveRoleSecrets(guardianRole, 'guardian')

  const trustedProject =
    overrides.projectTrusted === true || (user?.trustedProjects ?? []).some((t) => path.resolve(t.path) === workspaceRoot)
  // Untrusted projects may only make these stricter than the defaults.
  const pl = project?.limits ?? {}
  const tighten = (v: number | undefined, def: number, stricter: (a: number, b: number) => number) =>
    v === undefined || !Number.isFinite(v) ? def : trustedProject ? v : stricter(v, def)
  const limits: ContextLimits = {
    rationaleMaxEntries: tighten(pl.rationaleMaxEntries, 12, Math.min),
    rationaleMaxTokens: tighten(pl.rationaleMaxTokens, 1_500, Math.min),
    spillThresholdBytes: tighten(pl.spillThresholdBytes, 32 * 1024, Math.min),
    compactionTriggerRatio: tighten(pl.compactionTriggerRatio, 0.75, Math.min),
    keepRecentTurns: tighten(pl.keepRecentTurns, 2, Math.max),
  }
  const pb = project?.budget4D ?? {}
  const projectCost = tighten(pb.maxCostUsd, 2, Math.min)
  const budget: BudgetLimits = {
    maxRounds: overrides.maxRounds ?? tighten(pb.maxRounds, 5, Math.min),
    maxTotalTokens: overrides.maxTotalTokens ?? tighten(pb.maxTotalTokens, 500_000, Math.min),
    maxCostUsd: overrides.maxCostUsd === 'off' ? undefined : overrides.maxCostUsd ?? projectCost,
    maxWallClockMs: overrides.maxWallClockMs ?? tighten(pb.maxWallClockMs, 30 * 60_000, Math.min),
  }

  // CP-01: the default is `workspace-write` (Codex's fail-safe default). An
  // explicit `--sandbox`, `--full-auto`, `HY_SANDBOX` or a config value
  // still wins, and `sandbox.legacyUnconfined` keeps the old behaviour for
  // existing setups without a CLI flag.
  // CP-02: resolve the permission profile and its path lists. Only the user
  // config can define profiles; the project config cannot widen them.
  const permissionName = user?.defaultPermissions
  const profile =
    permissionName !== undefined ? mergePermissionProfile(permissionName, user?.permissions ?? {}) : undefined
  const denyRead = resolveDenyRead([...(profile?.denyRead ?? []), ...(user?.sandbox?.denyRead ?? [])], workspaceRoot)
  const readOnlySubpaths = resolveReadOnly(
    [...(profile?.readOnly ?? []), ...(user?.sandbox?.readOnly ?? [])],
    workspaceRoot,
  )

  const sandboxSource: HarnessConfig['sandboxSource'] =
    overrides.sandbox !== undefined
      ? 'cli'
      : overrides.fullAuto
        ? 'full-auto'
        : process.env.HY_SANDBOX
          ? 'env'
          : user?.sandboxMode !== undefined
            ? 'config'
            : 'default'
  const sandbox: SandboxMode =
    overrides.sandbox ??
    (overrides.fullAuto ? 'workspace-write' : undefined) ??
    (process.env.HY_SANDBOX ? parseSandboxMode(process.env.HY_SANDBOX) : undefined) ??
    user?.sandboxMode ??
    (user?.sandbox?.legacyUnconfined === true ? 'unconfined' : 'workspace-write')

  const trusted = trustedProject

  const userPolicyPath =
    user?.userPolicyPath ?? path.join(userConfigDir(), 'policy.star')
  const projectPolicyPath = path.join(workspaceRoot, '.hy-harness', 'policies', 'project.star')
  const mcpServers = {
    ...automationServers(user),
    ...(user?.mcpServers ?? {}),
    ...(trusted ? project?.mcpServers ?? {} : {}),
  }

  return {
    workspaceRoot,
    workspaceRoots,
    stateDir: path.resolve(overrides.stateDir ?? stateDirFor(workspaceRoot)),
    sandbox,
    sandboxSource,
    denyRead,
    readOnlySubpaths,
    ...(permissionName !== undefined ? { permissionProfile: permissionName } : {}),
    role,
    graderRole,
    orchestratorRole,
    subagentRole,
    ...(guardianRole !== undefined ? { guardianRole } : {}),
    guardianApproveBelow: user?.guardian?.approveBelow ?? 80,
    compactorRole,
    summarizerRole,
    rules: overrides.rules ?? [],
    limits,
    budget,
    approvalPolicy: overrides.approvalPolicy ?? user?.approvalPolicy ?? 'untrusted',
    autoApprove: overrides.autoApprove ?? user?.autoApprove ?? false,
    fullAuto: overrides.fullAuto ?? user?.fullAuto ?? false,
    // Default full since 2026-11-07: in the benchmark it cut tool calls, requests
    // and output tokens without raising prompt or uncached tokens.
    reasoningHistory: user?.reasoningHistory === 'none' ? 'none' : 'full',
    promptVariant: user?.promptVariant === 'lean' ? 'lean' : 'default',
    ptc: overrides.ptc ?? process.env.HY_PTC === '1',
    projectTrusted: trusted,
    protectedPaths: project?.protectedPaths ?? [],
    envPassthrough: user?.sandbox?.envPassthrough ?? [],
    extraWritableRoots: (user?.sandbox?.extraWritableRoots ?? []).map((r) => path.resolve(r)),
    ...(fs.existsSync(userPolicyPath) ? { userPolicyPath } : {}),
    ...(fs.existsSync(projectPolicyPath) ? { projectPolicyPath } : {}),
    mcpServers,
    hooks: mergeHooks(user?.hooks, trusted ? project?.hooks : undefined),
    lsp: user?.lsp ?? {},
    memory: overrides.memory === true || user?.memory?.enabled === true,
    memoryAuto: user?.memory?.auto === true,
    features: resolveFeatures(user?.features ?? {}),
    plugins: [...(user?.plugins ?? []), ...(trusted ? (project?.plugins ?? []).map((p) => path.resolve(workspaceRoot, p)) : [])],
    ...(user?.notify?.length ? { notify: user.notify } : {}),
    ...(overrides.web === true || user?.web?.enabled === true ? { web: { ...(user?.web ?? {}), enabled: true } } : {}),
    ...(overrides.sessionQuery === true || user?.sessionQuery?.enabled === true ? { sessionQuery: true } : {}),
    ...(overrides.persistentShell === true || user?.persistentShell?.enabled === true ? { persistentShell: true } : {}),
    ...(user?.update ? { update: { ...user.update } } : {}),
    bundles,
  }
}

/** Expands `~`, `$HOME` and `%VAR%`, then resolves against the workspace. */
function expandUserPath(value: string, workspaceRoot: string): string {
  let out = value.trim()
  if (out === '~' || out === '$HOME') out = os.homedir()
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = path.join(os.homedir(), out.slice(2))
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name: string) => process.env[name] ?? '')
  return path.resolve(workspaceRoot, out)
}

/**
 * CP-02: normalizes `denyRead` entries (profile + `sandbox.denyRead`), keeping
 * the first spelling of a path and dropping case-only duplicates (Windows).
 */
export function resolveDenyRead(paths: readonly string[], workspaceRoot: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of paths) {
    if (!raw || !raw.trim()) continue
    const abs = expandUserPath(raw, workspaceRoot)
    const key = abs.toLowerCase().replace(/[\\/]+$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(abs)
  }
  return out
}

/**
 * CP-02: merges a named profile with its `extends` chain (base first). Cycles
 * and unknown names fail closed with the list of defined profiles.
 */
export function mergePermissionProfile(
  name: string,
  profiles: Record<string, PermissionProfile>,
  seen: readonly string[] = [],
): PermissionProfile {
  if (seen.includes(name)) throw new Error(`permission profile cycle: ${[...seen, name].join(' -> ')}`)
  const profile = profiles[name]
  if (profile === undefined) {
    const defined = Object.keys(profiles).join(', ') || 'none'
    throw new Error(`unknown permission profile ${name}; defined: ${defined}`)
  }
  const base = profile.extends === undefined ? undefined : mergePermissionProfile(profile.extends, profiles, [...seen, name])
  const description = profile.description ?? base?.description
  return {
    ...(description === undefined ? {} : { description }),
    denyRead: [...(base?.denyRead ?? []), ...(profile.denyRead ?? [])],
    readOnly: [...(base?.readOnly ?? []), ...(profile.readOnly ?? [])],
    ...(base?.write ?? profile.write
      ? { write: [...(base?.write ?? []), ...(profile.write ?? [])] }
      : {}),
  }
}

/**
 * CP-02: `readOnly` carve-outs must be inside the workspace (the grant covers
 * it); anything else cannot be enforced, so the config is rejected.
 */
export function resolveReadOnly(paths: readonly string[], workspaceRoot: string): string[] {
  const resolved = resolveDenyRead(paths, workspaceRoot)
  const root = path.resolve(workspaceRoot).toLowerCase()
  for (const p of resolved) {
    const lower = p.toLowerCase()
    if (lower === root || !lower.startsWith(root + path.sep)) {
      throw new Error(`readOnly path ${p} is not a subdirectory of the workspace`)
    }
  }
  return resolved
}

/** The user config with `profiles[name]` laid over it (objects merged, other values replaced). */
function applyProfile(user: UserConfigFile | undefined, name: string | undefined): UserConfigFile | undefined {
  if (name === undefined) return user
  const profile = user?.profiles?.[name]
  if (!profile) throw new Error(`unknown profile ${name}; defined: ${Object.keys(user?.profiles ?? {}).join(', ') || 'none'}`)
  const merge = (a: unknown, b: unknown): unknown => {
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
      for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = merge(out[k], v)
      return out
    }
    return b === undefined ? a : b
  }
  return merge(user, profile) as UserConfigFile
}

/**
 * The user's hooks, then a trusted project's, for every event. It used to list
 * three events by name, so the CP-19 events (sessionStart, userPromptSubmit,
 * permissionRequest, stop, …) were dropped on load and never ran.
 */
function mergeHooks(a: HooksConfig = {}, b: HooksConfig = {}): HooksConfig {
  const out: Record<string, HookSpec[]> = {}
  for (const source of [a, b] as Array<Record<string, HookSpec[] | undefined>>) {
    for (const [event, specs] of Object.entries(source)) {
      if (Array.isArray(specs)) out[event] = [...(out[event] ?? []), ...specs]
    }
  }
  return out as HooksConfig
}

export function roleApiKey(role: RoleConfig): string | undefined {
  if (role.provider === 'ollama' || role.provider === 'mock') return undefined
  if (role.apiKey?.trim()) return role.apiKey.trim()
  const env =
    role.apiKeyEnv ??
    (role.provider === 'deepseek'
      ? 'DEEPSEEK_API_KEY'
      : role.provider === 'gemini'
        ? 'GEMINI_API_KEY'
        : role.provider === 'opencode'
          ? 'OPENCODE_API_KEY'
          : role.provider === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : 'OPENAI_API_KEY')
  return process.env[env]
}

/** CP-37: every path a config layer can come from, for `hy config paths`. */
export interface ConfigPaths {
  workspaceRoot: string
  userConfig: string
  projectConfig: string
  userSkills: string
  projectSkills: string
  stateDir: string
  spillDir: string
  worktreesDir: string
  sessionsDir: string
}

export function configPaths(workspaceRoot: string, stateDir: string): ConfigPaths {
  return {
    workspaceRoot,
    userConfig: path.join(userConfigDir(), 'config.json'),
    projectConfig: path.join(workspaceRoot, '.hy-harness', 'config.json'),
    userSkills: path.join(userConfigDir(), 'skills'),
    projectSkills: path.join(workspaceRoot, '.hy-harness', 'skills'),
    stateDir,
    spillDir: path.join(stateDir, 'spill'),
    worktreesDir: path.join(stateDir, 'worktrees'),
    sessionsDir: path.join(stateDir, 'sessions'),
  }
}