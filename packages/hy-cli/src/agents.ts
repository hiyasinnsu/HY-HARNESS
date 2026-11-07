import type { SessionEvent } from '../../core/dist/index.js'

/**
 * WP-22: continuable subagents.
 *
 * `delegate` (synchronous) keeps its original behaviour: a fresh agent answers
 * one task and is gone. With `background: true` the agent is registered here
 * instead, so the model (and the GUI) can list it, send it follow-up messages,
 * interrupt it and read its state after a restart.
 *
 * The registry is durable through the parent's session log: `agent/spawn`,
 * `agent/message`, `agent/interrupt`, `agent/close` are enough to rebuild the
 * list after a restart, and a child that was running becomes `interrupted` —
 * the same normalisation orchestration uses for stale workers (K5).
 */
export type SubagentStatus = 'running' | 'idle' | 'interrupted' | 'closed'

export interface SubagentView {
  agentId: string
  parentRunId: string
  task: string
  readOnly: boolean
  status: SubagentStatus
  createdAt: number
  updatedAt: number
  /** Follow-up turns started for this agent. */
  turns: number
  /** The last completed turn's answer (truncated for the wire). */
  final?: string
  error?: string
  /** True when the agent was created by `delegate { background: true }`. */
  background: boolean
}

/** The live child: one conversation per agent id. */
export interface SubagentRunner {
  /** Runs one turn (its answer, not the transcript). */
  run(message: string): Promise<string>
  /** Delivers a message into the running turn; throws when it is not running. */
  steer(message: string): { queued: number }
  /** Cancels the running turn, keeping the conversation. */
  abort(): void
  /** Releases the conversation (the log stays). */
  dispose(): void
}

export interface SubagentHost {
  /** Builds the child conversation for a new agent id. */
  create(agentId: string, readOnly: boolean): SubagentRunner
  /** Appends an `agent/*` event to the parent's session log. */
  log(event: string, payload: Record<string, unknown>): void
  /** Every state change, so the GUI can broadcast it. */
  changed?(view: SubagentView, event: 'spawn' | 'running' | 'idle' | 'interrupt' | 'close'): void
}

export const MAX_RUNNING_AGENTS = 8

/** A child run id is `<parent>.subN`; anything else is not ours to touch. */
export function isAgentOf(parentRunId: string, agentId: string): boolean {
  return agentId.startsWith(`${parentRunId}.sub`) && /^[^.\s]+$/.test(agentId.slice(parentRunId.length + '.sub'.length))
}

const MAX_FINAL = 2_000

export class SubagentRegistry {
  private readonly views = new Map<string, SubagentView>()
  private readonly runners = new Map<string, SubagentRunner>()
  private readonly pending = new Map<string, Promise<string>>()
  /** Agents whose current turn was cancelled: the next end is an interruption. */
  private readonly interrupted = new Set<string>()
  private nextId = 1

  constructor(
    private readonly host: SubagentHost,
    private readonly parentRunId: string,
  ) {}

