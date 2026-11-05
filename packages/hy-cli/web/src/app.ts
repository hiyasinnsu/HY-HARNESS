import { ApiError, api, cancelQueuedTurn, fetchTurnQueue, generateTitle, globalEvents, post, put, resolveQueuedTurn, resumeTurnQueue, sessionEvents, setSessionTitle } from './api.js'
import { detectLocale, localeChoices, translate } from './i18n.js'
import { formatRelative } from './time-format.js'
import { renderAssistantMessage, renderUserMessage, type MessageContext } from './message-view.js'
import { SHORTCUT_ACTIONS, matchesAccelerator, normalizeAccelerator, resolveShortcuts, shortcutConflicts, type ShortcutMap } from './shortcuts.js'
import { icon } from './icons.js'
import { commentKey, commentsToPrompt, parseUnifiedDiff, renderDiffFiles, type DiffComment } from './diff-view.js'
import { buildIndex, searchIndex, stepHit, type SearchHit } from './transcript-search.js'
import { pickerModels, renderModelRows, type CatalogModel } from './model-picker.js'
import { STATUS_ITEMS, renderStatusline, type StatusItem } from './statusline.js'
import { INITIAL_VIM, vimKey, type VimState } from './vim.js'
import { COMMANDS, filterCommands, helpRows, parseSlash, slashCompletions, type CommandSpec, type DetailsSection } from './slash-commands.js'

/** CP-32: `GET /api/hooks`. */
interface HooksView {
  hooks: Array<{ event: string; command: string[]; tools?: string[]; timeoutMs?: number }>
}

/** CP-32: `GET /api/doctor` (the same report as `hy doctor --json`). */
interface DoctorView {
  ok: boolean
  version: string
  checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }>
}

/** CP-32: settings sections the palette can jump to (`data-settings-section`). */
const SETTINGS_SECTIONS: ReadonlyArray<{ id: string; key: string }> = [
  { id: 'workspace', key: 'workspaceTitle' },
  { id: 'appearance', key: 'appearance' },
  { id: 'approval', key: 'approvalMode' },
  { id: 'models', key: 'models' },
  { id: 'capabilities', key: 'capabilities' },
  { id: 'automation', key: 'automation' },
  { id: 'update', key: 'updateTitle' },
]
import { sumDenials } from './denials.js'
import { escapeHtml, oneLine, renderMarkdown } from './markdown.js'
import { renderNoticeHtml } from './notice.js'
import { queueBadgeLabel, sendIntent, steerToggleLabel } from './turn-queue-intent.js'
import { renderTurnQueueHtml } from './turn-queue-view.js'
import { orchestrationIntent } from './orchestration-intent.js'
import { SCROLL_ANCHOR_AT_BOTTOM, anchorAfterRender, captureAnchor, type ScrollAnchor } from './scroll-anchor.js'
import { entryMotionKey, settledFlags, wrapEntryHtml } from './entry-motion.js'
import { caretAfterRender, composerDraftKey, readComposerDraft, shouldRebuildComposer, shouldStartSessionOnFocus, writeComposerDraft, type ComposerSnapshot } from './composer-draft.js'
import { Terminal } from '../vendor/xterm.mjs'
import { FitAddon } from '../vendor/addon-fit.mjs'
import type {
  AgentEvent,
  AgentView,
  ApprovalDetails,
  ApprovalRequest,
  AutomationData,
  AutomationRun,
  Bootstrap,
  ChatEntry,
  ChatToolEntry,
  ConfigSummary,
  FileEntry,
  FileResponse,
  GoalStateView,
  JobRecord,
  McpToolSummary,
  MemoryEntry,
  ModelProfile,
  OnboardingView,
  OpenInTargetView,
  OrchestrationView,
  PluginCatalog,
  PluginToolSummary,
  RalphStatus,
  ReferenceSession,
  SessionKind,
  SandboxInfo,
  SessionSnapshot,
  SessionState,
  SessionStatsView,
  SessionSummary,
  SettingsResponse,
  SubagentSummary,
  UpdateCheck,
  UpdateFetch,
  WorkerStatus,
  WorkspaceRootView,
  WorkerView,
  TrajectoryEvent,
  TreeResponse,
  TurnQueueView,
} from './types.js'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`missing element #${id}`)
  return element as T
}

interface PtyStatus {
  running: boolean
  pid?: number | undefined
  shell: string
  cwd: string
  cols: number
  rows: number
  output: string
  exit?: { exitCode: number; signal?: number | undefined } | undefined
  error?: string | undefined
}

interface AutomationForm {
  kind: 'schedule' | 'webhook'
  id?: string
  name: string
  cron: string
  cwd: string
  objective: string
  verifyCmds: string
  autoApprove: boolean
  enabled: boolean
  secret?: string
  endpoint?: string
}

interface State {
  boot?: Bootstrap | undefined
  sessions: SessionSummary[]
  current?: SessionSnapshot | undefined
  entries: ChatEntry[]
  busy: boolean
  orchestrationBusy: boolean
  planMode: boolean
  goal: string
  goalState: GoalStateView | null
  /**
   * True while the composer shows the blank chat opened by newSession(). A
   * blank chat has no session id, so this flag is what separates "the user
   * just opened a new chat" from "the user is looking at another chat" for the
   * orchestration chip.
   */
  freshChat: boolean
  search: string
  showArchived: boolean
  locale: string
  theme: 'dark' | 'light' | 'system'
  sidebarOpen: boolean
  right: 'files' | 'diff' | 'plan' | 'details' | 'trace' | 'browser' | 'terminal' | 'desktop' | null
  tree: Map<string, FileEntry[]>
  roots: WorkspaceRootView[]
  fileRoot: string
  expandedDirs: Set<string>
  selectedFile?: string | undefined
  file?: FileResponse | undefined
  diff: string
  diffError?: string | undefined
  plan: string
  planModeText: string
  notes: string
  skills: string
  status: string
  selectedEntry?: ChatToolEntry | undefined
  settings?: SettingsResponse | undefined
  orchestration?: OrchestrationView | undefined
  modelProfiles: ModelProfile[]
  pluginCatalog?: PluginCatalog | undefined
  automation?: AutomationData | undefined
  automationTab: 'schedules' | 'webhooks'
  automationForm?: AutomationForm | undefined
  automationRun?: AutomationRun | undefined
  automationTimer?: number | undefined
  modal?: 'settings' | 'help' | 'goal' | 'ralph' | 'model' | 'workspace' | 'palette' | 'automation' | 'roots' | 'rename' | 'sandbox' | 'onboarding' | 'outline' | 'feedback' | 'shortcuts' | 'hooks' | 'doctor' | 'rewind' | 'worktree' | 'import' | undefined
  /** Chat being renamed; only set while the rename dialog is open. */
  renameRunId?: string | undefined
  /** Current text of the rename input, so a failed save keeps what was typed. */
  renameDraft: string
  workspaces: string[]
  paletteQuery: string
  /** CP-33: diff viewer state (folded files, line comments, the open comment box). */
  diffCollapsed: Set<string>
  diffComments: Map<string, DiffComment>
  diffEditing?: { path: string; side: 'old' | 'new'; line: number } | undefined
  /** CP-33: transcript search (F3 / Ctrl+F). */
  findOpen: boolean
  findQuery: string
  findHits: SearchHit[]
  findPos: number
  /** CP-33: show message source instead of rendered Markdown. */
  rawTranscript: boolean
  /** CP-35: the model catalog for the picker, loaded when it opens. */
  modelCatalog: CatalogModel[]
  modelQuery: string
  /** CP-31: the import wizard's plan and the kinds the user keeps ticked. */
  importView?: { source: 'claude' | 'dsh'; items: Array<{ kind: string; target: string; action: string; summary: string; diff: string }> } | undefined
  importKinds: Set<string>
  /** CP-36: preferences from ui-state.json (via /api/ui-prefs). */
  prefs: { statusline: StatusItem[]; codeTheme: 'auto' | 'github' | 'monokai' | 'plain'; vimMode: boolean; shortcuts: Record<string, string> }
  vim: VimState
  /** CP-35: `/api/worktrees`. */
  worktrees?: { repo: boolean; dir: string; worktrees: Array<{ path: string; branch?: string; head?: string }> } | undefined
  /** CP-33: the turn picked in the rewind dialog, awaiting confirmation. */
  rewindTurn?: number | undefined
  /** CP-32: workspace files matching the palette query (fetched as you type). */
  paletteFiles: string[]
  /** CP-32: `/hooks` and `/doctor` modal contents. */
  hooksView?: HooksView | undefined
  doctorView?: DoctorView | undefined
  browserUrl: string
  browserSrc: string
  browserMode: 'preview' | 'automation'
  browserResult: string
  browserBusy: boolean
  desktopResult: string
  desktopBusy: boolean
  terminalHistory: Array<{ command: string; output: string; error?: string; exitCode?: number }>
  terminalBusy: boolean
  terminalMode: 'pty' | 'commands'
  ptyStatus?: PtyStatus | undefined
  ptyStarting: boolean
  ptyTerm?: Terminal | undefined
  ptyFit?: FitAddon | undefined
  ptySource?: EventSource | undefined
  ptyRunId?: string | undefined
  ralph?: RalphStatus | undefined
  ralphTimer?: number | undefined
  sse?: EventSource | undefined
  globalSse?: EventSource | undefined
  connection: 'connecting' | 'online' | 'reconnecting'
  toasts: Array<{ id: number; text: string; kind: 'info' | 'error' | 'success' }>
  expandedTools: Set<string>
  sending: boolean
  /** Latest /api/turn-queue view for the open chat; undefined means none fetched yet. */
  turnQueue?: TurnQueueView | undefined
  /** True while the badge is expanded into the list above the composer. */
  queueOpen: boolean
  /** What a submit does while a turn runs: join it now, or wait for it to end. */
  steerMode: 'steer' | 'queue'
  /** Text of the open chat's composer; mirrors `composerDrafts` for the open key. */
  draft: string
  /** Composer text per chat key, so switching chats does not lose what was typed. */
  composerDrafts: Map<string, string>
  attachments: Array<{ name: string; mimeType: string; data: string }>
  mentions: string[]
  /** WP-60: earlier chats offered by the `@` menu. */
  mentionSessions: ReferenceSession[]
  /** CP-21: skills offered as `@skill:name`. */
  mentionSkills: Array<{ name: string; description: string }>
  mentionStart: number
  mentionEnd: number
  mentionIndex: number
  /** CP-32: slash-command suggestions while the composer holds only `/name`. */
  slashItems: CommandSpec[]
  mentionTimer?: number | undefined
  jobs: JobRecord[]
  jobOutput: string
  subagents: SubagentSummary[]
  agents: AgentView[]
  agentEntries: ChatEntry[]
  trajectory: TrajectoryEvent[]
  mcp: McpToolSummary[]
  plugins: PluginToolSummary[]
  memory: MemoryEntry[]
  /** WP-61: the answer being rated, and what was typed in the feedback modal. */
  feedbackEntryId?: string | undefined
  feedbackCategory: string
  feedbackNote: string
  /** WP-61: measured timings of the open chat. */
  stats?: SessionStatsView | undefined
  /** WP-61: display-only masking of keys in the transcript. */
  maskSecrets: boolean
  /** WP-61: keyboard bindings (device-local). */
  shortcuts: ShortcutMap
  /** WP-61: programs offered by "Open In" (empty when the API is remote). */
  openInTargets: OpenInTargetView[]
  openInLocal: boolean
  /** WP-53: the first-run wizard's step and the choices made so far. */
  onboardingStep: number
  onboardingDraft: { sandbox: string; provider: string; model: string; baseUrl: string }
  onboardingBusy: boolean
  /** WP-53: the last `/api/update` answer (undefined until the user asks). */
  update?: UpdateCheck | undefined
  updateBusy: boolean
}

const state: State = {
  sessions: [],
  entries: [],
  busy: false,
  orchestrationBusy: false,
  planMode: false,
  goal: '',
  goalState: null,
  freshChat: false,
  search: '',
  showArchived: false,
  locale: detectLocale(),
  theme: (localStorage.getItem('hy-theme-v2') as 'dark' | 'light' | 'system' | null) ?? 'light',
  sidebarOpen: window.innerWidth >= 900,
  right: null,
  tree: new Map(),
  roots: [],
  fileRoot: 'main',
  expandedDirs: new Set(),
  diff: '',
  plan: '',
  planModeText: '',
  notes: '',
  skills: '',
  status: '',
  orchestration: undefined,
  modelProfiles: [],
  connection: 'connecting',
  workspaces: [],
  automationTab: 'schedules',
  paletteQuery: '',
  diffCollapsed: new Set<string>(),
  diffComments: new Map<string, DiffComment>(),
  findOpen: false,
  findQuery: '',
  findHits: [],
  findPos: -1,
  rawTranscript: false,
  modelCatalog: [],
  modelQuery: '',
  importKinds: new Set<string>(),
  prefs: { statusline: ['tokens', 'cache', 'last'], codeTheme: 'auto', vimMode: false, shortcuts: {} },
  vim: INITIAL_VIM,
  paletteFiles: [],
  renameDraft: '',
  browserUrl: '',
  browserSrc: '',
  browserMode: 'preview',
  browserResult: '',
  browserBusy: false,
  desktopResult: '',
  desktopBusy: false,
  terminalHistory: [],
  terminalBusy: false,
  terminalMode: 'pty',
  ptyStarting: false,
  toasts: [],
  expandedTools: new Set(),
  sending: false,
  queueOpen: false,
  steerMode: 'steer',
  draft: '',
  composerDrafts: new Map(),
  attachments: [],
  mentions: [],
  mentionSessions: [],
  mentionSkills: [],
  mentionStart: 0,
  mentionEnd: 0,
  mentionIndex: 0,
  slashItems: [],
  jobs: [],
  jobOutput: '',
  subagents: [],
  agents: [],
  agentEntries: [],
  trajectory: [],
  mcp: [],
  plugins: [],
  memory: [],
  onboardingStep: 0,
  onboardingDraft: { sandbox: '', provider: '', model: '', baseUrl: '' },
  onboardingBusy: false,
  feedbackCategory: '',
  feedbackNote: '',
  maskSecrets: localStorage.getItem('hy-mask-secrets') !== '0',
  shortcuts: loadStoredShortcuts(),
  openInTargets: [],
  openInLocal: false,
  updateBusy: false,
}

/** Bindings from localStorage, merged over the defaults (invalid ones dropped). */
function loadStoredShortcuts(): ShortcutMap {
  try {
    return resolveShortcuts(JSON.parse(localStorage.getItem('hy-shortcuts') ?? '{}'))
  } catch {
    return resolveShortcuts({})
  }
}

/** WP-64: the display switches `message-view.ts` needs. */
function messageContext(): MessageContext {
  return { locale: state.locale, mask: state.maskSecrets, raw: state.rawTranscript }
}

let toastId = 0

function toast(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  const id = ++toastId
  state.toasts.push({ id, text, kind })
  renderToasts()
  window.setTimeout(() => {
    state.toasts = state.toasts.filter((t) => t.id !== id)
    renderToasts()
  }, kind === 'error' ? 9000 : 4500)
}

function renderToasts(): void {
  const root = document.getElementById('toast-root')
  if (!root) return
  root.innerHTML = state.toasts
    .map(
      (t) =>
        `<div class="toast toast-${t.kind}">${t.kind === 'error' ? icon('alert', 16) : t.kind === 'success' ? icon('check', 16) : icon('info', 16)}<span>${escapeHtml(t.text)}</span><button class="toast-close" data-action="dismiss-toast" data-toast-id="${t.id}" aria-label="Close">${icon('close', 14)}</button></div>`,
    )
    .join('')
}

function tr(key: string, vars?: Record<string, string | number>): string {
  return translate(state.locale, key, vars)
}

function currentRunId(): string | undefined {
  return state.current?.runId
}

function currentState(): SessionState | undefined {
  return state.current?.state
}

function isDesktop(): boolean {
  return state.boot?.desktop === true || !!window.hyDesktop
}

function workspaceName(): string {
  return state.boot?.workspace.name ?? 'workspace'
}

/** WP-61: `system` follows the OS and is re-resolved on every change. */
function resolvedTheme(): 'light' | 'dark' {
  if (state.theme !== 'system') return state.theme
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function applyTheme(): void {
  const theme = resolvedTheme()
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  localStorage.setItem('hy-theme-v2', state.theme)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'light' ? '#fff9fc' : '#171017')
}

