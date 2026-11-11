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

/**
 * D2: what the user can do about a turn that ended with an error, one line.
 * Undefined when the cause gives no better advice than the message itself.
 */
export function turnErrorHint(cause: { kind: TurnEndCause; detail?: string }): string | undefined {
  switch (cause.kind) {
    case 'budget':
      return 'The cost or token budget is spent. Raise budget limits in config.json or start a new chat; work so far is kept.'
    case 'guardian':
      return 'Guardian denied several commands in a row. Review the denied commands, then approve or adjust the policy before retrying.'
    case 'context-overflow':
      return 'The conversation no longer fits the model. Compact it (/compact) or set the model\'s real context window in its models[] entry.'
    case 'exec-daemon':
      return 'The command runner (hy-exec-server) stopped. Restart the app; if it repeats, run `hy doctor`.'
    case 'provider': {
      const status = Number(/\d+/.exec(cause.detail ?? '')?.[0])
      if (status === 401 || status === 403) return 'The provider rejected the credentials. Check the API key for this model\'s role.'
      if (status === 402) return 'The provider account has no credit left. Top it up or switch models.'
      if (status === 404) return 'The provider does not know this model or path. Check the model name and base URL (`hy models discover` lists what it offers).'
      if (status === 429) return 'The provider is rate limiting. Wait a moment, or run fewer workers at once.'
      if (status >= 500) return 'The provider failed on its side. Retry shortly or switch models.'
      return undefined
    }
    default:
      return undefined
  }
}
