/** The work modes the server accepts (core WORK_MODES), in display order. */
export const WORK_MODES = ['fast', 'thorough', 'reflective'] as const
export type WorkMode = (typeof WORK_MODES)[number]
export function isWorkMode(value: unknown): value is WorkMode {
  return typeof value === 'string' && (WORK_MODES as readonly string[]).includes(value)
}
/** How the agent involves the user (core INTERACTION_MODES); combined with any work mode. */
export const INTERACTION_MODES = ['autonomous', 'collaborative'] as const
export type InteractionMode = (typeof INTERACTION_MODES)[number]
export function isInteractionMode(value: unknown): value is InteractionMode {
  return typeof value === 'string' && (INTERACTION_MODES as readonly string[]).includes(value)
}

export type SessionKind = 'chat' | 'orchestrator' | 'worker'
export type WorkerStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'done'

export type WorkerReportStatus = 'done' | 'partial' | 'blocked'

export interface SessionSummary {
  runId: string
  started: number
  last: number
  turns: number
  first: string
  ralph: boolean
  busy?: boolean
  planMode?: boolean
  pinned?: boolean
  archived?: boolean
  lastError?: string
  kind?: SessionKind
  parentRunId?: string
  orchestrationId?: string
  workerStatus?: WorkerStatus
  workerTitle?: string
  /** A user-assigned chat name; absent means the automatic title shows. */
  title?: string
  /** WP-60: a model-generated name, used when there is no manual one. */
  generatedTitle?: string
  /** WP-60: the chat this one was forked from. */
  forkedFrom?: string
}

export interface WorkerView {
  workerId: string
  title: string
  task: string
  scope: string[]
  status: WorkerStatus
  createdAt: number
  updatedAt: number
  lastEventAt: number
  lastSummary?: string | null
  lastError?: string | null
  reportStatus?: WorkerReportStatus | null
  blocker?: string | null
  closedAt?: number | null
}

export interface OrchestrationRecord {
  id: string
  orchestratorRunId: string
  status: 'active' | 'stopped'
  createdAt: number
  updatedAt: number
  maxWorkers: number
  workers: WorkerView[]
}

export interface OrchestrationView {
  active: OrchestrationRecord | null
}

export interface ModelProfile {
  id: string
  name: string
  provider: string
  model: string
  baseUrl?: string
  apiKeyEnv?: string
  contextWindowTokens?: number
  maxOutputTokens?: number
}

export interface RoleSummary {
  provider: string
  model: string
  /** CP-35: native function calling or tools described in the prompt. */
  toolMode?: 'native' | 'text'
  vision?: boolean
  baseUrl?: string
  apiKeyEnv?: string
  apiKeySet?: boolean
  contextWindowTokens: number
  maxOutputTokens: number
  effort?: string
  temperature?: number
  pricing?: unknown
  nativeTools?: boolean
}

export interface WorkspaceRootView {
  id: string
  path: string
  label: string
  writable: boolean
  /** `global`: applies to every workspace (legacy config); `workspace`: this workspace only. */
  scope?: 'workspace' | 'global'
}

export interface ConfigSummary {
  workspace: string
  roots: WorkspaceRootView[]
  stateDir: string
  sandbox: string
  worker: RoleSummary
  orchestrator: RoleSummary
  subagent: RoleSummary
  guardian: RoleSummary | null
  grader: RoleSummary
  compactor: RoleSummary
  summarizer: RoleSummary
  guardianApproveBelow: number
  ptc: boolean
  autoApprove: boolean
  fullAuto: boolean
  trusted: boolean
  limits: Record<string, number>
  budget: Record<string, number | undefined>
  features: {
    web: boolean
    search: boolean
    memory: boolean
    mcp: string[]
    plugins: number
    lsp: string[]
    guardian: boolean
  }
  settingsPath: string
}

export interface SandboxInfo {
  enforcement?: string
  gaps?: string[]
  grantedRoots?: string[]
  privateTemp?: string
  workspaceWriteAvailable?: boolean
  unavailableReason?: string
  unprotectedHardLinks?: number
  notices?: string[]
  error?: string
  /** CP-02/CP-06: applied path policies and the denials of this session. */
  denyRead?: string[]
  denyReadFailed?: string[]
  readOnly?: string[]
  readOnlyFailed?: string[]
}

export interface Bootstrap {
  version: string
  /** Which build is running (build-info.json); empty when unknown. */
  build?: { commit?: string; dirty?: boolean; builtAt?: string }
  desktop: boolean
  workspace: { root: string; name: string; stateDir: string; roots?: WorkspaceRootView[] }
  config: ConfigSummary
  sessions: SessionSummary[]
  orchestration?: OrchestrationView
  sandbox: SandboxInfo
  capabilities: SandboxInfo
  /** WP-53: the first-run wizard is open until this says complete. */
  onboarding?: OnboardingView
}

