/**
 * WP-60: forking a chat (DSH's `dsh-session` fork).
 *
 * A fork copies the chosen run's events into a new run in the same log: the
 * history is rebuilt from them by `Conversation`, so the new chat continues
 * from the same point without touching the original. The copy keeps the
 * original timestamps (the transcript stays truthful) and gets a fresh
 * `sessionId`/`seq` from `SessionLog.importEvents`.
 */
import type { SessionEvent } from '../../core/dist/index.js'

export class ForkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForkError'
  }
}

export interface ForkCopy {
  ts: number
  type: string
  payload: unknown
  runId: string
  round?: number
}

export interface ForkPlan {
  events: ForkCopy[]
  /** The fork point: the last copied source seq (0 for an empty source). */
  upToSeq: number
  /** Turns the copy contains (after undos). */
  turns: number
  /** Subagent runs that were deliberately not copied. */
  skippedSubagents: number
}

/** The events of one run that a fork may copy, in log order. */
export function sourceEvents(events: readonly SessionEvent[], sourceRunId: string): SessionEvent[] {
  return events.filter(
    (event) => event.runId === sourceRunId && event.type !== 'session/format' && !event.runId.includes('.sub'),
  )
}

/**
 * Plans a copy of `sourceRunId` up to (and including) `upToSeq`.
 *
 * Without `upToSeq` the whole run is copied, which is the "branch and try
 * another approach" case. A cut that lands before the run's first event is an
 * error rather than a silently empty fork.
 */
export function planFork(
  events: readonly SessionEvent[],
  sourceRunId: string,
  newRunId: string,
  options: { upToSeq?: number } = {},
): ForkPlan {
  const all = sourceEvents(events, sourceRunId)
  if (all.length === 0) throw new ForkError(`run ${sourceRunId} has no events to fork`)
  const copied = options.upToSeq === undefined ? all : all.filter((event) => event.seq <= options.upToSeq!)
  if (copied.length === 0) {
    throw new ForkError(`upToSeq ${options.upToSeq} is before the first event of ${sourceRunId}`)
  }
  let turns = 0
  for (const event of copied) {
    if (event.type === 'turn/start' || event.type === 'round/start') turns += 1
    if (event.type === 'turn/undo') turns -= 1
  }
  return {
    events: copied.map((event) => ({
      ts: event.ts,
      type: event.type,
      payload: event.payload,
      runId: newRunId,
      ...(event.round !== undefined ? { round: event.round } : {}),
    })),
    upToSeq: copied[copied.length - 1]!.seq,
    turns: Math.max(0, turns),
    skippedSubagents: new Set(
      events.filter((event) => event.runId?.startsWith(`${sourceRunId}.sub`)).map((event) => event.runId!),
    ).size,
  }
}
