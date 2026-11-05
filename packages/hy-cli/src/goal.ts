import type { SessionEvent, SessionLog } from '../../core/dist/index.js'

/** DSH `dsh-goal` equivalent: one persisted completion objective per session. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'
export type GoalActivation = 'armed' | 'disarmed'

/** Persisted goal data. Activation is process-local and never stored. */
export interface GoalSnapshot {
  id: string
  revision: number
  objective: string
  phase: GoalPhase
  roundsStarted: number
  maxGoalRounds: number
  /** Set only while phase is blocked. */
  blockerReason?: string
  /** HY-HARNESS evaluator bookkeeping. */
  judgeAttempts: number
  /** Consecutive goal rounds reporting the same blocker. */
  blockedStreak: number
  lastBlockedReason?: string
  lastBlockedRound?: number
}

export interface GoalView extends GoalSnapshot {
  activation: GoalActivation
}

export class GoalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'GoalError'
  }
}

const DEFAULT_MAX_GOAL_ROUNDS = 256
const MAX_JUDGE_ATTEMPTS = 3

/**
 * The goal state lives only in the session log, like DSH's `dsh-goal`. The
 * process-local activation flag is disarmed on every session start, so a
 * resumed or restarted session never continues on its own until the user
 * explicitly resumes the goal.
 */
export class GoalStore {
  private state: GoalSnapshot | undefined
  private activation: GoalActivation = 'disarmed'

  constructor(
    private readonly log: SessionLog,
    private readonly runId: string,
    events: readonly SessionEvent[],
    private readonly defaultMaxGoalRounds = DEFAULT_MAX_GOAL_ROUNDS,
  ) {
    this.replay(events)
  }

  private replay(events: readonly SessionEvent[]): void {
    let latest: GoalSnapshot | undefined
    for (const event of events) {
      if (event.runId !== this.runId) continue
      if (event.type === 'goal/change') {
        const value = (event.payload as { goal?: unknown }).goal
        latest = decodeSnapshot(value) ?? undefined
      } else if (event.type === 'goal/set') {
        // Legacy HY-HARNESS goal: a plain objective string.
        const objective = (event.payload as { goal?: unknown }).goal
        if (typeof objective === 'string' && objective.trim()) {
          latest = {
            id: `legacy-${this.runId}`,
            revision: 1,
            objective: objective.trim(),
            phase: 'active',
            roundsStarted: 0,
            maxGoalRounds: this.defaultMaxGoalRounds,
            judgeAttempts: 0,
            blockedStreak: 0,
          }
        } else {
          latest = undefined
        }
      }
    }
    this.state = latest
    // DSH disarms continuation after any session-start edge.
    this.activation = 'disarmed'
  }

  view(): GoalView | undefined {
    return this.state ? { ...this.state, activation: this.activation } : undefined
  }

  current(): GoalSnapshot | undefined {
    return this.state
  }

  isActive(): boolean {
    return this.state?.phase === 'active'
  }

  isArmed(): boolean {
    return this.activation === 'armed'
  }

  canCreate(): boolean {
    return this.state === undefined || this.state.phase === 'complete'
  }

