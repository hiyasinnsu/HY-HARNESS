// User hooks: commands run at fixed points of a session (Codex hooks and
// `notify`, DSH hook plugins). They come from the user's config or a trusted
// project's, and run unconfined, as the user, without a shell.
//
// CP-19 extends the original three events to the lifecycle points Codex has:
//
//   sessionStart, sessionEnd, userPromptSubmit, modelRequest, permissionRequest,
//   preToolUse, postToolUse, turnEnd (+ Codex-style `notify`)
//
// Each hook gets one JSON object on stdin. Semantics:
//   * `preToolUse` / `permissionRequest` / `userPromptSubmit`: exit code 2
//     blocks (stderr is the reason).
//   * `userPromptSubmit`: stdout (trimmed) is added to the user message as
//     untrusted context.
//   * Everything else is informational; a failure is reported and ignored.
import { spawn } from 'node:child_process'

export interface HookSpec {
  command: string[]
  /** Only for these tools (pre/postToolUse); default all. */
  tools?: string[]
  timeoutMs?: number
}

export interface HooksConfig {
  sessionStart?: HookSpec[]
  sessionEnd?: HookSpec[]
  userPromptSubmit?: HookSpec[]
  modelRequest?: HookSpec[]
  permissionRequest?: HookSpec[]
  preToolUse?: HookSpec[]
  postToolUse?: HookSpec[]
  subagentStart?: HookSpec[]
  subagentStop?: HookSpec[]
  stop?: HookSpec[]
  interrupt?: HookSpec[]
  preCompact?: HookSpec[]
  postCompact?: HookSpec[]
  turnEnd?: HookSpec[]
}

/** One configured hook, flattened for display (CP-32 `/hooks`). */
export interface HookListing {
  event: string
  command: string[]
  tools?: string[]
  timeoutMs?: number
}

/** Every configured hook in event order, then configuration order. */
export function describeHooks(hooks: HooksConfig | undefined): HookListing[] {
  const out: HookListing[] = []
  for (const [event, specs] of Object.entries(hooks ?? {}) as Array<[string, HookSpec[] | undefined]>) {
    for (const spec of specs ?? []) {
      out.push({
        event,
        command: [...spec.command],
        ...(spec.tools?.length ? { tools: [...spec.tools] } : {}),
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      })
    }
  }
  return out
}

export interface HookOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** The runner is injectable so the decision logic can be tested without spawning. */
export type HookRunner = (
  command: readonly string[],
  stdin: string,
  timeoutMs?: number,
  extraArg?: string,
) => Promise<HookOutcome>

export function runHook(
  command: readonly string[],
  stdin: string,
  timeoutMs = 10_000,
  extraArg?: string,
): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const [exe, ...args] = command
    if (!exe) {
      resolve({ code: null, stdout: '', stderr: 'empty hook command', timedOut: false })
      return
    }
    const child = spawn(exe, extraArg === undefined ? args : [...args, extraArg], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString('utf8')).slice(-8_000)))
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-8_000)))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: error.message, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
    child.stdin.on('error', () => {
      // The hook may exit without reading stdin.
    })
    child.stdin.end(stdin)
  })
}

export class Hooks {
  constructor(
    private readonly config: HooksConfig = {},
    private readonly notifyCommand?: readonly string[],
    private readonly report: (line: string) => void = () => {},
    private readonly runner: HookRunner = runHook,
  ) {}

  get empty(): boolean {
    const events: Array<keyof HooksConfig> = [
      'sessionStart',
      'sessionEnd',
      'userPromptSubmit',
      'modelRequest',
      'permissionRequest',
      'preToolUse',
      'postToolUse',
      'subagentStart',
      'subagentStop',
      'stop',
      'interrupt',
      'preCompact',
      'postCompact',
      'turnEnd',
    ]
    return !this.notifyCommand && events.every((event) => (this.config[event] ?? []).length === 0)
  }

  private matching(list: HookSpec[] | undefined, tool: string): HookSpec[] {
    return (list ?? []).filter((h) => !h.tools || h.tools.includes(tool))
  }