/** WP-61: font stacks are user text, so only safe characters are kept. */
function sanitizeFontStack(value: string): string {
  return value.replace(/[^A-Za-z0-9 ,\-_"']/g, '').trim().slice(0, 120)
}

function loadFonts(): { text: string; code: string } {
  return {
    text: sanitizeFontStack(localStorage.getItem('hy-font-text') ?? ''),
    code: sanitizeFontStack(localStorage.getItem('hy-font-code') ?? ''),
  }
}

function applyFonts(): void {
  const fonts = loadFonts()
  const root = document.documentElement
  // An empty value falls back to the stylesheet's own stack.
  if (fonts.text) root.style.setProperty('--font', fonts.text)
  else root.style.removeProperty('--font')
  if (fonts.code) root.style.setProperty('--mono', fonts.code)
  else root.style.removeProperty('--mono')
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US')
}

/** WP-60: a duration in the details panel (ms under a second, else seconds). */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`
}

/** CP-36: the composer statusline with the items picked in Settings. */
function statuslineHtml(current: SessionState | undefined): string {
  const role = state.boot?.config.worker
  const html = renderStatusline(state.prefs.statusline, {
    ...(current?.model ? { provider: current.model.provider, model: current.model.model } : role ? { provider: role.provider, model: role.model } : {}),
    ...(current?.sandboxMode ? { sandbox: current.sandboxMode } : state.boot?.config.sandbox ? { sandbox: state.boot.config.sandbox } : {}),
    inputTokens: current?.usage.inputTokens ?? 0,
    outputTokens: current?.usage.outputTokens ?? 0,
    cacheHitTokens: current?.usage.cacheHitTokens ?? 0,
    ...(current?.usage.cacheMissTokens !== undefined ? { cacheMissTokens: current.usage.cacheMissTokens } : {}),
    ...(current?.usage.lastInputTokens !== undefined ? { lastInputTokens: current.usage.lastInputTokens, lastOutputTokens: current.usage.lastOutputTokens ?? 0 } : {}),
    ...(role ? { contextWindowTokens: role.contextWindowTokens } : {}),
    ...(current ? { turns: current.turns } : {}),
  })
  const vim = state.prefs.vimMode ? `<span class="status-item vim-mode vim-${state.vim.mode}">${state.vim.mode === 'normal' ? 'NORMAL' : 'INSERT'}</span>` : ''
  return vim ? (html ? `${vim}<span class="status-sep">·</span>${html}` : vim) : html
}

/** CP-36: loads the saved preferences and applies them. */
async function loadPrefs(): Promise<void> {
  try {
    const data = await api<{ prefs: typeof state.prefs }>('/api/ui-prefs')
    state.prefs = data.prefs
    if (Object.keys(data.prefs.shortcuts).length > 0) {
      state.shortcuts = resolveShortcuts(data.prefs.shortcuts)
      localStorage.setItem('hy-shortcuts', JSON.stringify(data.prefs.shortcuts))
    }
  } catch {
    // Older server or offline: keep the defaults.
  }
  applyPrefs()
}

function applyPrefs(): void {
  document.documentElement.dataset.codeTheme = state.prefs.codeTheme
  if (!state.prefs.vimMode) state.vim = INITIAL_VIM
  renderComposer()
}

async function savePrefs(patch: Partial<typeof state.prefs>): Promise<void> {
  state.prefs = { ...state.prefs, ...patch }
  applyPrefs()
  try {
    const data = await put<{ prefs: typeof state.prefs }>('/api/ui-prefs', patch)
    state.prefs = data.prefs
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function cacheInfo(usage: SessionState['usage'] | undefined): { hit: number; total: number; rate: string } {
  const hit = Math.max(0, Number(usage?.cacheHitTokens ?? 0))
  const miss = Math.max(0, Number(usage?.cacheMissTokens ?? Math.max(0, (usage?.inputTokens ?? 0) - hit)))
  const total = hit + miss
  return { hit, total, rate: total > 0 ? ((hit / total) * 100).toFixed(2) : '0.00' }
}

function statusLabel(): string {
  if (state.connection === 'reconnecting') return tr('reconnecting')
  if (state.connection === 'connecting') return tr('connecting')
  if (state.busy) return tr('running')
  if (currentState()?.lastError) return tr('stopped')
  return tr('ready')
}

function statusClass(): string {
  if (state.connection !== 'online') return 'status-warn'
  if (state.busy) return 'status-running'
  if (currentState()?.lastError) return 'status-error'
  return 'status-ready'
}

function sessionTitle(session: SessionSummary | SessionSnapshot): string {
  if ('entries' in session) {
    const first = session.entries.find((e) => e.kind === 'user')
    return first?.kind === 'user' ? oneLine(first.text, 80) : tr('newSession')
  }
  // WP-60: a manual name wins, then a generated one, then the first message.
  const named = session.title ?? session.generatedTitle
  if (named) return oneLine(named, 80)
  return session.first ? oneLine(session.first, 80) : tr('newSession')
}

function toolIcon(name: string): string {
  switch (name) {
    case 'read_file':
      return 'read'
    case 'apply_patch':
      return 'edit'
    case 'shell':
      return 'terminal'
    case 'run_code':
      return 'cpu'
    case 'search_glob':
    case 'search_grep':
      return 'search'
    case 'update_plan':
      return 'plan'
    case 'delegate':
      return 'bot'
    case 'web_fetch':
    case 'web_search':
      return 'globe'
    case 'mcp_call':
      return 'cpu'
    case 'ask_user':
      return 'question'
    case 'claim_complete':
      return 'check'
    default:
      return 'dot'
  }
}

function toolTitle(entry: ChatToolEntry): string {
  const args = (entry.args ?? {}) as Record<string, unknown>
  switch (entry.name) {
    case 'read_file':
      return `Read ${String(args.path ?? 'file')}`
    case 'apply_patch': {
      const explicit = String(args.file ?? args.path ?? '')
      if (explicit) return `Edit ${explicit}`
      const patch = typeof args.patch === 'string' ? args.patch : ''
      const file = /^\+\+\+ (?:b\/)?(.+)$/m.exec(patch)?.[1] ?? /^--- (?:a\/)?(.+)$/m.exec(patch)?.[1]
      return file && file !== '/dev/null' ? `Edit ${file}` : 'Apply patch'
    }
    case 'shell':
      return `Shell · ${oneLine(String(args.command ?? ''), 90)}`
    case 'run_code':
      return `Run code${args.description ? ` · ${oneLine(String(args.description), 60)}` : ''}`
    case 'search_glob':
      return `Find ${String(args.pattern ?? '')}`
    case 'search_grep':
      return `Search ${String(args.pattern ?? '')}`
    case 'update_plan':
      return 'Update plan'
    case 'delegate':
      return `Subagent · ${oneLine(String(args.task ?? ''), 60)}`
    case 'web_fetch':
      return `Fetch ${oneLine(String(args.url ?? ''), 70)}`
    case 'web_search':
      return `Web search · ${oneLine(String(args.query ?? ''), 60)}`
    case 'mcp_call':
      return `MCP · ${String(args.server ?? '')}/${String(args.tool ?? '')}`
    case 'ask_user':
      return 'Question'
    case 'claim_complete':
      return 'Claim complete'
    default:
      return entry.name
  }
}

function toolStatus(entry: ChatToolEntry): string {
  if (entry.status === 'running') return `<span class="tool-spinner" aria-label="${tr('running')}"></span>`
  if (entry.status === 'error') return `<span class="tool-state error">${icon('x', 14)} ${tr('stopped')}</span>`
  return `<span class="tool-state ok">${icon('check', 14)} OK</span>`
}

function renderDiff(source: string): string {
  if (!source.trim()) return `<div class="panel-empty">${tr('noChanges')}</div>`
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const html = lines
    .map((line) => {
      let cls = 'diff-line'
      if (line.startsWith('+++') || line.startsWith('---')) cls += ' diff-header'
      else if (line.startsWith('@@')) cls += ' diff-hunk'
      else if (line.startsWith('+')) cls += ' diff-add'
      else if (line.startsWith('-')) cls += ' diff-del'
      else if (line.startsWith('diff ') || line.startsWith('index ')) cls += ' diff-meta'
      return `<span class="${cls}">${line ? escapeHtml(line) : ' '}</span>`
    })
    .join('')
  return `<pre class="diff">${html}</pre>`
}

function renderToolBody(entry: ChatToolEntry): string {
  const args = (entry.args ?? {}) as Record<string, unknown>
  const parts: string[] = []
  if (entry.name === 'apply_patch' && typeof args.patch === 'string') parts.push(renderDiff(args.patch))
  else if (entry.name === 'apply_patch' && typeof args.content === 'string') {
    parts.push(`<pre class="code-block"><code>${escapeHtml(args.content)}</code></pre>`)
  }
  if (entry.output) {
    parts.push(`<pre class="tool-output">${escapeHtml(entry.output)}</pre>`)
  }
  if (entry.result && typeof entry.result === 'object') {
    const result = entry.result as Record<string, unknown>
    const applied = Array.isArray(result.appliedFiles) ? result.appliedFiles.map(String) : []
    if (applied.length > 0) {
      parts.push(`<div class="file-chips">${applied.map((f) => `<button class="file-chip" data-action="open-file" data-path="${escapeHtml(f)}">${icon('file', 13)}${escapeHtml(f)}</button>`).join('')}</div>`)
    }
    if (Array.isArray(result.deleted) && result.deleted.length > 0) {
      parts.push(`<div class="muted small">deleted: ${result.deleted.map((d) => escapeHtml(String(d))).join(', ')}</div>`)
    }
    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      parts.push(`<div class="notice warn">${result.warnings.map((w) => escapeHtml(String(w))).join('<br>')}</div>`)
    }
  }
  if (parts.length === 0 && entry.status === 'running') {
    parts.push(`<div class="panel-empty">Running…</div>`)
  }
  return parts.join('')
}

function renderToolCard(entry: ChatToolEntry): string {
  const expanded = state.expandedTools.has(entry.id)
  const args = (entry.args ?? {}) as Record<string, unknown>
  const path = typeof args.path === 'string' ? args.path : typeof args.file === 'string' ? args.file : undefined
  return `<article class="tool-card ${entry.status === 'error' ? 'tool-error' : ''} ${expanded ? 'expanded' : ''}" data-entry-id="${entry.id}">
    <button class="tool-head" data-action="toggle-tool" data-entry-id="${entry.id}">
      <span class="tool-glyph ${entry.status}">${icon(toolIcon(entry.name), 16)}</span>
      <span class="tool-title">${escapeHtml(toolTitle(entry))}</span>
      ${entry.subagent ? `<span class="tag subtle">subagent</span>` : ''}
      ${entry.denial ? `<span class="tag danger" title="${tr('deniedTitle')}">${escapeHtml(`blocked: ${entry.denial}`)}</span>` : ''}
      <span class="tool-spacer"></span>
      ${toolStatus(entry)}
      <span class="tool-chevron">${icon(expanded ? 'chevron-down' : 'chevron-right', 16)}</span>
    </button>
    ${expanded ? `<div class="tool-body">${renderToolBody(entry)}<div class="tool-actions"><button class="link-btn" data-action="tool-details" data-entry-id="${entry.id}">${icon('diff', 16)} ${tr('detailsAction')}</button>${path ? `<button class="link-btn" data-action="open-file" data-path="${escapeHtml(path)}">${icon('file', 16)} ${tr('openInEditor')}</button>` : ''}</div></div>` : ''}
  </article>`
}

function renderPlanCard(entry: Extract<ChatEntry, { kind: 'plan' }>): string {
  const rows = entry.plan
    .map((p) => {
      const glyph = p.status === 'completed' ? '✓' : p.status === 'in_progress' ? '›' : '○'
      return `<li class="plan-${p.status}"><span class="plan-mark">${glyph}</span><span>${escapeHtml(p.step)}</span></li>`
    })
    .join('')
  return `<article class="plan-card"><div class="plan-head">${icon('plan', 16)}<span>Plan</span></div><ul>${rows}</ul></article>`
}

function renderApproval(entry: Extract<ChatEntry, { kind: 'approval' }>): string {
  if (entry.decision) {
    const scope = entry.scope && entry.scope !== 'once' ? ` <span class="tag subtle">${escapeHtml(tr(entry.scope === 'always' ? 'approveAlways' : 'approveSession'))}</span>` : ''
    const reason = entry.reason ? `<div class="approval-reason">${escapeHtml(entry.reason)}</div>` : ''
    return `<article class="approval-card decided ${entry.decision}"><div class="approval-head">${entry.decision === 'approved' ? icon('check', 16) : icon('x', 16)}<strong>${entry.decision === 'approved' ? tr('approved') : tr('denied')}</strong>${scope}<span class="muted">${escapeHtml(entry.request.command)}</span></div>${reason}</article>`
  }
  const sandbox = entry.request.sandbox ? `<span class="tag">${escapeHtml(entry.request.sandbox)}</span>` : ''
  const rule = entry.request.matchedRule ? `<span class="tag subtle">${escapeHtml(entry.request.matchedRule)}</span>` : ''
  // A worker's request is usually decided by the orchestrator, but the user can
  // always decide it here, and must for unconfined / low-integrity ones.
  const userOnly = entry.request.sandbox === 'unconfined' || entry.request.sandbox === 'low-integrity'
  const worker = state.current?.state.kind === 'worker'
  const workerNote = worker ? `<div class="approval-reason">${tr(userOnly ? 'workerApprovalUserOnly' : 'workerApprovalViaOrchestrator')}</div>` : ''
  // CP-34: everything the decision depends on, on one card.
  const d = entry.details
  const facts = d
    ? `<dl class="approval-facts">
      <dt>${tr('approvalCwd')}</dt><dd><code>${escapeHtml(d.cwd)}</code></dd>
      <dt>${tr('approvalEffect')}</dt><dd class="${userOnly ? 'risk' : ''}">${escapeHtml(d.effect)}</dd>
      ${d.paths.length ? `<dt>${tr('approvalPaths')}</dt><dd>${d.paths.map((p) => `<code>${escapeHtml(p)}</code>`).join(' ')}</dd>` : ''}
      ${d.network.length ? `<dt>${tr('approvalNetwork')}</dt><dd>${d.network.map((h) => `<code>${escapeHtml(h)}</code>`).join(' ')}</dd>` : ''}
    </dl>`
    : ''
  const persist = !worker && (d?.persistable ?? !userOnly)
  return `<article class="approval-card" data-approval-id="${entry.requestId}" tabindex="-1">
    <div class="approval-head">${icon('lock', 16)}<strong>${tr('approvalNeeded')}</strong>${sandbox}${rule}</div>
    <pre class="approval-command">${escapeHtml(entry.request.command)}</pre>
    ${entry.request.justification ? `<div class="approval-reason">${escapeHtml(entry.request.justification)}</div>` : ''}
    ${facts}
    ${workerNote}
    <input class="approval-input" id="approval-reason-${entry.requestId}" data-approval-reason="${entry.requestId}" placeholder="${tr('denyReasonPlaceholder')}" autocomplete="off">
    <div class="approval-actions">
      <button class="btn ghost" data-action="approval-deny" data-request-id="${entry.requestId}" title="N / Alt+N">${icon('x', 14)} ${tr('deny')} <kbd>N</kbd></button>
      ${!worker ? `<button class="btn ghost" data-action="approval-approve" data-scope="session" data-request-id="${entry.requestId}" title="S / Alt+S">${tr('approveSession')} <kbd>S</kbd></button>` : ''}
      ${persist ? `<button class="btn ghost" data-action="approval-approve" data-scope="always" data-request-id="${entry.requestId}" title="A / Alt+A">${tr('approveAlways')} <kbd>A</kbd></button>` : ''}
      <button class="btn primary" data-action="approval-approve" data-scope="once" data-request-id="${entry.requestId}" title="Y / Alt+Y">${icon('check', 14)} ${tr('approveOnce')} <kbd>Y</kbd></button>
    </div>
  </article>`
}

function renderQuestion(entry: Extract<ChatEntry, { kind: 'question' }>): string {
  if (entry.answer !== undefined) {
    return `<article class="question-card answered"><div class="question-head">${icon('question', 16)}<strong>${tr('theAgentAsks')}</strong></div><p>${escapeHtml(entry.question)}</p><div class="answer">${escapeHtml(entry.answer)}</div></article>`
  }
  return `<article class="question-card" data-question-id="${entry.requestId}">
    <div class="question-head">${icon('question', 16)}<strong>${tr('theAgentAsks')}</strong></div>
    <p>${escapeHtml(entry.question)}</p>
    <form class="question-form" data-action="answer-question" data-request-id="${entry.requestId}">
      <input name="answer" placeholder="${tr('answer')}…" autocomplete="off" autofocus>
      <button class="btn primary" type="submit">${tr('answer')}</button>
    </form>
  </article>`
}

function localizeNotice(text: string): string {
  const round = /^round (\d+) started$/.exec(text)
  if (round) return `${tr('round')} ${round[1]} ${tr('started')}`
  const ended = /^round (\d+): (.+)$/.exec(text)
  if (ended) return `${tr('round')} ${ended[1]}: ${ended[2] === 'succeeded' ? tr('succeeded') : ended[2]}`
  if (text === 'plan mode on') return tr('planModeOn')
  if (text === 'plan mode off') return tr('planModeOff')
  if (text.startsWith('goal: ')) return `${tr('goal')}: ${text.slice(6)}`
  if (text.startsWith('compacted ')) return `${tr('compacted')} ${text.slice(10)}`
  const effort = /^reasoning effort: (.+)$/.exec(text)
  if (effort) return tr('effortSet', { effort: effort[1] === 'provider default' ? tr('effortDefault') : tr(`effort_${effort[1]}`) })
  const steerLate = /^steering message arrived after the last step \((\d+)\)/.exec(text)
  if (steerLate) return tr('steerLate', { count: steerLate[1] ?? '' })
  return text
}

function renderEntry(entry: ChatEntry): string {
  switch (entry.kind) {
    // WP-64: user/assistant markup lives in message-view.ts so it can be tested
    // without a DOM (and so both kinds get the same absolute time chip).
    case 'user':
      return renderUserMessage(entry, messageContext())
    case 'assistant':
      return renderAssistantMessage(entry, messageContext())
    case 'thinking': {
      const summary = entry.summary
        ? `<span class="thinking-summary-inline${entry.summaryProvisional ? ' provisional' : ''}">：${escapeHtml(entry.summary)}</span>`
        : ''
      return `<details class="thinking-block" data-entry-id="${escapeHtml(entry.id)}"><summary><span class="thinking-title">${tr('thinking')}</span>${summary}</summary><pre>${escapeHtml(entry.text)}</pre></details>`
    }
    case 'notice':
      // Worker traffic arrives as one synthetic turn, so a notice can hold a
      // report, a heartbeat and an approval request. Only the report folds.
      return renderNoticeHtml(entry.level ?? 'info', localizeNotice(entry.text))
    case 'tool':
      return renderToolCard(entry)
    case 'plan':
      return renderPlanCard(entry)
    // WP-23: files the model showed with `present`; WP-52 adds a document preview.
    case 'deliverables':
      return `<section class="deliverables"><h4>${icon('file', 14)} ${tr('deliverables')}</h4>${entry.files
        .map((file) => {
          const previewable = /\.(pdf|png|jpe?g|webp|gif|docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(file.path)
          const preview = previewable
            ? `<button class="link-btn" data-action="preview-deliverable" data-path="${escapeHtml(file.path)}">${icon('read', 12)} ${tr('previewDocument')}</button>`
            : ''
          return `<div class="deliverable-card"><span class="deliverable-icon">${icon('file', 18)}</span><span class="deliverable-main"><code>${escapeHtml(file.path)}</code><span class="deliverable-meta">${formatBytes(file.size)} · ${file.lines} ${tr('lines')}${file.description ? ` · ${escapeHtml(file.description)}` : ''}</span></span><span class="deliverable-actions">${preview}<button class="link-btn" data-action="open-deliverable" data-path="${escapeHtml(file.path)}">${icon('external', 12)} ${tr('openInEditor')}</button><button class="link-btn" data-action="reveal-deliverable" data-path="${escapeHtml(file.path)}">${icon('folder', 12)} ${tr('showInFolder')}</button></span></div>`
        })
        .join('')}</section>`
    case 'approval':
      return renderApproval(entry)
    case 'question':
      return renderQuestion(entry)
  }
}

function renderEmptyState(): string {
  const config = state.boot?.config
  const enforcement = state.boot?.sandbox?.enforcement ?? 'none'
  const suggestions: Array<[string, string]> = [
    [tr('suggest1'), 'Summarize this repository and identify its main packages.'],
    [tr('suggest2'), 'Run the test suite, find the first failure, and fix it.'],
    [tr('suggest3'), 'Review the uncommitted changes for bugs and missing tests.'],
    [tr('suggest4'), 'Plan a small feature: inspect the code, propose the files to change, then implement it.'],
  ]
  return `<section class="hero">
    <div class="hero-header">
      <div class="hero-eyebrow">${icon('workspace', 16)}<span>${escapeHtml(workspaceName())}</span></div>
      <h2>${tr('whatBuild')}</h2>
      <p>${tr('heroDesc')}</p>
    </div>
    <div class="console-card">
      <div class="console-cell">
        <span class="console-label">${tr('workspaceTitle')}</span>
        <strong class="console-value mono">${escapeHtml(workspaceName())}</strong>
        <span class="console-sub mono">${escapeHtml(state.boot?.workspace.root ?? '')}</span>
      </div>
      <div class="console-cell">
        <span class="console-label">${tr('models')}</span>
        <strong class="console-value mono">${escapeHtml(config?.worker.model ?? 'qwen2.5:3b')}</strong>
        <span class="console-sub">${escapeHtml(config?.worker.provider ?? 'ollama')}</span>
      </div>
      <div class="console-cell">
        <span class="console-label">${tr('sandbox')}</span>
        <strong class="console-value mono">${escapeHtml(config?.sandbox ?? 'unconfined')}</strong>
        <span class="console-sub">${tr('enforcement')}: ${escapeHtml(enforcement)}</span>
      </div>
      <div class="console-cell">
        <span class="console-label">${tr('verifierLoop')}</span>
        <strong class="console-value mono">${escapeHtml(config?.grader ? config.grader.model : 'Gate 1 + Gate 2')}</strong>
        <span class="console-sub">${escapeHtml(config?.guardian ? `Guardian: ${config.guardian.model}` : 'Checkpoint refs active')}</span>
      </div>
    </div>
    <div class="suggestions">${suggestions
      .map(
        ([title, prompt]) =>
          `<button class="suggestion" data-action="suggest" data-prompt="${escapeHtml(prompt)}"><span>${escapeHtml(title)}</span>${icon('chevron-right', 16)}</button>`,
      )
      .join('')}</div>
  </section>`
}

/** Key for the blank chat opened by newSession(); it has no run id yet. */
const BLANK_CHAT_ANCHOR_KEY = ''

/** Where each chat was last left, so switching back restores the position. */
const transcriptAnchors = new Map<string, ScrollAnchor>()

/** Transcript elements that already carry the scroll listener. */
const watchedTranscripts = new WeakSet<HTMLElement>()

let transcriptScrollFrame: number | undefined

function transcriptAnchorKey(): string {
  return state.current?.runId ?? BLANK_CHAT_ANCHOR_KEY
}

/** Records the position of the transcript that is currently on screen. */
function captureTranscriptAnchor(): void {
  const el = document.getElementById('transcript')
  if (!el) return
  transcriptAnchors.set(transcriptAnchorKey(), captureAnchor(el.scrollTop, el.scrollHeight, el.clientHeight))
}

/** Records a scroll event whose animation frame has not run yet. */
function flushTranscriptAnchor(): void {
  if (transcriptScrollFrame === undefined) return
  window.cancelAnimationFrame(transcriptScrollFrame)
  transcriptScrollFrame = undefined
  captureTranscriptAnchor()
}

/** Captures the outgoing chat just before state.current is replaced. */
function rememberTranscriptAnchor(): void {
  flushTranscriptAnchor()
  captureTranscriptAnchor()
}

/**
 * Puts the remembered position back after the transcript is re-rendered. This
 * covers a chat switch and entries that stream into an open chat alike: a
 * reader who sits at the bottom keeps following the newest entry, and one who
 * scrolled up keeps their place.
 */
function restoreTranscriptAnchor(el: HTMLElement): void {
  const key = transcriptAnchorKey()
  // A chat this client has never shown opens at the newest turn rather than at
  // the oldest one.
  const saved = anchorAfterRender(transcriptAnchors.get(key) ?? SCROLL_ANCHOR_AT_BOTTOM)
  // `.transcript` is styled with `scroll-behavior: smooth`, so the jump is
  // requested as instant; an animated one would visibly drift on a switch.
  el.scrollTo({ top: Number.isFinite(saved) ? saved : el.scrollHeight, behavior: 'instant' })
  watchTranscriptScroll(el)
  if (Number.isFinite(saved)) return
  // Fonts and images can change the height one frame after the swap, so the
  // bottom is re-pinned once unless the reader has scrolled away meanwhile.
  window.requestAnimationFrame(() => {
    if (transcriptAnchorKey() !== key) return
    const current = transcriptAnchors.get(key)
    if (current && !current.stick) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
  })
}

/**
 * Attaches the scroll listener once per transcript element. renderShell()
 * rebuilds the element, so this runs after every render, not once at boot.
 */
function watchTranscriptScroll(el: HTMLElement): void {
  if (watchedTranscripts.has(el)) return
  watchedTranscripts.add(el)
  el.addEventListener(
    'scroll',
    () => {
      if (transcriptScrollFrame !== undefined) return
      transcriptScrollFrame = window.requestAnimationFrame(() => {
        transcriptScrollFrame = undefined
        captureTranscriptAnchor()
      })
    },
    { passive: true },
  )
}

let transcriptRenderFrame: number | undefined

/** Entries already on screen once; they must not replay their entrance animation. */
const shownEntries = new Set<string>()

function renderEntries(): string {
  const settled = settledFlags(shownEntries, state.entries.map(entryMotionKey))
  return state.entries.map((entry, i) => wrapEntryHtml(renderEntry(entry), settled[i] === true)).join('')
}

/** Coalesces live events into one transcript render per animation frame. */
function renderTranscript(): void {
  if (transcriptRenderFrame !== undefined) return
  transcriptRenderFrame = window.requestAnimationFrame(() => {
    transcriptRenderFrame = undefined
    renderTranscriptNow()
  })
}

function renderTranscriptNow(): void {
  const el = document.getElementById('transcript')
  if (!el) return
  window.queueMicrotask(() => applyFindHighlight())
  const body = state.entries.length === 0 && !state.busy ? renderEmptyState() : renderEntries()
  const running = state.busy
    ? `<div class="running-row"><span class="tool-spinner"></span><span>${state.connection === 'online' ? tr('working') : `${tr('reconnecting')}…`}</span></div>`
    : ''
  // CP-34: a focused (or newly arrived) approval card keeps the keyboard
  // across the re-render that replaces its element.
  const focusedCard = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('.approval-card[data-approval-id]')?.dataset.approvalId
  const focusCard = focusedCard ?? approvalToFocus
  el.innerHTML = `<div class="transcript-inner">${body}${running}</div>`
  restoreTranscriptAnchor(el)
  if (focusCard) {
    const card = el.querySelector<HTMLElement>(`.approval-card[data-approval-id="${CSS.escape(focusCard)}"]`)
    const active = document.activeElement
    const typing = (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && active.value !== ''
    if (card && !typing) card.focus({ preventScroll: false })
    if (card || !state.entries.some((e) => e.kind === 'approval' && e.requestId === focusCard && !e.decision)) approvalToFocus = undefined
  }
}

/** CP-34: the approval card to focus after the next transcript render. */
let approvalToFocus: string | undefined

function workerStatusText(status: WorkerStatus | undefined, blocker?: string | null): string {
  switch (status) {
    case 'queued':
      return tr('workerQueued')
    case 'running':
      return tr('workerRunning')
    case 'waiting':
      return tr('workerWaiting')
    case 'partial':
      return tr('workerPartial')
    case 'blocked':
      return blocker?.toLowerCase().startsWith('approval required') ? tr('workerApproval') : tr('workerBlocked')
    case 'failed':
      return tr('workerFailed')
    case 'stopped':
      return tr('workerStopped')
    case 'interrupted':
      return tr('workerInterrupted')
    case 'done':
      return tr('workerDone')
    default:
      return ''
  }
}

function renderSessionRow(session: SessionSummary, worker?: WorkerView): string {
  const active = session.runId === currentRunId()
  // A worker keeps its orchestrator-assigned title; a chat shows the name the
  // user gave it (WP-60: or a generated one), and falls back to the first
  // message only when unnamed.
  const title = worker?.title || session.workerTitle || session.title || session.generatedTitle || session.first || tr('newSession')
  const kind = session.kind ?? (worker ? 'worker' : 'chat')
  const badge = kind === 'orchestrator'
    ? `<span class="session-badge orch">${tr('orchestrator')}</span>`
    : worker
      ? `<span class="session-badge worker">${tr('worker')}</span>`
      : ''
  const meta = worker
    ? `${badge} ${workerStatusText(worker.status, worker.blocker)} · ${formatRelative(Date.now(), worker.updatedAt, state.locale)}`
    : `${session.turns} ${session.turns === 1 ? tr('turn') : tr('turns')} · ${formatRelative(Date.now(), session.last, state.locale)}${session.ralph ? ` · ${tr('ralph')}` : ''}${session.archived ? ` · ${tr('archived')}` : ''}`
  const actions = session.kind === 'chat' || !session.kind
    ? `<span class="session-actions">
        <button class="session-action" data-action="toggle-pin" data-run-id="${session.runId}" data-pinned="${session.pinned ? '1' : '0'}" title="${session.pinned ? 'Unpin' : 'Pin'}">${icon('pin', 14)}</button>
        <button class="session-action" data-action="toggle-archive" data-run-id="${session.runId}" data-archived="${session.archived ? '1' : '0'}" title="${session.archived ? 'Unarchive' : 'Archive'}">${icon('archive', 14)}</button>
        <button class="session-action" data-action="rename-session" data-run-id="${session.runId}" title="${tr('renameChat')}" aria-label="${tr('renameChat')}">${icon('edit', 14)}</button>
        <button class="session-action danger" data-action="delete-session" data-run-id="${session.runId}" title="${tr('deleteSession')}">${icon('trash', 14)}</button>
      </span>`
    : ''
  return `<div class="session-row ${active ? 'active' : ''} ${worker ? 'worker-row' : ''} ${session.archived ? 'archived' : ''} ${session.pinned ? 'pinned' : ''}" role="button" tabindex="0" data-action="select-session" data-run-id="${session.runId}">
      <span class="session-dot ${session.busy ? 'busy' : ''} ${worker ? `worker-${worker.status}` : ''}"></span>
      <span class="session-body">
        <span class="session-title">${session.pinned ? icon('pin', 14, 'pin-mark') : ''}${escapeHtml(oneLine(title, 70))}${kind === 'orchestrator' ? ` <span class="session-badge orch">${tr('orchestrator')}</span>` : ''}</span>
        <span class="session-meta">${meta}</span>
      </span>
      ${actions}
      ${session.busy || worker?.status === 'running' ? '<span class="tool-spinner small"></span>' : ''}
    </div>`
}

function renderSidebarSessions(): void {
  const el = document.getElementById('session-list')
  if (!el) return
  const search = state.search.toLowerCase()
  const visible = state.sessions.filter((s) => (state.showArchived || !s.archived) && (!search || `${s.first} ${s.workerTitle ?? ''} ${s.title ?? ''} ${s.runId}`.toLowerCase().includes(search)))
  if (visible.length === 0) {
    el.innerHTML = `<div class="sidebar-empty">${state.sessions.length === 0 ? tr('noSessions') : tr('noMatches')}</div>`
    return
  }
  const active = state.orchestration?.active
  const orchestrator = active ? visible.find((s) => s.runId === active.orchestratorRunId) : undefined
  const workers = active?.workers ?? []
  const workerIds = new Set(workers.map((w) => w.workerId))
  const rest = visible.filter((s) => s.runId !== orchestrator?.runId && !workerIds.has(s.runId))
  const rows: string[] = []
  if (orchestrator) {
    rows.push(`<div class="session-group">${tr('orchestration')}</div>`)
    rows.push(renderSessionRow(orchestrator))
    for (const worker of workers) {
      const summary = visible.find((s) => s.runId === worker.workerId)
      if (!summary) continue
      rows.push(renderSessionRow(summary, worker))
    }
  }
  let lastGroup = ''
  for (const session of rest) {
    const group = session.pinned ? tr('pinned') : new Date(session.last).toDateString() === new Date().toDateString() ? tr('today') : tr('earlier')
    if (group !== lastGroup) {
      rows.push(`<div class="session-group">${group}</div>`)
      lastGroup = group
    }
    rows.push(renderSessionRow(session))
  }
  el.innerHTML = rows.length > 0 ? rows.join('') : `<div class="sidebar-empty">${tr('noMatches')}</div>`
}

function renderHeader(): void {
  const title = document.getElementById('session-title')
  const sub = document.getElementById('session-sub')
  const pill = document.getElementById('run-status')
  if (!title || !sub || !pill) return
  const config = state.boot?.config
  const stateNow = currentState()
  const kind: SessionKind = stateNow?.kind ?? state.current?.state.kind ?? 'chat'
  title.textContent = !state.current
    ? tr('newSession')
    : kind === 'orchestrator'
      ? tr('orchestrator')
      : kind === 'worker'
        ? (stateNow?.workerTitle || tr('worker'))
        : sessionTitle(state.current)
  const kindBadge = kind === 'orchestrator'
    ? `<span class="session-badge orch">${tr('orchestrator')}</span>`
    : kind === 'worker'
      ? `<span class="session-badge worker">${tr('worker')}</span><span class="dot-sep">·</span><span>${workerStatusText(stateNow?.workerStatus)}</span>`
      : ''
  // A chat can be renamed from the header even when the sidebar is collapsed
  // or the row actions are out of view. Workers and the orchestrator keep the
  // title their owner assigned.
  const renameButton = document.getElementById('rename-current') as HTMLButtonElement | null
  if (renameButton) renameButton.hidden = !state.current || kind !== 'chat'
  const cache = cacheInfo(stateNow?.usage)
  sub.innerHTML = state.current
    ? `${kindBadge}${kindBadge ? '<span class="dot-sep">·</span>' : ''}<span>${escapeHtml(state.current.runId)}</span><span class="dot-sep">·</span><span>${escapeHtml(stateNow?.model?.provider ?? config?.worker.provider ?? '')}/${escapeHtml(stateNow?.model?.model ?? config?.worker.model ?? '')}</span><span class="dot-sep">·</span><span>${stateNow?.turns ?? 0} ${tr('turns')}</span><span class="dot-sep">·</span><span>${formatTokens(stateNow?.usage.inputTokens ?? 0)} in / ${formatTokens(stateNow?.usage.outputTokens ?? 0)} out</span><span class="dot-sep">·</span><span>cache ${formatTokens(cache.hit)} (${cache.rate}%)</span>${state.goal ? `<span class="dot-sep">·</span><span class="goal-inline" title="${escapeHtml(state.goal)}">${icon('target', 14)} ${escapeHtml(oneLine(state.goal, 60))}</span>` : ''}`
    : `<span>${escapeHtml(workspaceName())}</span>`
  pill.className = `status-pill ${statusClass()}`
  pill.innerHTML = `${state.busy ? '<span class="tool-spinner small"></span>' : '<span class="status-dot"></span>'}${statusLabel()}`
}

/** Key the open chat's composer draft is stored under. */
function composerKey(): string {
  return composerDraftKey(state.current?.runId)
}

/** Records what the composer holds now, for the chat that is open. */
function saveComposerDraft(value: string): void {
  state.draft = value
  state.composerDrafts = writeComposerDraft(state.composerDrafts, composerKey(), value)
}

/**
 * Records the composer's text for the chat that is open. The DOM is read first:
 * an IME composition in progress has not fired `input` yet, so `state.draft`
 * can lag behind what the user already sees.
 */
function captureComposerDraft(): void {
  const input = document.getElementById('composer-input')
  saveComposerDraft(input instanceof HTMLTextAreaElement ? input.value : state.draft)
}

/** Loads the open chat's draft; a chat never typed into reads as empty. */
function loadComposerDraft(): void {
  state.draft = readComposerDraft(state.composerDrafts, composerKey())
}

/**
 * Rebuilds the composer. `force` is set on a chat switch, where the textarea
 * itself must be replaced even if it currently has the focus.
 */
function renderComposer(force = false): void {
  const wrap = document.getElementById('composer-wrap')
  if (!wrap) return
  // A rebuild replaces the textarea under the caret, which drops an in-flight
  // IME composition and moves the caret back to the start. Background refreshes
  // (SSE state and orchestration events) arrive while the user is typing, so
  // they only refresh the per-turn controls instead.
  const focused = document.getElementById('composer-input')
  const inputFocused = focused instanceof HTMLTextAreaElement && document.activeElement === focused
  if (!force && !shouldRebuildComposer(inputFocused)) {
    updateComposerState()
    return
  }
  const config = state.boot?.config
  const current = currentState()
  const cache = cacheInfo(current?.usage)
  const modelName = current?.model?.model ?? config?.worker.model ?? 'model'
  // Beam Free rejects "none"; the other effort levels are valid for it.
  const effortValues = modelName === 'beam-free'
    ? ['', 'low', 'medium', 'high', 'xhigh', 'max']
    : ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const kind: SessionKind = current?.kind ?? state.current?.state.kind ?? 'chat'
  if (kind === 'worker') {
    wrap.innerHTML = `<div class="worker-readonly"><span class="session-badge worker">${tr('worker')}</span><span>${tr('workerReadOnly')}</span></div>`
    return
  }
  const orchestratorActive = state.orchestration?.active?.status === 'active'
  const activeOrchestratorRunId = orchestratorActive ? state.orchestration?.active?.orchestratorRunId : undefined
  const isActiveOrchestrator = kind === 'orchestrator' && state.current?.runId === activeOrchestratorRunId
  const orchestrationLabel = isActiveOrchestrator
    ? tr('stopOrchestration')
    : orchestratorActive
      ? tr('openOrchestrator')
      : kind === 'orchestrator'
        ? tr('startOrchestration')
        : tr('orchestration')
  // Taken before the swap, because it is the old textarea that holds the caret.
  // Only a focused field is restored: a rebuild triggered from elsewhere must
  // not pull the caret into the composer.
  const previous: ComposerSnapshot | undefined =
    inputFocused && focused instanceof HTMLTextAreaElement
      ? { value: focused.value, selectionStart: focused.selectionStart, selectionEnd: focused.selectionEnd }
      : undefined
  const attachments = state.attachments
    .map(
      (a, i) =>
        `<span class="attachment-chip"><img src="data:${escapeHtml(a.mimeType)};base64,${a.data}" alt=""><span>${escapeHtml(a.name)}</span><button type="button" data-action="remove-attachment" data-index="${i}" title="Remove">${icon('close', 14)}</button></span>`,
    )
    .join('')
  wrap.innerHTML = `<form class="composer" id="composer-form">
    <div id="turn-queue-host"></div>
    <div class="composer-box">
      ${state.goal ? `<div class="goal-banner"><span>${icon('target', 16)} ${tr('goal')}: ${escapeHtml(oneLine(state.goal, 160))}${state.goalState ? ` <span class="tag subtle">${escapeHtml(state.goalState.phase)} ${state.goalState.roundsStarted}/${state.goalState.maxGoalRounds}</span>` : ''}</span><button type="button" class="link-btn" data-action="open-goal">${tr('editGoal')}</button></div>` : ''}
      ${attachments ? `<div class="attachments">${attachments}</div>` : ''}
      <div class="mention-menu" id="mention-menu"></div>
      <textarea id="composer-input" rows="1" placeholder="${tr('inputPlaceholder')}" spellcheck="false">${escapeHtml(state.draft)}</textarea>
      <div class="composer-toolbar">
        <button type="button" class="icon-btn" data-action="attach-image" title="Attach an image">${icon('paperclip', 16)}</button>
        <button type="button" class="chip ${state.planMode ? 'active' : ''}" data-action="toggle-plan" ${kind === 'orchestrator' ? 'disabled' : ''} title="${kind === 'orchestrator' ? tr('orchestratorPlanOnly') : tr('plan')}">${icon('plan', 16)} ${tr('plan')}</button>
        <button type="button" class="chip ${isActiveOrchestrator ? 'active' : ''}" data-action="toggle-orchestration" title="${isActiveOrchestrator ? tr('stopOrchestration') : orchestrationLabel}">${icon('bot', 16)} ${orchestrationLabel}</button>
        <button type="button" class="chip" data-action="open-goal" title="${tr('setGoal')}">${icon('target', 16)} ${tr('goal')}</button>
        <button type="button" class="chip" data-action="open-model" title="Change model">${icon('cpu', 16)} ${escapeHtml(modelName)}</button>
        <select id="effort-select" class="effort-select" title="${tr('effort')}">${effortValues.map((e) => `<option value="${e}" ${(current?.effort ?? '') === e ? 'selected' : ''}>${e ? tr(`effort_${e}`) : tr('effortDefault')}</option>`).join('')}</select>
        <button type="button" class="chip" data-action="sandbox-menu" title="${tr('sandboxTitle')}">${icon('shield', 16)} ${escapeHtml(sandboxModeLabel(current?.sandboxMode ?? config?.sandbox ?? 'unconfined'))}</button>
        <span class="composer-spacer"></span>
        <span class="context-meter" title="Actual provider usage. This process: ${formatTokens(current?.usage.inputTokens ?? 0)} in / ${formatTokens(current?.usage.outputTokens ?? 0)} out, cache ${formatTokens(cache.hit)} (${cache.rate}%). Last turn: ${formatTokens(current?.usage.lastInputTokens ?? 0)} in / ${formatTokens(current?.usage.lastOutputTokens ?? 0)} out.">${statuslineHtml(current)}</span>
        <button type="button" class="icon-btn" data-action="toggle-right" title="Files and diff">${icon('panel', 16)}</button>
        ${state.busy ? `<button type="button" class="chip steer-mode" data-action="toggle-steer-mode" title="${state.steerMode === 'queue' ? tr('steerQueueTitle') : tr('steerTitle')}">${icon('bolt', 14)} ${escapeHtml(steerToggleLabel(state.steerMode, state.locale))}</button>` : ''}
        <button type="button" class="tq-badge" id="tq-badge" data-action="toggle-turn-queue" title="${tr('turnQueueToggle')}" hidden></button>
        <button type="submit" class="send-btn" id="send-btn" title="${tr('send')} (Enter)">${icon('send', 16)}</button>
        <button type="button" class="stop-btn" id="stop-btn" data-action="cancel" title="${tr('stop')}">${icon('stop', 16)}</button>
      </div>
      <input type="file" id="image-input" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
    </div>
    <div class="composer-meta"><span>${tr('enterHint')}</span><span>${state.connection === 'online' ? tr('connected') : state.connection}</span></div>
  </form>`
  updateComposerState()
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null
  if (input) {
    // The textarea is a new node, so an in-flight composition is gone and the
    // caret sits at the start. Both are put back from the snapshot.
    input.value = state.draft
    if (previous) {
      const caret = caretAfterRender(previous, state.draft)
      input.focus()
      input.setSelectionRange(caret.start, caret.end)
    }
    input.addEventListener('input', () => {
      saveComposerDraft(input.value)
      input.style.height = 'auto'
      input.style.height = `${Math.min(220, input.scrollHeight)}px`
      scheduleMentions(input)
    })
    input.style.height = 'auto'
    input.style.height = `${Math.min(220, input.scrollHeight)}px`
  }
  const effortSelect = document.getElementById('effort-select') as HTMLSelectElement | null
  effortSelect?.addEventListener('change', () => {
    void setEffort(effortSelect.value)
  })
  const file = document.getElementById('image-input') as HTMLInputElement | null
  file?.addEventListener('change', () => {
    const files = [...(file.files ?? [])].slice(0, Math.max(0, 8 - state.attachments.length))
    for (const f of files) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(f.type) || f.size > 8 * 1024 * 1024) {
        toast(`Unsupported or too-large image: ${f.name}`, 'error')
        continue
      }
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result ?? '')
        const comma = url.indexOf(',')
        if (comma < 0) return
        state.attachments.push({ name: f.name, mimeType: f.type, data: url.slice(comma + 1) })
        renderComposer()
      }
      reader.readAsDataURL(f)
    }
    file.value = ''
  })
}

function updateComposerState(): void {
  const send = document.getElementById('send-btn') as HTMLButtonElement | null
  const stop = document.getElementById('stop-btn') as HTMLButtonElement | null
  if (send) {
    // Not disabled while busy: a submit steers the running turn, or queues the
    // message when the composer's toggle says "after the turn".
    send.disabled = state.sending
    send.innerHTML = state.sending ? '<span class="tool-spinner small"></span>' : icon('send', 16)
    send.title = state.busy ? (state.steerMode === 'queue' ? tr('steerQueueTitle') : tr('steerTitle')) : `${tr('send')} (Enter)`
  }
  // The stop button stays the way out of a running turn; the textarea itself
  // remains editable so the next message can be queued.
  if (stop) stop.style.display = state.busy ? 'inline-flex' : 'none'
  renderTurnQueue()
}

function mentionCount(): number {
  return state.slashItems.length + state.mentionSkills.length + state.mentionSessions.length + state.mentions.length
}

function scheduleMentions(input: HTMLTextAreaElement): void {
  if (state.mentionTimer !== undefined) window.clearTimeout(state.mentionTimer)
  state.mentionTimer = window.setTimeout(() => {
    const cursor = input.selectionStart ?? input.value.length
    // CP-32: `/re` suggests /rename, /resume, /review.
    state.slashItems = cursor === input.value.length ? slashCompletions(input.value).slice(0, 8) : []
    if (state.slashItems.length > 0) {
      state.mentions = []
      state.mentionSessions = []
      state.mentionSkills = []
      state.mentionIndex = 0
      renderMentionMenu()
      return
    }
    const before = input.value.slice(0, cursor)
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
    if (!match) {
      state.mentions = []
      state.mentionSessions = []
      state.mentionSkills = []
      renderMentionMenu()
      return
    }
    const query = match[1] ?? ''
    state.mentionStart = cursor - query.length - 1
    state.mentionEnd = cursor
    state.mentionIndex = 0
    const runId = currentRunId()
    // WP-60: one call returns files and the earlier chats worth referencing.
    void api<{ files: string[]; sessions: ReferenceSession[]; skills?: Array<{ name: string; description: string }> }>(
      `/api/references?q=${encodeURIComponent(query)}${runId ? `&exclude=${encodeURIComponent(runId)}` : ''}`,
    )
      .then((data) => {
        state.mentions = data.files.slice(0, 30)
        state.mentionSessions = data.sessions.slice(0, 10)
        state.mentionSkills = (data.skills ?? []).slice(0, 8)
        renderMentionMenu()
      })
      .catch(() => {
        state.mentions = []
        state.mentionSessions = []
        state.mentionSkills = []
        renderMentionMenu()
      })
  }, 120)
}

function renderMentionMenu(): void {
  const el = document.getElementById('mention-menu')
  if (!el) return
  if (mentionCount() === 0) {
    el.classList.remove('open')
    el.innerHTML = ''
    return
  }
  el.classList.add('open')
  if (state.slashItems.length > 0) {
    el.innerHTML = `<div class="mention-section">${tr('commandsSection')}</div>${state.slashItems
      .map(
        (c, i) =>
          `<button type="button" class="mention-item ${i === state.mentionIndex ? 'active' : ''}" data-action="insert-slash" data-index="${i}">${icon(c.icon, 13)}<span>/${escapeHtml(c.slash ?? c.id)}${c.args ? ` <span class="muted">${escapeHtml(c.args)}</span>` : ''}</span><span class="muted small slash-desc">${escapeHtml(c.desc)}</span></button>`,
      )
      .join('')}`
    return
  }
  const skillRows = state.mentionSkills
    .map((skill, i) => `<button type="button" class="mention-item ${i === state.mentionIndex ? 'active' : ''}" data-action="insert-mention" data-index="${i}">${icon('book', 13)}<span>@skill:${escapeHtml(skill.name)}</span><span class="muted small slash-desc">${escapeHtml(oneLine(skill.description, 60))}</span></button>`)
    .join('')
  const skillOffset = state.mentionSkills.length
  const sessions = state.mentionSessions
    .map(
      (session, j) => { const i = j + skillOffset; return (
        `<button type="button" class="mention-item ${i === state.mentionIndex ? 'active' : ''}" data-action="insert-mention" data-index="${i}">${icon('clock', 13)}<span>${escapeHtml(oneLine(session.label, 70))}</span><code>${escapeHtml(session.runId)}</code></button>`) },
    )
    .join('')
  const files = state.mentions
    .map((file, offset) => {
      const i = skillOffset + state.mentionSessions.length + offset
      const folder = file.endsWith('/')
      return `<button type="button" class="mention-item ${i === state.mentionIndex ? 'active' : ''}" data-action="insert-mention" data-index="${i}">${icon(folder ? 'folder' : 'file', 13)}<span>${escapeHtml(file)}</span></button>`
    })
    .join('')
  el.innerHTML = `${skillRows ? `<div class="mention-section">${tr('skills')}</div>${skillRows}` : ''}${sessions ? `<div class="mention-section">${tr('sessionsSection')}</div>${sessions}` : ''}${files ? `<div class="mention-section">${tr('filesSection')}</div>${files}` : ''}`
}

/**
 * CP-32: picks a slash suggestion. A command without a required argument runs
 * at once (Enter); otherwise, or with `fill` (Tab), its name is inserted.
 */
function insertSlash(index: number, fill = false): void {
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null
  const spec = state.slashItems[index]
  if (!input || !spec?.slash) return
  state.slashItems = []
  state.mentionIndex = 0
  renderMentionMenu()
  if (!fill && !spec.args?.startsWith('<')) {
    input.value = ''
    saveComposerDraft('')
    void runCommand(spec.id)
    return
  }
  input.value = `/${spec.slash} `
  saveComposerDraft(input.value)
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}

function insertMention(index: number): void {
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null
  if (!input) return
  const skillCount = state.mentionSkills.length
  const sessionCount = state.mentionSessions.length
  let text: string
  let drilled = false
  if (index < skillCount) {
    text = `@skill:${state.mentionSkills[index]!.name} `
  } else if (index - skillCount < sessionCount) {
    const session = state.mentionSessions[index - skillCount]
    if (!session) return
    text = `@session:${session.runId} `
  } else {
    const file = state.mentions[index - skillCount - sessionCount]
    if (!file) return
    text = `@${file} `
    // A folder keeps the menu open so the next level can be picked.
    drilled = file.endsWith('/')
  }
  const before = input.value.slice(0, state.mentionStart)
  const after = input.value.slice(state.mentionEnd)
  input.value = `${before}${text}${after}`
  saveComposerDraft(input.value)
  state.mentions = []
  state.mentionSessions = []
  state.mentionSkills = []
  state.mentionIndex = 0
  renderMentionMenu()
  const cursor = before.length + text.length
  input.focus()
  input.setSelectionRange(cursor, cursor)
  if (drilled) scheduleMentions(input)
}

function renderShell(): void {
  // The shell is rebuilt below and the transcript element is replaced with it.
  // A scroll event that has not been recorded yet would be lost with the old
  // element, so it is flushed first. Nothing is captured otherwise: state.current
  // may already point at the incoming chat while the DOM still shows the old one.
  flushTranscriptAnchor()
  document.documentElement.lang = state.locale === 'zh' ? 'zh-CN' : state.locale
  const app = $('app')
  const config = state.boot?.config
  app.innerHTML = `<div class="app-shell" id="shell">
    <aside class="sidebar" id="sidebar">
      <div class="brand-row">
        <div class="brand-mark"><img src="/HY_icon.png" alt="HY-HARNESS"></div>
        <div class="brand-text"><strong>HY-HARNESS</strong><span>${isDesktop() ? 'Desktop' : 'Web'} · v${escapeHtml(state.boot?.version ?? 'unknown')}</span></div>
        <button class="icon-btn sidebar-collapse" data-action="toggle-sidebar" title="Toggle sidebar">${icon('sidebar', 16)}</button>
      </div>
      <button class="new-chat" data-action="new-session">${icon('plus', 16)} <span>${tr('newChat')}</span><kbd>Ctrl N</kbd></button>
      <div class="sidebar-nav">
        <button class="nav-row" data-action="open-ralph">${icon('plan', 16)} <span>${tr('verifierLoop')}</span></button>
        <button class="nav-row" data-action="open-automation">${icon('clock', 16)} <span>${tr('automation')}</span></button>
      </div>
      <div class="search-box">${icon('search', 16)}<input id="session-search" placeholder="${tr('searchSessions')}" autocomplete="off" value="${escapeHtml(state.search)}"></div>
      <div class="session-list" id="session-list"></div>
      <div class="sidebar-footer">
        <div class="workspace-row">
          <button class="workspace-chip" data-action="choose-workspace" title="${escapeHtml(state.boot?.workspace.root ?? '')}">${icon('folder', 16)}<span>${escapeHtml(workspaceName())}</span>${isDesktop() ? icon('chevron-down', 14) : ''}</button>
          <button class="icon-btn workspace-add-root" data-action="open-roots" title="${tr('addRoot')}">${icon('plus', 16)}</button>
        </div>
        <div class="sidebar-actions">
          <button class="side-btn" data-action="open-settings">${icon('settings', 16)} ${tr('settings')}</button>
          <button class="side-btn" data-action="toggle-theme">${state.theme === 'dark' ? icon('sun', 16) : icon('moon', 16)} ${state.theme === 'dark' ? tr('light') : tr('dark')}</button>
        </div>
        <button class="side-btn archived-toggle" data-action="toggle-archived-filter">${icon('archive', 16)} ${state.showArchived ? tr('hideArchived') : `${tr('showArchived')} (${state.sessions.filter((s) => s.archived).length})`}</button>
        <div class="sidebar-footnote">${escapeHtml(config?.worker.provider ?? '')}/${escapeHtml(config?.worker.model ?? '')} · ${escapeHtml(config?.sandbox ?? '')}</div>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <button class="icon-btn mobile-only" data-action="toggle-sidebar" title="Menu">${icon('sidebar', 16)}</button>
        <div class="session-heading"><h1 id="session-title">${tr('newSession')}</h1><div class="session-sub" id="session-sub"></div></div>
        <div class="topbar-actions">
          <button class="icon-btn" id="rename-current" data-action="rename-current" title="${tr('renameChat')}" hidden>${icon('edit', 16)}</button>
          <button class="icon-btn" data-action="open-outline" title="${tr('turnOutline')}">${icon('plan', 16)}</button>
          <button class="icon-btn" data-action="open-palette" title="${tr('commandPalette')} (Ctrl+K)">${icon('search', 16)}</button>
          <span class="status-pill" id="run-status"><span class="status-dot"></span>${tr('ready')}</span>
          <button class="icon-btn" data-action="toggle-right" title="${tr('toggleRightPanel')}">${icon('panel', 16)}</button>
          <button class="icon-btn" data-action="open-settings" title="${tr('settings')}">${icon('settings', 16)}</button>
        </div>
      </header>
      <div class="find-host" id="find-host"></div>
      <div class="transcript" id="transcript"></div>
      <div class="composer-wrap" id="composer-wrap"></div>
    </main>
    <aside class="rightbar" id="rightbar"></aside>
    <div class="toast-root" id="toast-root"></div>
    <div class="modal-root" id="modal-root"></div>
  </div>`
  applyShellState()
  renderSidebarSessions()
  renderHeader()
  renderComposer()
  renderTranscript()
  renderRightPanel()
  renderModal()
  const search = document.getElementById('session-search') as HTMLInputElement | null
  search?.addEventListener('input', () => {
    state.search = search.value
    renderSidebarSessions()
  })
}

function applyShellState(): void {
  const shell = document.getElementById('shell')
  if (!shell) return
  shell.classList.toggle('sidebar-collapsed', !state.sidebarOpen)
  shell.classList.toggle('right-open', state.right !== null)
  document.documentElement.dataset.theme = state.theme
}

function renderRightPanel(): void {
  const el = document.getElementById('rightbar')
  if (!el) return
  applyShellState()
  if (state.right === null) {
    disposePtyTerminal()
    el.innerHTML = ''
    return
  }
  // Replacing the panel would destroy the xterm canvas and its scrollback.
  // xterm is only recreated when the panel/session/mode changes.
  const keepPty =
    state.right === 'terminal' &&
    state.terminalMode === 'pty' &&
    state.ptyTerm !== undefined &&
    document.getElementById('pty-host') !== null
  if (keepPty) return
  if (state.ptyTerm) disposePtyTerminal()
  const tabs: Array<['files' | 'diff' | 'plan' | 'details' | 'trace' | 'browser' | 'terminal' | 'desktop', string, string]> = [
    ['files', tr('files'), 'folder'],
    ['diff', tr('diff'), 'diff'],
    ['plan', tr('planTab'), 'plan'],
    ['details', tr('details'), 'info'],
    ['trace', tr('trace'), 'clock'],
    ['browser', tr('browser'), 'globe'],
    ['terminal', tr('terminal'), 'terminal'],
    ['desktop', 'Desktop', 'desktop'],
  ]
  const tabHtml = tabs
    .map(([id, label, ico]) => `<button class="right-tab ${state.right === id ? 'active' : ''}" data-action="right-tab" data-panel="${id}">${icon(ico, 14)} ${label}</button>`)
    .join('')
  let body = ''
  if (state.right === 'files') body = renderFilesPanel()
  else if (state.right === 'diff') body = renderDiffPanel()
  else if (state.right === 'plan') body = renderPlanPanel()
  else if (state.right === 'trace') body = renderTracePanel()
  else if (state.right === 'browser') body = renderBrowserPanel()
  else if (state.right === 'terminal') body = renderTerminalPanel()
  else if (state.right === 'desktop') body = renderDesktopPanel()
  else body = renderDetailsPanel()
  el.innerHTML = `<div class="right-head"><div class="right-tabs">${tabHtml}</div><button class="icon-btn" data-action="close-right" title="Close panel">${icon('close', 16)}</button></div><div class="right-body">${body}</div>`
  document.getElementById('file-root')?.addEventListener('change', (event) => {
    state.fileRoot = (event.target as HTMLSelectElement).value
    state.tree.clear()
    state.selectedFile = undefined
    state.file = undefined
    void loadTree('')
  })
  if (state.right === 'terminal' && state.terminalMode === 'pty') {
    requestAnimationFrame(() => {
      void mountPtyTerminal()
    })
  }
}

function renderFilesPanel(): string {
  const rootId = state.fileRoot
  const root = state.roots.find((candidate) => candidate.id === rootId) ?? state.roots[0]
  const key = (dir: string): string => `${rootId}:${dir}`
  const tree = (dir: string, depth: number): string => {
    const entries = state.tree.get(key(dir))
    if (!entries) return `<div class="tree-loading">${tr('loading')}</div>`
    return entries
      .map((entry) => {
        const isDir = entry.type === 'dir'
        const expanded = state.expandedDirs.has(key(entry.path))
        const selected = state.selectedFile === `${rootId}:${entry.path}`
        return `<div class="tree-row ${selected ? 'selected' : ''}" style="--depth:${depth}">
          <button class="tree-item" data-action="${isDir ? 'toggle-dir' : 'open-file'}" data-path="${escapeHtml(entry.path)}">
            <span class="tree-chevron">${isDir ? icon(expanded ? 'chevron-down' : 'chevron-right', 13) : ''}</span>
            <span class="tree-icon">${icon(isDir ? (expanded ? 'folder' : 'folder') : entry.type === 'link' ? 'external' : 'file', 14)}</span>
            <span class="tree-name">${escapeHtml(entry.name)}</span>
            ${entry.size !== undefined ? `<span class="tree-size">${formatBytes(entry.size)}</span>` : ''}
          </button>
        </div>${isDir && expanded ? tree(entry.path, depth + 1) : ''}`
      })
      .join('')
  }
  const file = state.file
  const rootOptions = state.roots
    .map((candidate) => `<option value="${escapeHtml(candidate.id)}" ${candidate.id === rootId ? 'selected' : ''}>${escapeHtml(candidate.label)}${candidate.writable ? '' : ` (${tr('rootReadOnly')})`}</option>`)
    .join('')
  return `<div class="files-toolbar">
      <select id="file-root" class="file-root-select" title="${tr('workspaceRoots')}">${rootOptions}</select>
      <button class="icon-btn" data-action="refresh-tree" title="Refresh">${icon('refresh', 15)}</button>
      ${isDesktop() ? `<button class="icon-btn" data-action="reveal-workspace" title="Show workspace in Explorer">${icon('external', 15)}</button>` : ''}
      <button class="icon-btn" data-action="open-roots" title="${tr('addRoot')}">${icon('plus', 15)}</button>
      <span class="muted small">${escapeHtml(root?.path ?? '')}</span>
    </div>
    <div class="file-tree">${state.tree.has(key('')) ? tree('', 0) : '<div class="tree-loading">Loading…</div>'}</div>
    ${file ? `<div class="file-preview"><div class="file-preview-head"><span>${escapeHtml(file.path)}</span><span class="muted small">${file.lines} lines · ${formatBytes(file.size)}</span></div><pre class="file-content">${file.content.split('\n').map((line) => `<span class="file-line">${escapeHtml(line)}</span>`).join('')}</pre></div>` : ''}`
}

function renderDiffPanel(): string {
  // CP-33: files fold, lines carry numbers, and a click on a line number opens
  // a comment box; the comments go to the composer as one review message.
  const files = parseUnifiedDiff(state.diff)
  const comments = state.diffComments.size
  const toolbar = `<div class="files-toolbar"><button class="icon-btn" data-action="refresh-diff" title="Refresh">${icon('refresh', 15)}</button><span class="muted small">${tr('diffSince')}</span>${
    files.length > 1
      ? `<button class="link-btn" data-action="diff-fold-all">${state.diffCollapsed.size === files.length ? tr('diffUnfoldAll') : tr('diffFoldAll')}</button>`
      : ''
  }${comments > 0 ? `<button class="btn primary small" data-action="diff-send-comments">${icon('send', 13)} ${tr('diffSendComments')} (${comments})</button>` : ''}</div>`
  if (state.diffError) return `${toolbar}<div class="notice warn">${escapeHtml(state.diffError)}</div>`
  if (files.length === 0) return `${toolbar}${renderDiff(state.diff)}`
  const view = renderDiffFiles(files, {
    collapsed: state.diffCollapsed,
    comments: state.diffComments,
    editing: state.diffEditing,
    labels: {
      added: tr('diffAdded'),
      deleted: tr('diffDeleted'),
      renamed: tr('diffRenamed'),
      binary: tr('diffBinary'),
      comment: tr('diffComment'),
      save: tr('save'),
      cancel: tr('cancel'),
    },
  })
  return `${toolbar}<div class="diff-view">${view}</div>`
}

function rerenderDiff(): void {
  if (state.right === 'diff') renderRightPanel()
}

function saveDiffComment(): void {
  const editing = state.diffEditing
  if (!editing) return
  const text = (document.getElementById('diff-comment-input') as HTMLTextAreaElement | null)?.value.trim() ?? ''
  const key = commentKey(editing)
  if (text) state.diffComments.set(key, { ...editing, text })
  else state.diffComments.delete(key)
  state.diffEditing = undefined
  rerenderDiff()
}

function sendDiffComments(): void {
  const prompt = commentsToPrompt(state.diffComments.values())
  if (!prompt) return
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null
  if (!input) return
  input.value = input.value.trim() ? `${input.value.trim()}\n\n${prompt}` : prompt
  saveComposerDraft(input.value)
  input.dispatchEvent(new Event('input'))
  input.focus()
  state.diffComments.clear()
  rerenderDiff()
}

/** CP-33: the find bar over the transcript. */
function renderFindBar(): void {
  const host = document.getElementById('find-host')
  if (!host) return
  if (!state.findOpen) {
    host.innerHTML = ''
    return
  }
  const total = state.findHits.length
  const counter = state.findQuery.trim() ? (total ? `${state.findPos + 1} / ${total}` : tr('findNoMatches')) : ''
  const existing = document.getElementById('find-input') as HTMLInputElement | null
  if (existing) {
    const counterEl = document.getElementById('find-count')
    if (counterEl) counterEl.textContent = counter
    return
  }
  host.innerHTML = `<div class="find-bar" role="search">${icon('search', 14)}<input id="find-input" value="${escapeHtml(state.findQuery)}" placeholder="${tr('findPlaceholder')}" autocomplete="off"><span class="find-count" id="find-count">${escapeHtml(counter)}</span><button type="button" class="icon-btn" data-action="find-prev" title="Shift+Enter">↑</button><button type="button" class="icon-btn" data-action="find-next" title="Enter / F3">↓</button><button type="button" class="icon-btn" data-action="find-close" title="Esc">${icon('close', 14)}</button></div>`
  const input = document.getElementById('find-input') as HTMLInputElement | null
  input?.addEventListener('input', () => {
    state.findQuery = input.value
    runFind()
  })
}

function openFind(query?: string): void {
  state.findOpen = true
  if (query !== undefined) state.findQuery = query
  renderFindBar()
  const input = document.getElementById('find-input') as HTMLInputElement | null
  if (input) {
    if (query !== undefined) input.value = query
    input.focus()
    input.select()
  }
  runFind()
}

function closeFind(): void {
  state.findOpen = false
  state.findHits = []
  state.findPos = -1
  renderFindBar()
  applyFindHighlight()
}

function runFind(): void {
  state.findHits = searchIndex(buildIndex(state.entries as never), state.findQuery)
  state.findPos = state.findHits.length > 0 ? 0 : -1
  renderFindBar()
  applyFindHighlight(true)
}

function stepFind(backwards: boolean): void {
  state.findPos = stepHit(state.findPos, state.findHits.length, backwards)
  renderFindBar()
  applyFindHighlight(true)
}

/** Marks the hits in the rendered transcript; `scroll` brings the current one into view. */
function applyFindHighlight(scroll = false): void {
  for (const el of document.querySelectorAll('.search-hit, .search-current')) el.classList.remove('search-hit', 'search-current')
  if (!state.findOpen) return
  state.findHits.forEach((hit, i) => {
    const el = document.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(hit.id)}"]`)
    if (!el) return
    el.classList.add('search-hit')
    if (i === state.findPos) {
      el.classList.add('search-current')
      if (scroll) el.scrollIntoView({ block: 'center' })
    }
  })
}

