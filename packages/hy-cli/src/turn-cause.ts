// C2: one word for why a turn ended without completing, kept in the session
// log (`turn/error.cause`). Before this the log only said "aborted" or "error",
// and a goal that paused mid-run could not be told apart from a user cancel, a
// spent budget or a provider failure.

export type TurnEndCause =
  | 'user-cancel'
  | 'orchestration-stopped'
  | 'worker-stopped'
  | 'worker-closed'
  | 'chat-deleted'
  | 'server-shutdown'
  | 'aborted'
  | 'budget'
  | 'guardian'
  | 'provider'
  | 'context-overflow'
  | 'exec-daemon'
  | 'error'

const ABORT_REASONS = new Set(['user-cancel', 'orchestration-stopped', 'worker-stopped', 'worker-closed', 'chat-deleted', 'server-shutdown'])

/**
 * `abortReason` is what the code that aborted the turn recorded (only passed
 * when the turn's signal was aborted); otherwise the error decides.
 */
export function turnEndCause(error: unknown, abortReason?: string): { kind: TurnEndCause; detail?: string } {
  if (abortReason !== undefined) return { kind: ABORT_REASONS.has(abortReason) ? abortReason as TurnEndCause : 'aborted' }
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'BudgetExhaustedError') {
    const dimension = (error as { dimension?: unknown }).dimension
    return { kind: 'budget', ...(typeof dimension === 'string' ? { detail: dimension } : {}) }
  }
  if (name === 'TooManyDenialsError') return { kind: 'guardian' }
  if (name === 'ExecRpcError' || /hy-exec-server|exec daemon/i.test(message)) return { kind: 'exec-daemon' }
  if (name === 'LlmError') {
    const status = (error as { status?: unknown }).status
    if (/context|too long|maximum.*tokens|token limit/i.test(message) && status === 400) return { kind: 'context-overflow' }
    return { kind: 'provider', ...(typeof status === 'number' ? { detail: `HTTP ${status}` } : {}) }
  }
  if (name === 'AbortRunError' || name === 'RoundAbortedError') return { kind: 'aborted' }
  return { kind: 'error' }
}