/** WP-53: workspace → sandbox → model, saved in `<stateDir>/onboarding.json`. */
export interface OnboardingView {
  complete: boolean
  skipped: boolean
  steps: Array<'workspace' | 'sandbox' | 'model'>
  workspace: { root: string; name: string }
  sandbox: string
  model: { provider: string; model: string; baseUrl: string | null; apiKeyEnv: string | null; hasApiKey: boolean }
  saved: { sandbox: string | null; provider: string | null; model: string | null; baseUrl: string | null }
  choices: { sandboxes: string[]; providers: string[] }
}

/** WP-60: measured session timings (see `session-stats.ts`). */
export interface SessionStatsView {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  lastTurnMs: number
  firstResponseMs: number
  tools: Record<string, { calls: number; errors: number; ms: number }>
}

/** WP-60: an earlier chat offered as an `@session:` reference. */
export interface ReferenceSession {
  runId: string
  title: string | null
  first: string
  turns: number
  last: number
  label: string
}

/** WP-61: a program this machine can open a file with. */
export interface OpenInTargetView {
  id: string
  label: string
  kind: 'editor' | 'folder' | 'terminal' | 'git'
  command: string
}

/** WP-53: one signed release from the feed. */
export interface UpdateRelease {
  version: string
  url: string
  sha256: string
  size?: number
  channel?: string
  publishedAt?: string
  notes?: string
  mandatory?: boolean
}

export interface UpdateCheck {
  currentVersion: string
  channel: string
  feed: string | null
  configured: boolean
  release: UpdateRelease | null
  reason?: string
  error?: string
  hint?: string
}

export interface UpdateFetch {
  file: string
  sha256: string
  bytes: number
  sidecar: string
  version: string
  mandatory: boolean
}