  create(objective: string, maxGoalRounds = this.defaultMaxGoalRounds): GoalView {
    const value = objective.trim()
    if (!value) throw new GoalError('GOAL_OBJECTIVE_REQUIRED', 'goal objective is required')
    if (!this.canCreate()) {
      throw new GoalError('GOAL_EXISTS', 'an unfinished goal already exists; edit, pause, block or clear it first')
    }
    const max = validRounds(maxGoalRounds)
    const next: GoalSnapshot = {
      id: `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      revision: 1,
      objective: value,
      phase: 'active',
      roundsStarted: 0,
      maxGoalRounds: max,
      judgeAttempts: 0,
      blockedStreak: 0,
    }
    this.commit(next)
    this.activation = 'armed'
    return this.view()!
  }

  edit(objective: string, maxGoalRounds?: number): GoalView {
    const current = this.require()
    if (current.phase === 'complete') {
      throw new GoalError('GOAL_COMPLETE', 'a completed goal cannot be edited; create a new goal')
    }
    const value = objective.trim()
    if (!value) throw new GoalError('GOAL_OBJECTIVE_REQUIRED', 'goal objective is required')
    const next: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      objective: value,
      ...(maxGoalRounds !== undefined ? { maxGoalRounds: validRounds(maxGoalRounds) } : {}),
      judgeAttempts: 0,
      blockedStreak: 0,
    }
    delete next.blockerReason
    delete next.lastBlockedReason
    delete next.lastBlockedRound
    this.commit(next)
    return this.view()!
  }

  pause(): GoalView {
    const current = this.require()
    if (current.phase === 'complete') throw new GoalError('GOAL_COMPLETE', 'a completed goal cannot be paused')
    const next: GoalSnapshot = { ...current, revision: current.revision + 1, phase: 'paused' }
    this.commit(next)
    this.activation = 'disarmed'
    return this.view()!
  }

  resume(): GoalView {
    const current = this.require()
    if (current.phase === 'complete') throw new GoalError('GOAL_COMPLETE', 'a completed goal cannot be resumed')
    if (current.phase === 'active' && this.activation === 'armed') return this.view()!
    if (current.roundsStarted >= current.maxGoalRounds) {
      throw new GoalError('GOAL_ROUND_LIMIT', `goal reached its ${current.maxGoalRounds}-round limit`)
    }
    const next: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      phase: 'active',
      blockedStreak: 0,
    }
    delete next.blockerReason
    delete next.lastBlockedReason
    delete next.lastBlockedRound
    this.commit(next)
    this.activation = 'armed'
    return this.view()!
  }

  clear(): void {
    this.state = undefined
    this.activation = 'disarmed'
    this.log.append('goal/change', { goal: null })
  }

  complete(): GoalView {
    const current = this.require()
    const next: GoalSnapshot = { ...current, revision: current.revision + 1, phase: 'complete' }
    this.commit(next)
    this.activation = 'disarmed'
    return this.view()!
  }

  /** Record a failed grader attempt; block after three. */
  judgeFailed(): GoalView {
    const current = this.require()
    const attempts = current.judgeAttempts + 1
    if (attempts >= MAX_JUDGE_ATTEMPTS) {
      const next: GoalSnapshot = {
        ...current,
        revision: current.revision + 1,
        phase: 'blocked',
        blockerReason: 'grader-rejected',
        judgeAttempts: attempts,
      }
      this.commit(next)
      this.activation = 'disarmed'
      return this.view()!
    }
    const next: GoalSnapshot = { ...current, revision: current.revision + 1, judgeAttempts: attempts }
    this.commit(next)
    return this.view()!
  }

  judgePassed(): GoalView {
    const current = this.require()
    return this.completeWith({ ...current, judgeAttempts: 0 })
  }

  private completeWith(next: GoalSnapshot): GoalView {
    this.commit({ ...next, revision: next.revision + 1, phase: 'complete' })
    this.activation = 'disarmed'
    return this.view()!
  }

  /**
   * Records a blocked claim. DSH requires the same condition for three
   * consecutive goal rounds; a direct human stop may block immediately.
   */
  block(reason: string, options: { immediate?: boolean } = {}): GoalView {
    const current = this.require()
    const text = reason.trim()
    if (!text) throw new GoalError('GOAL_BLOCK_REASON_REQUIRED', 'blocked_reason is required')
    if (options.immediate) {
      const next: GoalSnapshot = {
        ...current,
        revision: current.revision + 1,
        phase: 'blocked',
        blockerReason: text.slice(0, 2_000),
        blockedStreak: 0,
      }
      this.commit(next)
      this.activation = 'disarmed'
      return this.view()!
    }
    if (current.lastBlockedRound === current.roundsStarted) {
      throw new GoalError(
        'GOAL_BLOCK_SAME_ROUND',
        'blocked was already reported in this round; wait for the next goal round before repeating it',
      )
    }
    const streak = current.lastBlockedReason === text ? current.blockedStreak + 1 : 1
    if (streak < 3) {
      const next: GoalSnapshot = {
        ...current,
        revision: current.revision + 1,
        blockedStreak: streak,
        lastBlockedReason: text,
        lastBlockedRound: current.roundsStarted,
      }
      this.commit(next)
      throw new GoalError(
        'GOAL_BLOCK_NEEDS_ROUNDS',
        `the same blocking condition must persist for 3 goal rounds (${streak}/3); continue and report it again next round`,
      )
    }
    const next: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      phase: 'blocked',
      blockerReason: text.slice(0, 2_000),
      blockedStreak: streak,
      lastBlockedReason: text,
      lastBlockedRound: current.roundsStarted,
    }
    this.commit(next)
    this.activation = 'disarmed'
    return this.view()!
  }

  /** Starts one autonomous goal round and persists the counter. */
  beginRound(): { round: number; view: GoalView } | undefined {
    const current = this.state
    if (!current || current.phase !== 'active' || this.activation !== 'armed') return undefined
    if (current.roundsStarted >= current.maxGoalRounds) {
      this.block('round-limit', { immediate: true })
      return undefined
    }
    const next: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      roundsStarted: current.roundsStarted + 1,
      judgeAttempts: 0,
    }
    this.commit(next)
    return { round: next.roundsStarted, view: this.view()! }
  }

  disarm(): void {
    this.activation = 'disarmed'
  }

  private require(): GoalSnapshot {
    if (!this.state) throw new GoalError('GOAL_NONE', 'no goal is set')
    return this.state
  }

  private commit(next: GoalSnapshot): void {
    this.state = next
    this.log.append('goal/change', { goal: next })
  }
}

function validRounds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GoalError('GOAL_ROUNDS_INVALID', 'maxGoalRounds must be a positive safe integer')
  }
  return value
}

function decodeSnapshot(raw: unknown): GoalSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const phase = value.phase
  const allowedPhases: readonly GoalPhase[] = ['active', 'paused', 'blocked', 'complete']
  if (
    typeof value.id !== 'string' ||
    typeof value.revision !== 'number' ||
    typeof value.objective !== 'string' ||
    typeof phase !== 'string' ||
    !(allowedPhases as readonly string[]).includes(phase) ||
    typeof value.roundsStarted !== 'number' ||
    typeof value.maxGoalRounds !== 'number'
  ) {
    return null
  }
  return {
    id: value.id,
    revision: value.revision,
    objective: value.objective,
    phase: phase as GoalPhase,
    roundsStarted: value.roundsStarted,
    maxGoalRounds: value.maxGoalRounds,
    ...(typeof value.blockerReason === 'string' ? { blockerReason: value.blockerReason } : {}),
    judgeAttempts: typeof value.judgeAttempts === 'number' ? value.judgeAttempts : 0,
    blockedStreak: typeof value.blockedStreak === 'number' ? value.blockedStreak : 0,
    ...(typeof value.lastBlockedReason === 'string' ? { lastBlockedReason: value.lastBlockedReason } : {}),
    ...(typeof value.lastBlockedRound === 'number' ? { lastBlockedRound: value.lastBlockedRound } : {}),
  }
}