  /**
   * Rebuilds the list a restart left behind: the log is the truth, and a child
   * that was `running` when the process died can no longer be running.
   */
  static replay(events: readonly SessionEvent[], parentRunId: string): SubagentView[] {
    const views = new Map<string, SubagentView>()
    const relevant = events.filter((e) => e.runId === parentRunId).sort((a, b) => a.seq - b.seq)
    for (const event of relevant) {
      const p = (event.payload ?? {}) as Record<string, unknown>
      const agentId = typeof p.agentId === 'string' ? p.agentId : ''
      if (!agentId || !isAgentOf(parentRunId, agentId)) continue
      const existing = views.get(agentId)
      const base: SubagentView =
        existing ??
        {
          agentId,
          parentRunId,
          task: typeof p.task === 'string' ? p.task : '',
          readOnly: p.readOnly !== false,
          status: 'idle',
          createdAt: event.ts,
          updatedAt: event.ts,
          turns: 0,
          background: p.background === true,
        }
      // Nothing after `agent/close` reopens the agent (the aborted turn's
      // `agent/end` is logged after it).
      if (base.status === 'closed' && event.type !== 'agent/spawn') continue
      switch (event.type) {
        case 'agent/spawn':
          views.set(agentId, { ...base, status: 'idle', updatedAt: event.ts })
          break
        case 'agent/message':
          views.set(agentId, {
            ...base,
            status: 'running',
            turns: base.turns + 1,
            updatedAt: event.ts,
          })
          break
        case 'agent/end':
          // A turn that finished before the restart stays finished; only a turn
          // whose last event is `agent/message` becomes `interrupted` below.
          views.set(agentId, {
            ...base,
            status: p.interrupted === true ? 'interrupted' : 'idle',
            updatedAt: event.ts,
            ...(typeof p.final === 'string' ? { final: p.final.slice(0, MAX_FINAL) } : {}),
            ...(typeof p.error === 'string' ? { error: p.error } : {}),
          })
          break
        case 'agent/interrupt':
          views.set(agentId, { ...base, status: 'interrupted', updatedAt: event.ts })
          break
        case 'agent/close':
          views.set(agentId, { ...base, status: 'closed', updatedAt: event.ts })
          break
        default:
          break
      }
    }
    // Whatever the log says, nothing is running in this process yet.
    return [...views.values()].map((v) => (v.status === 'running' ? { ...v, status: 'interrupted' } : v))
  }

  /** Restored agents are listed and messaged; their runner is created on demand. */
  restore(views: readonly SubagentView[]): void {
    for (const view of views) {
      if (this.views.has(view.agentId)) continue
      const normalized = view.status === 'running' ? { ...view, status: 'interrupted' as const } : view
      this.views.set(view.agentId, normalized)
      const used = Number(/(\d+)$/.exec(view.agentId.slice(this.parentRunId.length + '.sub'.length))?.[1] ?? 0)
      if (Number.isFinite(used) && used >= this.nextId) this.nextId = used + 1
    }
  }