export interface ChatPlanStep {
  step: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ChatToolEntry {
  id: string
  kind: 'tool'
  runId: string
  callId: string
  name: string
  args?: unknown
  output?: string
  result?: unknown
  isError?: boolean
  /** CP-06: why the call was blocked (policy/approval/sandbox/…). */
  denial?: string
  step?: number
  subagent?: string
  ts: number
  status: 'running' | 'done' | 'error'
}

export interface DeliverableFile {
  path: string
  size: number
  lines: number
  description?: string
}

/** CP-34: what an approval would do (server: approval-view.ts). */
export interface ApprovalDetails {
  cwd: string
  sandbox: string
  effect: string
  paths: string[]
  network: string[]
  persistable: boolean
}

export type ChatEntry =
  | { id: string; kind: 'user'; runId: string; text: string; ts: number; images?: number; steering?: boolean; turn?: number }
  | { id: string; kind: 'assistant'; runId: string; text: string; ts: number; final?: boolean }
  | { id: string; kind: 'thinking'; runId: string; text: string; ts: number; summary?: string; summaryProvisional?: boolean }
  | ChatToolEntry
  | { id: string; kind: 'plan'; runId: string; plan: ChatPlanStep[]; ts: number }
  | { id: string; kind: 'deliverables'; runId: string; files: DeliverableFile[]; ts: number }
  | { id: string; kind: 'notice'; runId: string; text: string; ts: number; level?: 'info' | 'warn' | 'error' }
  | { id: string; kind: 'approval'; runId: string; requestId: string; request: ApprovalRequest; ts: number; decision?: 'approved' | 'denied'; details?: ApprovalDetails; reason?: string; scope?: 'once' | 'session' | 'always' }
  | { id: string; kind: 'question'; runId: string; requestId: string; question: string; ts: number; answer?: string }

export interface ApprovalRequest {
  command: string
  justification?: string
  sandbox?: string
  matchedRule?: string
  cwd?: string
}

export interface GoalStateView {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  roundsStarted: number
  maxGoalRounds: number
  blockerReason?: string
  activation: 'armed' | 'disarmed'
}

export interface SessionState {
  runId: string
  kind?: SessionKind
  parentRunId?: string
  orchestrationId?: string
  workerStatus?: WorkerStatus
  workerTitle?: string
  busy: boolean
  turns: number
  planMode: boolean
  workMode?: WorkMode
  interactionMode?: InteractionMode
  /** WP-12: the session's live sandbox mode. */
  sandboxMode?: 'read-only' | 'workspace-write' | 'low-integrity' | 'unconfined'
  goal?: string | null
  goalState?: GoalStateView | null
  model?: { provider: string; model: string }
  usage: {
    inputTokens: number
    outputTokens: number
    cacheHitTokens?: number
    cacheMissTokens?: number
    cacheUsageComplete?: boolean
    lastInputTokens?: number
    lastOutputTokens?: number
    lastCacheHitTokens?: number
    lastCacheMissTokens?: number
  }
  effort?: string
  lastError?: string
}

export interface JobRecord {
  jobId: string
  command: string
  status: string
  started: number
  updated: number
}

export interface JobInfo {
  jobId: string
  command: string
  state: string
  outputBytes: number
  exitCode?: number | null
  sandbox: string
}

export interface SubagentSummary {
  runId: string
  readOnly: boolean
  started: number
  entries: number
  preview: string
}

/** A background subagent the chat can keep talking to (WP-22). */
export interface AgentView {
  agentId: string
  parentRunId: string
  task: string
  readOnly: boolean
  status: 'running' | 'idle' | 'interrupted' | 'closed'
  createdAt: number
  updatedAt: number
  turns: number
  final?: string
  error?: string
  background: boolean
}

export interface TrajectoryEvent {
  v: number
  seq: number
  ts: number
  type: string
  payload: unknown
  runId?: string
  round?: number
}

export interface McpToolSummary {
  server: string
  name: string
  description: string
  readOnly: boolean
}

export interface PluginToolSummary {
  name: string
  description: string
  readOnly: boolean
  plugin: string
}

export interface PluginCatalog {
  configured: string[]
  tools: PluginToolSummary[]
  errors: string[]
  directories: Array<{ path: string; files: string[] }>
}

export interface AutomationSchedule {
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
  nextRun?: string
}

export interface AutomationWebhook {
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
  endpoint: string
}

export interface AutomationRun {
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

export interface AutomationData {
  schedules: AutomationSchedule[]
  webhooks: AutomationWebhook[]
  runs: AutomationRun[]
  active: string[]
}

export interface MemoryEntry {
  key: string
  text: string
  updated: string
}

export interface RalphStatus {
  id: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  objective: string
  runId?: string
  output: string
  started: number
  ended?: number
}

export interface SessionSnapshot {
  runId: string
  entries: ChatEntry[]
  state: SessionState
}

export interface QueuedTurnView {
  /** Client-provided id; the de-duplication and cancel key. */
  id: string
  message: string
  /** Number of attached images. The bytes stay on the server. */
  images: number
  queuedAt: number
}

/**
 * Shape of every `/api/turn-queue` response. The server sends the whole view
 * after each mutation, so the UI never merges partial results.
 */
export interface TurnQueueView {
  runId: string
  queued: QueuedTurnView[]
  /** Id of the turn running right now, if any. */
  running: string | null
  /** Ids whose outcome is unknown after a crash; the user resolves them. */
  uncertain: string[]
  /** A restored or failed queue waits here until the user resumes it. */
  paused: boolean
}

export interface AgentEvent {
  type: string
  [key: string]: unknown
}

export interface FileEntry {
  name: string
  path: string
  type: 'dir' | 'file' | 'link'
  size?: number
}

export interface TreeResponse {
  path: string
  entries: FileEntry[]
}

export interface FileResponse {
  path: string
  size: number
  lines: number
  content: string
  truncated: boolean
}

export interface SettingsResponse {
  path: string
  user: {
    roles?: Record<string, Partial<RoleSummary>>
    models?: ModelProfile[]
    autoApprove?: boolean
    fullAuto?: boolean
    sandboxMode?: string
    web?: { enabled?: boolean; searchUrl?: string; allowDomains?: string[] }
    memory?: { enabled?: boolean }
    profiles?: Record<string, unknown>
    trustedProjects?: Array<{ path: string }>
    mcpServers?: Record<string, unknown>
    plugins?: string[]
    automation?: {
      browser?: { enabled?: boolean; browser?: string; headless?: boolean; isolated?: boolean }
      desktop?: { enabled?: boolean }
    }
  }
  active: ConfigSummary
}

export interface DesktopBridge {
  isDesktop: true
  platform: string
  chooseWorkspace(path?: string): Promise<string | null>
  pickFolder(): Promise<string | null>
  recentWorkspaces(): Promise<string[]>
  copyText(text: string): Promise<boolean>
  openPath(path: string): Promise<void>
  showItemInFolder(path: string): Promise<void>
  notify(title: string, body: string): Promise<boolean>
  applyUpdate(): Promise<{ ok: boolean; error?: string; from?: string }>
  /** Whether a staged build would be applied (older desktop shells lack it). */
  checkUpdate?(): Promise<{ available: boolean; version?: string; commit?: string; builtAt?: string; current: string; reason?: string }>
  /** Resident mode (tray, close-to-tray, start at Windows login). */
  residentState?(): Promise<{ resident: boolean; openAtLogin: boolean; loginAvailable: boolean }>
  setResident?(next: { resident?: boolean; openAtLogin?: boolean }): Promise<{ resident: boolean; openAtLogin: boolean; loginAvailable: boolean }>
  /** Tells the shell to refresh its tray after phone access changed. */
  phoneChanged?(): Promise<void>
  pickPluginFile(): Promise<string | null>
  onMenu(cb: (action: string) => void): () => void
  versions?(): Promise<Record<string, string>>
}

declare global {
  interface Window {
    hyDesktop?: DesktopBridge
  }
}
