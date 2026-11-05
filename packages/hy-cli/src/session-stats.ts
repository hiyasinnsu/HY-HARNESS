/**
 * WP-60: per-session timing (DSH's `dsh-session-stats`).
 *
 * What can honestly be measured from the agent's event stream:
 *
 * - `llmMs`: step start → step end (the provider call).
 * - `toolMs`: tool start → tool result.
 * - `firstResponseMs`: turn start → the first step end ("time to the first
 *   answer"). DSH reports TTFT; the providers here do not expose token
 *   timestamps, so a first-answer latency is what we can defend.
 * - `lastTurnMs`: the wall time of the turn that just finished.
 *
 * The live numbers are written once per turn as a `session/stats` snapshot, so
 * they survive a restart; `statsFromEvents` takes the newest snapshot and only
 * counts what the log itself proves when an older log has no snapshot.
 */
import type { SessionEvent } from '../../core/dist/index.js'

export interface ToolStats {
  calls: number
  errors: number
  ms: number
}

export interface SessionStats {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  /** Wall time of the last completed turn. */
  lastTurnMs: number
  /** Turn start → the first step's end. */
  firstResponseMs: number
  tools: Record<string, ToolStats>
}

export interface StatsClock {
  /** Set when the agent reports `step-start`. */
  stepStart?: number | undefined
  /** Set when a turn starts (or at its first event). */
  turnStart?: number | undefined
  /** The first `step-end` of the current turn. */
  firstStepEnd?: number | undefined
  /** `tool-start` timestamps by call id. */
  toolStarts: Map<string, number>
}

export function emptyStats(): SessionStats {
  return { turns: 0, steps: 0, llmMs: 0, toolMs: 0, lastTurnMs: 0, firstResponseMs: 0, tools: {} }
}

export function emptyClock(): StatsClock {
  return { toolStarts: new Map() }
}

/** A shallow copy with the tools sorted, for the API and the GUI. */
export function statsView(stats: SessionStats): SessionStats {
  return {
    ...stats,
    tools: Object.fromEntries(Object.entries(stats.tools).sort(([a], [b]) => a.localeCompare(b))),
  }
}

function isStats(value: unknown): value is SessionStats {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.turns === 'number' &&
    typeof record.steps === 'number' &&
    typeof record.llmMs === 'number' &&
    typeof record.toolMs === 'number' &&
    typeof record.tools === 'object' &&
    record.tools !== null &&
    !Array.isArray(record.tools)
  )
}

/** Counts the calls the log itself proves (a call always writes a result). */
export function countToolResults(stats: SessionStats, events: readonly SessionEvent[]): SessionStats {
  const tools: Record<string, ToolStats> = { ...stats.tools }
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const payload = event.payload as { name?: unknown; isError?: unknown } | undefined
    const name = typeof payload?.name === 'string' && payload.name ? payload.name : 'unknown'
    const current = tools[name] ?? { calls: 0, errors: 0, ms: 0 }
    tools[name] = {
      ...current,
      calls: current.calls + 1,
      errors: current.errors + (payload?.isError === true ? 1 : 0),
    }
  }
  return { ...stats, tools }
}

/**
 * The stats of a session from its log: the newest `session/stats` snapshot plus
 * any tool result the log recorded after it.
 */
export function statsFromEvents(events: readonly SessionEvent[]): SessionStats {
  let snapshot: SessionStats | undefined
  let snapshotIndex = -1
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!
    if (event.type === 'session/stats' && isStats(event.payload)) {
      snapshot = event.payload
      snapshotIndex = index
    }
  }
  if (snapshot) {
    // The snapshot already counts its own turn; only later results add calls.
    return countToolResults(snapshot, events.slice(snapshotIndex + 1))
  }
  // A log without snapshots still knows its turns, steps and tool calls.
  let turns = 0
  let steps = 0
  for (const event of events) {
    if (event.type === 'turn/start' || event.type === 'round/start') turns += 1
    if (event.type === 'turn/undo') turns -= 1
    if (event.type === 'step/end') steps += 1
  }
  return { ...countToolResults(emptyStats(), events), turns: Math.max(0, turns), steps }
}

/**
 * Folds one live agent event into the running totals. The clock keeps the
 * moment a step or a tool started, because the agent's events carry no time.
 */
export function applyAgentEvent(
  stats: SessionStats,
  clock: StatsClock,
  event: { type: string; callId?: unknown; name?: unknown },
  now: number,
): SessionStats {
  const callId = typeof event.callId === 'string' ? event.callId : ''
  const name = typeof event.name === 'string' && event.name ? event.name : 'unknown'
  switch (event.type) {
    case 'step-start':
      clock.turnStart ??= now
      clock.stepStart = now
      return stats
    case 'step-end': {
      clock.turnStart ??= now
      const elapsed = clock.stepStart === undefined ? 0 : Math.max(0, now - clock.stepStart)
      clock.firstStepEnd ??= now
      return { ...stats, steps: stats.steps + 1, llmMs: stats.llmMs + elapsed }
    }
    case 'tool-start':
      clock.toolStarts.set(callId, now)
      return stats
    case 'tool':
    case 'tool-error': {
      const started = clock.toolStarts.get(callId)
      if (callId) clock.toolStarts.delete(callId)
      const elapsed = started === undefined ? 0 : Math.max(0, now - started)
      const current = stats.tools[name] ?? { calls: 0, errors: 0, ms: 0 }
      return {
        ...stats,
        toolMs: stats.toolMs + elapsed,
        tools: {
          ...stats.tools,
          [name]: {
            calls: current.calls + 1,
            errors: current.errors + (event.type === 'tool-error' ? 1 : 0),
            ms: current.ms + elapsed,
          },
        },
      }
    }
    default:
      return stats
  }
}

/**
 * Ends the current turn: adds the turn, records the first-answer latency and
 * resets the clock. The caller persists the result as a `session/stats` event.
 */
export function finishTurn(
  stats: SessionStats,
  clock: StatsClock,
  now: number,
): { stats: SessionStats; firstResponseMs: number; lastTurnMs: number } {
  const firstResponseMs =
    clock.turnStart === undefined || clock.firstStepEnd === undefined ? 0 : Math.max(0, clock.firstStepEnd - clock.turnStart)
  const lastTurnMs = clock.turnStart === undefined ? 0 : Math.max(0, now - clock.turnStart)
  clock.stepStart = undefined
  clock.turnStart = undefined
  clock.firstStepEnd = undefined
  clock.toolStarts.clear()
  return {
    stats: { ...stats, turns: stats.turns + 1, firstResponseMs, lastTurnMs },
    firstResponseMs,
    lastTurnMs,
  }
}
