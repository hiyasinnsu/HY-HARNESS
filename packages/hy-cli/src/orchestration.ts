// Orchestration state for the A+ mode (one workspace, path scopes).
//
// The orchestrator and every worker are ordinary sessions. This module keeps
// only the hierarchy and the safety rules that sit above them: one active
// orchestrator, non-overlapping worker scopes, worker status and the last
// report. The web server owns the side effects (turns, approvals, SSE).
import fs from 'node:fs'
import path from 'node:path'

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

export interface WorkerRecord {
  runId: string
  title: string
  task: string
  /** Repository-relative directories. A worker may edit only below these. */
  scope: string[]
  status: WorkerStatus
  createdAt: number
  updatedAt: number
  /** Last agent event; the heartbeat uses it to spot a stalled worker. */
  lastEventAt: number
  lastHeartbeatAt?: number
  lastSummary?: string
  lastError?: string
  /** Machine-readable status from the worker's final report. */
  lastReportStatus?: WorkerReportStatus | undefined
  /** One-line reason from BLOCKED_BY, or the approval that stopped the turn. */
  blocker?: string | undefined
  closedAt?: number
  /** Closing releases ownership, not the conversation or its cached history. */
  pendingMessages?: { id: string; text: string; createdAt: number }[]
  lastInstruction?: { id: string; receivedAt: number; appliedAt?: number }
  briefRevision?: number
}

export interface ProjectBrief {
  revision: number
  objective: string
  successCriteria: string
  constraints: string
  decisions: string
  evidence: string
}

export interface OrchestrationRecord {
  id: string
  orchestratorRunId: string
  status: 'active' | 'stopped'
  createdAt: number
  updatedAt: number
  maxWorkers: number
  workers: WorkerRecord[]
  brief?: ProjectBrief
  /** Durable report queue; remove only after its control turn completes. */
  inbox?: { id: string; text: string; interrupt?: boolean }[]
  directScope?: string[]
  /**
   * USD reserved for turns that are running right now. It is released when
   * each turn settles, so a stuck turn cannot block the orchestration for
   * good; it is not a record of what was spent.
   */
  reservedCostUsd?: number
  /** USD already spent by finished turns of this orchestration (0 when unset). */
  spentCostUsd?: number
}

export interface OrchestrationState {
  version: 1
  active: OrchestrationRecord | null
}

export interface OrchestrationView {
  active: OrchestrationRecord | null
}

/** Workers that may run at once by default; the host also caps stored values. */
export const DEFAULT_MAX_WORKERS = 5
/** Upper bound for a persisted maxWorkers value (guards a hand-edited state file). */
export const MAX_WORKERS_CEILING = 6

export const EMPTY_ORCHESTRATION: OrchestrationState = { version: 1, active: null }