/** CP-33: Esc Esc / `/rewind [turn]`. */
function openRewind(turn?: number): void {
  state.rewindTurn = turn
  state.modal = 'rewind'
  renderModal()
}

async function confirmRewind(): Promise<void> {
  const runId = currentRunId()
  const turn = state.rewindTurn
  if (!runId || turn === undefined) return
  const userEntry = state.entries.find((e): e is Extract<ChatEntry, { kind: 'user' }> => e.kind === 'user' && e.turn === turn)
  try {
    const result = await post<{ result: string }>(`/api/sessions/${encodeURIComponent(runId)}/undo`, { toTurn: turn })
    state.modal = undefined
    state.rewindTurn = undefined
    renderModal()
    toast(result.result.split('\n').at(-1) ?? result.result, 'success')
    // Like Codex: the rewound message comes back into the composer to edit.
    const input = document.getElementById('composer-input') as HTMLTextAreaElement | null
    if (input && userEntry) {
      input.value = userEntry.text
      saveComposerDraft(input.value)
      input.dispatchEvent(new Event('input'))
      input.focus()
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function toggleRaw(): void {
  state.rawTranscript = !state.rawTranscript
  renderTranscript()
  toast(state.rawTranscript ? tr('rawOn') : tr('rawOff'))
}

function renderBrowserPanel(): string {
  const hasPlaywright = state.mcp.some((t) => t.server === 'playwright')
  const tabs = `<div class="panel-mode-tabs"><button class="right-tab ${state.browserMode === 'preview' ? 'active' : ''}" data-action="browser-mode" data-mode="preview">${tr('preview')}</button><button class="right-tab ${state.browserMode === 'automation' ? 'active' : ''}" data-action="browser-mode" data-mode="automation">Playwright</button></div>`
  if (state.browserMode === 'automation') {
    if (!hasPlaywright) {
      return `${tabs}<div class="panel-empty">${tr('playwrightNotEnabled')}</div>`
    }
    return `${tabs}<div class="automation-panel">
      <div class="browser-bar"><input id="browser-url" value="${escapeHtml(state.browserUrl)}" placeholder="${tr('browserPlaceholder')}" autocomplete="off"><button class="btn primary" data-action="browser-nav" ${state.browserBusy ? 'disabled' : ''}>${icon('arrow-up', 14)} ${tr('navigate')}</button><button class="btn ghost" data-action="browser-snapshot" ${state.browserBusy ? 'disabled' : ''}>${icon('read', 14)} ${tr('snapshot')}</button></div>
      <div class="automation-controls"><input id="browser-ref" placeholder="@e12 (from snapshot)"><button class="btn ghost" data-action="browser-click" ${state.browserBusy ? 'disabled' : ''}>${tr('click')}</button><input id="browser-text" placeholder="text"><button class="btn ghost" data-action="browser-type" ${state.browserBusy ? 'disabled' : ''}>${tr('type')}</button><button class="btn ghost" data-action="browser-press" ${state.browserBusy ? 'disabled' : ''}>${tr('pressEnter')}</button></div>
      <pre class="automation-output">${escapeHtml(state.browserResult || tr('browserAutomationHint'))}</pre>
    </div>`
  }
  const src = state.browserSrc
  return `${tabs}<div class="browser-bar"><form id="browser-form"><input id="browser-url" value="${escapeHtml(state.browserUrl)}" placeholder="${tr('browserPlaceholder')}" autocomplete="off"><button class="btn primary" type="submit">${icon('arrow-up', 14)} ${tr('go')}</button></form><button class="icon-btn" data-action="browser-external" title="${tr('openInEditor')}">${icon('external', 15)}</button></div>
    ${src ? `<iframe id="browser-frame" class="browser-frame" src="${escapeHtml(src)}" sandbox="allow-scripts allow-forms allow-popups allow-modals" referrerpolicy="no-referrer" title="Browser preview"></iframe>` : `<div class="panel-empty">${tr('browserPlaceholder')}</div>`}`
}

function renderDesktopPanel(): string {
  const hasDesktop = state.mcp.some((t) => t.server === 'agent-desktop')
  if (!hasDesktop) {
    return `<div class="panel-empty">${tr('desktopNotEnabled')}</div>`
  }
  return `<div class="automation-panel">
    <div class="automation-controls"><input id="desktop-app" placeholder="App name (e.g. notepad.exe)"><button class="btn ghost" data-action="desktop-list" ${state.desktopBusy ? 'disabled' : ''}>${icon('read', 14)} ${tr('apps')}</button><button class="btn primary" data-action="desktop-snapshot" ${state.desktopBusy ? 'disabled' : ''}>${icon('desktop', 14)} ${tr('snapshot')}</button></div>
    <div class="automation-controls"><input id="desktop-ref" placeholder="@s8f3k2p9:e8"><button class="btn ghost" data-action="desktop-click" ${state.desktopBusy ? 'disabled' : ''}>${tr('click')}</button><input id="desktop-text" placeholder="text"><button class="btn ghost" data-action="desktop-type" ${state.desktopBusy ? 'disabled' : ''}>${tr('type')}</button></div>
    <div class="automation-controls"><input id="desktop-combo" placeholder="key combo (e.g. ctrl+s)"><button class="btn ghost" data-action="desktop-press" ${state.desktopBusy ? 'disabled' : ''}>${tr('press')}</button></div>
    <pre class="automation-output">${escapeHtml(state.desktopResult || tr('desktopAutomationHint'))}</pre>
  </div>`
}

function renderTerminalPanel(): string {
  const tabs = `<div class="panel-mode-tabs"><button class="right-tab ${state.terminalMode === 'pty' ? 'active' : ''}" data-action="terminal-mode" data-mode="pty">${tr('persistent')}</button><button class="right-tab ${state.terminalMode === 'commands' ? 'active' : ''}" data-action="terminal-mode" data-mode="commands">${tr('commands')}</button></div>`
  return `<div class="terminal-wrap">${tabs}${state.terminalMode === 'pty' ? renderPtyPanel() : renderCommandTerminal()}</div>`
}

function renderPtyPanel(): string {
  const status = state.ptyStatus
  const running = status?.running === true
  const label = state.ptyStarting
    ? tr('running')
    : status?.error
      ? `error: ${status.error}`
      : running
        ? `${tr('running')} · ${status?.shell ?? ''}${status?.pid ? ` · pid ${status.pid}` : ''}`
        : status?.exit
          ? `exited (${status.exit.exitCode})`
          : tr('stopped')
  return `<div class="terminal-panel pty-panel">
    <div class="pty-toolbar">
      <span class="pty-status ${running ? 'is-running' : ''}"><span class="status-dot"></span>${escapeHtml(label)}</span>
      <button class="link-btn" data-action="pty-start" ${running || state.ptyStarting ? 'disabled' : ''}>${icon('play', 12)} ${tr('run')}</button>
      <button class="link-btn" data-action="pty-stop" ${running ? '' : 'disabled'}>${icon('stop', 12)} ${tr('stop')}</button>
      <button class="link-btn" data-action="pty-clear">${icon('trash', 12)} ${tr('clear')}</button>
    </div>
    <div id="pty-host" class="pty-host"></div>
    <div class="pty-hint">${tr('ptyHint')}</div>
  </div>`
}

function renderCommandTerminal(): string {
  const history = state.terminalHistory.length
    ? state.terminalHistory
        .map(
          (entry) =>
            `<div class="terminal-entry"><div class="terminal-cmd">$ ${escapeHtml(entry.command)}</div><pre class="terminal-output">${escapeHtml(entry.output || (entry.error ?? ''))}</pre>${entry.error ? `<div class="notice error">${escapeHtml(entry.error)}</div>` : ''}</div>`,
        )
        .join('')
    : `<div class="panel-empty">${tr('terminalHint')}</div>`
  return `<div class="terminal-panel"><div class="terminal-history">${history}</div><form id="terminal-form" class="terminal-form"><span class="terminal-prompt">$</span><input id="terminal-input" placeholder="git status --short" autocomplete="off" ${state.terminalBusy ? 'disabled' : ''}><button class="btn primary" type="submit" ${state.terminalBusy ? 'disabled' : ''}>${state.terminalBusy ? '<span class="tool-spinner small"></span>' : tr('run')}</button></form><button class="link-btn" data-action="terminal-clear">${icon('trash', 12)} ${tr('clear')}</button></div>`
}

function ptyEndpoint(action: string): string {
  const runId = currentRunId()
  if (!runId) throw new Error('no active session')
  return `/api/sessions/${encodeURIComponent(runId)}/pty${action}`
}

function ptyStatusLabel(): string {
  const status = state.ptyStatus
  if (state.ptyStarting) return tr('running')
  if (status?.error) return `error: ${status.error}`
  if (status?.running) return `${tr('running')} · ${status.shell}${status.pid ? ` · pid ${status.pid}` : ''}`
  if (status?.exit) return `exited (${status.exit.exitCode})`
  return tr('stopped')
}

function paintPtyStatus(): void {
  const status = state.ptyStatus
  const label = document.querySelector('.pty-status')
  if (label) {
    label.innerHTML = `<span class="status-dot"></span>${escapeHtml(ptyStatusLabel())}`
    label.classList.toggle('is-running', status?.running === true)
  }
  const start = document.querySelector<HTMLButtonElement>('[data-action="pty-start"]')
  if (start) start.disabled = status?.running === true || state.ptyStarting
  const stop = document.querySelector<HTMLButtonElement>('[data-action="pty-stop"]')
  if (stop) stop.disabled = status?.running !== true
}

function setPtyStatus(status: PtyStatus | undefined): void {
  state.ptyStatus = status
  paintPtyStatus()
}

function disposePtyTerminal(): void {
  state.ptySource?.close()
  state.ptySource = undefined
  state.ptyTerm?.dispose()
  state.ptyTerm = undefined
  state.ptyFit = undefined
  state.ptyRunId = undefined
  state.ptyStarting = false
  state.ptyStatus = undefined
}

function openPtyEvents(runId: string): void {
  state.ptySource?.close()
  const source = new EventSource(`/api/sessions/${encodeURIComponent(runId)}/pty/events`)
  state.ptySource = source
  source.addEventListener('pty', (raw) => {
    if (state.ptyRunId !== runId) return
    const term = state.ptyTerm
    if (!term) return
    let event: { type?: string; data?: string; status?: PtyStatus; exitCode?: number; signal?: number }
    try {
      event = JSON.parse((raw as MessageEvent<string>).data) as typeof event
    } catch {
      return
    }
    if (event.type === 'snapshot' || event.type === 'reset') {
      if (event.status) {
        setPtyStatus(event.status)
        term.reset()
        if (event.status.output) term.write(event.status.output)
      }
    } else if (event.type === 'data' && typeof event.data === 'string') {
      term.write(event.data)
    } else if (event.type === 'exit') {
      term.write(`\r\n\x1b[90m[process exited${typeof event.exitCode === 'number' ? `: ${event.exitCode}` : ''}]\x1b[0m\r\n`)
      const current = state.ptyStatus
      setPtyStatus({
        ...(current ?? { shell: '', cwd: '', cols: term.cols, rows: term.rows, output: '' }),
        running: false,
        ...(typeof event.exitCode === 'number'
          ? { exit: { exitCode: event.exitCode, ...(typeof event.signal === 'number' ? { signal: event.signal } : {}) } }
          : {}),
      })
      source.close()
      state.ptySource = undefined
    }
  })
}

async function startPtySession(): Promise<void> {
  const term = state.ptyTerm
  const runId = currentRunId()
  if (!term || !runId) return
  state.ptyStarting = true
  paintPtyStatus()
  try {
    const status = await post<PtyStatus>(ptyEndpoint('/start'), { cols: term.cols, rows: term.rows })
    setPtyStatus(status)
    term.reset()
    if (status.output) term.write(status.output)
    openPtyEvents(runId)
    term.focus()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
    toast(message, 'error')
  } finally {
    state.ptyStarting = false
    paintPtyStatus()
  }
}

async function mountPtyTerminal(): Promise<void> {
  const runId = currentRunId()
  const host = document.getElementById('pty-host')
  if (!runId || !(host instanceof HTMLElement)) return
  if (state.ptyTerm && state.ptyRunId === runId) return
  disposePtyTerminal()
  const term = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontSize: 12,
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
    scrollback: 5000,
    theme: {
      background: '#fff8fb',
      foreground: '#35242e',
      cursor: '#e05c88',
      selectionBackground: '#ffd6e5',
      black: '#35242e',
      red: '#d64545',
      green: '#2f9e62',
      yellow: '#b7791f',
      blue: '#e05c88',
      magenta: '#a855a8',
      cyan: '#2f8f9e',
      white: '#ffffff',
      brightBlack: '#8d6a79',
      brightRed: '#e05c88',
      brightGreen: '#2f9e62',
      brightYellow: '#b7791f',
      brightBlue: '#e05c88',
      brightMagenta: '#a855a8',
      brightCyan: '#2f8f9e',
      brightWhite: '#35242e',
    },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)
  state.ptyTerm = term
  state.ptyFit = fit
  state.ptyRunId = runId
  term.onData((data) => {
    void post(ptyEndpoint('/input'), { data }).catch((error: unknown) => {
      term.write(`\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`)
    })
  })
  term.onResize(({ cols, rows }) => {
    // FitAddon fires before /pty/start has created the process.
    if (state.ptyStatus?.running !== true) return
    void post(ptyEndpoint('/resize'), { cols, rows }).catch(() => {
      // The panel may have closed while resizing.
    })
  })
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  try {
    fit.fit()
  } catch {
    // xterm is not visible (the panel was closed during the frame).
  }
  await startPtySession()
}

async function stopPtySession(): Promise<void> {
  try {
    const status = await post<PtyStatus>(ptyEndpoint('/stop'))
    setPtyStatus(status)
    state.ptySource?.close()
    state.ptySource = undefined
    state.ptyTerm?.write('\r\n\x1b[90m[stopped]\x1b[0m\r\n')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function clearPty(): Promise<void> {
  try {
    const status = await post<PtyStatus>(ptyEndpoint('/clear'))
    setPtyStatus(status)
    state.ptyTerm?.reset()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function renderTracePanel(): string {
  const rows = state.trajectory.length
    ? state.trajectory
        .slice(-400)
        .reverse()
        .map(
          (e) =>
            `<div class="trajectory-row" title="${escapeHtml(JSON.stringify(e.payload).slice(0, 500))}"><span class="seq">${e.seq}</span><span class="etype">${escapeHtml(e.type)}</span><span class="etime">${formatTime(e.ts)}</span></div>`,
        )
        .join('')
    : '<div class="panel-empty">No events yet.</div>'
  return `<div class="files-toolbar"><button class="icon-btn" data-action="refresh-trace" title="Refresh">${icon('refresh', 15)}</button><span class="muted small">${state.trajectory.length} event(s) · raw session log</span></div>${rows}`
}

function renderPlanPanel(): string {
  const source = state.plan || state.planModeText
  return `<div class="files-toolbar"><button class="icon-btn" data-action="refresh-plan" title="Refresh">${icon('refresh', 15)}</button><span class="muted small">${state.planMode ? 'plan mode is on' : 'last update_plan'}</span></div><div class="panel-pre">${escapeHtml(source || 'No plan yet.')}</div>`
}

function renderMiniEntries(entries: ChatEntry[]): string {
  return entries
    .slice(-30)
    .map((entry) => {
      if (entry.kind === 'user') return `<div class="mini-row user"><span>You</span><p>${escapeHtml(entry.text.slice(0, 300))}</p></div>`
      if (entry.kind === 'assistant') return `<div class="mini-row"><span>HY</span><p>${escapeHtml(entry.text.slice(0, 500))}</p></div>`
      if (entry.kind === 'tool') return `<div class="mini-row tool"><span>${escapeHtml(entry.name)}</span><p>${escapeHtml((entry.output ?? '').slice(0, 260))}</p></div>`
      if (entry.kind === 'notice') return `<div class="mini-row notice-row">${escapeHtml(entry.text)}</div>`
      return ''
    })
    .join('')
}

/** WP-60: jumps to a message in the transcript (the outline's rows). */
function scrollToEntry(entryId: string): void {
  const node = document.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(entryId)}"]`)
  if (!node) return
  node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  node.classList.add('flash')
  window.setTimeout(() => node.classList.remove('flash'), 1_200)
}

const FEEDBACK_CATEGORIES_UI = ['accuracy', 'style', 'instruction', 'speed', 'tool_use', 'safety', 'other'] as const

/** WP-61: sends a rating; `extra` carries the category and the note. */
async function sendFeedback(rating: 'up' | 'down', entryId: string, extra: { category?: string; note?: string } = {}): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    await post(`/api/sessions/${encodeURIComponent(runId)}/feedback`, {
      rating,
      entryId,
      ...(extra.category ? { category: extra.category } : {}),
      ...(extra.note ? { note: extra.note } : {}),
    })
    toast(tr('feedbackThanks'), 'success')
  } catch (error) {
    toast(`${tr('feedbackFailed')}: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

function openFeedback(entryId: string): void {
  state.feedbackEntryId = entryId
  state.feedbackCategory = ''
  state.feedbackNote = ''
  state.modal = 'feedback'
  renderModal()
}

/** WP-61: the feedback dialog (a down rating can name a category and a note). */
function renderFeedbackModal(): string {
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal feedback-modal" role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${icon('alert', 16)} ${tr('feedbackTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
    <div class="modal-body">
      <p class="muted">${tr('feedbackHint')}</p>
      <div class="feedback-categories">${FEEDBACK_CATEGORIES_UI.map((category) => `<button type="button" class="chip ${state.feedbackCategory === category ? 'active' : ''}" data-action="feedback-category" data-category="${category}">${tr(`feedbackCategory_${category}`)}</button>`).join('')}</div>
      <label class="modal-field">${tr('feedbackNote')}<textarea id="feedback-note" rows="3" placeholder="${tr('feedbackNotePlaceholder')}">${escapeHtml(state.feedbackNote)}</textarea></label>
      <div class="settings-note">${icon('lock', 14)} ${tr('feedbackLocalOnly')}</div>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-action="close-modal">${tr('cancel')}</button><button class="btn primary" data-action="feedback-send">${icon('check', 16)} ${tr('feedbackSend')}</button></div>
  </div></div>`
}

/** WP-61: the shortcuts editor (record a chord, reset one or all). */
function renderShortcutsModal(): string {
  const conflicts = shortcutConflicts(state.shortcuts)
  const rows = SHORTCUT_ACTIONS.map((action) => {
    const keys = state.shortcuts[action.id] ?? ''
    const isDefault = keys === normalizeAccelerator(action.defaultKeys)
    return `<div class="shortcut-row"><span>${escapeHtml(tr(action.labelKey))}</span><input class="shortcut-input" data-shortcut="${action.id}" value="${escapeHtml(keys)}" readonly placeholder="${escapeHtml(tr('shortcutRecord'))}" autocomplete="off">${isDefault ? '' : `<button type="button" class="link-btn" data-action="shortcut-clear" data-shortcut="${action.id}">${tr('reset')}</button>`}</div>`
  }).join('')
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal shortcuts-modal" role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${icon('bolt', 16)} ${tr('shortcuts')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
    <div class="modal-body">
      <p class="muted">${tr('shortcutsHint')}</p>
      <div class="shortcut-list">${rows}</div>
      ${conflicts.length > 0 ? `<div class="settings-note warn">${icon('alert', 14)} ${escapeHtml(conflicts.join('; '))}</div>` : ''}
      <div class="settings-note">${icon('info', 14)} ${tr('shortcutsDeviceOnly')}</div>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-action="shortcut-reset">${tr('shortcutsResetAll')}</button><span style="flex:1 1 auto"></span><button class="btn primary" data-action="close-modal">${tr('close')}</button></div>
  </div></div>`
}

/** The chord pressed in a shortcut input, or '' while only a modifier is held. */
function chordFromEvent(event: KeyboardEvent): string {
  const key = event.key
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return ''
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  parts.push(key.length === 1 ? key.toUpperCase() : key)
  return parts.join('+')
}

function shortcutActionFor(event: KeyboardEvent): string | undefined {
  for (const action of SHORTCUT_ACTIONS) {
    const keys = state.shortcuts[action.id]
    if (keys && matchesAccelerator(event, keys)) return action.id
  }
  return undefined
}

function runShortcut(actionId: string): void {
  switch (actionId) {
    case 'palette':
      openPalette()
      break
    case 'newSession':
      void newSession()
      break
    case 'settings':
      void openSettings()
      break
    case 'outline':
      state.modal = 'outline'
      renderModal()
      break
    case 'toggleSidebar':
      state.sidebarOpen = !state.sidebarOpen
      applyShellState()
      break
    case 'toggleTheme':
      setTheme(state.theme === 'light' ? 'dark' : state.theme === 'dark' ? 'system' : 'light')
      break
    case 'focusComposer':
      document.getElementById('composer-input')?.focus()
      break
    case 'stopTurn':
      void cancel()
      break
    case 'find':
      openFind()
      break
    default:
      break
  }
}

/** WP-61: opens the selected file (or the workspace root) in a detected program. */
async function openInTarget(target: string): Promise<void> {
  try {
    await post('/api/open-in', {
      target,
      path: state.selectedFile ?? '.',
      root: state.fileRoot,
    })
    toast(tr('openInStarted'), 'success')
  } catch (error) {
    toast(`${tr('openInFailed')}: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

/** CP-06: mode, path policies and the blocked calls of this session. */
function sandboxRows(sandbox: SandboxInfo | undefined): string {
  const config = state.boot?.config
  const rows = [
    `<div class="detail-row"><span>mode</span><strong>${escapeHtml(config?.sandbox ?? '')}</strong></div>`,
    `<div class="detail-row"><span>enforcement</span><strong>${escapeHtml(sandbox?.enforcement ?? 'unknown')}</strong></div>`,
  ]
  const denyRead = sandbox?.denyRead ?? []
  if (denyRead.length > 0) {
    rows.push(`<div class="detail-row"><span>${tr('denyReadPaths')}</span><strong>${denyRead.length}</strong></div>`)
  }
  const readOnly = sandbox?.readOnly ?? []
  if (readOnly.length > 0) {
    rows.push(`<div class="detail-row"><span>${tr('readOnlyPaths')}</span><strong>${readOnly.length}</strong></div>`)
  }
  const denials = sumDenials(state.entries)
  if (denials.length > 0) {
    const total = denials.reduce((sum, item) => sum + item.count, 0)
    rows.push(
      `<div class="detail-row"><span>${tr('blockedCalls')}</span><strong>${total}</strong></div>`,
      `<ul class="denial-list">${denials
        .map((item) => `<li><span class="tag danger">${escapeHtml(item.kind)}</span><span>${item.count}</span></li>`)
        .join('')}</ul>`,
    )
  }
  const lastDenied = [...state.entries].reverse().find((entry): entry is ChatToolEntry => entry.kind === 'tool' && Boolean(entry.denial))
  if (lastDenied?.output) {
    rows.push(`<p class="muted small mono">${escapeHtml(lastDenied.output.slice(0, 300))}</p>`)
  }
  for (const failed of [...(sandbox?.denyReadFailed ?? []), ...(sandbox?.readOnlyFailed ?? [])].slice(0, 3)) {
    rows.push(`<div class="detail-row"><span>${tr('deniedFailed')}</span><strong class="mono small">${escapeHtml(failed)}</strong></div>`)
  }
  return rows.join('')
}
function renderDetailsPanel(): string {
  const config = state.boot?.config
  const entry = state.selectedEntry
  const sandbox = state.boot?.sandbox
  const jobs = state.jobs.length
    ? state.jobs
        .map(
          (job) =>
            `<div class="job-row"><span class="job-state ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span><code>${escapeHtml(job.command)}</code><button class="link-btn" data-action="job-output" data-job-id="${escapeHtml(job.jobId)}">${icon('read', 12)} Output</button>${job.status === 'running' || job.status === 'backgrounded' ? `<button class="link-btn danger" data-action="job-kill" data-job-id="${escapeHtml(job.jobId)}">${icon('stop', 12)} Kill</button>` : ''}</div>`,
        )
        .join('')
    : `<div class="panel-empty">${tr('noJobs')}</div>`
  const workers = state.orchestration?.active?.workers.length
    ? state.orchestration.active.workers
        .map(
          (worker) =>
            `<div class="worker-card"><button class="agent-row" data-action="select-session" data-run-id="${escapeHtml(worker.workerId)}"><span class="agent-kind worker-${worker.status}">${escapeHtml(workerStatusText(worker.status, worker.blocker))}</span><span class="worker-card-main"><strong>${escapeHtml(worker.title)}</strong><span class="worker-scope">${escapeHtml(worker.scope.join(', '))}</span></span></button>${worker.status !== 'done' ? `<button class="link-btn danger" data-action="stop-worker" data-worker-id="${escapeHtml(worker.workerId)}">${icon('stop', 12)} ${tr('stop')}</button>` : ''}${worker.blocker ? `<div class="worker-blocker">${escapeHtml(oneLine(worker.blocker, 180))}</div>` : ''}${worker.lastSummary ? `<div class="worker-summary">${escapeHtml(oneLine(worker.lastSummary, 180))}</div>` : ''}${worker.lastError ? `<div class="worker-error">${escapeHtml(oneLine(worker.lastError, 180))}</div>` : ''}</div>`,
        )
        .join('')
    : `<div class="panel-empty">${tr('noWorkers')}</div>`
  const subagents = state.subagents.length
    ? state.subagents
        .map(
          (sub) =>
            `<button class="agent-row" data-action="open-subagent" data-sub-id="${escapeHtml(sub.runId)}"><span class="agent-kind">${sub.readOnly ? 'read-only' : 'write'}</span><code>${escapeHtml(sub.runId)}</code><span class="agent-preview">${escapeHtml(sub.preview || `${sub.entries} event(s)`)}</span></button>`,
        )
        .join('')
    : `<div class="panel-empty">${tr('noSubagents')}</div>`
  // WP-22: background subagents keep their conversation, so the panel offers a
  // follow-up box (or a stop button while a turn runs).
  const agents = state.agents.length
    ? state.agents
        .map((agent) => {
          const id = escapeHtml(agent.agentId)
          const running = agent.status === 'running'
          const actions = running
            ? `<button class="link-btn danger" data-action="agent-interrupt" data-agent-id="${id}">${icon('stop', 12)} ${tr('stop')}</button>`
            : agent.status === 'closed'
              ? ''
              : `<input class="agent-input" data-agent-input="${id}" placeholder="${tr('agentFollowUp')}" autocomplete="off"><button class="link-btn" data-action="agent-send" data-agent-id="${id}">${icon('send', 12)} ${tr('send')}</button>`
          return `<div class="agent-card"><div class="agent-head"><span class="agent-kind agent-${escapeHtml(agent.status)}">${escapeHtml(agent.status)}</span><code>${id}</code>${agent.readOnly ? `<span class="tag subtle">read-only</span>` : ''}</div><div class="agent-task">${escapeHtml(oneLine(agent.task, 180))}</div>${agent.final ? `<div class="agent-preview">${escapeHtml(oneLine(agent.final, 240))}</div>` : ''}${agent.error ? `<div class="agent-error">${escapeHtml(oneLine(agent.error, 240))}</div>` : ''}<div class="agent-actions">${actions}</div></div>`
        })
        .join('')
    : ''
  const trajectory = state.trajectory.length
    ? state.trajectory
        .slice(-60)
        .reverse()
        .map((e) => `<div class="trajectory-row"><span class="seq">${e.seq}</span><span class="etype">${escapeHtml(e.type)}</span><span class="etime">${formatTime(e.ts)}</span></div>`)
        .join('')
    : `<div class="panel-empty">${tr('noEvents')}</div>`
  const mcp = state.mcp.length
    ? state.mcp.map((t) => `<div class="catalog-row"><span class="tag">${escapeHtml(t.server)}</span><code>${escapeHtml(t.name)}</code><span>${escapeHtml(t.description)}</span></div>`).join('')
    : `<div class="panel-empty">${tr('noMcp')}</div>`
  const plugins = state.plugins.length
    ? state.plugins.map((t) => `<div class="catalog-row"><span class="tag">${escapeHtml(t.plugin)}</span><code>${escapeHtml(t.name)}</code><span>${escapeHtml(t.description)}</span></div>`).join('')
    : `<div class="panel-empty">${tr('noPlugins')}</div>`
  const memory = state.memory.length
    ? state.memory.map((m) => `<div class="catalog-row"><code>${escapeHtml(m.key)}</code><span>${escapeHtml(m.text)}</span><span class="muted small">${escapeHtml(m.updated)}</span></div>`).join('')
    : `<div class="panel-empty">${tr('memoryEmpty')}</div>`
  return `<div class="details-scroll">
    <section class="detail-block"><h3>${icon('target', 16)} ${tr('sessionGoal')}</h3>${state.goal ? `<p class="goal-text">${escapeHtml(state.goal)}</p>` : `<div class="panel-empty">${tr('noGoal')}</div>`}<button class="btn ghost" data-action="open-goal">${icon('edit', 14)} ${state.goal ? tr('editGoal') : tr('setGoal')}</button></section>
    ${entry ? `<section class="detail-block"><h3>${icon(toolIcon(entry.name), 16)} ${escapeHtml(entry.name)}</h3><div class="detail-row"><span>status</span><strong>${escapeHtml(entry.status)}</strong></div><div class="detail-row"><span>call</span><code>${escapeHtml(entry.callId)}</code></div><pre class="detail-json">${escapeHtml(JSON.stringify({ args: entry.args, result: entry.result, output: entry.output }, null, 2))}</pre></section>` : ''}
    <section class="detail-block"><h3>${icon('terminal', 16)} ${tr('jobs')}</h3>${jobs}${state.jobOutput ? `<pre class="detail-json">${escapeHtml(state.jobOutput)}</pre>` : ''}<button class="link-btn" data-action="refresh-jobs">${icon('refresh', 14)} ${tr('refreshJobs')}</button></section>
    <section class="detail-block"><h3>${icon('bot', 16)} ${tr('workers')}</h3>${workers}</section>
    <section class="detail-block"><h3>${icon('bot', 16)} ${tr('subagents')}</h3>${agents}${subagents}${state.agentEntries.length ? `<div class="mini-transcript">${renderMiniEntries(state.agentEntries)}</div>` : ''}</section>
    <section class="detail-block" data-section="session"><h3>${icon('info', 16)} ${tr('session')}</h3><pre class="panel-pre">${escapeHtml(state.status || 'No status yet.')}</pre></section>
    <section class="detail-block" data-section="stats"><h3>${icon('clock', 16)} ${tr('statsTitle')}</h3>${statsRows()}</section>
    <section class="detail-block"><h3>${icon('git', 16)} ${tr('forkChat')}</h3><p class="muted small">${tr('forkHint')}</p><button class="btn ghost" data-action="fork-chat" data-run-id="${escapeHtml(currentRunId() ?? '')}" ${currentRunId() ? '' : 'disabled'}>${icon('git', 14)} ${tr('forkChat')}</button></section>
    <section class="detail-block"><h3>${icon('external', 16)} ${tr('openIn')}</h3>${openInRows()}</section>
    <section class="detail-block" data-section="notes"><h3>${icon('plan', 16)} ${tr('notes')}</h3><pre class="panel-pre">${escapeHtml(state.notes || tr('noNotes'))}</pre></section>
    <section class="detail-block" data-section="skills"><h3>${icon('book', 16)} ${tr('skills')}</h3><pre class="panel-pre">${escapeHtml(state.skills || tr('noSkills'))}</pre></section>
    <section class="detail-block" data-section="mcp"><h3>${icon('cpu', 16)} ${tr('mcp')}</h3>${mcp}</section>
    <section class="detail-block" data-section="plugins"><h3>${icon('cpu', 16)} ${tr('plugins')}</h3>${plugins}</section>
    <section class="detail-block" data-section="memory"><h3>${icon('read', 16)} ${tr('workspaceMemory')}</h3>${memory}</section>
    <section class="detail-block"><h3>${icon('shield', 16)} ${tr('sandbox')}</h3>${sandboxRows(sandbox)}</section>
    <section class="detail-block"><h3>${icon('cpu', 16)} ${tr('roles')}</h3>${config ? roleRows(config) : ''}</section>
    <section class="detail-block"><h3>${icon('clock', 16)} ${tr('trajectory')}</h3>${trajectory}<button class="link-btn" data-action="refresh-details">${icon('refresh', 14)} ${tr('refresh')}</button></section>
  </div>`
}

/** WP-61: the "Open In" block of the details panel. */
function openInRows(): string {
  if (!state.openInLocal) return `<div class="panel-empty">${tr('openInRemote')}</div>`
  if (state.openInTargets.length === 0) return `<div class="panel-empty">${tr('openInNone')}</div>`
  return `<div class="field-row"><select id="open-in-target">${state.openInTargets
    .map((target) => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.label)} (${target.kind})</option>`)
    .join('')}</select><button class="btn ghost" data-action="open-in">${icon('external', 14)} ${tr('open')}</button></div><p class="muted small">${escapeHtml(state.selectedFile ?? tr('openInRoot'))}</p>`
}

/** WP-61: the timings section of the details panel. */
function statsRows(): string {
  const stats = state.stats
  if (!stats || (stats.turns === 0 && stats.steps === 0)) return `<div class="panel-empty">${tr('noStats')}</div>`
  const rows: Array<[string, string]> = [
    [tr('statTurns'), formatTokens(stats.turns)],
    [tr('statSteps'), formatTokens(stats.steps)],
    [tr('statLlm'), formatDuration(stats.llmMs)],
    [tr('statTools'), formatDuration(stats.toolMs)],
    [tr('statFirstAnswer'), formatDuration(stats.firstResponseMs)],
    [tr('statLastTurn'), formatDuration(stats.lastTurnMs)],
  ]
  const tools = Object.entries(stats.tools)
    .map(
      ([name, tool]) =>
        `<div class="detail-row"><span><code>${escapeHtml(name)}</code></span><strong>${tool.calls}${tool.errors ? ` (${tool.errors} err)` : ''}${tool.ms ? ` · ${formatDuration(tool.ms)}` : ''}</strong></div>`,
    )
    .join('')
  return (
    rows.map(([label, value]) => `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`).join('') +
    (tools ? `<div class="stats-tools">${tools}</div>` : '')
  )
}

function roleRows(config: ConfigSummary): string {
  const rows: Array<[string, { provider: string; model: string } | null]> = [
    ['worker', config.worker],
    ['guardian', config.guardian],
    ['grader', config.grader],
    ['compactor', config.compactor],
    ['summarizer', config.summarizer],
  ]
  return rows
    .map(([name, role]) => `<div class="detail-row"><span>${name}</span><strong>${role ? `${escapeHtml(role.provider)}/${escapeHtml(role.model)}` : '—'}</strong></div>`)
    .join('')
}

function renderAutomationModal(): string {
  const data = state.automation
  const tab = state.automationTab
  const rows = tab === 'schedules'
    ? (data?.schedules ?? [])
        .map(
          (s) =>
            `<div class="automation-row"><div class="automation-main"><strong>${escapeHtml(s.name)}</strong><span class="automation-meta"><code>${escapeHtml(s.cron)}</code> · ${escapeHtml(s.cwd)}${s.nextRun ? ` · ${tr('next')} ${escapeHtml(new Date(s.nextRun).toLocaleString())}` : ''}</span></div><span class="automation-status ${s.lastStatus ?? ''}">${escapeHtml(s.lastStatus ?? 'idle')}</span><div class="automation-actions"><button class="link-btn" data-action="automation-run" data-kind="schedules" data-id="${s.id}">${icon('terminal', 12)} ${tr('run')}</button><button class="link-btn" data-action="automation-edit" data-kind="schedules" data-id="${s.id}">${icon('edit', 12)} ${tr('edit')}</button><button class="link-btn" data-action="automation-toggle" data-kind="schedules" data-id="${s.id}" data-enabled="${s.enabled ? '1' : '0'}">${s.enabled ? tr('pause') : tr('resume')}</button><button class="link-btn danger" data-action="automation-delete" data-kind="schedules" data-id="${s.id}">${icon('trash', 12)}</button></div></div>`,
        )
        .join('')
    : (data?.webhooks ?? [])
        .map(
          (w) =>
            `<div class="automation-row"><div class="automation-main"><strong>${escapeHtml(w.name)}</strong><span class="automation-meta"><code>${escapeHtml(w.endpoint)}</code> · ${escapeHtml(w.cwd)}</span></div><span class="automation-status ${w.lastStatus ?? ''}">${escapeHtml(w.lastStatus ?? 'idle')}</span><div class="automation-actions"><button class="link-btn" data-action="automation-run" data-kind="webhooks" data-id="${w.id}">${icon('terminal', 12)} ${tr('run')}</button><button class="link-btn" data-action="automation-edit" data-kind="webhooks" data-id="${w.id}">${icon('edit', 12)} ${tr('edit')}</button><button class="link-btn" data-action="automation-toggle" data-kind="webhooks" data-id="${w.id}" data-enabled="${w.enabled ? '1' : '0'}">${w.enabled ? tr('pause') : tr('resume')}</button><button class="link-btn danger" data-action="automation-delete" data-kind="webhooks" data-id="${w.id}">${icon('trash', 12)}</button></div></div>`,
        )
        .join('')
  const form = state.automationForm
  const formHtml = form
    ? `<div class="automation-form"><h3>${form.id ? tr('edit') : tr('newItem')} ${form.kind === 'schedule' ? tr('schedules') : tr('webhooks')}</h3>
        <label class="modal-field">${tr('name')}<input id="automation-name" value="${escapeHtml(form.name)}"></label>
        ${form.kind === 'schedule' ? `<label class="modal-field">${tr('cronLabel')}<input id="automation-cron" value="${escapeHtml(form.cron)}" placeholder="0 9 * * 1-5"></label>` : ''}
        <label class="modal-field">${tr('workspaceTitle')}<input id="automation-cwd" value="${escapeHtml(form.cwd)}"></label>
        <label class="modal-field">${tr('objective')}<textarea id="automation-objective" rows="3">${escapeHtml(form.objective)}</textarea></label>
        <label class="modal-field">${tr('verificationCommands')}<textarea id="automation-verify" rows="2" placeholder="npm test">${escapeHtml(form.verifyCmds)}</textarea></label>
        <div class="field-row"><label class="modal-field checkbox-field"><input id="automation-auto" type="checkbox" ${form.autoApprove ? 'checked' : ''}> ${tr('autoApprove')}</label><label class="modal-field checkbox-field"><input id="automation-enabled" type="checkbox" ${form.enabled ? 'checked' : ''}> ${tr('enabled')}</label></div>
        ${form.kind === 'webhook' && form.secret ? `<div class="automation-secret"><div><strong>${tr('webhookUrl')}</strong><code>${escapeHtml(location.origin + (form.endpoint ?? ''))}</code></div><div><strong>${tr('secretHeader')}</strong><code>x-hy-webhook-secret: ${escapeHtml(form.secret)}</code><button class="link-btn" data-action="automation-copy" data-copy="${escapeHtml(form.secret)}">${icon('copy', 12)} ${tr('copy')}</button></div><div class="muted small">${tr('triggerNote')}</div></div>` : ''}
        <div class="automation-form-actions"><button class="btn ghost" data-action="automation-cancel">${tr('cancel')}</button><button class="btn primary" data-action="automation-save">${icon('check', 15)} ${tr('save')}</button></div>
      </div>`
    : ''
  const run = state.automationRun
  const runHtml = run ? `<div class="automation-run"><div class="automation-run-head"><strong>${escapeHtml(run.name)}</strong><span class="automation-status ${run.status}">${run.status}</span>${run.runId ? `<code>${escapeHtml(run.runId)}</code>` : ''}</div><pre class="ralph-output">${escapeHtml(run.output.join('\n') || tr('loading'))}</pre></div>` : ''
  return `<div class="modal-backdrop" data-action="close-automation"><div class="modal automation-modal" role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${icon('clock', 16)} ${tr('automation')}</h2><span class="muted small">cron + webhook → hy run / hy ralph</span><button class="icon-btn" data-action="close-automation">${icon('close', 16)}</button></div>
    <div class="modal-body">
      <div class="automation-tabs"><button class="right-tab ${tab === 'schedules' ? 'active' : ''}" data-action="automation-tab" data-tab="schedules">${tr('schedules')} (${data?.schedules.length ?? 0})</button><button class="right-tab ${tab === 'webhooks' ? 'active' : ''}" data-action="automation-tab" data-tab="webhooks">${tr('webhooks')} (${data?.webhooks.length ?? 0})</button><span class="automation-spacer"></span><button class="btn ghost" data-action="automation-new" data-kind="${tab === 'schedules' ? 'schedule' : 'webhook'}">${icon('plus', 14)} ${tr('newItem')}</button></div>
      <div class="automation-list">${rows || `<div class="panel-empty">${tab === 'schedules' ? tr('noSchedules') : tr('noWebhooks')}</div>`}</div>
      ${formHtml}
      ${runHtml}
    </div>
    <div class="modal-foot"><span class="muted small">${tr('automationFooter')}</span><button class="btn primary" data-action="close-automation">${tr('close')}</button></div>
  </div></div>`
}

async function openAutomation(): Promise<void> {
  try {
    const data = await api<AutomationData>('/api/automation')
    state.automation = data
    state.automationTab = 'schedules'
    state.automationForm = undefined
    state.automationRun = undefined
    state.modal = 'automation'
    renderModal()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function refreshAutomation(): Promise<void> {
  try {
    state.automation = await api<AutomationData>('/api/automation')
    renderModal()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function newAutomationForm(kind: 'schedule' | 'webhook'): void {
  state.automationForm = {
    kind,
    name: '',
    cron: '0 9 * * 1-5',
    cwd: state.boot?.workspace.root ?? '',
    objective: '',
    verifyCmds: '',
    autoApprove: false,
    enabled: true,
  }
  renderModal()
}

function editAutomationForm(kind: 'schedule' | 'webhook', id: string): void {
  const item = kind === 'schedule' ? state.automation?.schedules.find((s) => s.id === id) : state.automation?.webhooks.find((w) => w.id === id)
  if (!item) return
  state.automationForm = {
    kind,
    id: item.id,
    name: item.name,
    cron: 'cron' in item ? item.cron : '',
    cwd: item.cwd,
    objective: item.objective,
    verifyCmds: item.verifyCmds.join('\n'),
    autoApprove: item.autoApprove,
    enabled: item.enabled,
    ...('secret' in item ? { secret: item.secret, endpoint: item.endpoint } : {}),
  }
  renderModal()
}

async function saveAutomationForm(): Promise<void> {
  const form = state.automationForm
  if (!form) return
  const body = {
    name: (document.getElementById('automation-name') as HTMLInputElement | null)?.value.trim() ?? '',
    ...(form.kind === 'schedule' ? { cron: (document.getElementById('automation-cron') as HTMLInputElement | null)?.value.trim() ?? '' } : {}),
    cwd: (document.getElementById('automation-cwd') as HTMLInputElement | null)?.value.trim() ?? '',
    objective: (document.getElementById('automation-objective') as HTMLTextAreaElement | null)?.value.trim() ?? '',
    verifyCmds: ((document.getElementById('automation-verify') as HTMLTextAreaElement | null)?.value ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
    autoApprove: (document.getElementById('automation-auto') as HTMLInputElement | null)?.checked === true,
    enabled: (document.getElementById('automation-enabled') as HTMLInputElement | null)?.checked === true,
  }
  try {
    const collection = form.kind === 'schedule' ? 'schedules' : 'webhooks'
    if (form.id) await put(`/api/automation/${collection}/${encodeURIComponent(form.id)}`, body)
    else await post(`/api/automation/${collection}`, body)
    state.automationForm = undefined
    await refreshAutomation()
    toast('Automation saved', 'success')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function deleteAutomation(kind: 'schedules' | 'webhooks', id: string): Promise<void> {
  try {
    await api(`/api/automation/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    state.automationForm = undefined
    await refreshAutomation()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function toggleAutomation(kind: 'schedules' | 'webhooks', id: string, enabled: boolean): Promise<void> {
  try {
    await post(`/api/automation/${kind}/${encodeURIComponent(id)}/enabled`, { enabled })
    await refreshAutomation()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function runAutomation(kind: 'schedules' | 'webhooks', id: string): Promise<void> {
  try {
    const run = await post<AutomationRun>(`/api/automation/${kind}/${encodeURIComponent(id)}/run`)
    state.automationRun = run
    renderModal()
    if (state.automationTimer !== undefined) window.clearInterval(state.automationTimer)
    state.automationTimer = window.setInterval(() => void pollAutomationRun(), 800)
    void pollAutomationRun()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function pollAutomationRun(): Promise<void> {
  const run = state.automationRun
  if (!run) return
  try {
    const next = await api<AutomationRun>(`/api/automation/runs/${encodeURIComponent(run.id)}`)
    state.automationRun = next
    renderModal()
    if (next.status !== 'running') {
      if (state.automationTimer !== undefined) window.clearInterval(state.automationTimer)
      state.automationTimer = undefined
      await refreshAutomation()
    }
  } catch {
    // keep polling
  }
}

interface ProviderDefaults {
  model: string
  baseUrl: string
  apiKeyEnv: string
  contextWindowTokens: number
  maxOutputTokens: number
}

function sandboxModeLabel(mode: string): string {
  switch (mode) {
    case 'read-only':
      return tr('sandboxReadOnly')
    case 'workspace-write':
      return tr('sandboxWorkspaceWrite')
    case 'unconfined':
      return tr('sandboxUnconfined')
    case 'low-integrity':
      return tr('sandboxLowIntegrity')
    default:
      return mode
  }
}

function approvalSandboxNote(mode: string): string {
  return mode === 'unconfined' ? tr('approvalSandboxUnconfined') : tr('approvalSandboxConfined', { mode })
}

function providerDefaults(provider: string): ProviderDefaults {
  switch (provider) {
    case 'deepseek':
      return { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', contextWindowTokens: 1_048_576, maxOutputTokens: 393_216 }
    case 'openai-compatible':
      return { model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', contextWindowTokens: 1_047_576, maxOutputTokens: 32_768 }
    case 'opencode':
      return { model: 'deepseek-v4.1-flash', baseUrl: 'https://opencode.ai/inference/go/openai/v1', apiKeyEnv: 'OPENCODE_API_KEY', contextWindowTokens: 1_000_000, maxOutputTokens: 131_072 }
    case 'gemini':
      return { model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKeyEnv: 'GEMINI_API_KEY', contextWindowTokens: 1_048_576, maxOutputTokens: 65_536 }
    case 'mock':
      return { model: 'mock', baseUrl: '', apiKeyEnv: '', contextWindowTokens: 32_768, maxOutputTokens: 4_096 }
    default:
      return { model: 'qwen2.5:3b', baseUrl: 'http://127.0.0.1:11434', apiKeyEnv: '', contextWindowTokens: 32_768, maxOutputTokens: 8_192 }
  }
}

function providerModels(provider: string): string[] {
  switch (provider) {
    case 'deepseek':
      return ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro']
    case 'openai-compatible':
      return ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'o4-mini', 'gpt-6.1-terra']
    case 'opencode':
      return ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-free', 'deepseek-v4-pro', 'deepseek-v4-flash', 'beam-free', 'kimi-k3', 'glm-5.3', 'qwen3.8-flash', 'minimax-m3.1-flash-free']
    case 'gemini':
      return ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-pro']
    case 'mock':
      return ['mock']
    default:
      return ['qwen2.5:3b', 'qwen2.5-coder:7b', 'deepseek-r1:7b', 'llama3.2:3b']
  }
}

function modelProfileRow(profile: ModelProfile): string {
  return `<div class="model-profile-row" data-model-id="${escapeHtml(profile.id)}"><span>${escapeHtml(profile.name)}</span><code>${escapeHtml(profile.provider)}/${escapeHtml(profile.model)}</code><button class="link-btn danger" data-action="model-delete" data-id="${escapeHtml(profile.id)}">${tr('delete')}</button></div>`
}

function refreshModelProfileOptions(): void {
  const options = `<option value="">${tr('customProviderDefault')}</option>${state.modelProfiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}`
  for (const select of document.querySelectorAll<HTMLSelectElement>('select[data-role][data-field="modelProfile"]')) {
    const current = select.value
    select.innerHTML = options
    if ([...select.options].some((option) => option.value === current)) select.value = current
  }
}

function modelDefaults(provider: string, model: string): { contextWindowTokens: number; maxOutputTokens: number } {
  const opencode = provider === 'opencode'
  switch (model) {
    case 'deepseek-flash':
      // Native 1,048,576 context / 393,216 output; 262,144 is the 25% output
      // reserve left by the default compaction trigger.
      return { contextWindowTokens: 1_048_576, maxOutputTokens: 262_144 }
    case 'deepseek-chat':
    case 'deepseek-reasoner':
      // Legacy aliases no longer listed by the provider; keep the old cap so a
      // saved configuration cannot send an oversized max_tokens.
      return { contextWindowTokens: 1_048_576, maxOutputTokens: 8_192 }
    case 'deepseek-v4.1-flash':
      return opencode
        ? { contextWindowTokens: 1_000_000, maxOutputTokens: 131_072 }
        : { contextWindowTokens: 1_048_576, maxOutputTokens: 262_144 }
    case 'deepseek-v4.1-flash-free':
      // OpenCode's free route advertises 200K context and a 32K output cap.
      return { contextWindowTokens: 200_000, maxOutputTokens: 32_000 }
    case 'deepseek-v4-pro':
    case 'deepseek-v4-flash':
      return opencode
        ? { contextWindowTokens: 1_000_000, maxOutputTokens: 131_072 }
        : { contextWindowTokens: 1_048_576, maxOutputTokens: 262_144 }
    case 'beam-free':
    case 'kimi-k3':
      return { contextWindowTokens: 1_048_576, maxOutputTokens: 131_072 }
    case 'glm-5.3':
    case 'qwen3.8-flash':
      return { contextWindowTokens: 1_000_000, maxOutputTokens: 131_072 }
    case 'minimax-m3.1-flash-free':
      return { contextWindowTokens: 1_000_000, maxOutputTokens: 512_000 }
    case 'gemini-3.8-flash':
    case 'gemini-2.5-flash':
    case 'gemini-2.5-pro':
      return { contextWindowTokens: 1_048_576, maxOutputTokens: 65_536 }
    case 'gpt-4.1':
    case 'gpt-4.1-mini':
      return { contextWindowTokens: 1_047_576, maxOutputTokens: 32_768 }
    case 'gpt-6.1-terra':
      return { contextWindowTokens: 1_050_000, maxOutputTokens: 128_000 }
    case 'gpt-4o-mini':
      return { contextWindowTokens: 128_000, maxOutputTokens: 16_384 }
    case 'o4-mini':
      return { contextWindowTokens: 200_000, maxOutputTokens: 100_000 }
    case 'qwen2.5:3b':
    case 'qwen2.5-coder:7b':
    case 'deepseek-r1:7b':
    case 'llama3.2:3b':
      // Qwen2.5 3B: 32,768 context, 8,192 max generation.
      return { contextWindowTokens: 32_768, maxOutputTokens: 8_192 }
    case 'mock':
      return { contextWindowTokens: 32_768, maxOutputTokens: 4_096 }
    default:
      return {
        contextWindowTokens: providerDefaults(provider).contextWindowTokens,
        maxOutputTokens: providerDefaults(provider).maxOutputTokens,
      }
  }
}

interface ModelPreset {
  id: string
  label: string
  provider: string
  model: string
}

const EFFORT_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** OpenCode's DeepSeek routes expose none/low/high/max, not xhigh/minimal. */
const DEEPSEEK_OPENCODE_MODELS = new Set([
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-free',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
])

/** Beam Free exposes low..max only (no none/minimal). */
function effortValuesFor(provider: string, model: string): readonly string[] {
  if (provider === 'opencode' && DEEPSEEK_OPENCODE_MODELS.has(model)) {
    return ['none', 'low', 'high', 'max']
  }
  if (provider === 'gemini' && model === 'gemini-3.8-flash') {
    // Gemini 3.8 Flash supports low/medium/high; minimal is rejected.
    return ['low', 'medium', 'high']
  }
  return provider === 'opencode' && model === 'beam-free'
    ? EFFORT_OPTIONS.filter((value) => value !== 'none' && value !== 'minimal')
    : EFFORT_OPTIONS
}

const MODEL_PRESETS: ModelPreset[] = [
  { id: 'deepseek-flash', label: 'DeepSeek · deepseek-flash', provider: 'deepseek', model: 'deepseek-flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek · deepseek-v4-pro', provider: 'deepseek', model: 'deepseek-v4-pro' },
  { id: 'ollama-qwen', label: 'Ollama · qwen2.5:3b', provider: 'ollama', model: 'qwen2.5:3b' },
  { id: 'gemini-flash', label: 'Gemini · gemini-3.8-flash', provider: 'gemini', model: 'gemini-3.8-flash' },
  { id: 'openai-mini', label: 'OpenAI-compatible · gpt-4.1-mini', provider: 'openai-compatible', model: 'gpt-4.1-mini' },
  { id: 'opencode-beam-free', label: 'OpenCode · Beam Free', provider: 'opencode', model: 'beam-free' },
  { id: 'mock', label: 'Mock · mock', provider: 'mock', model: 'mock' },
]

const DEFAULT_MODEL_PROFILES: ModelProfile[] = MODEL_PRESETS.map((p) => ({
  id: p.id,
  name: p.label,
  provider: p.provider,
  model: p.model,
  ...(providerDefaults(p.provider).baseUrl ? { baseUrl: providerDefaults(p.provider).baseUrl } : {}),
  ...(providerDefaults(p.provider).apiKeyEnv ? { apiKeyEnv: providerDefaults(p.provider).apiKeyEnv } : {}),
  contextWindowTokens: modelDefaults(p.provider, p.model).contextWindowTokens,
  maxOutputTokens: modelDefaults(p.provider, p.model).maxOutputTokens,
}))

/**
 * Saves a chat name. An empty field clears the override, so the automatic
 * title from the first message shows again. On failure the dialog stays open
 * with the typed text and only an error toast appears; nothing is reported as
 * saved unless the server accepted it.
 */
function openRename(runId: string): void {
  const session = state.sessions.find((candidate) => candidate.runId === runId)
  state.renameRunId = runId
  state.renameDraft = session?.title ?? ''
  state.modal = 'rename'
  renderModal()
}

/**
 * WP-60: asks the model to name this chat, then opens the rename dialog with
 * the suggestion filled in. The user can edit it and save (which pins it) or
 * cancel and keep the automatic title.
 */
async function generateTitleFor(runId: string): Promise<void> {
  try {
    const data = await generateTitle(runId, 'all')
    state.renameRunId = runId
    state.renameDraft = data.title
    state.modal = 'rename'
    renderModal()
    toast(
      data.source === 'llm'
        ? tr('titleGenerated')
        : tr('titleHeuristic', { reason: data.reason ?? tr('titleNoProvider') }),
      data.source === 'llm' ? 'success' : 'info',
    )
    await refreshSessions()
  } catch (error) {
    toast(`${tr('generateTitleFailed')}: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

/**
 * WP-60: copies the open chat into a new one (same history, new run) so the
 * user can try another approach without losing the original.
 */
async function forkSession(runId: string): Promise<void> {
  try {
    const data = await post<{ runId: string; forkedFrom: string; turns: number }>(
      `/api/sessions/${encodeURIComponent(runId)}/fork`,
      {},
    )
    await refreshSessions()
    await selectSession(data.runId)
    toast(tr('forked'), 'success')
  } catch (error) {
    toast(`${tr('forkFailed')}: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

async function saveTitle(runId: string): Promise<void> {
  const input = document.getElementById('rename-input') as HTMLInputElement | null
  const raw = input?.value ?? state.renameDraft
  try {
    const data = await setSessionTitle(runId, raw)
    state.modal = undefined
    state.renameRunId = undefined
    state.renameDraft = ''
    renderModal()
    toast(data.title ? tr('renamed') : tr('renamedAuto'), 'success')
    await refreshSessions()
  } catch (error) {
    // Keep the dialog and the typed name so the user can fix it.
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/**
 * WP-53: the first-run wizard. Three steps, saved on the server, and applied to
 * the running server immediately (the chat's model and the sandbox default).
 */
function renderOnboarding(): string {
  const view = state.boot?.onboarding
  if (!view) return ''
  const step = Math.max(0, Math.min(2, state.onboardingStep))
  const titles = [tr('onboardingStepWorkspace'), tr('onboardingStepSandbox'), tr('onboardingStepModel')]
  const dots = titles
    .map((title, index) => `<span class="onboarding-dot ${index === step ? 'active' : ''} ${index < step ? 'done' : ''}" title="${escapeHtml(title)}">${index + 1}</span>`)
    .join('')
  let body = ''
  if (step === 0) {
    body = `<p class="muted">${tr('onboardingIntro')}</p>
      <div class="onboarding-workspace"><span class="deliverable-icon">${icon('folder', 20)}</span><div><strong>${escapeHtml(view.workspace.name)}</strong><code>${escapeHtml(view.workspace.root)}</code></div></div>
      <div class="settings-note">${icon('info', 14)} ${tr('onboardingWorkspaceHint')}</div>`
  } else if (step === 1) {
    const options: Array<{ mode: string; label: string; desc: string; risk?: boolean }> = [
      { mode: 'read-only', label: tr('sandboxReadOnly'), desc: tr('sandboxReadOnlyDesc') },
      { mode: 'workspace-write', label: tr('sandboxWorkspaceWrite'), desc: tr('sandboxWorkspaceWriteDesc') },
      { mode: 'unconfined', label: tr('sandboxUnconfined'), desc: tr('sandboxUnconfinedDesc'), risk: true },
    ]
    body =
      `<p class="muted">${tr('onboardingSandboxHint')}</p>` +
      options
        .map(
          (option) => `<button type="button" class="agent-row ${state.onboardingDraft.sandbox === option.mode ? 'active' : ''}" data-action="onboarding-sandbox" data-mode="${option.mode}">
            <span class="agent-kind">${escapeHtml(option.label)}${option.risk === true ? ` <span class="tag">${tr('sandboxRisk')}</span>` : ''}</span>
            <span class="agent-preview">${escapeHtml(option.desc)}</span>
            ${state.onboardingDraft.sandbox === option.mode ? `<span class="session-badge">${tr('current')}</span>` : ''}
          </button>`,
        )
        .join('')
  } else {
    body = `<p class="muted">${tr('onboardingModelHint')}</p>
      <label class="modal-field">${tr('provider')}<select id="onboarding-provider">${view.choices.providers
        .map((provider) => `<option value="${provider}" ${state.onboardingDraft.provider === provider ? 'selected' : ''}>${provider}</option>`)
        .join('')}</select></label>
      <label class="modal-field">${tr('model')}<input id="onboarding-model" value="${escapeHtml(state.onboardingDraft.model)}" autocomplete="off"></label>
      <label class="modal-field">${tr('baseUrl')}<input id="onboarding-baseurl" value="${escapeHtml(state.onboardingDraft.baseUrl)}" placeholder="${tr('customProviderDefault')}" autocomplete="off"></label>
      <div class="settings-note">${icon('lock', 14)} ${tr('onboardingApiKey', {
        env: view.model.apiKeyEnv ?? tr('onboardingNoKey'),
        state: view.model.hasApiKey ? tr('onboardingKeySet') : tr('onboardingKeyMissing'),
      })}</div>`
  }
  const last = step === 2
  const busy = state.onboardingBusy ? 'disabled' : ''
  return `<div class="modal-backdrop"><div class="modal onboarding-modal" role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${icon('bolt', 16)} ${tr('onboardingTitle')}</h2><div class="onboarding-dots">${dots}</div></div>
    <div class="modal-body">
      <div class="onboarding-step-title">${escapeHtml(titles[step] ?? '')}</div>
      ${body}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn ghost" data-action="onboarding-skip" ${busy}>${tr('onboardingSkip')}</button>
      <span style="flex:1 1 auto"></span>
      ${step > 0 ? `<button type="button" class="btn ghost" data-action="onboarding-back" ${busy}>${tr('onboardingBack')}</button>` : ''}
      <button type="button" class="btn primary" data-action="${last ? 'onboarding-finish' : 'onboarding-next'}" ${busy}>${last ? tr('onboardingFinish') : tr('onboardingNext')}</button>
    </div>
  </div></div>`
}

function openOnboarding(): void {
  const view = state.boot?.onboarding
  if (!view) return
  state.modal = 'onboarding'
  state.onboardingStep = 0
  state.onboardingDraft = {
    sandbox: view.saved.sandbox ?? view.sandbox,
    provider: view.saved.provider ?? view.model.provider,
    model: view.saved.model ?? view.model.model,
    baseUrl: view.saved.baseUrl ?? view.model.baseUrl ?? '',
  }
  renderModal()
}

async function finishOnboarding(skip: boolean): Promise<void> {
  if (state.onboardingBusy) return
  state.onboardingBusy = true
  renderModal()
  try {
    const draft = state.onboardingDraft
    const provider = (document.getElementById('onboarding-provider') as HTMLSelectElement | null)?.value ?? draft.provider
    const model = (document.getElementById('onboarding-model') as HTMLInputElement | null)?.value.trim() || draft.model
    const baseUrl = (document.getElementById('onboarding-baseurl') as HTMLInputElement | null)?.value.trim() ?? draft.baseUrl
    const data = await post<{ onboarding: OnboardingView; applied: string[] }>(
      '/api/onboarding/complete',
      skip ? { skip: true } : { complete: true, sandbox: draft.sandbox, provider, model, baseUrl },
    )
    if (state.boot) state.boot.onboarding = data.onboarding
    state.modal = undefined
    renderModal()
    await refreshBoot()
    toast(skip ? tr('onboardingSkipped') : tr('onboardingDone'), 'success')
  } catch (error) {
    toast(`${tr('onboardingFailed')}: ${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    state.onboardingBusy = false
    if (state.modal === 'onboarding') renderModal()
  }
}

function renderModal(): void {
  const el = document.getElementById('modal-root')
  if (!el) return
  if (!state.modal) {
    el.innerHTML = ''
    return
  }
  if (state.modal === 'onboarding') {
    el.innerHTML = renderOnboarding()
    return
  }
  if (state.modal === 'sandbox') {
    const active = currentState()?.sandboxMode ?? state.boot?.config.sandbox ?? 'unconfined'
    const options = [
      { mode: 'read-only', label: tr('sandboxReadOnly'), desc: tr('sandboxReadOnlyDesc') },
      { mode: 'workspace-write', label: tr('sandboxWorkspaceWrite'), desc: tr('sandboxWorkspaceWriteDesc') },
      { mode: 'unconfined', label: tr('sandboxUnconfined'), desc: tr('sandboxUnconfinedDesc'), risk: true },
    ]
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal goal-modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${icon('shield', 16)} ${tr('sandboxTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body">
        <p class="muted">${tr('sandboxDesc')}</p>
        ${options
          .map(
            (option) => `<button type="button" class="agent-row ${option.mode === active ? 'active' : ''}" data-action="set-sandbox" data-mode="${option.mode}">
              <span class="agent-kind">${escapeHtml(option.label)}</span>
              <span class="agent-preview">${escapeHtml(option.desc)}</span>
              ${option.mode === active ? `<span class="session-badge">${tr('current')}</span>` : ''}
              ${option.risk === true ? `<span class="tag">${tr('sandboxRisk')}</span>` : ''}
            </button>`,
          )
          .join('')}
      </div>
      <div class="modal-foot"><button class="btn ghost" data-action="close-modal">${tr('close')}</button></div>
    </div></div>`
    return
  }
  if (state.modal === 'automation') {
    el.innerHTML = renderAutomationModal()
    return
  }
  if (state.modal === 'roots') {
    const rows = state.roots
      .map(
        (root) => `<div class="root-row" data-root-id="${escapeHtml(root.id)}">
          <div class="root-main"><strong>${escapeHtml(root.label)}</strong><code>${escapeHtml(root.path)}</code><span class="root-kind">${root.writable ? tr('rootWritable') : tr('rootReadOnly')}</span></div>
          ${root.id === 'main' ? '' : `<button class="link-btn danger" data-action="remove-root" data-root-id="${escapeHtml(root.id)}">${tr('removeRoot')}</button>`}
        </div>`,
      )
      .join('')
    el.innerHTML = `<div class="modal-backdrop"><div class="modal roots-modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${icon('folder', 16)} ${tr('workspaceRoots')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body">
        <div class="settings-note">${icon('info', 14)} ${tr('rootHint')}</div>
        <div class="root-list">${rows}</div>
        <form class="root-form">
          <label>${tr('workspaceTitle')}<input id="root-path" placeholder="G:\\path\\to\\folder" autocomplete="off"></label>
          <div class="root-form-actions">
            <label class="checkbox-field"><input type="checkbox" id="root-writable"> ${tr('rootWritable')}</label>
            ${isDesktop() ? `<button type="button" class="btn ghost" data-action="root-browse">${tr('browse')}</button>` : ''}
            <button type="submit" class="btn primary">${icon('plus', 14)} ${tr('addRoot')}</button>
          </div>
        </form>
      </div>
    </div></div>`
    return
  }

  if (state.modal === 'help') {
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${icon('question', 16)} ${tr('helpTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body help-list">
        ${helpRows().map((row) => `<div class="help-row"><code>${escapeHtml(row.usage)}</code><span>${escapeHtml(row.desc)}</span></div>`).join('')}
      </div>
    </div></div>`
    return
  }
  if (state.modal === 'palette') {
    // CP-32: commands, chats, workspace files and settings sections in one list.
    const query = state.paletteQuery.toLowerCase().trim()
    const commands = filterCommands(query)
      .map((c) => `<button class="palette-row" data-action="palette-run" data-command="${c.id}">${icon(c.icon, 16)}<span>${escapeHtml(c.label ?? c.id)}</span>${c.slash ? `<code>/${escapeHtml(c.slash)}</code>` : ''}</button>`)
      .join('')
    const sessions = state.sessions
      .filter((s) => !query || `${s.first} ${s.title ?? ''} ${s.workerTitle ?? ''} ${s.runId}`.toLowerCase().includes(query))
      .slice(0, 5)
      .map((s) => `<button class="palette-row" data-action="palette-session" data-run-id="${s.runId}">${icon('clock', 16)}<span>${escapeHtml(oneLine(s.title || s.first || tr('newSession'), 70))}</span><code>${escapeHtml(s.runId)}</code></button>`)
      .join('')
    const files = query
      ? state.paletteFiles
          .slice(0, 6)
          .map((file) => `<button class="palette-row" data-action="palette-file" data-path="${escapeHtml(file)}">${icon('file', 16)}<span>${escapeHtml(file)}</span></button>`)
          .join('')
      : ''
    const settings = query
      ? SETTINGS_SECTIONS.filter((section) => `${tr(section.key)} settings ${section.id}`.toLowerCase().includes(query))
          .map((section) => `<button class="palette-row" data-action="palette-settings" data-section="${section.id}">${icon('settings', 16)}<span>${tr('settings')} › ${escapeHtml(tr(section.key))}</span></button>`)
          .join('')
      : ''
    const empty = !commands && !sessions && !files && !settings
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal palette-modal" role="dialog" aria-modal="true">
      <div class="palette-input-row">${icon('search', 16)}<input id="palette-input" value="${escapeHtml(state.paletteQuery)}" placeholder="${tr('palettePlaceholder')}" autocomplete="off" autofocus><kbd>Esc</kbd></div>
      <div class="palette-list">
        ${commands ? `<div class="palette-section">${tr('commandsSection')}</div>${commands}` : ''}
        ${sessions ? `<div class="palette-section">${tr('sessionsSection')}</div>${sessions}` : ''}
        ${files ? `<div class="palette-section">${tr('filesSection')}</div>${files}` : ''}
        ${settings ? `<div class="palette-section">${tr('settings')}</div>${settings}` : ''}
        ${empty ? `<div class="panel-empty">${tr('noMatches')}</div>` : ''}
      </div>
    </div></div>`
    const input = document.getElementById('palette-input') as HTMLInputElement | null
    if (input) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
      input.addEventListener('input', () => {
        state.paletteQuery = input.value
        renderModal()
        schedulePaletteFiles(input.value)
      })
    }
    return
  }
  if (state.modal === 'rewind') {
    const turns = state.entries.flatMap((e) => (e.kind === 'user' && e.turn !== undefined ? [{ id: e.id, text: e.text, ts: e.ts, turn: e.turn }] : []))
    const picked = state.rewindTurn
    const body =
      picked !== undefined
        ? `<p>${escapeHtml(tr('rewindConfirmText').replace('{turn}', String(picked)))}</p><blockquote class="rewind-quote">${escapeHtml(oneLine(turns.find((t) => t.turn === picked)?.text ?? '', 200))}</blockquote>`
        : turns.length
          ? `<p class="muted">${tr('rewindHint')}</p>${turns
              .slice()
              .reverse()
              .map((t) => `<button type="button" class="outline-row" data-action="rewind-to" data-turn="${t.turn}"><span class="outline-index">${t.turn}</span><span class="outline-text">${escapeHtml(oneLine(t.text, 90))}</span><span class="outline-time">${escapeHtml(formatRelative(Date.now(), t.ts, state.locale))}</span></button>`)
              .join('')}`
          : `<div class="panel-empty">${tr('rewindNoTurns')}</div>`
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true" data-modal="rewind">
      <div class="modal-head"><h2>${icon('refresh', 16)} ${tr('rewindTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body">${body}</div>
      ${picked !== undefined ? `<div class="modal-foot"><button class="btn ghost" data-action="rewind-back">${tr('cancel')}</button><button class="btn primary" data-action="rewind-confirm" id="rewind-confirm">${icon('refresh', 14)} ${tr('rewindConfirm')}</button></div>` : ''}
    </div></div>`
    if (picked !== undefined) (document.getElementById('rewind-confirm') as HTMLButtonElement | null)?.focus()
    return
  }
  if (state.modal === 'import') {
    const view = state.importView
    const pending = view?.items.filter((i) => i.action !== 'skip') ?? []
    const kinds = [...new Set(pending.map((i) => i.kind))]
    const rows = view?.items.length
      ? view.items
          .map(
            (item) => `<details class="import-row import-${escapeHtml(item.action)}"><summary><span class="tag">${escapeHtml(item.action)}</span><span class="tag subtle">${escapeHtml(item.kind)}</span><span>${escapeHtml(item.summary)}</span></summary><code class="muted small">${escapeHtml(item.target)}</code>${item.diff ? `<pre class="import-diff">${escapeHtml(item.diff)}</pre>` : ''}</details>`,
          )
          .join('')
      : `<div class="panel-empty">${tr('importNothing')}</div>`
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal roots-modal" role="dialog" aria-modal="true" data-modal="import">
      <div class="modal-head"><h2>${icon('external', 16)} ${tr('importTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body">
        <div class="panel-mode-tabs"><button class="right-tab ${view?.source === 'claude' ? 'active' : ''}" data-action="import-source" data-source="claude">Claude Code</button><button class="right-tab ${view?.source === 'dsh' ? 'active' : ''}" data-action="import-source" data-source="dsh">DSH</button></div>
        <div class="settings-note">${icon('info', 14)} ${tr('importHint')}</div>
        ${kinds.length ? `<div class="import-kinds">${kinds.map((k) => `<label class="toggle"><input type="checkbox" data-import-kind="${escapeHtml(k)}" ${state.importKinds.has(k) ? 'checked' : ''}> ${escapeHtml(k)}</label>`).join('')}</div>` : ''}
        <div class="import-list">${rows}</div>
      </div>
      <div class="modal-foot"><button class="btn ghost" data-action="close-modal">${tr('cancel')}</button><button class="btn primary" data-action="import-apply" ${pending.some((i) => state.importKinds.has(i.kind)) ? '' : 'disabled'}>${icon('check', 14)} ${tr('importApply')} (${pending.filter((i) => state.importKinds.has(i.kind)).length})</button></div>
    </div></div>`
    for (const box of el.querySelectorAll<HTMLInputElement>('input[data-import-kind]')) {
      box.addEventListener('change', () => {
        const kind = box.dataset.importKind!
        if (box.checked) state.importKinds.add(kind)
        else state.importKinds.delete(kind)
        renderModal()
      })
    }
    return
  }
  if (state.modal === 'worktree') {
    const view = state.worktrees
    const nameOf = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p
    const rows = !view?.repo
      ? `<div class="panel-empty">${tr('worktreeNoRepo')}</div>`
      : view.worktrees.length
        ? view.worktrees
            .map((w) => {
              const name = nameOf(w.path)
              const open = isDesktop() ? `<button class="link-btn" data-action="switch-workspace" data-path="${escapeHtml(w.path)}">${tr('worktreeOpen')}</button>` : `<button class="link-btn" data-action="copy-text" data-text="${escapeHtml(w.path)}">${tr('copyPath')}</button>`
              return `<div class="worktree-row" data-worktree="${escapeHtml(name)}"><div class="root-main"><strong>${escapeHtml(w.branch ?? name)}</strong><code>${escapeHtml(w.path)}</code></div><div class="worktree-actions">${open}<button class="link-btn" data-action="worktree-apply" data-name="${escapeHtml(name)}">${tr('worktreeApply')}</button><button class="link-btn danger" data-action="worktree-remove" data-name="${escapeHtml(name)}">${tr('worktreeRemove')}</button></div></div>`
            })
            .join('')
        : `<div class="panel-empty">${tr('worktreeNone')}</div>`
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal roots-modal" role="dialog" aria-modal="true" data-modal="worktree">
      <div class="modal-head"><h2>${icon('git', 16)} ${tr('worktreeTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body">
        <div class="settings-note">${icon('info', 14)} ${tr('worktreeHint')}</div>
        <div class="root-list">${rows}</div>
        ${view?.repo ? `<form class="root-form" data-action="worktree-create"><label>${tr('worktreeName')}<input id="worktree-name" placeholder="feature-x" autocomplete="off"></label><div class="root-form-actions"><button type="submit" class="btn primary">${icon('plus', 14)} ${tr('worktreeCreate')}</button></div></form>` : ''}
      </div>
    </div></div>`
    const form = el.querySelector<HTMLFormElement>('form[data-action="worktree-create"]')
    form?.addEventListener('submit', (event) => {
      event.preventDefault()
      const name = (document.getElementById('worktree-name') as HTMLInputElement | null)?.value.trim()
      if (name) void openWorktrees(name)
    })
    return
  }
  if (state.modal === 'hooks') {
    const hooks = state.hooksView?.hooks ?? []
    const rows = hooks.length
      ? hooks
          .map(
            (hook) => `<div class="catalog-row"><span class="tag">${escapeHtml(hook.event)}</span><code>${escapeHtml(hook.command.join(' '))}</code><span class="muted small">${hook.tools?.length ? escapeHtml(hook.tools.join(', ')) : ''}${hook.timeoutMs ? ` · ${hook.timeoutMs} ms` : ''}</span></div>`,
          )
          .join('')
      : `<div class="panel-empty">${tr('noHooks')}</div>`
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true" data-modal="hooks">
      <div class="modal-head"><h2>${icon('bolt', 16)} ${tr('hooksTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body"><p class="muted">${tr('hooksDesc')}</p>${rows}</div>
    </div></div>`
    return
  }
  if (state.modal === 'doctor') {
    const report = state.doctorView
    const badge = (status: string) => `<span class="tag doctor-${status}">${escapeHtml(status)}</span>`
    const body = report
      ? `<p class="muted">HY-HARNESS ${escapeHtml(report.version)} · ${report.ok ? tr('doctorOk') : tr('doctorProblems')}</p>${report.checks
          .map((check) => `<div class="catalog-row">${badge(check.status)}<code>${escapeHtml(check.name)}</code><span>${escapeHtml(check.detail)}</span></div>`)
          .join('')}`
      : `<div class="panel-empty">${tr('doctorRunning')}</div>`
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true" data-modal="doctor">
      <div class="modal-head"><h2>${icon('shield', 16)} ${tr('doctorTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body">${body}</div>
    </div></div>`
    return
  }
  if (state.modal === 'workspace') {
    const rows = state.workspaces.length
      ? state.workspaces
          .map(
            (workspace) =>
              `<button class="workspace-row ${workspace === state.boot?.workspace.root ? 'active' : ''}" data-action="switch-workspace" data-path="${escapeHtml(workspace)}">${icon('folder', 16)}<span>${escapeHtml(workspace)}</span>${workspace === state.boot?.workspace.root ? `<span class="tag">${tr('current')}</span>` : ''}</button>`,
          )
          .join('')
      : '<div class="panel-empty">No recent workspaces.</div>'
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal goal-modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${icon('workspace', 16)} ${tr('workspaceTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body"><div class="workspace-list">${rows}</div></div>
      <div class="modal-foot"><button class="btn ghost" data-action="close-modal">${tr('cancel')}</button><button class="btn primary" data-action="browse-workspace">${icon('folder', 16)} ${tr('browse')}</button></div>
    </div></div>`
    return
  }
  if (state.modal === 'feedback') {
    el.innerHTML = renderFeedbackModal()
    return
  }
  if (state.modal === 'shortcuts') {
    el.innerHTML = renderShortcutsModal()
    return
  }
  if (state.modal === 'outline') {
    // WP-60: a jump list for long chats. Every entry is already loaded; the
    // outline is how a user reaches turn 3 of 80 without scrolling.
    const turns = state.entries.filter((entry): entry is Extract<ChatEntry, { kind: 'user' }> => entry.kind === 'user')
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal outline-modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${icon('plan', 16)} ${tr('turnOutline')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body outline-list">
        ${turns.length ? turns.map((entry, index) => `<button class="outline-row" data-action="jump-entry" data-entry-id="${escapeHtml(entry.id)}"><span class="outline-index">${index + 1}</span><span class="outline-text">${escapeHtml(oneLine(entry.text, 120))}</span><span class="outline-time">${formatTime(entry.ts)}</span></button>`).join('') : `<div class="panel-empty">${tr('noTurns')}</div>`}
      </div>
    </div></div>`
    return
  }
  if (state.modal === 'rename') {
    const runId = state.renameRunId ?? ''
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal goal-modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${icon('edit', 16)} ${tr('renameChat')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body">
        <p class="muted">${tr('renameDesc')}</p>
        <label class="modal-field">${tr('renamePlaceholder')}<input id="rename-input" value="${escapeHtml(state.renameDraft)}" maxlength="120" autocomplete="off" autofocus></label>
      </div>
      <div class="modal-foot"><button class="btn ghost" data-action="generate-title" data-run-id="${escapeHtml(runId)}">${icon('bolt', 16)} ${tr('generateTitle')}</button><span style="flex:1 1 auto"></span><button class="btn ghost" data-action="close-modal">${tr('cancel')}</button><button class="btn primary" data-action="save-title" data-run-id="${escapeHtml(runId)}">${icon('check', 16)} ${tr('save')}</button></div>
    </div></div>`
    const input = document.getElementById('rename-input') as HTMLInputElement | null
    if (input) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
    return
  }
  if (state.modal === 'model') {
    // CP-35: the catalog with capabilities; the session's provider is pickable.
    const worker = state.current?.state.model ?? state.boot?.config.worker
    const role = state.boot?.config.worker
    const current = { provider: worker?.provider ?? role?.provider ?? '', model: worker?.model ?? role?.model ?? '' }
    const rows = renderModelRows(pickerModels(state.modelCatalog, current.provider, state.modelQuery), current, {
      tools: tr('capTools'),
      vision: tr('capVision'),
      reasoning: tr('capReasoning'),
      cache: tr('capCache'),
      current: tr('current'),
      otherProvider: tr('otherProvider'),
      context: tr('capContext'),
    })
    const mode = role?.toolMode ? `<span class="tag">${tr(role.toolMode === 'native' ? 'toolModeNative' : 'toolModeText')}</span>` : ''
    const vision = role?.vision !== undefined ? `<span class="tag">${tr(role.vision ? 'capVision' : 'noVision')}</span>` : ''
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal goal-modal model-modal" role="dialog" aria-modal="true" data-modal="model">
      <div class="modal-head"><h2>${icon('cpu', 16)} ${tr('modelTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body">
        <p class="muted">${tr('modelDesc')}</p>
        <div class="model-current"><code>${escapeHtml(current.provider)}/${escapeHtml(current.model)}</code>${mode}${vision}</div>
        <input id="model-search" class="model-search" value="${escapeHtml(state.modelQuery)}" placeholder="${tr('modelSearch')}" autocomplete="off">
        <div class="model-list">${rows || `<div class="panel-empty">${tr('noMatches')}</div>`}</div>
        <label class="modal-field">${tr('modelName')}<input id="model-input" value="${escapeHtml(current.model)}" placeholder="qwen2.5:3b"></label>
      </div>
      <div class="modal-foot"><button class="btn ghost" data-action="close-modal">${tr('cancel')}</button><button class="btn primary" data-action="save-model">${icon('check', 16)} ${tr('switchModel')}</button></div>
    </div></div>`
    const search = document.getElementById('model-search') as HTMLInputElement | null
    search?.addEventListener('input', () => {
      state.modelQuery = search.value
      const list = document.querySelector('.model-list')
      if (list) {
        list.innerHTML =
          renderModelRows(pickerModels(state.modelCatalog, current.provider, state.modelQuery), current, {
            tools: tr('capTools'),
            vision: tr('capVision'),
            reasoning: tr('capReasoning'),
            cache: tr('capCache'),
            current: tr('current'),
            otherProvider: tr('otherProvider'),
            context: tr('capContext'),
          }) || `<div class="panel-empty">${tr('noMatches')}</div>`
      }
    })
    return
  }
  if (state.modal === 'goal') {
    const gs = state.goalState
    const status = gs
      ? `<div class="settings-row"><span>${tr('goal')}</span><strong>${escapeHtml(gs.phase)} · ${gs.roundsStarted}/${gs.maxGoalRounds}</strong></div>${
          gs.blockerReason ? `<div class="settings-note">${escapeHtml(gs.blockerReason)}</div>` : ''
        }`
      : ''
    const controls = gs
      ? gs.phase === 'complete'
        ? ''
        : gs.phase === 'active' && gs.activation === 'armed'
          ? `<button class="btn ghost" data-action="pause-goal">${tr('pause')}</button>`
          : `<button class="btn ghost" data-action="resume-goal">${tr('resume')}</button>`
      : ''
    const clear = gs ? `<button class="btn ghost danger" data-action="clear-goal">${tr('clear')}</button>` : ''
    el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal goal-modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${icon('target', 16)} ${tr('goalTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
      <div class="modal-body">
        ${status}
        <p class="muted">${tr('goalDesc')}</p>
        <textarea id="goal-input" class="goal-input" rows="4" placeholder="e.g. Make the test suite pass without changing the fixtures.">${escapeHtml(state.goal)}</textarea>
      </div>
      <div class="modal-foot">${clear}${controls}<button class="btn ghost" data-action="close-modal">${tr('cancel')}</button><button class="btn primary" data-action="save-goal">${icon('check', 16)} ${tr('saveGoal')}</button></div>
    </div></div>`
    return
  }
  if (state.modal === 'ralph') {
    if (!state.ralph) {
      el.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal ralph-modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h2>${icon('plan', 16)} ${tr('ralphTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
        <div class="modal-body">
          <p class="muted">${tr('ralphDesc')}</p>
          <label class="modal-field">${tr('objective')}<textarea id="ralph-objective" rows="3" placeholder="e.g. Make the test suite pass without changing the fixtures."></textarea></label>
          <label class="modal-field">${tr('verificationCommands')}<textarea id="ralph-verify" rows="3" placeholder="npm test&#10;npm run typecheck"></textarea></label>
          <div class="field-row">
            <label class="modal-field">${tr('maxRounds')}<input id="ralph-rounds" type="number" min="1" max="20" value="3"></label>
            <label class="modal-field checkbox-field"><input id="ralph-auto" type="checkbox"> ${tr('autoApprove')}</label>
          </div>
          <div class="settings-note">${icon('alert', 14)} ${tr('autoApproveWarning')}</div>
        </div>
        <div class="modal-foot"><button class="btn ghost" data-action="close-modal">${tr('cancel')}</button><button class="btn primary" data-action="start-ralph">${icon('send', 16)} ${tr('startLoop')}</button></div>
      </div></div>`
      return
    }
    const job = state.ralph
    const running = job.status === 'running'
    el.innerHTML = `<div class="modal-backdrop"><div class="modal ralph-modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${icon('plan', 16)} ${tr('ralphTitle')}</h2><span class="status-pill ${running ? 'status-running' : job.status === 'succeeded' ? 'status-ready' : 'status-error'}">${running ? '<span class="tool-spinner small"></span>' : ''}${escapeHtml(job.status)}</span><button class="icon-btn" data-action="close-ralph">${icon('close', 16)}</button></div>
      <div class="modal-body">
        <div class="ralph-objective">${escapeHtml(job.objective)}</div>
        <pre class="ralph-output" id="ralph-output">${escapeHtml(job.output || tr('loading'))}</pre>
      </div>
      <div class="modal-foot">
        ${running ? `<button class="btn ghost" data-action="cancel-ralph">${icon('stop', 14)} ${tr('stopLoop')}</button>` : ''}
        ${job.runId ? `<button class="btn ghost" data-action="open-ralph-run" data-run-id="${escapeHtml(job.runId)}">${icon('external', 14)} ${tr('openRun')}</button>` : ''}
        <button class="btn primary" data-action="close-ralph">${tr('close')}</button>
      </div>
    </div></div>`
    window.setTimeout(() => {
      const output = document.getElementById('ralph-output')
      if (output) output.scrollTop = output.scrollHeight
    }, 20)
    return
  }
  const settings = state.settings
  const roles = settings?.user.roles ?? {}
  const approvalMode = settings?.user.autoApprove ? 'all' : settings?.user.fullAuto ? 'confined' : 'manual'
  const fields = (role: string, label: string, required = false): string => {
    const active = role === 'worker' ? settings?.active.worker : role === 'orchestrator' ? settings?.active.orchestrator : role === 'subagent' ? settings?.active.subagent : role === 'guardian' ? settings?.active.guardian : role === 'grader' ? settings?.active.grader : role === 'summarizer' ? settings?.active.summarizer : settings?.active.compactor
    const value = (roles[role] ?? {}) as Record<string, unknown>
    const provider = String(value.provider ?? active?.provider ?? 'ollama')
    const defaults = providerDefaults(provider)
    // An explicit provider must not inherit Ollama's endpoint or limits.
    const explicit = value.provider !== undefined
    const baseUrl = value.baseUrl ?? (explicit ? defaults.baseUrl : active?.baseUrl ?? defaults.baseUrl)
    const apiKeyEnv = value.apiKeyEnv ?? (explicit ? defaults.apiKeyEnv : active?.apiKeyEnv ?? defaults.apiKeyEnv)
    const model = String(value.model ?? active?.model ?? defaults.model)
    const limits = modelDefaults(provider, model)
    const selectedProfile = state.modelProfiles.find((p) => p.id === value.modelProfile) ?? state.modelProfiles.find((p) => p.provider === provider && p.model === model)
    const profileOptions = state.modelProfiles.map((p) => `<option value="${p.id}" ${selectedProfile?.id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
    const effort = String(value.effort ?? active?.effort ?? '')
    const effortOptions = effortValuesFor(provider, model)
    return `<fieldset class="role-fieldset" ${required ? 'open' : ''}><legend>${label}</legend>
      <label>${tr('modelProfile')}<select data-role="${role}" data-field="modelProfile" data-preset><option value="">${tr('customProviderDefault')}</option>${profileOptions}</select></label>
      <label>${tr('effort')}<select data-role="${role}" data-field="effort">
        <option value="">${tr('effortDefault')}</option>
        ${effortOptions.map((e) => `<option value="${e}" ${effort === e ? 'selected' : ''}>${tr('effort_' + e)}</option>`).join('')}
      </select></label>
      <div class="settings-note">${tr('effortNote')}</div>
      <details class="model-advanced"><summary>${tr('advanced')}</summary>
        <label>${tr('provider')}<select data-role="${role}" data-field="provider">
          ${['ollama', 'deepseek', 'openai-compatible', 'opencode', 'gemini', 'mock'].map((p) => `<option value="${p}" ${provider === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select></label>
        <label>${tr('model')}<input list="model-options-${role}" data-role="${role}" data-field="model" value="${escapeHtml(model)}"><datalist id="model-options-${role}">${providerModels(provider).map((m) => `<option value="${escapeHtml(m)}"></option>`).join('')}</datalist></label>
        <label>${tr('baseUrl')}<input data-role="${role}" data-field="baseUrl" value="${escapeHtml(String(baseUrl))}" placeholder="${tr('customProviderDefault')}"></label>
        <label>${tr('apiKeyEnv')}<input data-role="${role}" data-field="apiKeyEnv" value="${escapeHtml(String(apiKeyEnv))}" placeholder="e.g. OPENAI_API_KEY"></label>
        <label>${tr('directApiKey')}<input type="password" autocomplete="new-password" data-role="${role}" data-field="apiKey" value="" placeholder="${value.apiKeySet ? tr('apiKeySetPlaceholder') : tr('optional')}"></label>
        <div class="field-row"><label>${tr('contextWindow')}<input type="number" readonly title="${tr('limitsAutoTitle')}" data-role="${role}" data-field="contextWindowTokens" value="${String(limits.contextWindowTokens)}"></label><label>${tr('maxOutput')}<input type="number" readonly title="${tr('limitsAutoTitle')}" data-role="${role}" data-field="maxOutputTokens" value="${String(limits.maxOutputTokens)}"></label></div>
        <div class="settings-note">${tr('limitsAutoNote')}</div>
      </details>
    </fieldset>`
  }
  el.innerHTML = `<div class="modal-backdrop"><div class="modal settings-modal" role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${icon('settings', 16)} ${tr('settingsTitle')}</h2><button class="icon-btn" data-action="close-modal">${icon('close', 16)}</button></div>
    <div class="modal-body">
      <div class="settings-note">${icon('info', 14)} ${tr('settingsHotApply')}</div>
      <section class="settings-section" data-settings-section="workspace">
        <h3>${tr('workspaceTitle')}</h3>
        <div class="settings-row"><span>${tr('settingsRoot')}</span><code>${escapeHtml(settings?.active.workspace ?? state.boot?.workspace.root ?? '')}</code></div>
        <div class="settings-row"><span>${tr('settingsConfig')}</span><code>${escapeHtml(settings?.path ?? '')}</code></div>
        <div class="settings-row"><span>${tr('language')}</span><select id="settings-locale">${localeChoices().map((l) => `<option value="${l.id}" ${state.locale === l.id ? 'selected' : ''}>${l.label}</option>`).join('')}</select></div>
        <div class="settings-row"><span>${tr('sandbox')}</span><select id="settings-sandbox">${['unconfined', 'workspace-write', 'read-only'].map((m) => `<option value="${m}" ${settings?.active.sandbox === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div class="settings-row"><span>${tr('enforcement')}</span><strong>${escapeHtml(String((state.boot?.sandbox?.enforcement ?? 'unknown')))}</strong></div>
      </section>
      <section class="settings-section" data-settings-section="appearance">
        <h3>${tr('appearance')}</h3>
        <div class="settings-row"><span>${tr('theme')}</span><select id="settings-theme">${['light', 'dark', 'system'].map((value) => `<option value="${value}" ${state.theme === value ? 'selected' : ''}>${tr(`theme_${value}`)}</option>`).join('')}</select></div>
        <div class="settings-row"><span>${tr('maskSecretsLabel')}</span><label class="toggle"><input id="settings-mask" type="checkbox" ${state.maskSecrets ? 'checked' : ''}> ${tr('enabled')}</label></div>
        <div class="settings-row"><span>${tr('fontText')}</span><input id="settings-font-text" value="${escapeHtml(loadFonts().text)}" placeholder="Segoe UI Variable"></div>
        <div class="settings-row"><span>${tr('fontCode')}</span><input id="settings-font-code" value="${escapeHtml(loadFonts().code)}" placeholder="Cascadia Code"></div>
        <div class="settings-row"><span>${tr('shortcuts')}</span><button type="button" class="btn ghost" data-action="open-shortcuts">${icon('bolt', 14)} ${tr('editShortcuts')}</button></div>
        <div class="settings-row"><span>${tr('statusline')}</span><div class="statusline-picks">${STATUS_ITEMS.map((item) => `<label class="toggle"><input type="checkbox" data-pref-status="${item}" ${state.prefs.statusline.includes(item) ? 'checked' : ''}> ${tr(`status_${item}`)}</label>`).join('')}</div></div>
        <div class="settings-row"><span>${tr('codeTheme')}</span><select data-pref="codeTheme">${(['auto', 'github', 'monokai', 'plain'] as const).map((theme) => `<option value="${theme}" ${state.prefs.codeTheme === theme ? 'selected' : ''}>${tr(`codeTheme_${theme}`)}</option>`).join('')}</select></div>
        <div class="settings-row"><span>${tr('vimMode')}</span><label class="toggle"><input type="checkbox" data-pref="vimMode" ${state.prefs.vimMode ? 'checked' : ''}> ${tr('enabled')}</label></div>
        <div class="settings-note">${icon('info', 14)} ${tr('appearanceNote')} ${tr('prefsSavedNote')}</div>
      </section>
      <section class="settings-section" data-settings-section="approval">
        <h3>${tr('approvalMode')}</h3>
        <div class="settings-row"><span>${tr('approvalMode')}</span><select id="settings-approval">
          <option value="manual" ${approvalMode === 'manual' ? 'selected' : ''}>${tr('approvalManual')}</option>
          <option value="confined" ${approvalMode === 'confined' ? 'selected' : ''}>${tr('approvalConfined')}</option>
          <option value="all" ${approvalMode === 'all' ? 'selected' : ''}>${tr('approvalAll')}</option>
        </select></div>
        <div class="settings-note">${icon('info', 14)} <span>${tr('approvalNote')} <span id="approval-sandbox-note">${escapeHtml(approvalSandboxNote(settings?.active.sandbox ?? 'unconfined'))}</span></span></div>
      </section>
      <section class="settings-section" data-settings-section="models"><h3>${tr('models')}</h3><div class="settings-note">${icon('info', 14)} ${tr('apiKeyEnvHint')}</div>
        <div class="model-registry">
          <div class="settings-row"><strong>${tr('modelRegistry')}</strong><span class="muted small">${tr('modelRegistryHint')}</span></div>
          <div class="model-profile-list">${state.modelProfiles.length ? state.modelProfiles.map((p) => `<div class="model-profile-row"><span>${escapeHtml(p.name)}</span><code>${escapeHtml(p.provider)}/${escapeHtml(p.model)}</code><button class="link-btn danger" data-action="model-delete" data-id="${escapeHtml(p.id)}">${tr('delete')}</button></div>`).join('') : `<div class="panel-empty">${tr('noModels')}</div>`}</div>
          <div class="model-profile-form">
            <input id="model-new-name" placeholder="${tr('name')}" autocomplete="off">
            <select id="model-new-provider">${['ollama', 'deepseek', 'openai-compatible', 'opencode', 'gemini', 'mock'].map((p) => `<option value="${p}">${p}</option>`).join('')}</select>
            <input id="model-new-model" placeholder="${tr('model')}" autocomplete="off">
            <input id="model-new-base" placeholder="${tr('baseUrl')}" autocomplete="off">
            <input id="model-new-key" placeholder="${tr('apiKeyEnv')}" autocomplete="off">
            <button type="button" class="btn ghost" data-action="model-register">${icon('plus', 14)} ${tr('addModel')}</button>
          </div>
        </div>
        <h4 class="settings-subhead">${tr('roleAssignment')}</h4>
        ${fields('worker', tr('workerRequired'), true)}${fields('orchestrator', tr('orchestratorRole'))}${fields('subagent', tr('subagentRole'))}${fields('guardian', tr('guardianRole'))}${fields('grader', tr('graderRole'))}${fields('compactor', tr('compactorRole'))}${fields('summarizer', tr('summarizerRole'))}
      </section>
      <section class="settings-section" data-settings-section="capabilities">
        <h3>${tr('capabilities')}</h3>
        <div class="settings-row"><span>${tr('workspaceMemory')}</span><label class="toggle"><input id="settings-memory" type="checkbox" ${(settings?.user.memory?.enabled ?? settings?.active.features.memory) ? 'checked' : ''}> ${tr('memoryEnabled')}</label></div>
        <div class="settings-row"><span>${tr('webTools')}</span><label class="toggle"><input id="settings-web" type="checkbox" ${(settings?.user.web?.enabled ?? settings?.active.features.web) ? 'checked' : ''}> ${tr('webEnabled')}</label></div>
        <label class="modal-field">${tr('pluginModules')}<textarea id="settings-plugins" rows="3" placeholder="C:\Users\me\hy-plugins\jira.mjs">${escapeHtml((settings?.user.plugins ?? []).join('\n'))}</textarea></label>
        <div class="plugin-status">
          ${state.pluginCatalog ? `<div class="muted small">${tr('pluginStatusLoaded', { tools: state.pluginCatalog.tools.length, modules: state.pluginCatalog.configured.length })}</div>${state.pluginCatalog.errors.map((e) => `<div class="plugin-error">${escapeHtml(e)}</div>`).join('')}` : `<div class="muted small">${tr('pluginStatusUnavailable')}</div>`}
        </div>
        <div class="plugin-actions"><button type="button" class="btn ghost" data-action="reload-plugins">${icon('refresh', 14)} ${tr('reloadPlugins')}</button>${isDesktop() ? `<button type="button" class="btn ghost" data-action="add-plugin-file">${icon('plus', 14)} ${tr('addPluginFile')}</button>` : ''}</div>
      </section>
      <section class="settings-section" data-settings-section="automation">
        <h3>${tr('automation')}</h3>
        <div class="settings-row"><span>${tr('browserAutomation')}</span><label class="toggle"><input id="settings-browser" type="checkbox" ${settings?.user.automation?.browser?.enabled ? 'checked' : ''}> ${tr('enabled')}</label></div>
        <div class="settings-row"><span>${tr('browser')}</span><select id="settings-browser-name">${['chrome', 'msedge', 'chromium', 'firefox', 'webkit'].map((b) => `<option value="${b}" ${(settings?.user.automation?.browser?.browser ?? 'chrome') === b ? 'selected' : ''}>${b}</option>`).join('')}</select></div>
        <div class="settings-row"><span>${tr('mode')}</span><label class="toggle"><input id="settings-browser-headless" type="checkbox" ${settings?.user.automation?.browser?.headless !== false ? 'checked' : ''}> ${tr('headless')}</label><label class="toggle"><input id="settings-browser-isolated" type="checkbox" ${settings?.user.automation?.browser?.isolated ? 'checked' : ''}> ${tr('isolated')}</label></div>
        <div class="settings-row"><span>${tr('desktopAutomation')}</span><label class="toggle"><input id="settings-desktop" type="checkbox" ${settings?.user.automation?.desktop?.enabled ? 'checked' : ''}> ${tr('enabled')}</label></div>
        <div class="settings-note" id="automation-restart-note" hidden>${icon('alert', 14)} ${tr('automationChangedNote')}</div>
      </section>
      <section class="settings-section" data-settings-section="update">
        <h3>${tr('updateTitle')}</h3>
        <div class="settings-note">${icon('info', 14)} ${tr('updateHint')}</div>
        <div class="settings-row"><span>${tr('updateChannel')}</span><code>${escapeHtml(state.update?.channel ?? 'stable')}</code></div>
        <div class="settings-row"><span>${tr('updateFeed')}</span><code>${escapeHtml(state.update?.feed ?? tr('updateNotConfigured'))}</code></div>
        <div class="settings-note" id="update-result">${updateResultText()}</div>
        <div class="plugin-actions">
          <button type="button" class="btn ghost" data-action="check-update" ${state.updateBusy ? 'disabled' : ''}>${icon('refresh', 14)} ${tr('updateCheck')}</button>
          ${state.update?.release ? `<button type="button" class="btn ghost" data-action="fetch-update" ${state.updateBusy ? 'disabled' : ''}>${icon('external', 14)} ${tr('updateFetch')}</button>` : ''}
          ${isDesktop() ? `<button type="button" class="btn ghost" data-action="apply-update">${icon('refresh', 14)} ${tr('applyUpdate')}</button>` : `<span class="muted small">${tr('updateDesktopOnly')}</span>`}
        </div>
      </section>
      <div class="settings-note">${icon('info', 15)} ${tr('restartNote')}</div>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-action="close-modal">${tr('cancel')}</button><button class="btn primary" data-action="save-settings">${icon('check', 15)} ${tr('saveSettings')}</button></div>
  </div></div>`
  const sandboxSelect = document.getElementById('settings-sandbox') as HTMLSelectElement | null
  sandboxSelect?.addEventListener('change', () => {
    const note = document.getElementById('approval-sandbox-note')
    if (note) note.textContent = approvalSandboxNote(sandboxSelect.value)
  })
  const localeSelect = document.getElementById('settings-locale') as HTMLSelectElement | null
  localeSelect?.addEventListener('change', () => {
    state.locale = localeSelect.value
    localStorage.setItem('hy-locale', state.locale)
    renderShell()
  })
  const syncEffortOptions = (role: string): void => {
    const provider = document.querySelector<HTMLSelectElement>(`select[data-role="${role}"][data-field="provider"]`)?.value ?? 'ollama'
    const model = document.querySelector<HTMLInputElement>(`input[data-role="${role}"][data-field="model"]`)?.value ?? ''
    const effort = document.querySelector<HTMLSelectElement>(`select[data-role="${role}"][data-field="effort"]`)
    if (!effort) return
    const current = effort.value
    const values = effortValuesFor(provider, model)
    effort.innerHTML = `<option value="">${tr('effortDefault')}</option>${values.map((value) => `<option value="${value}">${tr('effort_' + value)}</option>`).join('')}`
    effort.value = current === '' || values.some((value) => value === current) ? current : ''
  }
  for (const select of document.querySelectorAll<HTMLSelectElement>('select[data-role][data-field="provider"]')) {
    select.addEventListener('change', () => {
      const role = select.dataset.role
      if (!role) return
      const defaults = providerDefaults(select.value)
      const set = (field: string, value: string): void => {
        const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-role="${role}"][data-field="${field}"]`)
        if (input) input.value = value
      }
      set('model', defaults.model)
      set('baseUrl', defaults.baseUrl)
      set('apiKeyEnv', defaults.apiKeyEnv)
      set('contextWindowTokens', String(defaults.contextWindowTokens))
      set('maxOutputTokens', String(defaults.maxOutputTokens))
      const list = document.getElementById(`model-options-${role}`)
      if (list) list.innerHTML = providerModels(select.value).map((model) => `<option value="${escapeHtml(model)}"></option>`).join('')
      syncEffortOptions(role)
    })
  }
  for (const select of document.querySelectorAll<HTMLSelectElement>('select[data-role][data-preset]')) {
    select.addEventListener('change', () => {
      const preset = state.modelProfiles.find((p) => p.id === select.value)
      const role = select.dataset.role
      if (!preset || !role) return
      const set = (field: string, value: string): void => {
        const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-role="${role}"][data-field="${field}"]`)
        if (input) input.value = value
      }
      const provider = document.querySelector<HTMLSelectElement>(`select[data-role="${role}"][data-field="provider"]`)
      if (provider) {
        provider.value = preset.provider
        provider.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const model = document.querySelector<HTMLInputElement>(`input[data-role="${role}"][data-field="model"]`)
      if (model) {
        model.value = preset.model
        model.dispatchEvent(new Event('input', { bubbles: true }))
      }
      if (preset.baseUrl) set('baseUrl', preset.baseUrl)
      if (preset.apiKeyEnv) set('apiKeyEnv', preset.apiKeyEnv)
      if (preset.contextWindowTokens) set('contextWindowTokens', String(preset.contextWindowTokens))
      if (preset.maxOutputTokens) set('maxOutputTokens', String(preset.maxOutputTokens))
      syncEffortOptions(role)
    })
  }
  const automationRestartNote = document.getElementById('automation-restart-note')
  for (const id of ['settings-browser', 'settings-browser-name', 'settings-browser-headless', 'settings-browser-isolated', 'settings-desktop']) {
    document.getElementById(id)?.addEventListener('change', () => {
      if (automationRestartNote) automationRestartNote.hidden = false
    })
  }
  for (const model of document.querySelectorAll<HTMLInputElement>('input[data-role][data-field="model"]')) {
    model.addEventListener('input', () => {
      const role = model.dataset.role
      if (!role) return
      const provider = document.querySelector<HTMLSelectElement>(`select[data-role="${role}"][data-field="provider"]`)?.value ?? 'ollama'
      const limits = modelDefaults(provider, model.value)
      const context = document.querySelector<HTMLInputElement>(`input[data-role="${role}"][data-field="contextWindowTokens"]`)
      const max = document.querySelector<HTMLInputElement>(`input[data-role="${role}"][data-field="maxOutputTokens"]`)
      if (context) context.value = String(limits.contextWindowTokens)
      if (max) max.value = String(limits.maxOutputTokens)
      syncEffortOptions(role)
    })
  }
}

function setTheme(theme: 'dark' | 'light' | 'system'): void {
  state.theme = theme
  applyTheme()
  renderShell()
}

function closeSse(): void {
  state.sse?.close()
  state.sse = undefined
}

async function selectSession(runId: string): Promise<void> {
  // The orchestration chip follows the open chat, so any explicit session
  // selection clears the blank-chat marker set by newSession().
  state.freshChat = false
  // Taken while state.current still points at the outgoing chat.
  rememberTranscriptAnchor()
  // Same for the composer: the text belongs to the chat being left.
  captureComposerDraft()
  disposePtyTerminal()
  closeSse()
  try {
    const snapshot = await api<SessionSnapshot>(`/api/sessions/${encodeURIComponent(runId)}`)
    state.current = snapshot
    state.entries = snapshot.entries
    state.busy = snapshot.state.busy
    state.planMode = snapshot.state.planMode
    state.goal = snapshot.state.goal ?? ''
    state.goalState = snapshot.state.goalState ?? null
    state.selectedEntry = undefined
    state.turnQueue = undefined
    state.queueOpen = false
    connectSession(runId)
    void refreshTurnQueue()
    renderSidebarSessions()
    renderHeader()
    // The key changed with state.current, so the incoming chat's draft is the
    // one to show. Forced because the textarea must be replaced even if it
    // still holds the focus from the chat just left.
    loadComposerDraft()
    renderComposer(true)
    renderTranscript()
    if (state.right === 'diff') void loadDiff()
    if (state.right === 'plan') void loadPlan()
    if (state.right === 'details') void loadDetails()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function connectSession(runId: string): void {
  const es = sessionEvents(runId)
  state.sse = es
  es.addEventListener('snapshot', (event) => {
    if (state.sse !== es) return
    const data = JSON.parse((event as MessageEvent).data) as SessionSnapshot
    state.current = data
    state.entries = data.entries
    state.busy = data.state.busy
    state.planMode = data.state.planMode
    state.goal = data.state.goal ?? ''
    state.goalState = data.state.goalState ?? null
    state.connection = 'online'
    renderHeader()
    renderComposer()
    renderTranscript()
    renderSidebarSessions()
  })
  es.addEventListener('session', (event) => {
    if (state.sse !== es) return
    const data = JSON.parse((event as MessageEvent).data) as Record<string, unknown>
    handleSessionEvent(data)
  })
  es.onopen = () => {
    if (state.sse !== es) return
    state.connection = 'online'
    renderHeader()
  }
  es.onerror = () => {
    if (state.sse !== es) return
    state.connection = 'reconnecting'
    renderHeader()
  }
}

function handleSessionEvent(data: Record<string, unknown>): void {
  const type = String(data.type ?? '')
  switch (type) {
    case 'entry': {
      const entry = data.entry as ChatEntry
      if (entry && !state.entries.some((e) => e.id === entry.id)) state.entries.push(entry)
      renderTranscript()
      break
    }
    // WP-22: a background subagent changed state (spawned, running, idle...).
    case 'agent/state': {
      const agent = data.agent as AgentView | undefined
      if (agent) {
        const index = state.agents.findIndex((a) => a.agentId === agent.agentId)
        if (index >= 0) state.agents[index] = agent
        else state.agents.push(agent)
        if (state.right === 'details') renderRightPanel()
      }
      break
    }
    case 'agent': {
      applyLiveEvent(data.event as AgentEvent)
      renderTranscript()
      break
    }
    case 'thinking/summary': {
      const entryId = String(data.entryId ?? '')
      const summary = String(data.summary ?? '').trim()
      const entry = state.entries.find((candidate) => candidate.id === entryId)
      if (entry?.kind === 'thinking' && summary) {
        entry.summary = summary
        renderTranscript()
      }
      break
    }
    case 'state': {
      const next = data.state as SessionState
      const previous = state.current?.state
      if (state.current) state.current.state = next
      state.busy = next.busy
      state.planMode = next.planMode
      state.goal = next.goal ?? ''
      state.goalState = next.goalState ?? null
      renderHeader()
      const composerChanged =
        !previous ||
        previous.planMode !== next.planMode ||
        (previous.goal ?? null) !== (next.goal ?? null) ||
        (previous.goalState?.phase ?? null) !== (next.goalState?.phase ?? null) ||
        (previous.goalState?.roundsStarted ?? null) !== (next.goalState?.roundsStarted ?? null) ||
        (previous.goalState?.blockerReason ?? null) !== (next.goalState?.blockerReason ?? null) ||
        previous.model?.provider !== next.model?.provider ||
        previous.model?.model !== next.model?.model
      if (composerChanged) renderComposer()
      else updateComposerState()
      break
    }
    case 'turn/start': {
      state.busy = true
      state.connection = 'online'
      renderHeader()
      updateComposerState()
      renderTranscript()
      break
    }
    case 'turn/cancelling': {
      toast(tr('cancelling'))
      break
    }
    case 'turn/end': {
      state.busy = false
      if (data.error) toast(String(data.error), 'error')
      if (String(data.outcome) === 'completed') {
        toast(tr('turnComplete'), 'success')
        if (window.hyDesktop && (!document.hasFocus() || document.hidden)) {
          void window.hyDesktop.notify('HY-HARNESS', `Turn complete in ${workspaceName()}`)
        }
      }
      void refreshSessions()
      // A finished turn may have started the next queued one, so this is the
      // only place the list is refreshed without a user action.
      void refreshTurnQueue()
      renderHeader()
      updateComposerState()
      renderTranscript()
      break
    }
    case 'approval/request': {
      const entry: ChatEntry = {
        id: `approval-${String(data.requestId)}`,
        kind: 'approval',
        runId: currentRunId() ?? '',
        requestId: String(data.requestId),
        request: data.request as ApprovalRequest,
        ...(data.details ? { details: data.details as ApprovalDetails } : {}),
        ts: Date.now(),
      }
      if (!state.entries.some((e) => e.id === entry.id)) state.entries.push(entry)
      renderTranscript()
      // CP-34: the card takes the keyboard (Y / S / A / N) unless the user is typing.
      approvalToFocus = entry.requestId
      break
    }
    case 'approval/decision': {
      const entry = state.entries.find((e) => e.kind === 'approval' && e.requestId === data.requestId)
      if (entry?.kind === 'approval') {
        entry.decision = data.approved === true ? 'approved' : 'denied'
        if (typeof data.reason === 'string') entry.reason = data.reason
        if (data.scope === 'session' || data.scope === 'always') entry.scope = data.scope
      }
      renderTranscript()
      break
    }
    case 'approval/timeout':
      toast('Approval timed out; the command was denied', 'error')
      break
    case 'question/request': {
      const entry: ChatEntry = { id: `question-${String(data.requestId)}`, kind: 'question', runId: currentRunId() ?? '', requestId: String(data.requestId), question: String(data.question ?? ''), ts: Date.now() }
      if (!state.entries.some((e) => e.id === entry.id)) state.entries.push(entry)
      renderTranscript()
      break
    }
    case 'question/answer': {
      const entry = state.entries.find((e) => e.kind === 'question' && e.requestId === data.requestId)
      if (entry?.kind === 'question') entry.answer = String(data.answer ?? '')
      renderTranscript()
      break
    }
    case 'transcript': {
      state.entries = (data.entries as ChatEntry[]) ?? []
      renderTranscript()
      break
    }
    case 'notice': {
      state.entries.push({ id: `notice-${Date.now()}`, kind: 'notice', runId: currentRunId() ?? '', text: String(data.text ?? ''), ts: Date.now() })
      renderTranscript()
      break
    }
    case 'sessions': {
      state.sessions = (data.sessions as SessionSummary[]) ?? []
      renderSidebarSessions()
      break
    }
    default:
      break
  }
}

function applyLiveEvent(event: AgentEvent): void {
  const runId = currentRunId() ?? ''
  const ts = Date.now()
  switch (event.type) {
    case 'thinking': {
      const content = String(event.content ?? '').trim()
      if (content) {
        const seq = typeof event.seq === 'number' ? event.seq : undefined
        state.entries.push({ id: seq !== undefined ? `think-${seq}` : `think-${ts}-${state.entries.length}`, kind: 'thinking', runId, text: content, ts })
      }
      break
    }
    case 'thinking/summary': {
      const entryId = String(event.entryId ?? '')
      const summary = String(event.summary ?? '').trim()
      const entry = state.entries.find((candidate) => candidate.id === entryId)
      if (entry?.kind === 'thinking' && summary) {
        entry.summary = summary
        entry.summaryProvisional = event.provisional === true
      }
      // Update just this header instead of re-rendering a long transcript on
      // every summary token/refinement.
      const block = [...document.querySelectorAll<HTMLElement>('.thinking-block')].find((candidate) => candidate.dataset.entryId === entryId)
      if (block && summary) {
        let span = block.querySelector<HTMLElement>('.thinking-summary-inline')
        if (!span) {
          span = document.createElement('span')
          span.className = 'thinking-summary-inline'
          block.querySelector('summary')?.append(span)
        }
        span.textContent = `：${summary}`
        span.classList.toggle('provisional', event.provisional === true)
      }
      break
    }
    case 'assistant': {
      const content = String(event.content ?? '').trim()
      if (!content) break
      if (content.startsWith('{')) {
        try {
          const parsed = JSON.parse(content) as { final?: unknown; tool?: unknown; calls?: unknown }
          if (typeof parsed.final === 'string' || parsed.tool !== undefined || Array.isArray(parsed.calls)) break
        } catch {
          // A cut-off tool call is not a plain-text assistant answer.
          if (/^\{\s*"(?:tool|calls)"\s*:/.test(content)) break
        }
      }
      state.entries.push({ id: `live-${ts}-${state.entries.length}`, kind: 'assistant', runId, text: content, ts })
      break
    }
    case 'tool-start': {
      const callId = String(event.callId ?? `live-${state.entries.length}`)
      state.entries.push({ id: `tool-${callId}`, kind: 'tool', runId, callId, name: String(event.name ?? 'tool'), ...(event.args !== undefined ? { args: event.args } : {}), ...(event.step === undefined ? {} : { step: Number(event.step) }), ts, status: 'running' })
      break
    }
    case 'tool': {
      const callId = String(event.callId ?? '')
      const entry = state.entries.find((e): e is ChatToolEntry => e.kind === 'tool' && e.callId === callId)
      if (entry) {
        entry.output = JSON.stringify(event.result ?? null, null, 2)
        entry.result = event.result
        entry.status = 'done'
      } else {
        state.entries.push({ id: `tool-${callId || ts}`, kind: 'tool', runId, callId: callId || `live-${ts}`, name: String(event.name ?? 'tool'), ...(event.args !== undefined ? { args: event.args } : {}), output: JSON.stringify(event.result ?? null, null, 2), result: event.result, ts, status: 'done' })
      }
      break
    }
    case 'tool-error': {
      const callId = String(event.callId ?? '')
      const entry = state.entries.find((e): e is ChatToolEntry => e.kind === 'tool' && e.callId === callId)
      if (entry) {
        entry.output = String(event.message ?? 'tool failed')
        entry.isError = true
        entry.status = 'error'
      } else {
        state.entries.push({ id: `tool-${callId || ts}`, kind: 'tool', runId, callId: callId || `live-${ts}`, name: String(event.name ?? 'tool'), ...(event.args !== undefined ? { args: event.args } : {}), output: String(event.message ?? 'tool failed'), isError: true, ts, status: 'error' })
      }
      break
    }
    case 'final': {
      const text = String(event.content ?? '')
      const last = state.entries.at(-1)
      if (last?.kind === 'assistant' && last.text === text) break
      state.entries.push({ id: `final-${ts}-${state.entries.length}`, kind: 'assistant', runId, text, ts, final: true })
      break
    }
    case 'retry':
      state.entries.push({ id: `retry-${ts}-${state.entries.length}`, kind: 'notice', runId, text: `${tr('retrying')} (${String(event.reason ?? 'invalid response')})`, ts, level: 'warn' })
      break
    default:
      break
  }
}

async function refreshSessions(): Promise<void> {
  try {
    const data = await api<{ sessions: SessionSummary[] }>(`/api/sessions${state.showArchived ? '?archived=1' : ''}`)
    state.sessions = data.sessions
    renderSidebarSessions()
  } catch {
    // keep the last list
  }
}

async function togglePin(runId: string, pinned: boolean): Promise<void> {
  try {
    await post(`/api/sessions/${encodeURIComponent(runId)}/pin`, { pinned })
    await refreshSessions()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function toggleArchive(runId: string, archived: boolean): Promise<void> {
  try {
    await post(`/api/sessions/${encodeURIComponent(runId)}/archive`, { archived })
    await refreshSessions()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function copyText(text: string): Promise<void> {
  if (window.hyDesktop?.copyText && await window.hyDesktop.copyText(text)) return
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // Electron can deny the async clipboard API when the window has no focus.
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    if (!copied) throw new Error(tr('copyFailed'))
  }
}

async function copyEntry(entryId: string): Promise<void> {
  const entry = state.entries.find((candidate) => candidate.id === entryId)
  if (entry?.kind !== 'assistant') return
  try {
    await copyText(entry.text)
    toast(tr('copied'), 'success')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function deleteSession(runId: string): Promise<void> {
  if (!window.confirm(tr('deleteSessionConfirm'))) return
  try {
    await api(`/api/sessions/${encodeURIComponent(runId)}`, { method: 'DELETE' })
    toast(tr('sessionDeleted'), 'success')
    if (currentRunId() === runId) await newSession()
    else await refreshSessions()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function connectGlobal(): void {
  const es = globalEvents()
  state.globalSse = es
  es.addEventListener('sessions', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as { sessions: SessionSummary[] }
    state.sessions = data.sessions ?? []
    renderSidebarSessions()
  })
  es.addEventListener('orchestration', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as { orchestration: OrchestrationView }
    const before = state.orchestration?.active
    state.orchestration = data.orchestration
    const after = state.orchestration?.active
    // Worker/heartbeat updates arrive often. Rebuilding the composer on every
    // one steals focus from the textarea and makes the UI look like it is
    // blinking. Rebuild only when the active orchestration actually changes.
    if (before?.status !== after?.status || before?.orchestratorRunId !== after?.orchestratorRunId) {
      renderHeader()
      renderComposer()
      renderSidebarSessions()
    } else {
      renderSidebarSessions()
      renderHeader()
    }
    if (state.right === 'details') void loadDetails()
  })
}

async function startOrchestration(): Promise<void> {
  if (state.orchestrationBusy) return
  state.orchestrationBusy = true
  try {
    const data = await post<{ runId: string; state: SessionState; orchestration: OrchestrationView }>('/api/orchestration/start')
    state.orchestration = data.orchestration
    await refreshSessions()
    await selectSession(data.runId)
    toast(tr('orchestrationStarted'), 'success')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    state.orchestrationBusy = false
  }
}

async function stopOrchestration(): Promise<void> {
  if (state.orchestrationBusy) return
  if (state.orchestration?.active?.status !== 'active') return
  if (!window.confirm(tr('stopOrchestrationConfirm'))) return
  state.orchestrationBusy = true
  try {
    const data = await post<{ orchestration: OrchestrationView }>('/api/orchestration/stop')
    state.orchestration = data.orchestration
    await refreshSessions()
    // Stopping is only reachable from the active orchestrator (or a worker),
    // so always return to a blank composer without creating an empty session.
    await newSession()
    toast(tr('orchestrationStopped'), 'success')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    state.orchestrationBusy = false
  }
}

async function toggleOrchestration(): Promise<void> {
  const active = state.orchestration?.active?.status === 'active' ? state.orchestration.active : undefined
  const intent = orchestrationIntent({
    freshChat: state.freshChat,
    activeRunId: active?.orchestratorRunId,
    currentRunId: state.current?.runId,
  })
  switch (intent) {
    case 'start':
      // The orchestration now owns the composer, so clear the blank-chat
      // marker: a second click must stop it instead of starting another one.
      state.freshChat = false
      await startOrchestration()
      return
    case 'stop':
      await stopOrchestration()
      return
    case 'open-active':
      // A normal chat, a worker, or an older orchestrator that is not the
      // active one: open the active orchestrator instead of stopping it.
      if (active) await selectSession(active.orchestratorRunId)
      return
    case 'noop':
      return
  }
}

async function stopWorker(workerId: string): Promise<void> {
  if (!window.confirm(tr('stopWorkerConfirm'))) return
  try {
    const data = await post<{ orchestration: OrchestrationView }>(`/api/orchestration/workers/${encodeURIComponent(workerId)}/stop`)
    state.orchestration = data.orchestration
    await refreshSessions()
    renderSidebarSessions()
    renderHeader()
    renderComposer()
    toast(tr('workerStopped'), 'success')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function newSession(): Promise<void> {
  // Taken while state.current still points at the chat being left.
  rememberTranscriptAnchor()
  captureComposerDraft()
  disposePtyTerminal()
  closeSse()
  // Do not create a server session here. A tab appears only when the first
  // message is sent; otherwise deleting a chat would immediately add an empty
  // replacement tab and the sidebar would grow without bound.
  state.current = undefined
  state.entries = []
  state.busy = false
  state.sending = false
  state.planMode = false
  state.goal = ''
  state.goalState = null
  // Mark the blank chat so the orchestration chip starts a new orchestration
  // instead of reopening the one this chat was created from.
  state.freshChat = true
  state.selectedEntry = undefined
  state.right = null
  // A new chat starts empty; the text typed so far stays with the chat it was
  // typed into, which is what the draft map above just recorded.
  saveComposerDraft('')
  state.attachments = []
  state.turnQueue = undefined
  state.queueOpen = false
  await refreshSessions()
  renderHeader()
  renderComposer(true)
  renderTranscript()
  renderRightPanel()
  focusComposer()
}

function focusComposer(): void {
  window.setTimeout(() => (document.getElementById('composer-input') as HTMLTextAreaElement | null)?.focus(), 30)
}

async function sendMessage(text: string): Promise<void> {
  if (state.current?.state.kind === 'worker') {
    toast(tr('workerReadOnly'), 'error')
    return
  }
  // A running turn no longer rejects the message; sendIntent decides between an
  // immediate send, steering the running turn and a durable queue entry.
  const intent = sendIntent(state.busy, state.steerMode)
  const images = state.attachments.map((a) => ({ mimeType: a.mimeType, data: a.data }))
  if (!text.trim() && images.length === 0) return
  state.sending = true
  updateComposerState()
  let runId = currentRunId()
  let created = false
  try {
    if (!runId) {
      // A blank composer has no server session yet. Create it only now, when
      // the first message is actually sent.
      const data = await post<{ runId: string; state: SessionState }>('/api/sessions')
      runId = data.runId
      created = true
      state.current = { runId: data.runId, entries: [], state: data.state }
      state.entries = []
      state.busy = false
      state.planMode = data.state.planMode
      state.goal = data.state.goal ?? ''
      state.goalState = data.state.goalState ?? null
      state.selectedEntry = undefined
      state.right = null
      connectSession(data.runId)
      await refreshSessions()
      renderHeader()
      // The run id, and with it the draft key, just changed.
      loadComposerDraft()
      renderComposer(true)
    }
    // WP-21: while a turn runs the message either joins it at the next step
    // boundary (`steer`) or waits in the durable queue (`queue`).
    if (intent === 'steer') {
      try {
        await post(`/api/sessions/${encodeURIComponent(runId)}/steer`, {
          message: text,
          ...(images.length > 0 ? { images } : {}),
        })
        saveComposerDraft('')
        state.attachments = []
        renderComposer(true)
        focusComposer()
        return
      } catch (error) {
        // The turn ended between the click and the request: fall back to a
        // normal turn instead of losing the text.
        if (!(error instanceof ApiError) || (error.status !== 400 && error.status !== 409)) throw error
      }
    }
    await post(`/api/sessions/${encodeURIComponent(runId)}/turn`, {
      message: text,
      ...(images.length > 0 ? { images } : {}),
      ...(intent === 'queue' ? { queue: true } : {}),
    })
    saveComposerDraft('')
    state.attachments = []
    if (intent === 'queue') {
      // The turn is waiting on the server; the authoritative list comes back
      // from the queue endpoint, not from a local guess about the position.
      renderComposer(true)
      focusComposer()
      // Open the list once so the user sees where the message went; the badge
      // still toggles it afterwards.
      state.queueOpen = true
      await refreshTurnQueue()
    } else {
      state.busy = true
      state.connection = 'online'
      renderHeader()
      renderComposer(true)
    }
  } catch (error) {
    if (created && runId) {
      // The first send failed after creating the tab: remove it instead of
      // leaving an empty session behind.
      try {
        await api(`/api/sessions/${encodeURIComponent(runId)}`, { method: 'DELETE' })
      } catch {
        // The server may have already removed it.
      }
      state.current = undefined
      await refreshSessions()
      renderHeader()
      loadComposerDraft()
      renderComposer(true)
      renderTranscript()
    }
    toast(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    state.sending = false
    updateComposerState()
  }
}

/**
 * Fetches the queue view for the open chat. Called only after a send, after a
 * queue action and when a turn ends; there is deliberately no polling.
 */
async function refreshTurnQueue(): Promise<void> {
  const runId = currentRunId()
  if (!runId) {
    state.turnQueue = undefined
    renderTurnQueue()
    return
  }
  try {
    state.turnQueue = await fetchTurnQueue(runId)
  } catch {
    // Keep the last view; the next refresh retries.
    return
  }
  renderTurnQueue()
}

function renderTurnQueue(): void {
  const host = document.getElementById('turn-queue-host')
  if (!host) return
  const view = state.turnQueue
  const html = view ? renderTurnQueueHtml(view, state.locale) : ''
  // A turn whose outcome is unknown must be visible even when the user closed
  // the list, otherwise the blocked queue looks empty.
  const forced = (view?.uncertain.length ?? 0) > 0
  host.innerHTML = html && (state.queueOpen || forced) ? html : ''
  const badge = document.getElementById('tq-badge') as HTMLButtonElement | null
  if (!badge) return
  const queued = view?.queued.length ?? 0
  const label = forced && queued === 0 ? tr('turnQueueUncertain') : queueBadgeLabel(queued, state.locale)
  badge.textContent = label
  badge.hidden = label === ''
  badge.classList.toggle('active', state.queueOpen)
}

async function onQueueAction(el: HTMLElement): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  const action = el.dataset.queueAction
  const id = el.dataset.queueId
  try {
    if (action === 'cancel' && id) state.turnQueue = await cancelQueuedTurn(runId, id)
    else if (action === 'cancel-all') state.turnQueue = await cancelQueuedTurn(runId)
    else if (action === 'resume') state.turnQueue = await resumeTurnQueue(runId)
    else if (action === 'resolve' && id) {
      const decision = el.dataset.queueDecision === 'resend' ? 'resend' : 'discard'
      state.turnQueue = await resolveQueuedTurn(runId, id, decision)
    } else return
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
    return
  }
  renderTurnQueue()
}

function command(text: string): boolean {
  const parsed = parseSlash(text)
  if (!parsed) return false
  if (!parsed.command) {
    toast(`Unknown command /${parsed.name}. Try /help.`, 'error')
    return true
  }
  void runCommand(parsed.command.id, parsed.args)
  return true
}

/** CP-32: runs one entry of COMMANDS, from the composer or the palette. */
async function runCommand(id: string, args = ''): Promise<void> {
  const spec = COMMANDS.find((c) => c.id === id)
  if (spec?.section) {
    await openDetailsSection(spec.section)
    return
  }
  const runId = currentRunId()
  switch (id) {
    case 'new':
      await newSession()
      return
    case 'help':
      state.modal = 'help'
      renderModal()
      return
    case 'settings':
      await openSettings()
      return
    case 'diff':
    case 'plan':
    case 'files':
    case 'trace':
    case 'browser':
    case 'terminal':
      await showRight(id)
      return
    case 'plan-mode':
      await togglePlan(args === 'off' ? false : args === 'on' ? true : undefined)
      return
    case 'goal': {
      if (!args) {
        await openGoal()
        return
      }
      const [sub, ...rest] = args.split(/\s+/)
      if (sub === 'pause' || sub === 'resume' || sub === 'clear') await goalAction(sub)
      else if (sub === 'edit') await saveGoalText(rest.join(' '), 'edit')
      else await saveGoalText(args)
      return
    }
    case 'undo':
    case 'compact':
    case 'review':
      await runAction(id)
      return
    case 'init':
      await sendMessage('Create an AGENTS.md at the workspace root for coding agents working in this repository. Inspect the repository first (README, package manifests, build and test scripts, directory layout). Include: what the project is, how to build, test and lint it (exact commands), the code layout, and conventions a contributor must follow. Keep it short and factual; do not invent commands. If AGENTS.md already exists, improve it instead of replacing what is still right.')
      return
    case 'model':
      if (args) await runAction('model', args)
      else toast('Usage: /model <name>')
      return
    case 'export':
      if (runId) window.open(`/api/sessions/${encodeURIComponent(runId)}/export?format=md`, '_blank')
      return
    // WP-61: `/feedback [text]` rates the last answer from the keyboard.
    case 'feedback': {
      const lastAnswer = [...state.entries].reverse().find((entry) => entry.kind === 'assistant')
      if (!lastAnswer) {
        toast(tr('feedbackNoAnswer'))
        return
      }
      state.feedbackEntryId = lastAnswer.id
      state.feedbackNote = args
      state.modal = 'feedback'
      renderModal()
      return
    }
    case 'rename':
      if (!runId) return
      if (!args) {
        openRename(runId)
        return
      }
      try {
        const data = await setSessionTitle(runId, args)
        toast(data.title ? tr('renamed') : tr('renamedAuto'), 'success')
        await refreshSessions()
        renderHeader()
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error')
      }
      return
    case 'generate-title':
      if (runId) await generateTitleFor(runId)
      return
    case 'fork':
      if (runId) await forkSession(runId)
      return
    case 'archive': {
      if (!runId) return
      // An archived chat is not in state.sessions unless "show archived" is
      // on, so ask the server (with archived chats) for the current state.
      let archived = false
      try {
        const listed = await api<{ sessions: SessionSummary[] }>('/api/sessions?archived=1')
        archived = listed.sessions.find((s) => s.runId === runId)?.archived === true
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error')
        return
      }
      await toggleArchive(runId, !archived)
      toast(archived ? tr('chatUnarchived') : tr('chatArchived'), 'success')
      return
    }
    case 'resume':
      state.paletteQuery = args
      state.paletteFiles = []
      state.modal = 'palette'
      renderModal()
      return
    case 'hooks':
      await openHooks()
      return
    case 'worktree':
      await openWorktrees(args || undefined)
      return
    case 'import':
      await openImport(args === 'dsh' ? 'dsh' : 'claude')
      return
    case 'find':
      openFind(args || undefined)
      return
    case 'raw':
      toggleRaw()
      return
    case 'rewind': {
      const turn = args ? Number(args) : undefined
      if (turn !== undefined && (!Number.isInteger(turn) || turn < 1)) {
        toast('Usage: /rewind [turn]', 'error')
        return
      }
      openRewind(turn)
      return
    }
    case 'doctor':
      await openDoctor()
      return
    case 'ralph':
      openRalph()
      return
    case 'outline':
      state.modal = 'outline'
      renderModal()
      return
    case 'shortcuts':
      state.modal = 'shortcuts'
      renderModal()
      return
    case 'theme':
      setTheme(state.theme === 'dark' ? 'light' : 'dark')
      return
    default:
      toast(`Unknown command ${id}`, 'error')
  }
}

/** Opens a right panel; unlike setRight it never closes one that is already open. */
async function showRight(panel: 'files' | 'diff' | 'plan' | 'details' | 'trace' | 'browser' | 'terminal'): Promise<void> {
  if (state.right === panel) state.right = null
  await setRight(panel)
}

/** CP-32: `/mcp`, `/usage`, … open the details panel at their section. */
async function openDetailsSection(section: DetailsSection): Promise<void> {
  await showRight('details')
  const block = document.querySelector<HTMLElement>(`.detail-block[data-section="${section}"]`)
  if (!block) return
  block.scrollIntoView({ block: 'start' })
  block.classList.add('flash')
  window.setTimeout(() => block.classList.remove('flash'), 1_200)
}

/** CP-31: the import wizard: a plan with diffs, nothing written until Apply. */
async function openImport(source: 'claude' | 'dsh'): Promise<void> {
  try {
    const view = await api<NonNullable<typeof state.importView>>(`/api/import?source=${source}`)
    state.importView = view
    state.importKinds = new Set(view.items.filter((i) => i.action !== 'skip').map((i) => i.kind))
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
    return
  }
  state.modal = 'import'
  renderModal()
}

async function applyImportPlan(): Promise<void> {
  const view = state.importView
  if (!view) return
  try {
    const result = await post<{ written: string[]; failed: string[] }>('/api/import', { source: view.source, kinds: [...state.importKinds] })
    toast(result.failed.length ? `${tr('importFailed')}: ${result.failed.join('; ')}` : `${tr('importDone')}: ${result.written.length}`, result.failed.length ? 'error' : 'success')
    await refreshSessions()
    await openImport(view.source)
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/** CP-35: the worktree dialog; `/worktree name` creates one first. */
async function openWorktrees(create?: string): Promise<void> {
  try {
    if (create) {
      const made = await post<{ path: string; branch: string }>('/api/worktrees', { name: create })
      toast(`${tr('worktreeCreated')}: ${made.branch}`, 'success')
    }
    state.worktrees = await api<NonNullable<typeof state.worktrees>>('/api/worktrees')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
    return
  }
  state.modal = 'worktree'
  renderModal()
}

async function worktreeAction(action: 'apply' | 'remove', name: string, force = false): Promise<void> {
  try {
    if (action === 'apply') {
      const result = await post<{ applied: string[]; empty: boolean; committed?: boolean }>('/api/worktrees/apply', { name })
      toast(result.empty ? tr('worktreeNothing') : `${tr('worktreeApplied')}: ${result.applied.join(', ')}`, 'success')
      if (state.right === 'diff') void loadDiff()
    } else {
      await post('/api/worktrees/remove', { name, ...(force ? { force: true } : {}) })
      toast(tr('worktreeRemoved'), 'success')
    }
    state.worktrees = await api<NonNullable<typeof state.worktrees>>('/api/worktrees')
    if (state.modal === 'worktree') renderModal()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function openHooks(): Promise<void> {
  try {
    state.hooksView = await api<HooksView>('/api/hooks')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
    return
  }
  state.modal = 'hooks'
  renderModal()
}

async function openDoctor(): Promise<void> {
  state.doctorView = undefined
  state.modal = 'doctor'
  renderModal()
  try {
    state.doctorView = await api<DoctorView>('/api/doctor')
  } catch (error) {
    state.modal = undefined
    renderModal()
    toast(error instanceof Error ? error.message : String(error), 'error')
    return
  }
  if (state.modal === 'doctor') renderModal()
}

async function runAction(action: 'undo' | 'compact' | 'review' | 'model', value?: string): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    if (action === 'model') {
      const next = value?.trim() ?? ''
      const result = await post<{ result: string }>(`/api/sessions/${encodeURIComponent(runId)}/model`, { model: next })
      if (next) {
        // Remember the worker model for new sessions as well as this one.
        await put('/api/settings', { roles: { worker: { model: next } } })
        if (state.boot) state.boot.config.worker.model = next
        if (state.settings) state.settings.active.worker.model = next
        renderHeader()
        renderComposer()
        toast(`${result.result} ${tr('modelSaved')}`, 'success')
      } else {
        toast(result.result, 'success')
      }
    } else if (action === 'undo') {
      const result = await post<{ result: string }>(`/api/sessions/${encodeURIComponent(runId)}/undo`)
      toast(result.result, 'success')
    } else if (action === 'compact') {
      const result = await post<{ result: string }>(`/api/sessions/${encodeURIComponent(runId)}/compact`)
      toast(result.result, 'success')
    } else {
      toast('Reviewing the working tree…')
      const result = await post<{ final: string }>(`/api/sessions/${encodeURIComponent(runId)}/review`)
      toast('Review complete', 'success')
      void result
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function setEffort(effort: string): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    const result = await post<{ result: string; effort: string }>(`/api/sessions/${encodeURIComponent(runId)}/effort`, { effort })
    if (state.current) state.current.state.effort = result.effort
    toast(tr('effortSet', { effort: effort ? tr(`effort_${effort}`) : tr('effortDefault') }), 'success')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function togglePlan(on?: boolean): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  if (state.current?.state.kind === 'orchestrator') {
    toast(tr('orchestratorPlanOnly'), 'info')
    return
  }
  try {
    const result = await post<{ result: string; planMode: boolean }>(`/api/sessions/${encodeURIComponent(runId)}/plan-mode`, { on: on ?? !state.planMode })
    state.planMode = result.planMode
    toast(result.result, 'success')
    renderComposer()
    renderHeader()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function setRight(panel: 'files' | 'diff' | 'plan' | 'details' | 'trace' | 'browser' | 'terminal' | 'desktop'): Promise<void> {
  state.right = state.right === panel ? null : panel
  renderRightPanel()
  if (state.right === 'files') await loadTree('')
  if (state.right === 'diff') await loadDiff()
  if (state.right === 'plan') await loadPlan()
  if (state.right === 'details') await loadDetails()
  if (state.right === 'trace') await loadTrajectory()
  if (state.right === 'browser' || state.right === 'desktop') await loadMcp()
}

function goBrowser(): void {
  const input = document.getElementById('browser-url') as HTMLInputElement | null
  const raw = (input?.value ?? state.browserUrl).trim()
  if (!raw) return
  const candidate = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) URLs are allowed')
    state.browserUrl = url.href
    state.browserSrc = url.href
    renderRightPanel()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function openBrowserExternal(): void {
  if (!state.browserSrc) return
  window.open(state.browserSrc, '_blank', 'noopener,noreferrer')
}

async function runTerminal(): Promise<void> {
  const runId = currentRunId()
  const input = document.getElementById('terminal-input') as HTMLInputElement | null
  const command = input?.value.trim() ?? ''
  if (!runId || !command) return
  state.terminalBusy = true
  renderRightPanel()
  try {
    const data = await post<{ result: { stdout?: string; stderr?: string; exitCode?: number; status?: string } }>(
      `/api/sessions/${encodeURIComponent(runId)}/terminal`,
      { command },
    )
    const result = data.result ?? {}
    const output = [result.stdout ?? '', result.stderr ?? ''].filter(Boolean).join('\n')
    state.terminalHistory.push({ command, output: output || `(${result.status ?? 'completed'})`, ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}) })
  } catch (error) {
    state.terminalHistory.push({ command, output: '', error: error instanceof Error ? error.message : String(error) })
  } finally {
    state.terminalBusy = false
    renderRightPanel()
    window.setTimeout(() => (document.getElementById('terminal-input') as HTMLInputElement | null)?.focus(), 20)
  }
}

function clearTerminal(): void {
  state.terminalHistory = []
  renderRightPanel()
}

async function loadMcp(): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    const data = await api<{ tools: McpToolSummary[] }>(`/api/sessions/${encodeURIComponent(runId)}/mcp`)
    state.mcp = data.tools ?? []
    renderRightPanel()
  } catch {
    // The panel shows its own "not enabled" state.
  }
}

async function callMcp(server: string, tool: string, args: unknown): Promise<string> {
  const runId = currentRunId()
  if (!runId) throw new Error('no active session')
  const data = await post<{ result: { isError?: boolean; text?: string; structured?: unknown } }>(
    `/api/sessions/${encodeURIComponent(runId)}/mcp-call`,
    { server, tool, args },
  )
  const result = data.result
  const text = result.text ?? (result.structured !== undefined ? JSON.stringify(result.structured, null, 2) : JSON.stringify(result, null, 2))
  return result.isError ? `ERROR: ${text}` : text
}

async function runBrowserTool(tool: string, args: unknown): Promise<void> {
  state.browserBusy = true
  renderRightPanel()
  try {
    state.browserResult = await callMcp('playwright', tool, args)
  } catch (error) {
    state.browserResult = `ERROR: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    state.browserBusy = false
    renderRightPanel()
  }
}

async function runDesktopTool(tool: string, args: unknown): Promise<void> {
  state.desktopBusy = true
  renderRightPanel()
  try {
    state.desktopResult = await callMcp('agent-desktop', tool, args)
  } catch (error) {
    state.desktopResult = `ERROR: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    state.desktopBusy = false
    renderRightPanel()
  }
}

async function loadTrajectory(): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    const data = await api<{ events: TrajectoryEvent[] }>(`/api/sessions/${encodeURIComponent(runId)}/trajectory`)
    state.trajectory = data.events
    renderRightPanel()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function loadTree(dir: string): Promise<void> {
  const key = `${state.fileRoot}:${dir}`
  if (state.tree.has(key)) return
  try {
    const data = await api<TreeResponse>(`/api/files/tree?path=${encodeURIComponent(dir)}&root=${encodeURIComponent(state.fileRoot)}`)
    state.tree.set(key, data.entries)
    renderRightPanel()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function toggleDir(dir: string): Promise<void> {
  const key = `${state.fileRoot}:${dir}`
  if (state.expandedDirs.has(key)) state.expandedDirs.delete(key)
  else {
    state.expandedDirs.add(key)
    if (!state.tree.has(key)) await loadTree(dir)
  }
  renderRightPanel()
}

async function openFile(path: string): Promise<void> {
  try {
    const data = await api<FileResponse>(`/api/files?path=${encodeURIComponent(path)}&root=${encodeURIComponent(state.fileRoot)}`)
    state.file = data
    state.selectedFile = `${state.fileRoot}:${path}`
    if (state.right !== 'files') state.right = 'files'
    renderRightPanel()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function loadDiff(): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    const data = await api<{ diff: string; error?: string }>(`/api/sessions/${encodeURIComponent(runId)}/diff`)
    state.diff = data.diff
    state.diffError = data.error
    renderRightPanel()
  } catch (error) {
    state.diffError = error instanceof Error ? error.message : String(error)
    renderRightPanel()
  }
}

async function loadPlan(): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    const data = await api<{ plan: string; planMode: boolean }>(`/api/sessions/${encodeURIComponent(runId)}/plan`)
    state.plan = data.plan
    state.planModeText = data.planMode ? 'plan mode is on' : ''
    renderRightPanel()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function loadDetails(): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  const base = `/api/sessions/${encodeURIComponent(runId)}`
  const safe = async <T>(promise: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await promise
    } catch {
      return fallback
    }
  }
  const [status, notes, skills, goal, jobs, subagents, trajectory, mcp, plugins, memory, agents, stats, openIn] = await Promise.all([
    safe(api<{ status: string }>(`${base}/status`), { status: '' }),
    safe(api<{ notes: string }>(`${base}/notes`), { notes: '' }),
    safe(api<{ skills: string }>(`${base}/skills`), { skills: '' }),
    safe(api<{ goal: string | null; state?: GoalStateView | null }>(`${base}/goal`), { goal: null }),
    safe(api<{ jobs: JobRecord[] }>(`${base}/jobs`), { jobs: [] }),
    safe(api<{ subagents: SubagentSummary[] }>(`${base}/subagents`), { subagents: [] }),
    safe(api<{ events: TrajectoryEvent[] }>(`${base}/trajectory`), { events: [] }),
    safe(api<{ tools: McpToolSummary[] }>(`${base}/mcp`), { tools: [] }),
    safe(api<{ tools: PluginToolSummary[] }>(`${base}/plugins`), { tools: [] }),
    safe(api<{ entries: MemoryEntry[] }>(`${base}/memory`), { entries: [] }),
    safe(api<{ agents: AgentView[] }>(`${base}/agents`), { agents: [] }),
    safe(api<{ stats: SessionStatsView }>(`${base}/stats`), { stats: undefined as unknown as SessionStatsView }),
    safe(api<{ local: boolean; targets: OpenInTargetView[] }>('/api/open-in'), { local: false, targets: [] }),
  ])
  state.status = status.status
  state.notes = notes.notes
  state.skills = skills.skills
  state.goal = goal.goal ?? ''
  state.goalState = goal.state ?? null
  state.jobs = jobs.jobs
  state.subagents = subagents.subagents
  state.trajectory = trajectory.events
  state.mcp = mcp.tools
  state.plugins = plugins.tools
  state.memory = memory.entries
  state.agents = agents.agents
  state.stats = stats.stats
  state.openInTargets = openIn.targets
  state.openInLocal = openIn.local
  renderRightPanel()
  renderComposer()
}

function openPalette(): void {
  state.paletteQuery = ''
  state.paletteFiles = []
  state.modal = 'palette'
  renderModal()
}

let paletteFilesTimer: number | undefined
let paletteFilesSeq = 0

/**
 * CP-32: workspace files for the palette, fetched 150 ms after typing stops.
 * A response for an older query is dropped, so results never flicker back.
 */
function schedulePaletteFiles(query: string): void {
  if (paletteFilesTimer !== undefined) window.clearTimeout(paletteFilesTimer)
  const q = query.trim().replace(/^\//, '')
  if (q.length < 2) {
    state.paletteFiles = []
    return
  }
  const seq = ++paletteFilesSeq
  paletteFilesTimer = window.setTimeout(() => {
    void api<{ files: string[] }>(`/api/files/search?q=${encodeURIComponent(q)}`)
      .then((data) => {
        if (seq !== paletteFilesSeq || state.modal !== 'palette') return
        state.paletteFiles = data.files
        renderModal()
      })
      .catch(() => undefined)
  }, 150)
}

/** CP-32: the palette's "Settings › …" rows open the dialog at that section. */
async function openSettingsSection(section: string): Promise<void> {
  await openSettings()
  const block = document.querySelector<HTMLElement>(`[data-settings-section="${section}"]`)
  if (!block) return
  block.scrollIntoView({ block: 'start' })
  block.classList.add('flash')
  window.setTimeout(() => block.classList.remove('flash'), 1_200)
}

function runPalette(command: string): void {
  state.modal = undefined
  renderModal()
  void runCommand(command)
}

function openRalph(): void {
  if (state.ralphTimer !== undefined) window.clearInterval(state.ralphTimer)
  state.ralphTimer = undefined
  state.ralph = undefined
  state.modal = 'ralph'
  renderModal()
}

async function startRalph(): Promise<void> {
  const objective = (document.getElementById('ralph-objective') as HTMLTextAreaElement | null)?.value.trim() ?? ''
  const verifyCmds = ((document.getElementById('ralph-verify') as HTMLTextAreaElement | null)?.value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const maxRounds = Number((document.getElementById('ralph-rounds') as HTMLInputElement | null)?.value ?? 3)
  const autoApprove = (document.getElementById('ralph-auto') as HTMLInputElement | null)?.checked === true
  if (!objective || verifyCmds.length === 0) {
    toast('An objective and at least one verification command are required', 'error')
    return
  }
  try {
    const created = await post<{ id: string; status: RalphStatus['status']; objective: string }>('/api/ralph', {
      objective,
      verifyCmds,
      maxRounds,
      autoApprove,
    })
    state.ralph = { id: created.id, status: created.status, objective: created.objective, output: '', started: Date.now() }
    renderModal()
    if (state.ralphTimer !== undefined) window.clearInterval(state.ralphTimer)
    state.ralphTimer = window.setInterval(() => void pollRalph(), 700)
    void pollRalph()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function pollRalph(): Promise<void> {
  const job = state.ralph
  if (!job) return
  try {
    const next = await api<RalphStatus>(`/api/ralph/${encodeURIComponent(job.id)}`)
    state.ralph = next
    renderModal()
    if (next.status !== 'running') {
      if (state.ralphTimer !== undefined) window.clearInterval(state.ralphTimer)
      state.ralphTimer = undefined
      await refreshSessions()
    }
  } catch {
    // keep polling
  }
}

async function cancelRalph(): Promise<void> {
  const job = state.ralph
  if (!job) return
  try {
    await post(`/api/ralph/${encodeURIComponent(job.id)}/cancel`)
    await pollRalph()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function closeRalph(): void {
  if (state.ralphTimer !== undefined) window.clearInterval(state.ralphTimer)
  state.ralphTimer = undefined
  state.modal = undefined
  state.ralph = undefined
  renderModal()
}

async function openGoal(): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    const data = await api<{ goal: string | null; state?: GoalStateView | null }>(`/api/sessions/${encodeURIComponent(runId)}/goal`)
    state.goal = data.goal ?? ''
    state.goalState = data.state ?? null
    state.modal = 'goal'
    renderModal()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function openSandboxMenu(): void {
  if (!state.current) {
    toast(tr('sandboxDesc'), 'error')
    return
  }
  state.modal = 'sandbox'
  renderModal()
}

/**
 * Switches this chat's sandbox mode (WP-12). The switch is recorded in the
 * session log and applies from the next tool call; it never retroactively
 * changes a running command.
 */
async function setSandboxMode(mode: string): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    const result = await post<{ mode: string }>(`/api/sessions/${encodeURIComponent(runId)}/sandbox`, { mode })
    if (state.current && typeof result.mode === 'string') {
      state.current.state.sandboxMode = result.mode as NonNullable<SessionState['sandboxMode']>
    }
    toast(tr('sandboxChanged', { mode: sandboxModeLabel(String(result.mode ?? mode)) }), 'success')
    state.modal = undefined
    renderModal()
    renderHeader()
    renderComposer(true)
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function openModel(): void {
  state.modal = 'model'
  state.modelQuery = ''
  renderModal()
  if (state.modelCatalog.length === 0) {
    void api<{ models: CatalogModel[] }>('/api/models')
      .then((data) => {
        state.modelCatalog = data.models
        if (state.modal === 'model') renderModal()
      })
      .catch(() => undefined)
  }
}

async function saveModel(): Promise<void> {
  const value = (document.getElementById('model-input') as HTMLInputElement | null)?.value.trim() ?? ''
  if (!value) return
  state.modal = undefined
  renderModal()
  await runAction('model', value)
}

async function saveGoalText(goal: string, action?: 'edit'): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    const data = await post<{ result: string; goal: string | null; state?: GoalStateView | null }>(
      `/api/sessions/${encodeURIComponent(runId)}/goal`,
      { goal, ...(action ? { action } : {}) },
    )
    state.goal = data.goal ?? ''
    state.goalState = data.state ?? null
    renderModal()
    renderComposer()
    toast(data.result, 'success')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function saveGoal(): Promise<void> {
  const input = document.getElementById('goal-input') as HTMLTextAreaElement | null
  state.modal = undefined
  await saveGoalText(input?.value.trim() ?? '')
}

async function goalAction(action: 'pause' | 'resume' | 'clear'): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    const data = await post<{ result: string; goal: string | null; state?: GoalStateView | null }>(
      `/api/sessions/${encodeURIComponent(runId)}/goal`,
      { action },
    )
    state.goal = data.goal ?? ''
    state.goalState = data.state ?? null
    renderModal()
    renderComposer()
    toast(data.result, 'success')
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function refreshJobs(): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    const data = await api<{ jobs: JobRecord[] }>(`/api/sessions/${encodeURIComponent(runId)}/jobs`)
    state.jobs = data.jobs
    renderRightPanel()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function loadJobOutput(jobId: string): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    const data = await api<{ data: string }>(`/api/sessions/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}/output`)
    state.jobOutput = data.data
    renderRightPanel()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function killJob(jobId: string): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    await post(`/api/sessions/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}/kill`)
    toast(`Killed ${jobId}`, 'success')
    await refreshJobs()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function openSubagent(runId: string): Promise<void> {
  const parent = currentRunId()
  if (!parent) return
  try {
    const data = await api<{ entries: ChatEntry[] }>(`/api/sessions/${encodeURIComponent(parent)}/subagents/${encodeURIComponent(runId)}`)
    state.agentEntries = data.entries
    renderRightPanel()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/** WP-22: sends a follow-up to a background subagent and refreshes the panel. */
async function sendAgentMessage(agentId: string): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  const input = document.querySelector<HTMLInputElement>(`[data-agent-input="${agentId}"]`)
  const message = (input?.value ?? '').trim()
  if (!message) return
  try {
    await post(`/api/sessions/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/message`, { message })
    if (input) input.value = ''
    await loadDetails()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/** WP-22: stops a background subagent's running turn; the conversation stays. */
async function interruptAgent(agentId: string): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    await post(`/api/sessions/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/interrupt`)
    await loadDetails()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/** WP-23: a `present` card → the file viewer (added roots keep their prefix). */
async function openDeliverable(path: string): Promise<void> {
  const match = /^root:([^/]+)\/(.+)$/.exec(path)
  if (match) {
    state.fileRoot = match[1]!
    await openFile(match[2]!)
    return
  }
  state.fileRoot = 'main'
  await openFile(path)
}

/** WP-52: open the document preview (PDF/image/Office) in a new tab. */
function previewDeliverable(path: string): void {
  const runId = currentRunId()
  if (!runId) return
  // The server converts Office documents when LibreOffice is installed and
  // answers 415 with a readable message when it is not.
  const url = `/api/sessions/${encodeURIComponent(runId)}/document?path=${encodeURIComponent(path)}`
  window.open(url, '_blank', 'noopener')
}

/** WP-23: ask the host to show the file in the OS file manager. */
async function revealDeliverable(path: string): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    await post(`/api/sessions/${encodeURIComponent(runId)}/reveal`, { path })
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function openSettings(): Promise<void> {
  try {
    const [settings, plugins] = await Promise.all([
      api<SettingsResponse>('/api/settings'),
      api<PluginCatalog>('/api/plugins').catch(() => undefined),
    ])
    state.settings = settings
    state.modelProfiles = settings.user.models ?? DEFAULT_MODEL_PROFILES
    state.pluginCatalog = plugins
    state.modal = 'settings'
    renderModal()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function reloadPlugins(): Promise<void> {
  try {
    const catalog = await post<PluginCatalog & { note: string }>('/api/plugins/reload')
    state.pluginCatalog = catalog
    toast(`${catalog.tools.length} plugin tool(s) loaded. ${catalog.note}`, 'success')
    renderModal()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function addPluginFile(): Promise<void> {
  if (!window.hyDesktop) {
    toast('Add the module path to the plugin list (browse is available in the desktop app).')
    return
  }
  try {
    const file = await window.hyDesktop.pickPluginFile()
    if (!file) return
    const textarea = document.getElementById('settings-plugins') as HTMLTextAreaElement | null
    if (!textarea) return
    textarea.value = `${textarea.value.trim()}${textarea.value.trim() ? '\n' : ''}${file}`
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function refreshBoot(): Promise<void> {
  const boot = await api<Bootstrap>('/api/bootstrap')
  state.boot = boot
  state.sessions = boot.sessions
  state.orchestration = boot.orchestration
  state.roots = boot.workspace.roots ?? boot.config.roots ?? []
  if (!state.roots.some((root) => root.id === state.fileRoot)) state.fileRoot = 'main'
  if (state.current) state.current.state.effort = boot.config.worker.effort ?? ''
  renderShell()
}

async function saveSettings(): Promise<void> {
  const roles: Record<string, Record<string, unknown>> = {}
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-role][data-field]')) {
    const role = el.dataset.role!
    const field = el.dataset.field!
    roles[role] ??= {}
    let value: unknown = el.value.trim()
    if (field === 'contextWindowTokens' || field === 'maxOutputTokens') value = Number(value)
    if (field === 'effort' && value === '') {
      // null clears the role's effort in the server-side merge.
      roles[role]![field] = null
      continue
    }
    if (value === '' || (typeof value === 'number' && !Number.isFinite(value))) continue
    roles[role]![field] = value
  }
  const sandbox = (document.getElementById('settings-sandbox') as HTMLSelectElement | null)?.value
  const approval = (document.getElementById('settings-approval') as HTMLSelectElement | null)?.value ?? 'manual'
  const plugins = ((document.getElementById('settings-plugins') as HTMLTextAreaElement | null)?.value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const memoryEnabled = (document.getElementById('settings-memory') as HTMLInputElement | null)?.checked
  const webEnabled = (document.getElementById('settings-web') as HTMLInputElement | null)?.checked
  const browserEnabled = (document.getElementById('settings-browser') as HTMLInputElement | null)?.checked
  const browserName = (document.getElementById('settings-browser-name') as HTMLSelectElement | null)?.value ?? 'chrome'
  const browserHeadless = (document.getElementById('settings-browser-headless') as HTMLInputElement | null)?.checked
  const browserIsolated = (document.getElementById('settings-browser-isolated') as HTMLInputElement | null)?.checked
  const desktopEnabled = (document.getElementById('settings-desktop') as HTMLInputElement | null)?.checked
  // WP-61: appearance is device-local, so it is applied even if the server
  // rejects the rest of the form.
  const themeValue = (document.getElementById('settings-theme') as HTMLSelectElement | null)?.value
  if (themeValue === 'light' || themeValue === 'dark' || themeValue === 'system') {
    state.theme = themeValue
    applyTheme()
  }
  const mask = (document.getElementById('settings-mask') as HTMLInputElement | null)?.checked
  if (mask !== undefined) {
    state.maskSecrets = mask
    localStorage.setItem('hy-mask-secrets', mask ? '1' : '0')
  }
  const fontText = sanitizeFontStack((document.getElementById('settings-font-text') as HTMLInputElement | null)?.value ?? '')
  const fontCode = sanitizeFontStack((document.getElementById('settings-font-code') as HTMLInputElement | null)?.value ?? '')
  localStorage.setItem('hy-font-text', fontText)
  localStorage.setItem('hy-font-code', fontCode)
  applyFonts()
  try {
    const result = await put<{ hotReloaded?: boolean; sandboxRestartRequired?: boolean }>('/api/settings', {
      roles,
      models: state.modelProfiles,
      autoApprove: approval === 'all',
      fullAuto: approval === 'confined',
      ...(sandbox ? { sandboxMode: sandbox } : {}),
      plugins,
      ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
      ...(webEnabled !== undefined ? { webEnabled } : {}),
      automation: {
        browser: { enabled: browserEnabled === true, browser: browserName, headless: browserHeadless === true, isolated: browserIsolated === true },
        desktop: { enabled: desktopEnabled === true },
      },
    })
    state.modal = undefined
    renderModal()
    if (result.hotReloaded) {
      await refreshBoot()
      toast(result.sandboxRestartRequired ? tr('settingsAppliedSandbox') : tr('settingsApplied'), 'success')
    } else {
      toast(tr('settingsRestart'), 'error')
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function addWorkspaceRoot(path: string, writable: boolean): Promise<void> {
  try {
    const data = await post<{ roots: WorkspaceRootView[] }>('/api/workspace/roots', { path, writable })
    state.roots = data.roots
    if (state.boot) state.boot.workspace.roots = data.roots
    if (state.boot) state.boot.config.roots = data.roots
    await refreshBoot()
    state.modal = 'roots'
    renderModal()
    toast(tr('addRoot'), 'success')
  } catch (error) {
    toast(`${tr('addRootFailed')} ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

async function removeWorkspaceRoot(id: string): Promise<void> {
  try {
    const data = await api<{ roots: WorkspaceRootView[] }>(`/api/workspace/roots/${encodeURIComponent(id)}`, { method: 'DELETE' })
    state.roots = data.roots
    await refreshBoot()
    if (state.fileRoot === id) state.fileRoot = 'main'
    state.modal = 'roots'
    renderModal()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function openWorkspaceRoots(): void {
  state.modal = 'roots'
  renderModal()
}

async function browseWorkspaceRoot(): Promise<void> {
  if (!window.hyDesktop?.pickFolder) {
    toast(tr('browse'), 'error')
    return
  }
  try {
    const picked = await window.hyDesktop.pickFolder()
    const input = document.getElementById('root-path') as HTMLInputElement | null
    if (picked && input) input.value = picked
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/**
 * WP-53: an explicit check of the signed release feed. Nothing is downloaded
 * until the user asks, and a feed that fails verification is refused wholesale.
 */
function updateResultText(): string {
  const update = state.update
  if (!update) return tr('updateNotChecked')
  if (update.error) return `${tr('updateFailed')}: ${update.error}`
  if (!update.configured) return `${tr('updateNotConfigured')} ${update.hint ?? ''}`.trim()
  if (update.release) {
    const notes = update.release.notes ? ` — ${update.release.notes}` : ''
    const mandatory = update.release.mandatory ? ` ${tr('updateMandatory')}` : ''
    return `${tr('updateAvailable', { version: update.release.version })}${mandatory}${notes}`
  }
  return tr('updateUpToDate', { version: update.currentVersion })
}

async function checkUpdate(): Promise<void> {
  state.updateBusy = true
  try {
    state.update = await api<UpdateCheck>('/api/update')
  } catch (error) {
    state.update = undefined
    toast(`${tr('updateFailed')}: ${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    state.updateBusy = false
    if (state.modal === 'settings') renderModal()
  }
  const release = state.update?.release
  if (release) toast(tr('updateAvailable', { version: release.version }), 'info')
}

async function fetchUpdate(): Promise<void> {
  if (!state.update?.release) return
  state.updateBusy = true
  try {
    const result = await post<UpdateFetch>('/api/update/fetch', {})
    toast(tr('updateDownloaded', { file: result.file }), 'success')
    if (isDesktop()) toast(tr('updateRestartToApply'))
  } catch (error) {
    toast(`${tr('updateFailed')}: ${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    state.updateBusy = false
    if (state.modal === 'settings') renderModal()
  }
}

async function applyUpdate(): Promise<void> {
  if (!window.hyDesktop?.applyUpdate) {
    toast(tr('updateDesktopOnly'), 'error')
    return
  }
  if (!window.confirm(tr('updateConfirm'))) return
  try {
    const result = await window.hyDesktop.applyUpdate()
    if (!result.ok) {
      toast(`${tr('updateFailed')}: ${result.error ?? ''}`, 'error')
      return
    }
    toast(tr('updateStarted'), 'success')
  } catch (error) {
    toast(`${tr('updateFailed')}: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

async function chooseWorkspace(): Promise<void> {
  if (!window.hyDesktop) {
    toast('Start hy web with --cwd <dir> to change the workspace.')
    return
  }
  try {
    state.workspaces = await window.hyDesktop.recentWorkspaces()
  } catch {
    state.workspaces = []
  }
  state.modal = 'workspace'
  renderModal()
}

async function switchWorkspace(path: string): Promise<void> {
  if (!window.hyDesktop) return
  state.modal = undefined
  renderModal()
  try {
    await window.hyDesktop.chooseWorkspace(path)
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function browseWorkspace(): Promise<void> {
  if (!window.hyDesktop) return
  state.modal = undefined
  renderModal()
  try {
    await window.hyDesktop.chooseWorkspace()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function approve(requestId: string, approved: boolean, scope: 'once' | 'session' | 'always' = 'once'): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  const reason = (document.getElementById(`approval-reason-${requestId}`) as HTMLInputElement | null)?.value.trim()
  try {
    await post(`/api/sessions/${encodeURIComponent(runId)}/approval`, { requestId, approved, ...(reason && !approved ? { reason } : {}), ...(approved && scope !== 'once' ? { scope } : {}) })
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function answerQuestion(requestId: string, answer: string): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    await post(`/api/sessions/${encodeURIComponent(runId)}/answer`, { requestId, answer })
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function openEntryDetails(entryId: string): void {
  const entry = state.entries.find((e) => e.kind === 'tool' && e.id === entryId)
  if (entry?.kind !== 'tool') return
  state.selectedEntry = entry
  state.right = 'details'
  renderRightPanel()
  void loadDetails()
}

function onSubmit(event: Event): void {
  event.preventDefault()
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null
  if (!input) return
  const text = input.value.trim()
  if (!text && state.attachments.length === 0) return
  if (text && command(text)) {
    saveComposerDraft('')
    input.value = ''
    input.style.height = 'auto'
    return
  }
  void sendMessage(text || 'Describe the attached image(s).')
}

async function cancel(): Promise<void> {
  const runId = currentRunId()
  if (!runId) return
  try {
    await post(`/api/sessions/${encodeURIComponent(runId)}/cancel`)
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

let modalBackdropPointerDown = false
let startingSession = false

function onDocumentClick(event: MouseEvent): void {
  const backdropPressed = modalBackdropPointerDown
  modalBackdropPointerDown = false
  const target = event.target as HTMLElement
  // Queue rows are delegated before the generic lookup: they carry
  // `data-queue-action` instead of `data-action` so the two switches stay apart.
  const queueButton = target.closest<HTMLElement>('[data-queue-action]')
  if (queueButton) {
    void onQueueAction(queueButton)
    return
  }
  const el = target.closest<HTMLElement>('[data-action]')
  if (!el) return
  const action = el.dataset.action
  if (!action) return
  // A backdrop closes only when the same gesture both started and ended on
  // the backdrop. Dragging from an input to the backdrop must not close it.
  if ((action === 'close-modal' || action === 'close-ralph' || action === 'close-automation') && el.classList.contains('modal-backdrop')) {
    if (event.target !== el || !backdropPressed) return
  }
  switch (action) {
    case 'toggle-sidebar':
      state.sidebarOpen = !state.sidebarOpen
      applyShellState()
      break
    case 'toggle-theme':
      // WP-61: light → dark → system → light.
      setTheme(state.theme === 'light' ? 'dark' : state.theme === 'dark' ? 'system' : 'light')
      break
    case 'feedback-up':
      if (el.dataset.entryId) void sendFeedback('up', el.dataset.entryId)
      break
    case 'feedback-down':
      if (el.dataset.entryId) openFeedback(el.dataset.entryId)
      break
    case 'feedback-category':
      state.feedbackCategory = el.dataset.category ?? ''
      renderModal()
      break
    case 'feedback-send': {
      const note = (document.getElementById('feedback-note') as HTMLTextAreaElement | null)?.value.trim() ?? ''
      const entryId = state.feedbackEntryId ?? ''
      const category = state.feedbackCategory
      state.modal = undefined
      state.feedbackEntryId = undefined
      state.feedbackNote = ''
      renderModal()
      if (entryId) void sendFeedback('down', entryId, { ...(category ? { category } : {}), ...(note ? { note } : {}) })
      break
    }
    case 'open-shortcuts':
      state.modal = 'shortcuts'
      renderModal()
      break
    case 'shortcut-reset':
      localStorage.removeItem('hy-shortcuts')
      state.shortcuts = loadStoredShortcuts()
      renderModal()
      toast(tr('shortcutsReset'), 'success')
      break
    case 'shortcut-clear': {
      const actionId = el.dataset.shortcut ?? ''
      const action = SHORTCUT_ACTIONS.find((candidate) => candidate.id === actionId)
      if (action) {
        state.shortcuts[actionId] = action.defaultKeys
        localStorage.setItem('hy-shortcuts', JSON.stringify(state.shortcuts))
        void savePrefs({ shortcuts: { ...state.shortcuts } })
        renderModal()
      }
      break
    }
    case 'open-in': {
      const target = (document.getElementById('open-in-target') as HTMLSelectElement | null)?.value ?? ''
      if (target) void openInTarget(target)
      break
    }
    case 'new-session':
      void newSession()
      break
    case 'toggle-orchestration':
      void toggleOrchestration()
      break
    case 'stop-worker':
      if (el.dataset.workerId) void stopWorker(el.dataset.workerId)
      break
    case 'choose-workspace':
      void chooseWorkspace()
      break
    case 'open-roots':
      openWorkspaceRoots()
      break
    case 'apply-update':
      void applyUpdate()
      break
    case 'check-update':
      void checkUpdate()
      break
    case 'generate-title':
      if (el.dataset.runId) void generateTitleFor(el.dataset.runId)
      break
    case 'open-outline':
      state.modal = 'outline'
      renderModal()
      break
    case 'jump-entry':
      state.modal = undefined
      renderModal()
      if (el.dataset.entryId) scrollToEntry(el.dataset.entryId)
      break
    case 'fork-chat':
      if (el.dataset.runId) void forkSession(el.dataset.runId)
      break
    case 'fetch-update':
      void fetchUpdate()
      break
    case 'onboarding-next':
      state.onboardingStep = Math.min(2, state.onboardingStep + 1)
      renderModal()
      break
    case 'onboarding-back':
      state.onboardingStep = Math.max(0, state.onboardingStep - 1)
      renderModal()
      break
    case 'onboarding-sandbox':
      if (el.dataset.mode) state.onboardingDraft.sandbox = el.dataset.mode
      renderModal()
      break
    case 'onboarding-skip':
      void finishOnboarding(true)
      break
    case 'onboarding-finish':
      void finishOnboarding(false)
      break
    case 'root-browse':
      void browseWorkspaceRoot()
      break
    case 'remove-root':
      if (el.dataset.rootId) void removeWorkspaceRoot(el.dataset.rootId)
      break
    case 'toggle-archived-filter':
      state.showArchived = !state.showArchived
      renderShell()
      void refreshSessions()
      break
    case 'toggle-pin':
      if (el.dataset.runId) void togglePin(el.dataset.runId, el.dataset.pinned !== '1')
      break
    case 'toggle-archive':
      if (el.dataset.runId) void toggleArchive(el.dataset.runId, el.dataset.archived !== '1')
      break
    case 'rename-current': {
      const current = state.current
      if (!current) break
      const kind = current.state.kind
      if (kind && kind !== 'chat') break
      openRename(current.runId)
      break
    }
    case 'rename-session': {
      const runId = el.dataset.runId
      if (!runId) break
      openRename(runId)
      break
    }
    case 'delete-session':
      if (el.dataset.runId) void deleteSession(el.dataset.runId)
      break
    case 'copy-entry':
      if (el.dataset.entryId) void copyEntry(el.dataset.entryId)
      break
    case 'switch-workspace':
      if (el.dataset.path) void switchWorkspace(el.dataset.path)
      break
    case 'browse-workspace':
      void browseWorkspace()
      break
    case 'select-session':
      if (el.dataset.runId) void selectSession(el.dataset.runId)
      break
    case 'toggle-right':
      void setRight(state.right ?? 'files')
      break
    case 'close-right':
      state.right = null
      renderRightPanel()
      break
    case 'right-tab':
      if (el.dataset.panel) void setRight(el.dataset.panel as 'files' | 'diff' | 'plan' | 'details' | 'trace' | 'browser' | 'terminal' | 'desktop')
      break
    case 'refresh-tree':
      state.tree.clear()
      state.expandedDirs.clear()
      void loadTree('')
      break
    case 'refresh-diff':
      state.diff = ''
      void loadDiff()
      break
    case 'refresh-plan':
      void loadPlan()
      break
    case 'refresh-trace':
      void loadTrajectory()
      break
    case 'browser-external':
      openBrowserExternal()
      break
    case 'browser-mode':
      state.browserMode = el.dataset.mode === 'automation' ? 'automation' : 'preview'
      renderRightPanel()
      break
    case 'browser-nav': {
      const url = (document.getElementById('browser-url') as HTMLInputElement | null)?.value.trim() ?? ''
      if (url) void runBrowserTool('browser_navigate', { url })
      break
    }
    case 'browser-snapshot':
      void runBrowserTool('browser_snapshot', {})
      break
    case 'browser-click': {
      const ref = (document.getElementById('browser-ref') as HTMLInputElement | null)?.value.trim() ?? ''
      if (ref) void runBrowserTool('browser_click', { element: ref, target: ref })
      break
    }
    case 'browser-type': {
      const ref = (document.getElementById('browser-ref') as HTMLInputElement | null)?.value.trim() ?? ''
      const text = (document.getElementById('browser-text') as HTMLInputElement | null)?.value ?? ''
      if (ref) void runBrowserTool('browser_type', { element: ref, target: ref, text })
      break
    }
    case 'browser-press':
      void runBrowserTool('browser_press_key', { key: 'Enter' })
      break
    case 'desktop-list':
      void runDesktopTool('desktop_list_apps', {})
      break
    case 'desktop-snapshot': {
      const app = (document.getElementById('desktop-app') as HTMLInputElement | null)?.value.trim() ?? ''
      if (app) void runDesktopTool('desktop_snapshot', { app, interactiveOnly: true, compact: true })
      break
    }
    case 'desktop-click': {
      const ref = (document.getElementById('desktop-ref') as HTMLInputElement | null)?.value.trim() ?? ''
      if (ref) void runDesktopTool('desktop_click', { ref })
      break
    }
    case 'desktop-type': {
      const ref = (document.getElementById('desktop-ref') as HTMLInputElement | null)?.value.trim() ?? ''
      const text = (document.getElementById('desktop-text') as HTMLInputElement | null)?.value ?? ''
      if (ref) void runDesktopTool('desktop_type', { ref, text })
      break
    }
    case 'desktop-press': {
      const combo = (document.getElementById('desktop-combo') as HTMLInputElement | null)?.value.trim() ?? ''
      if (combo) void runDesktopTool('desktop_press', { combo })
      break
    }
    case 'terminal-mode':
      state.terminalMode = el.dataset.mode === 'commands' ? 'commands' : 'pty'
      disposePtyTerminal()
      renderRightPanel()
      break
    case 'pty-start':
      void startPtySession()
      break
    case 'pty-stop':
      void stopPtySession()
      break
    case 'pty-clear':
      void clearPty()
      break
    case 'terminal-clear':
      clearTerminal()
      break
    case 'toggle-dir':
      if (el.dataset.path) void toggleDir(el.dataset.path)
      break
    case 'open-file':
      if (el.dataset.path) void openFile(el.dataset.path)
      break
    case 'reveal-workspace':
      if (window.hyDesktop && state.boot) void window.hyDesktop.showItemInFolder(state.boot.workspace.root)
      break
    case 'toggle-tool': {
      const id = el.dataset.entryId
      if (!id) break
      if (state.expandedTools.has(id)) state.expandedTools.delete(id)
      else state.expandedTools.add(id)
      renderTranscript()
      break
    }
    case 'tool-details':
      if (el.dataset.entryId) openEntryDetails(el.dataset.entryId)
      break
    case 'approval-approve':
      if (el.dataset.requestId) void approve(el.dataset.requestId, true, el.dataset.scope === 'session' || el.dataset.scope === 'always' ? el.dataset.scope : 'once')
      break
    case 'approval-deny':
      if (el.dataset.requestId) void approve(el.dataset.requestId, false)
      break
    case 'cancel':
      void cancel()
      break
    case 'toggle-turn-queue':
      state.queueOpen = !state.queueOpen
      renderTurnQueue()
      break
    case 'toggle-steer-mode':
      state.steerMode = state.steerMode === 'steer' ? 'queue' : 'steer'
      renderComposer()
      toast(state.steerMode === 'queue' ? tr('steerQueueTitle') : tr('steerTitle'))
      break
    case 'toggle-plan':
      void togglePlan()
      break
    case 'open-settings':
      void openSettings()
      break
    case 'close-modal':
      state.modal = undefined
      state.renameRunId = undefined
      state.renameDraft = ''
      renderModal()
      break
    case 'save-settings':
      void saveSettings()
      break
    case 'model-register': {
      const name = (document.getElementById('model-new-name') as HTMLInputElement | null)?.value.trim() ?? ''
      const provider = (document.getElementById('model-new-provider') as HTMLSelectElement | null)?.value ?? 'ollama'
      const model = (document.getElementById('model-new-model') as HTMLInputElement | null)?.value.trim() ?? ''
      if (!name || !model) {
        toast(tr('modelRequired'), 'error')
        break
      }
      const base = (document.getElementById('model-new-base') as HTMLInputElement | null)?.value.trim() ?? ''
      const key = (document.getElementById('model-new-key') as HTMLInputElement | null)?.value.trim() ?? ''
      const defaults = providerDefaults(provider)
      const limits = modelDefaults(provider, model)
      const profile: ModelProfile = {
        id: `model-${Date.now()}`,
        name,
        provider,
        model,
        ...(base || defaults.baseUrl ? { baseUrl: base || defaults.baseUrl } : {}),
        ...(key || defaults.apiKeyEnv ? { apiKeyEnv: key || defaults.apiKeyEnv } : {}),
        contextWindowTokens: limits.contextWindowTokens,
        maxOutputTokens: limits.maxOutputTokens,
      }
      state.modelProfiles = [...state.modelProfiles, profile]
      const list = document.querySelector('.model-profile-list')
      if (list) {
        list.querySelector('.panel-empty')?.remove()
        list.insertAdjacentHTML('beforeend', modelProfileRow(profile))
      }
      refreshModelProfileOptions()
      for (const id of ['model-new-name', 'model-new-model', 'model-new-base', 'model-new-key']) {
        const input = document.getElementById(id) as HTMLInputElement | null
        if (input) input.value = ''
      }
      toast(tr('modelAdded'), 'success')
      break
    }
    case 'model-delete': {
      const id = el.dataset.id
      if (!id) break
      state.modelProfiles = state.modelProfiles.filter((profile) => profile.id !== id)
      el.closest('.model-profile-row')?.remove()
      refreshModelProfileOptions()
      break
    }
    case 'reload-plugins':
      void reloadPlugins()
      break
    case 'add-plugin-file':
      void addPluginFile()
      break
    case 'open-model':
      openModel()
      break
    case 'sandbox-menu':
      openSandboxMenu()
      break
    case 'set-sandbox':
      if (el.dataset.mode) void setSandboxMode(el.dataset.mode)
      break
    case 'save-model':
      void saveModel()
      break
    case 'pick-model': {
      const input = document.getElementById('model-input') as HTMLInputElement | null
      if (input && el.dataset.model) {
        input.value = el.dataset.model
        void saveModel()
      }
      break
    }
    case 'save-title':
      if (el.dataset.runId) void saveTitle(el.dataset.runId)
      break
    case 'attach-image':
      ;(document.getElementById('image-input') as HTMLInputElement | null)?.click()
      break
    case 'insert-slash': {
      const index = Number(el.dataset.index)
      if (Number.isInteger(index)) insertSlash(index)
      break
    }
    case 'insert-mention': {
      const index = Number(el.dataset.index)
      if (Number.isInteger(index)) insertMention(index)
      break
    }
    case 'remove-attachment': {
      const index = Number(el.dataset.index)
      if (Number.isInteger(index)) {
        state.attachments.splice(index, 1)
        renderComposer()
      }
      break
    }
    case 'open-goal':
      void openGoal()
      break
    case 'open-ralph':
      openRalph()
      break
    case 'open-automation':
      void openAutomation()
      break
    case 'close-automation':
      if (state.automationTimer !== undefined) window.clearInterval(state.automationTimer)
      state.automationTimer = undefined
      state.modal = undefined
      state.automationForm = undefined
      state.automationRun = undefined
      renderModal()
      break
    case 'automation-tab':
      state.automationTab = el.dataset.tab === 'webhooks' ? 'webhooks' : 'schedules'
      state.automationForm = undefined
      state.automationRun = undefined
      renderModal()
      break
    case 'automation-new':
      newAutomationForm(el.dataset.kind === 'webhook' ? 'webhook' : 'schedule')
      break
    case 'automation-edit':
      if (el.dataset.kind && el.dataset.id) editAutomationForm(el.dataset.kind === 'webhooks' ? 'webhook' : 'schedule', el.dataset.id)
      break
    case 'automation-save':
      void saveAutomationForm()
      break
    case 'automation-cancel':
      state.automationForm = undefined
      renderModal()
      break
    case 'automation-delete':
      if (el.dataset.kind === 'schedules' || el.dataset.kind === 'webhooks') {
        const kind = el.dataset.kind
        if (el.dataset.id) void deleteAutomation(kind, el.dataset.id)
      }
      break
    case 'automation-toggle':
      if ((el.dataset.kind === 'schedules' || el.dataset.kind === 'webhooks') && el.dataset.id) {
        void toggleAutomation(el.dataset.kind, el.dataset.id, el.dataset.enabled !== '1')
      }
      break
    case 'automation-run':
      if ((el.dataset.kind === 'schedules' || el.dataset.kind === 'webhooks') && el.dataset.id) {
        void runAutomation(el.dataset.kind, el.dataset.id)
      }
      break
    case 'automation-copy':
      if (el.dataset.copy) void navigator.clipboard.writeText(el.dataset.copy).then(() => toast('Copied', 'success')).catch(() => toast('Copy failed', 'error'))
      break
    case 'open-palette':
      openPalette()
      break
    case 'palette-run':
      if (el.dataset.command) runPalette(el.dataset.command)
      break
    case 'palette-session':
      if (el.dataset.runId) {
        state.modal = undefined
        renderModal()
        void selectSession(el.dataset.runId)
      }
      break
    case 'import-source':
      if (el.dataset.source === 'claude' || el.dataset.source === 'dsh') void openImport(el.dataset.source)
      break
    case 'import-apply':
      void applyImportPlan()
      break
    case 'worktree-apply':
      if (el.dataset.name) void worktreeAction('apply', el.dataset.name)
      break
    case 'worktree-remove':
      if (el.dataset.name) void worktreeAction('remove', el.dataset.name, event.shiftKey)
      break
    case 'copy-text':
      if (el.dataset.text) void copyText(el.dataset.text).then(() => toast(tr('copied'), 'success'))
      break
    case 'diff-fold': {
      const path = el.dataset.path
      if (!path) break
      if (state.diffCollapsed.has(path)) state.diffCollapsed.delete(path)
      else state.diffCollapsed.add(path)
      rerenderDiff()
      break
    }
    case 'diff-fold-all': {
      const files = parseUnifiedDiff(state.diff).map((f) => f.path)
      if (state.diffCollapsed.size === files.length) state.diffCollapsed.clear()
      else state.diffCollapsed = new Set(files)
      rerenderDiff()
      break
    }
    case 'diff-comment': {
      const path = el.dataset.path
      const line = Number(el.dataset.line)
      const side = el.dataset.side === 'old' ? 'old' : 'new'
      if (!path || !Number.isInteger(line)) break
      state.diffEditing = { path, side, line }
      rerenderDiff()
      ;(document.getElementById('diff-comment-input') as HTMLTextAreaElement | null)?.focus()
      break
    }
    case 'diff-comment-save':
      saveDiffComment()
      break
    case 'diff-comment-cancel':
      state.diffEditing = undefined
      rerenderDiff()
      break
    case 'diff-send-comments':
      sendDiffComments()
      break
    case 'find-next':
      stepFind(false)
      break
    case 'find-prev':
      stepFind(true)
      break
    case 'find-close':
      closeFind()
      break
    case 'rewind-to':
      if (el.dataset.turn) openRewind(Number(el.dataset.turn))
      break
    case 'rewind-back':
      openRewind(undefined)
      break
    case 'rewind-confirm':
      void confirmRewind()
      break
    case 'palette-file':
      if (el.dataset.path) {
        state.modal = undefined
        renderModal()
        void openFile(el.dataset.path)
      }
      break
    case 'palette-settings':
      if (el.dataset.section) void openSettingsSection(el.dataset.section)
      break
    case 'start-ralph':
      void startRalph()
      break
    case 'cancel-ralph':
      void cancelRalph()
      break
    case 'close-ralph':
      closeRalph()
      break
    case 'open-ralph-run':
      if (el.dataset.runId) {
        closeRalph()
        void selectSession(el.dataset.runId)
      }
      break
    case 'pause-goal':
      void goalAction('pause')
      break
    case 'resume-goal':
      void goalAction('resume')
      break
    case 'clear-goal':
      void goalAction('clear')
      break
    case 'save-goal':
      void saveGoal()
      break
    case 'refresh-jobs':
      void refreshJobs()
      break
    case 'job-output':
      if (el.dataset.jobId) void loadJobOutput(el.dataset.jobId)
      break
    case 'job-kill':
      if (el.dataset.jobId) void killJob(el.dataset.jobId)
      break
    case 'open-subagent':
      if (el.dataset.subId) void openSubagent(el.dataset.subId)
      break
    case 'agent-send':
      if (el.dataset.agentId) void sendAgentMessage(el.dataset.agentId)
      break
    case 'agent-interrupt':
      if (el.dataset.agentId) void interruptAgent(el.dataset.agentId)
      break
    case 'open-deliverable':
      if (el.dataset.path) void openDeliverable(el.dataset.path)
      break
    case 'reveal-deliverable':
      if (el.dataset.path) void revealDeliverable(el.dataset.path)
      break
    case 'preview-deliverable':
      if (el.dataset.path) previewDeliverable(el.dataset.path)
      break
    case 'refresh-details':
      void loadDetails()
      break
    case 'dismiss-toast':
      if (el.dataset.toastId) {
        state.toasts = state.toasts.filter((t) => t.id !== Number(el.dataset.toastId))
        renderToasts()
      }
      break
    case 'suggest':
      if (el.dataset.prompt) {
        saveComposerDraft(el.dataset.prompt)
        renderComposer(true)
        focusComposer()
      }
      break
    case 'answer-question': {
      // handled by the form submit listener
      break
    }
    default:
      break
  }
}

function onDocumentSubmit(event: Event): void {
  const form = event.target as HTMLFormElement
  if (form.id === 'composer-form') {
    onSubmit(event)
    return
  }
  if (form.id === 'browser-form') {
    event.preventDefault()
    goBrowser()
    return
  }
  if (form.id === 'terminal-form') {
    event.preventDefault()
    void runTerminal()
    return
  }
  if (form.classList.contains('root-form')) {
    event.preventDefault()
    const input = document.getElementById('root-path') as HTMLInputElement | null
    const writable = (document.getElementById('root-writable') as HTMLInputElement | null)?.checked === true
    if (input?.value.trim()) void addWorkspaceRoot(input.value.trim(), writable)
    return
  }
  if (form.classList.contains('question-form')) {
    event.preventDefault()
    const requestId = form.dataset.requestId
    const input = form.querySelector<HTMLInputElement>('input[name="answer"]')
    if (requestId && input) void answerQuestion(requestId, input.value)
    return
  }
}

let lastEscapeAt = 0

/** CP-34: approval keys. Returns true when the key was used. */
function approvalKey(event: KeyboardEvent, target: HTMLElement): boolean {
  // Alt+Y / Alt+S / Alt+A / Alt+N decide the newest pending approval from anywhere.
  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    const pending = [...state.entries].reverse().find((e) => e.kind === 'approval' && !e.decision)
    const key = event.key.toLowerCase()
    if (!pending || pending.kind !== 'approval' || !['y', 's', 'a', 'n'].includes(key)) return false
    const card = document.querySelector<HTMLElement>(`.approval-card[data-approval-id="${CSS.escape(pending.requestId)}"]`)
    if (key === 'n') {
      event.preventDefault()
      void approve(pending.requestId, false)
      return true
    }
    const scope = key === 'y' ? 'once' : key === 's' ? 'session' : 'always'
    if (card && !card.querySelector(`[data-scope="${scope}"]`)) return false
    event.preventDefault()
    void approve(pending.requestId, true, scope)
    return true
  }
  if (event.ctrlKey || event.metaKey) return false
  if (target instanceof HTMLInputElement && target.dataset.approvalReason) {
    if (event.key !== 'Enter') return false
    event.preventDefault()
    void approve(target.dataset.approvalReason, false)
    return true
  }
  const card = target.closest<HTMLElement>('.approval-card[data-approval-id]')
  if (!card || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return false
  const requestId = card.dataset.approvalId!
  const key = event.key.toLowerCase()
  const scope = key === 'y' ? 'once' : key === 's' ? 'session' : key === 'a' ? 'always' : undefined
  if (scope) {
    if (!card.querySelector(`[data-scope="${scope}"]`)) return false
    event.preventDefault()
    void approve(requestId, true, scope)
    return true
  }
  if (key === 'n') {
    event.preventDefault()
    void approve(requestId, false)
    return true
  }
  return false
}

function onDocumentKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement
  if (approvalKey(event, target)) return
  // CP-36: Vim-style editing in the composer when enabled in Settings.
  if (state.prefs.vimMode && target instanceof HTMLTextAreaElement && target.id === 'composer-input' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
    const insertWithMenu = state.vim.mode === 'insert' && mentionCount() > 0
    if (!insertWithMenu) {
      const result = vimKey(state.vim, event.key, { text: target.value, cursor: target.selectionStart ?? target.value.length })
      const modeChanged = result.state.mode !== state.vim.mode
      state.vim = result.state
      if (result.handled) {
        event.preventDefault()
        if (result.edit.text !== target.value) {
          target.value = result.edit.text
          saveComposerDraft(target.value)
        }
        // A one-character selection stands in for the block cursor in normal mode.
        target.setSelectionRange(result.edit.cursor, state.vim.mode === 'normal' ? Math.min(result.edit.text.length, result.edit.cursor + 1) : result.edit.cursor)
        target.classList.toggle('vim-normal', state.vim.mode === 'normal')
        if (modeChanged) {
          const meter = document.querySelector('.context-meter')
          if (meter) meter.innerHTML = statuslineHtml(currentState())
        }
        return
      }
    }
  }
  // CP-33: the find bar. Enter / F3 next, Shift+Enter / Shift+F3 previous, Esc closes.
  if (target instanceof HTMLInputElement && target.id === 'find-input') {
    if (event.key === 'Enter' || event.key === 'F3') {
      event.preventDefault()
      stepFind(event.shiftKey)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeFind()
      return
    }
  }
  if (event.key === 'F3') {
    event.preventDefault()
    if (state.findOpen && state.findHits.length > 0) stepFind(event.shiftKey)
    else openFind()
    return
  }
  // CP-33: Esc Esc (no dialog, nothing to dismiss) opens the rewind picker.
  if (event.key === 'Escape' && !state.modal && mentionCount() === 0 && !state.findOpen) {
    const now = Date.now()
    if (now - lastEscapeAt < 600) {
      lastEscapeAt = 0
      if (currentRunId()) openRewind()
      return
    }
    lastEscapeAt = now
  }
  // WP-61: a focused shortcut input records the next chord instead of running it.
  if (target instanceof HTMLInputElement && target.dataset.shortcut) {
    event.preventDefault()
    if (event.key === 'Escape' || event.key === 'Tab') return
    const chord = normalizeAccelerator(chordFromEvent(event))
    if (!chord) return
    const actionId = target.dataset.shortcut
    state.shortcuts[actionId] = chord
    localStorage.setItem('hy-shortcuts', JSON.stringify(state.shortcuts))
    void savePrefs({ shortcuts: { ...state.shortcuts } })
    renderModal()
    return
  }
  // Shortcuts fire anywhere except while typing plain text; chords with a
  // modifier still work inside the composer (swap a chat mid-draft).
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable
  const actionId = shortcutActionFor(event)
  if (actionId) {
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey
    if (!(typing && plain)) {
      event.preventDefault()
      runShortcut(actionId)
      return
    }
  }
  if (target instanceof HTMLTextAreaElement && target.id === 'composer-input' && mentionCount() > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      state.mentionIndex = (state.mentionIndex + 1) % mentionCount()
      renderMentionMenu()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      state.mentionIndex = (state.mentionIndex - 1 + mentionCount()) % mentionCount()
      renderMentionMenu()
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      if (state.slashItems.length > 0) insertSlash(state.mentionIndex, event.key === 'Tab')
      else insertMention(state.mentionIndex)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      state.slashItems = []
      state.mentions = []
      state.mentionSessions = []
      state.mentionSkills = []
      renderMentionMenu()
      return
    }
  }
  if (event.key === 'Enter' && target instanceof HTMLInputElement && target.id === 'rename-input') {
    // The dialog is a single field, so Enter saves it like the Save button.
    event.preventDefault()
    if (state.renameRunId) void saveTitle(state.renameRunId)
    return
  }
  if (event.key === 'Escape') {
    if (state.modal) {
      if (state.automationTimer !== undefined) window.clearInterval(state.automationTimer)
      state.automationTimer = undefined
      state.modal = undefined
      state.automationForm = undefined
      state.automationRun = undefined
      renderModal()
      return
    }
  }
  const modifier = event.ctrlKey || event.metaKey
  if (modifier && event.key.toLowerCase() === 'n') {
    event.preventDefault()
    void newSession()
    return
  }
  if (modifier && event.key.toLowerCase() === 'b') {
    event.preventDefault()
    state.sidebarOpen = !state.sidebarOpen
    applyShellState()
    return
  }
  if (modifier && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    openPalette()
    return
  }
  if (target instanceof HTMLInputElement && target.id === 'palette-input' && event.key === 'Enter') {
    event.preventDefault()
    const first = document.querySelector<HTMLElement>('.palette-row')
    first?.click()
    return
  }
  if (target instanceof HTMLTextAreaElement && target.id === 'composer-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    target.closest('form')?.requestSubmit()
  }
}

async function init(): Promise<void> {
  applyTheme()
  applyFonts()
  // WP-64: the sidebar shows relative times, so refresh it once a minute even
  // when nothing else happens. The interval is unref'd in the browser context
  // by construction (the page owns it), and a hidden tab still wakes on focus.
  window.setInterval(() => {
    if (document.visibilityState === 'visible') renderSidebarSessions()
  }, 60_000)
  // WP-61: `system` follows the OS while the app is open.
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.theme === 'system') applyTheme()
    })
  } catch {
    // An old engine without matchMedia keeps the light theme.
  }
  // CP-36: Settings › Appearance preferences are saved as they change.
  document.addEventListener('change', (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return
    if (target.dataset.prefStatus !== undefined) {
      const picked = STATUS_ITEMS.filter((item) => document.querySelector<HTMLInputElement>(`[data-pref-status="${item}"]`)?.checked)
      void savePrefs({ statusline: [...picked] })
    } else if (target.dataset.pref === 'codeTheme' && target instanceof HTMLSelectElement) {
      void savePrefs({ codeTheme: target.value as typeof state.prefs.codeTheme })
    } else if (target.dataset.pref === 'vimMode' && target instanceof HTMLInputElement) {
      void savePrefs({ vimMode: target.checked })
    }
  })
  document.addEventListener('pointerdown', (event) => {
    const target = event.target
    const backdrop = target instanceof Element ? target.closest<HTMLElement>('.modal-backdrop') : null
    modalBackdropPointerDown = backdrop !== null && target === backdrop
  }, true)
  document.addEventListener('focusin', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement) || target.id !== 'composer-input') return
    // A blank chat is already open when the user starts typing into it. Treating
    // that focus as "open a chat" rebuilt the composer under the caret on every
    // keystroke, which erased the text and made the input flicker.
    const start = shouldStartSessionOnFocus({
      hasCurrentSession: state.current !== undefined,
      freshChat: state.freshChat,
      startingSession,
    })
    if (!start) return
    startingSession = true
    void newSession().finally(() => {
      startingSession = false
      document.getElementById('composer-input')?.focus()
    })
  })
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('submit', onDocumentSubmit)
  document.addEventListener('keydown', onDocumentKeydown)
  window.addEventListener('resize', () => {
    try {
      state.ptyFit?.fit()
    } catch {
      // The terminal panel is not visible.
    }
  })
  try {
    const boot = await api<Bootstrap>('/api/bootstrap')
    state.boot = boot
    state.sessions = boot.sessions
    state.orchestration = boot.orchestration
    state.roots = boot.workspace.roots ?? boot.config.roots ?? []
    if (!state.roots.some((root) => root.id === state.fileRoot)) state.fileRoot = 'main'
    state.connection = 'online'
    renderShell()
    await loadPrefs()
    connectGlobal()
    // WP-53: a fresh install starts with the three-step wizard.
    if (boot.onboarding && !boot.onboarding.complete) openOnboarding()
    const preferred = boot.orchestration?.active?.orchestratorRunId ?? boot.sessions[0]?.runId
    if (preferred) await selectSession(preferred)
    else await newSession()
    if (window.hyDesktop) {
      window.hyDesktop.onMenu((action) => {
        if (action === 'new-session') void newSession()
        else if (action === 'settings') void openSettings()
        else if (action === 'toggle-sidebar') {
          state.sidebarOpen = !state.sidebarOpen
          applyShellState()
        } else if (action === 'refresh') window.location.reload()
      })
    }
  } catch (error) {
    const app = document.getElementById('app')
    if (app) {
      app.innerHTML = `<div class="auth-screen"><div class="auth-card"><div class="brand-mark">HY</div><h1>HY-HARNESS</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p><p class="muted">Open the URL printed by <code>hy web</code> or start the desktop app.</p></div></div>`
    }
  }
}

// The desktop screenshot/demo harness and native menu use this narrow hook.
;(window as unknown as { hySelectSession?: (runId: string) => void }).hySelectSession = (runId: string) => {
  void selectSession(runId)
}

void init()