  list(): SubagentView[] {
    return [...this.views.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(agentId: string): SubagentView | undefined {
    return this.views.get(agentId)
  }

  running(): number {
    return [...this.views.values()].filter((v) => v.status === 'running').length
  }

  /**
   * Registers a new child and (when `start` is given) begins a turn at once.
   * Returns the view; the returned promise of the turn is tracked internally.
   */
  spawn(task: string, readOnly: boolean, options: { background?: boolean; start?: string } = {}): SubagentView {
    if (this.running() >= MAX_RUNNING_AGENTS) {
      throw new Error(`too many subagents running (limit ${MAX_RUNNING_AGENTS}); interrupt one first`)
    }
    const agentId = `${this.parentRunId}.sub${this.nextId++}`
    const now = Date.now()
    const view: SubagentView = {
      agentId,
      parentRunId: this.parentRunId,
      task,
      readOnly,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      turns: 0,
      background: options.background === true,
    }
    this.host.log('agent/spawn', {
      agentId,
      task,
      readOnly,
      ...(options.background ? { background: true } : {}),
    })
    this.views.set(agentId, view)
    this.host.changed?.(view, 'spawn')
    if (options.start !== undefined) this.start(agentId, options.start)
    return this.views.get(agentId)!
  }

  /**
   * Sends a message: a follow-up turn when the agent is idle, a steering message
   * when it is running. Synchronous so a tool call can report the new state.
   */
  send(agentId: string, message: string): SubagentView {
    const view = this.require(agentId)
    const text = message.trim()
    if (!text) throw new Error('message is required')
    if (view.status === 'closed') throw new Error(`${agentId} is closed`)
    if (view.status === 'running') {
      const runner = this.runners.get(agentId)
      if (!runner) throw new Error(`${agentId} is not available in this process`)
      runner.steer(text)
      this.host.log('agent/message', { agentId, message: text, steering: true })
      return this.touch(agentId, {})
    }
    this.host.log('agent/message', { agentId, message: text })
    this.start(agentId, text)
    return this.views.get(agentId)!
  }

  /** Runs a turn in the background; the registry owns the promise. */
  start(agentId: string, message: string): Promise<string> {
    const view = this.require(agentId)
    if (view.status === 'running') throw new Error(`${agentId} is already running`)
    const runner = this.runnerFor(agentId)
    this.touch(agentId, { status: 'running', turns: view.turns + 1 })
    this.host.changed?.(this.views.get(agentId)!, 'running')
    const run = async (): Promise<string> => {
      try {
        const final = await runner.run(message)
        this.host.log('agent/end', { agentId, final: final.slice(0, MAX_FINAL) })
        this.touch(agentId, { ...(this.isClosed(agentId) ? {} : { status: 'idle' as const }), final: final.slice(0, MAX_FINAL) })
        return final
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        // An interrupted turn is not a failed one: it stays `interrupted` so a
        // restart, the GUI and the log agree it was cut off (K5 discipline).
        const interrupted = this.interrupted.delete(agentId)
        this.host.log('agent/end', { agentId, error: text, ...(interrupted ? { interrupted: true } : {}) })
        // A closed agent stays closed: `close` aborts the turn, and its end
        // must not reopen the agent for messages.
        this.touch(agentId, { ...(this.isClosed(agentId) ? {} : { status: interrupted ? ('interrupted' as const) : ('idle' as const) }), error: text })
        throw error
      } finally {
        this.pending.delete(agentId)
        this.host.changed?.(this.views.get(agentId)!, 'idle')
      }
    }
    const task = run()
    // Nobody awaits a background turn; the rejection is reported through the
    // view (and the log), so keep Node from treating it as unhandled.
    task.catch(() => {})
    this.pending.set(agentId, task)
    return task
  }

  /** Cancels the running turn but keeps the conversation for a follow-up. */
  interrupt(agentId: string): SubagentView {
    const view = this.require(agentId)
    if (view.status !== 'running') throw new Error(`${agentId} is not running`)
    this.interrupted.add(agentId)
    this.runners.get(agentId)?.abort()
    this.host.log('agent/interrupt', { agentId })
    this.touch(agentId, { status: 'interrupted' })
    this.host.changed?.(this.views.get(agentId)!, 'interrupt')
    return this.views.get(agentId)!
  }

  close(agentId: string): SubagentView {
    const view = this.require(agentId)
    this.runners.get(agentId)?.abort()
    this.runners.get(agentId)?.dispose()
    this.runners.delete(agentId)
    this.host.log('agent/close', { agentId })
    this.touch(agentId, { status: 'closed' })
    this.host.changed?.(this.views.get(agentId)!, 'close')
    return this.views.get(agentId)!
  }

  private isClosed(agentId: string): boolean {
    return this.views.get(agentId)?.status === 'closed'
  }

  /** Waits for the current turn (tests and the web API's interrupt path). */
  wait(agentId: string): Promise<string> {
    return this.pending.get(agentId) ?? Promise.resolve(this.views.get(agentId)?.final ?? '')
  }

  /** Releases every live child (server shutdown). A running turn is interrupted. */
  dispose(): void {
    for (const [agentId, runner] of this.runners) {
      if (this.views.get(agentId)?.status === 'running') {
        this.interrupted.add(agentId)
        this.host.log('agent/interrupt', { agentId, reason: 'shutdown' })
        try {
          runner.abort()
        } catch {
          // Already gone.
        }
      }
      runner.dispose()
    }
    this.runners.clear()
  }

  private runnerFor(agentId: string): SubagentRunner {
    const existing = this.runners.get(agentId)
    if (existing) return existing
    const view = this.require(agentId)
    const runner = this.host.create(agentId, view.readOnly)
    this.runners.set(agentId, runner)
    return runner
  }

  private require(agentId: string): SubagentView {
    if (!isAgentOf(this.parentRunId, agentId)) throw new Error(`not a subagent of ${this.parentRunId}: ${agentId}`)
    const view = this.views.get(agentId)
    if (!view) throw new Error(`unknown subagent ${agentId}`)
    return view
  }

  private touch(agentId: string, patch: Partial<SubagentView>): SubagentView {
    const current = this.views.get(agentId)
    if (!current) throw new Error(`unknown subagent ${agentId}`)
    const next: SubagentView = { ...current, ...patch, updatedAt: Date.now() }
    // A completed turn must not keep a stale error from an earlier one.
    if (patch.status === 'running') delete next.error
    this.views.set(agentId, next)
    return next
  }
}