export function loadOrchestrationState(file: string): OrchestrationState {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  } catch {
    return { version: 1, active: null }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: 1, active: null }
  const raw = parsed as { version?: unknown; active?: unknown }
  if (raw.version !== 1 || !raw.active || typeof raw.active !== 'object' || Array.isArray(raw.active)) {
    return { version: 1, active: null }
  }
  const a = raw.active as Record<string, unknown>
  if (
    typeof a.id !== 'string' ||
    typeof a.orchestratorRunId !== 'string' ||
    (a.status !== 'active' && a.status !== 'stopped') ||
    !Array.isArray(a.workers)
  ) {
    return { version: 1, active: null }
  }
  const workers = a.workers
    .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object' && !Array.isArray(w))
    .map((w) => sanitizeWorker(w))
    .filter((w): w is WorkerRecord => w !== undefined)
  return {
    version: 1,
    active: {
      id: a.id,
      orchestratorRunId: a.orchestratorRunId,
      status: a.status,
      createdAt: typeof a.createdAt === 'number' ? a.createdAt : Date.now(),
      updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : Date.now(),
      maxWorkers: typeof a.maxWorkers === 'number' ? Math.max(1, Math.min(MAX_WORKERS_CEILING, Math.floor(a.maxWorkers))) : DEFAULT_MAX_WORKERS,
      workers,
      // Files written before the split carry the cumulative spend in
      // `reservedCostUsd` and nothing is running across an upgrade, so that
      // value becomes the spend and the reservation starts empty (counting it
      // as both would reserve the same dollars twice).
      ...(typeof a.spentCostUsd === 'number' && Number.isFinite(a.spentCostUsd) && a.spentCostUsd >= 0
        ? {
            spentCostUsd: a.spentCostUsd,
            ...(typeof a.reservedCostUsd === 'number' && Number.isFinite(a.reservedCostUsd) && a.reservedCostUsd >= 0
              ? { reservedCostUsd: a.reservedCostUsd }
              : {}),
          }
        : typeof a.reservedCostUsd === 'number' && Number.isFinite(a.reservedCostUsd) && a.reservedCostUsd >= 0
          ? { spentCostUsd: a.reservedCostUsd, reservedCostUsd: 0 }
          : {}),
      ...(validBrief(a.brief) ? { brief: a.brief } : {}),
      ...(Array.isArray(a.inbox) ? { inbox: a.inbox.filter((v): v is NonNullable<OrchestrationRecord['inbox']>[number] => !!v && typeof v.id === 'string' && typeof v.text === 'string') } : {}),
    },
  }
}

function validBrief(value: unknown): value is ProjectBrief {
  if (!value || typeof value !== 'object') return false
  const b = value as Record<string, unknown>
  return Number.isSafeInteger(b.revision) && Number(b.revision) >= 1 &&
    ['objective', 'successCriteria', 'constraints', 'decisions', 'evidence'].every((key) => typeof b[key] === 'string')
}

export function renderProjectBrief(record: OrchestrationRecord | undefined): string {
  const b = record?.brief
  return b ? `[project brief revision ${b.revision}]\nObjective: ${b.objective}\nSuccess: ${b.successCriteria}\nConstraints: ${b.constraints}\nDecisions: ${b.decisions}\nEvidence: ${b.evidence}\n[/project brief]` : record ? '[project brief revision 0]\nNo shared brief has been recorded yet.\n[/project brief]' : ''
}

/** Shared by fresh workers, resumed workers and the orchestrator's direct edits. */
export function assertScopeAvailable(record: OrchestrationRecord, scope: readonly string[], workerId?: string): void {
  const owners = scopeOwners(record).filter((worker) => worker.runId !== workerId)
  for (const next of scope) {
    for (const owner of owners) {
      const current = owner.scope.find((held) => scopesOverlap(next, held))
      if (current) throw new Error(`scope ${next} overlaps ${current} owned by ${owner.title} (${owner.runId}); continue that worker or review and release its scope first`)
    }
    if (record.directScope?.some((held) => scopesOverlap(next, held))) {
      throw new Error(`scope ${next} is owned by the orchestrator; release it before delegating`)
    }
  }
}

export const WORKER_REPORT_MISSING =
  'Worker report is missing a valid STATUS line. Request the remaining work, verification and a complete report.'