  /** Runs one list; returns the first blocking outcome (exit 2). */
  private async each(
    list: HookSpec[] | undefined,
    payload: unknown,
    tool?: string,
  ): Promise<{ blocked?: string; context: string[] }> {
    const context: string[] = []
    for (const hook of tool === undefined ? (list ?? []) : this.matching(list, tool)) {
      const result = await this.runner(hook.command, JSON.stringify(payload), hook.timeoutMs)
      if (result.code === 2) return { blocked: result.stderr.trim() || `blocked by hook ${hook.command.join(' ')}`, context }
      if (result.code !== 0) {
        this.report(
          `hook ${hook.command.join(' ')} failed (${result.timedOut ? 'timed out' : `exit ${String(result.code)}`}): ${result.stderr.trim().slice(0, 300)}`,
        )
        continue
      }
      const text = result.stdout.trim()
      if (text) context.push(text)
    }
    return { context }
  }

  /** Informational lifecycle hooks (never block). */
  async sessionStart(payload: Record<string, unknown>): Promise<void> {
    await this.each(this.config.sessionStart, { event: 'sessionStart', ...payload })
  }

  async sessionEnd(payload: Record<string, unknown>): Promise<void> {
    await this.each(this.config.sessionEnd, { event: 'sessionEnd', ...payload })
  }

  async modelRequest(payload: Record<string, unknown>): Promise<void> {
    await this.each(this.config.modelRequest, { event: 'modelRequest', ...payload })
  }

  /** A submit hook may block; stdout becomes context on the user message. */
  async userPromptSubmit(payload: Record<string, unknown>): Promise<{ block?: string; context?: string }> {
    const result = await this.each(this.config.userPromptSubmit, { event: 'userPromptSubmit', ...payload })
    return {
      ...(result.blocked !== undefined ? { block: result.blocked } : {}),
      ...(result.context.length > 0 ? { context: result.context.join('\n') } : {}),
    }
  }

  /** Exit code 2 denies the request (the reason is shown to the model). */
  async permissionRequest(request: Record<string, unknown>): Promise<string | undefined> {
    const result = await this.each(this.config.permissionRequest, { event: 'permissionRequest', ...request })
    return result.blocked
  }

  async preCompact(payload: { pairs: number; tokens: number }): Promise<void> {
    await this.each(this.config.preCompact, { event: 'preCompact', ...payload })
  }

  async postCompact(payload: { pairs: number; summarized: boolean }): Promise<void> {
    await this.each(this.config.postCompact, { event: 'postCompact', ...payload })
  }
  /** CP-19: a background subagent started (or was resumed) for this session. */
  async subagentStart(payload: { runId: string; agentId: string; task: string; readOnly?: boolean }): Promise<void> {
    await this.each(this.config.subagentStart, { event: 'subagentStart', ...payload })
  }

  /** CP-19: a background subagent closed (or was interrupted). */
  async subagentStop(payload: { runId: string; agentId: string; status?: string }): Promise<void> {
    await this.each(this.config.subagentStop, { event: 'subagentStop', ...payload })
  }
  /** CP-19: the user stopped the turn (Ctrl-C / the GUI Stop button). */
  async stop(payload: { runId: string; turn: number; reason?: string }): Promise<void> {
    await this.each(this.config.stop, { event: 'stop', ...payload })
  }

  /** CP-19: an exception interrupted the turn. */
  async interrupt(payload: { runId: string; turn: number; reason?: string }): Promise<void> {
    await this.each(this.config.interrupt, { event: 'interrupt', ...payload })
  }
  async preToolUse(tool: string, args: unknown): Promise<string | undefined> {
    const result = await this.each(this.config.preToolUse, { event: 'preToolUse', tool, args }, tool)
    return result.blocked
  }

  async postToolUse(tool: string, args: unknown, outcome: { result?: unknown; error?: string }): Promise<void> {
    await this.each(this.config.postToolUse, { event: 'postToolUse', tool, args, ...outcome }, tool)
  }

  async turnEnd(payload: { runId: string; turn: number; final: string; cwd: string }): Promise<void> {
    const json = JSON.stringify({ event: 'turnEnd', type: 'agent-turn-complete', ...payload })
    for (const hook of this.config.turnEnd ?? []) {
      const result = await this.runner(hook.command, json, hook.timeoutMs)
      if (result.code !== 0) {
        this.report(`hook ${hook.command.join(' ')} failed (exit ${String(result.code)}): ${result.stderr.trim().slice(0, 300)}`)
      }
    }
    if (this.notifyCommand) {
      const result = await this.runner(this.notifyCommand, '', 10_000, json)
      if (result.code !== 0) this.report(`notify failed (exit ${String(result.code)}): ${result.stderr.trim().slice(0, 300)}`)
    }
  }
}