function sanitizeWorker(raw: Record<string, unknown>): WorkerRecord | undefined {
  if (
    typeof raw.runId !== 'string' ||
    typeof raw.title !== 'string' ||
    typeof raw.task !== 'string' ||
    !Array.isArray(raw.scope)
  ) {
    return undefined
  }
  const legacyMissingReport = raw.status === 'waiting' && raw.lastReportStatus === undefined
  const legacyReport = legacyMissingReport && typeof raw.lastSummary === 'string' ? parseWorkerReport(raw.lastSummary) : undefined
  const status = legacyMissingReport ? legacyReport?.status === 'done' ? 'waiting' : legacyReport?.status ?? 'partial' : raw.status
  const allowed: readonly WorkerStatus[] = [
    'queued',
    'running',
    'waiting',
    'partial',
    'blocked',
    'failed',
    'stopped',
    'interrupted',
    'done',
  ]
  const reportStatus = raw.lastReportStatus ?? legacyReport?.status
  const blocker = legacyMissingReport && !legacyReport ? WORKER_REPORT_MISSING : raw.blocker ?? legacyReport?.reason
  const allowedReports: readonly WorkerReportStatus[] = ['done', 'partial', 'blocked']
  return {
    runId: raw.runId,
    title: raw.title,
    task: raw.task,
    scope: raw.scope.filter((s): s is string => typeof s === 'string' && s.trim().length > 0),
    status: typeof status === 'string' && (allowed as readonly string[]).includes(status) ? (status as WorkerStatus) : 'interrupted',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    lastEventAt: typeof raw.lastEventAt === 'number' ? raw.lastEventAt : Date.now(),
    ...(typeof raw.lastHeartbeatAt === 'number' ? { lastHeartbeatAt: raw.lastHeartbeatAt } : {}),
    ...(typeof raw.lastSummary === 'string' ? { lastSummary: raw.lastSummary } : {}),
    ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError } : {}),
    ...(typeof reportStatus === 'string' && (allowedReports as readonly string[]).includes(reportStatus)
      ? { lastReportStatus: reportStatus as WorkerReportStatus }
      : {}),
    ...(typeof blocker === 'string' && blocker.trim() ? { blocker: blocker.trim().slice(0, 4_000) } : {}),
    ...(typeof raw.closedAt === 'number' ? { closedAt: raw.closedAt } : {}),
    ...(Number.isSafeInteger(raw.briefRevision) && Number(raw.briefRevision) >= 0 ? { briefRevision: Number(raw.briefRevision) } : {}),
    ...(Array.isArray(raw.pendingMessages) ? {
      pendingMessages: raw.pendingMessages.filter((m): m is { id: string; text: string; createdAt: number } =>
        !!m && typeof m === 'object' && typeof m.id === 'string' && typeof m.text === 'string' && typeof m.createdAt === 'number'),
    } : {}),
    ...(raw.lastInstruction && typeof raw.lastInstruction === 'object' && typeof (raw.lastInstruction as Record<string, unknown>).id === 'string' && typeof (raw.lastInstruction as Record<string, unknown>).receivedAt === 'number'
      ? { lastInstruction: raw.lastInstruction as NonNullable<WorkerRecord['lastInstruction']> } : {}),
  }
}

export function saveOrchestrationState(file: string, state: OrchestrationState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/** Normalizes a repository-relative scope, rejecting escapes and broad roots. */
export function normalizeScope(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/')
  const file = trimmed.startsWith('file:')
  const rawValue = file ? trimmed.slice(5) : trimmed
  if (file && rawValue.endsWith('/')) {
    throw new Error(`file scope must name one file, not a directory: ${raw}`)
  }
  const value = rawValue.replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (!value || value === '.' || value === '**' || value === '/') {
    throw new Error(
      file
        ? 'file scope must name one file below the workspace'
        : 'scope must name a directory below the workspace, not the whole workspace',
    )
  }
  if (path.posix.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new Error(`scope must be relative to the workspace: ${raw}`)
  }
  const parts = value.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`scope contains an invalid segment: ${raw}`)
  }
  const normalized = parts.join('/')
  return file ? `file:${normalized}` : normalized
}

export function normalizeScopes(raw: readonly string[]): string[] {
  const scopes = [...new Set(raw.map(normalizeScope))]
  if (scopes.length === 0) throw new Error('at least one scope is required')
  return scopes
}

/** True when two directory/file scopes overlap. A `file:` scope owns one path. */
export function scopesOverlap(a: string, b: string): boolean {
  const file = (scope: string) => scope.startsWith('file:')
  const pathOf = (scope: string) => {
    const value = (file(scope) ? scope.slice(5) : scope).replace(/\/+$/, '')
    return process.platform === 'win32' ? value.toLowerCase() : value
  }
  const af = file(a)
  const bf = file(b)
  if (af && bf) return pathOf(a) === pathOf(b)
  if (af) return pathOf(a) === pathOf(b) || pathOf(a).startsWith(`${pathOf(b)}/`)
  if (bf) return pathOf(b) === pathOf(a) || pathOf(b).startsWith(`${pathOf(a)}/`)
  const x = pathOf(a)
  const y = pathOf(b)
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

export function workerOwnsScope(worker: WorkerRecord, rel: string): boolean {
  if (!workerHoldsScope(worker)) return false
  return worker.scope.some((scope) => scopesOverlap(scope, `file:${rel.replace(/\\/g, '/').replace(/^\/+/, '')}`))
}

/** True while the worker still reserves its scope. Only closing releases it. */
export function workerHoldsScope(worker: WorkerRecord): boolean {
  return worker.status !== 'done'
}

/** Workers that still reserve their scope. Stopped workers stay reserved until closed. */
export function scopeOwners(record: OrchestrationRecord): WorkerRecord[] {
  return record.workers.filter(workerHoldsScope)
}

export function activeWorkerCount(record: OrchestrationRecord): number {
  return record.workers.filter(workerHoldsScope).length
}

/**
 * A worker that finished its turn with `STATUS: done` and has not been closed.
 * Its scope is still reserved, so the orchestrator must either review and
 * close it or send the next step. Leaving it invisible strands the scope.
 */
export function workerAwaitingReview(worker: WorkerRecord): boolean {
  return worker.status === 'waiting'
}

/**
 * A restart cannot leave a worker turn running. Mark every running/queued
 * worker as interrupted so the orchestrator sees it and reviews or closes it;
 * otherwise the UI shows a live "running" worker no process is executing and
 * its scope stays blocked forever.
 */
export function markStaleWorkersInterrupted(record: OrchestrationRecord, now = Date.now()): boolean {
  let changed = false
  for (const worker of record.workers) {
    if (worker.status !== 'running' && worker.status !== 'queued') continue
    worker.status = 'interrupted'
    worker.lastError = 'the app restarted while this worker was running'
    worker.updatedAt = now
    worker.lastEventAt = now
    changed = true
  }
  if (changed) record.updatedAt = now
  return changed
}

/** True when a new worker may start; a closed worker releases its slot. */
export function canSpawnWorker(record: OrchestrationRecord): boolean {
  return activeWorkerCount(record) < record.maxWorkers
}

/**
 * Parses the machine-readable status lines required by the worker prompt.
 */
export function parseWorkerReport(text: string): { status: WorkerReportStatus; reason?: string } | undefined {
  const status = /^[ \t]*(?:\*\*)?STATUS(?:\*\*)?[ \t]*:[ \t]*(?:\*\*)?[ \t]*(done|partial|blocked)(?:\*\*)?[ \t]*$/im.exec(text)
  if (!status) return undefined
  const reason = /^\s*(?:\*\*)?BLOCKED_BY(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$/im.exec(text)?.[1]?.replace(/\*\*$/, '').trim()
  return {
    status: status[1]!.toLowerCase() as WorkerReportStatus,
    ...(reason ? { reason: reason.slice(0, 1_000) } : {}),
  }
}

/** True when a worker's state must be surfaced before the task is called complete. */
export function workerNeedsAttention(status: WorkerStatus): boolean {
  return status === 'blocked' || status === 'partial' || status === 'failed' || status === 'interrupted'
}

export function workerStatusLabel(status: WorkerStatus): string {
  switch (status) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'waiting':
      return 'waiting for review'
    case 'partial':
      return 'partially done'
    case 'blocked':
      return 'blocked'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'stopped'
    case 'interrupted':
      return 'interrupted by restart'
    case 'done':
      return 'done'
  }
}
