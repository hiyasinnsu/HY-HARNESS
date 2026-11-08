import { createHash } from 'node:crypto'
import { LlmError, type ChatMessage, type Completion, type ImageInput, type LlmProvider, type Usage } from './llm.js'
import type { SessionEvent, SessionLog } from './session-log.js'
import { buildSystemPrompt, lastSessionContext, nativeToolDefs, sessionContextBlock, type InteractionMode, type PromptExtras, type WorkMode } from './prompt.js'
import { AbortRunError, type ToolRuntime } from './tools.js'
import { Ledger, discoverPinned } from './ledger.js'
import type { SkillInfo } from './skills.js'
import type { MemoryStore } from './memory.js'
import { validate, type Schema, type ToolSpec } from './tool-registry.js'
import { looksLikeBrokenToolCall, recoverTemplateCall } from './reply-guard.js'
import { steerMessage, type SteerInbox } from './steering.js'
import { classifyDenial, type DenialInfo } from './denial.js'
import { estimateTokens } from './tokens.js'
import { featureEnabled } from './features.js'
import type { Hooks } from './hooks.js'

/** Where a spilled tool output lives (design §8). */
export interface SpillRef {
  spillId: string
  /** `read_file` path for the full text, e.g. `spill://<session>/<call>`. */
  path: string
  byteLength: number
  totalLines: number
}

/**
 * Spill and compaction hooks (design §8). Implemented in `@hy/seams`
 * (`SpillCompaction`); without one, long outputs are truncated and nothing is
 * compacted.
 */
export interface ContextManager {
  /** Every tool output passes through here before it enters the conversation. */
  toolOutput(callId: string, output: string): { visible: string; spillRef?: SpillRef }
  /**
   * Called before each request with the last provider-reported input tokens.
   * May return a compacted list; `messages[0]` (system) and `messages[1]`
   * (objective) stay first, and assistant/user pairs are never split.
   */
  beforeRequest(messages: ChatMessage[], lastInputTokens: number): Promise<ChatMessage[]>
  /**
   * Called after each completion; a manager may prepare work in the background
   * (CP-22: warm the summary for the next request). Must not throw.
   */
  afterResponse?(messages: ChatMessage[], completion: { usage: { inputTokens: number } }): void
}

export interface AgentEvent {
  type:
    | 'assistant'
    | 'assistant-delta'
    | 'thinking'
    | 'tool'
    | 'tool-error'
    | 'final'
    | 'retry'
    | 'step-start'
    | 'step-end'
    | 'tool-start'
  [key: string]: unknown
}

export interface AgentOptions {
  provider: LlmProvider
  tools: ToolRuntime
  sessionLog: SessionLog
  workspaceRoot: string
  maxOutputTokens?: number
  /** Goal mode: a prose-only plan/confirmation must not end the turn before acting. */
  goalMode?: boolean
  /** `full`: assistant messages keep their reasoning, which the provider gets back (HarnessConfig.reasoningHistory). */
  reasoningHistory?: 'none' | 'full'
  /** System-prompt variant (benchmark experiments; HarnessConfig.promptVariant). */
  promptVariant?: 'lean' | 'legacy' | 'lean2' | 'lean3' | 'lean4'
  workMode?: () => WorkMode
  /** How the agent involves the user (session context, like the work mode). */
  interactionMode?: () => InteractionMode
  /** CP-38: resolved feature flags (streaming can be turned off). */
  features?: Readonly<Record<string, boolean>>
  /** CP-19: lifecycle hooks (userPromptSubmit, modelRequest, …). Default: none. */
  hooks?: Hooks
  /** Current goal shown in the system prompt. */
  goal?: { objective: string; phase: string; blockerReason?: string }
  temperature?: number
  effort?: string
  ptc?: boolean
  /** Pinned constraints + agent notes, re-rendered into every request (design §8). */
  ledger?: Ledger
  context?: ContextManager
  /**
   * An objective (`hy ralph`) session: only `claim_complete` finishes; a reply
   * without a tool call is nudged once, then the round is `stalled` (OQ-4).
   */
  objective?: boolean
  /** Skills listed in the system prompt (the same list as the ToolRuntime's). */
  skills?: readonly SkillInfo[]
  /** MCP tool catalog for the system prompt (`McpManager.renderCatalog()`). */
  mcpCatalog?: string
  /** Offer `delegate` (the ToolRuntime must have a delegate handler). */
  delegate?: boolean
  /** Role-specific text placed after the workspace header (orchestrator / worker). */
  roleInstruction?: string
  /** Only these tools are offered (must match the ToolRuntime's allowTools). */
  allowTools?: ReadonlySet<string>
  /** Offer `web_fetch` (the ToolRuntime must have `web`). */
  web?: boolean
  /** Offer `web_search` (the ToolRuntime's `web` has a searchUrl). */
  search?: boolean
  /** Offer `lsp` (the ToolRuntime has an LspManager). */
  lsp?: boolean
  /** The final answer must be JSON matching this schema (Codex `exec --output-schema`). */
  finalSchema?: Schema
  /** Offer `ask_user` (the ToolRuntime must have `askUser`). */
  ask?: boolean
  /** Offer tools through the provider's native function calling (Ollama, OpenAI-compatible). */
  nativeTools?: boolean
  /** Plugin tools (the same as the ToolRuntime's plugins). */
  extraTools?: readonly ToolSpec[]
  /** Workspace memory, re-rendered into every request (the ToolRuntime has the same store). */
  memory?: MemoryStore
  /** Cancels the turn: provider calls and in-flight tools stop. */
  signal?: AbortSignal
  /**
   * The session's steering inbox (WP-21). Drained at the start of every step, so
   * a message the user sent mid-turn reaches the model in the next request.
   */
  steer?: SteerInbox
  /** Makes tool call ids unique across turns (e.g. `t2-`). */
  callIdPrefix?: string
  onEvent?: (event: AgentEvent) => void
}

export interface AgentResult {
  /** `final`: a `hy run` answer; `claimed`: claim_complete; `stalled`: no claim after a nudge. */
  outcome: 'final' | 'claimed' | 'stalled'
  final: string
  steps: number
  usage: Usage
  /** The conversation after this turn, without the system prompt (pass it back to continue). */
  history: ChatMessage[]
}

/** The model-visible text of a tool result (also used to rebuild history from the log). */
export function toolResultMessage(name: string, output: string): string {
  return `TOOL RESULT (${name}):\n${output}`
}

export function toolErrorMessage(name: string, message: string): string {
  return `TOOL ERROR (${name}): ${message}\nFix the call or choose another approach.`
}

/**
 * Rebuilds a run's conversation from its session log (`hy resume`): the user
 * messages, the assistant replies and the tool results exactly as the model saw
 * them. A `turn/undo` drops everything since the matching `turn/start`.
 */
/**
 * The rejected reply (when it was not logged as `assistant/message`) and the
 * correction just pushed, for a `turn/retry` / `turn/nudge` payload, so
 * `rebuildHistory` reproduces them.
 */
function replay(messages: readonly ChatMessage[], withAssistant: boolean): { assistant?: string; withReasoning?: boolean; nudge: string } {
  return {
    ...(withAssistant ? { assistant: messages.at(-2)?.content ?? '', ...(messages.at(-2)?.reasoning ? { withReasoning: true } : {}) } : {}),
    nudge: messages.at(-1)?.content ?? '',
  }
}

export function rebuildHistory(events: readonly SessionEvent[], runId: string): ChatMessage[] {
  const history: ChatMessage[] = []
  const turnStarts = new Map<number, number>()
  const relevant = events.filter((e) => e.runId === runId).sort((a, b) => a.seq - b.seq)
  let lastType = ''
  // reasoningHistory full: the reasoning logged just before an assistant reply rides on it.
  let lastThinking: string | undefined
  const reply = (content: string, withReasoning: unknown): ChatMessage =>
    withReasoning === true && lastThinking ? { role: 'assistant', content, reasoning: lastThinking } : { role: 'assistant', content }
  for (const e of relevant) {
    const p = (e.payload ?? {}) as Record<string, unknown>
    const prevType = lastType
    lastType = e.type
    switch (e.type) {
      case 'turn/start':
        turnStarts.set(Number(p.turn), history.length)
        break
      case 'turn/undo': {
        const at = turnStarts.get(Number(p.turn))
        if (at !== undefined) history.length = at
        break
      }
      case 'user/message':
        // `sent` is what the model got when it differs from what the user typed
        // (hook context); the rebuilt history must match the cached prefix.
        history.push({ role: 'user', content: String(p.sent ?? p.content ?? '') })
        break
      case 'context/update': {
        // The session-context block rides on the newest user message.
        const text = String(p.content ?? '')
        const prev = history.at(-1)
        if (prev?.role === 'user') prev.content = `${prev.content}\n\n${text}`
        else history.push({ role: 'user', content: text })
        break
      }
      case 'image/attached': {
        const files = Array.isArray(p.files) ? p.files.map(String) : []
        const prev = history.at(-1)
        if (files.length > 0 && prev?.role === 'user') prev.content = `${prev.content}\n\n[image attached: ${files.join(', ')}]`
        break
      }
      case 'turn/retry':
      case 'turn/nudge':
        // A rejected reply and the correction the agent sent back.
        if (typeof p.nudge === 'string') {
          if (typeof p.assistant === 'string') history.push(reply(p.assistant, p.withReasoning))
          history.push({ role: 'user', content: p.nudge })
        }
        break
      case 'user/steer':
        // Logged raw (the transcript shows what the user typed); the marker is
        // added the same way the running agent adds it.
        history.push({ role: 'user', content: steerMessage(String(p.content ?? '')) })
        break
      case 'assistant/thinking':
        lastThinking = String(p.content ?? '')
        break
      case 'assistant/message':
        history.push(reply(String(p.content ?? ''), p.withReasoning))
        break
      case 'tool/result': {
        const name = String(p.name ?? '')
        const output = String(p.output ?? '')
        const text = p.isError === true ? toolErrorMessage(name, output) : toolResultMessage(name, output)
        // Results of one step's several calls share one user message.
        const prev = history.at(-1)
        if (prevType === 'tool/result' && prev?.role === 'user') prev.content = `${prev.content}\n\n${text}`
        else history.push({ role: 'user', content: text })
        break
      }
    }
  }
  return history
}

interface Call {
  tool: string
  args?: unknown
}

interface Action {
  tool?: string
  args?: unknown
  /** Several independent calls in one step. */
  calls?: unknown[]
  /** The same list under the name models sometimes use (`{"tools":[...]}`). */
  tools?: unknown[]
  /** A string; with `finalSchema`, a JSON value (or its JSON text). */
  final?: unknown
}

function stripFence(text: string): string {
  const t = text.trim()
  if (t.startsWith('```')) {
    return t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim()
  }
  return t
}

function parseAction(text: string): Action | undefined {
  const t = stripFence(text)
  try {
    const parsed = JSON.parse(t) as unknown
    if (parsed && typeof parsed === 'object') return parsed as Action
  } catch {
    // Fall through to the first balanced object.
  }
  const start = t.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < t.length; i++) {
    const c = t[i]!
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1)) as Action
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

function truncate(text: string, max = 20_000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars] …`
}

/** Appended to the result of an identical consecutive tool call. */
export function repeatReminder(times: number): string {
  return `\n[reminder] This is the same call with the same arguments ${times} times in a row; its result will not change. Change your approach, or finish if the work is done.`
}

/**
 * Finds a repeating cycle at the end of a step history (each entry is one
 * step's calls and whether they failed): A B C A B C has period 3, seen twice.
 * Period 1 is left to the consecutive-repeat reminder. Reports only when a
 * whole new copy of the cycle has just completed, so the model is told once
 * per lap, not on every step.
 */
export function detectCycle(steps: readonly string[], maxPeriod = 4): { period: number; times: number } | undefined {
  const n = steps.length
  for (let period = 2; period <= maxPeriod; period++) {
    if (n < period * 2) break
    const lap = steps.slice(n - period)
    if (lap.every((step) => step === lap[0])) continue
    let matched = 0
    while (matched < n - period && steps[n - 1 - matched] === steps[n - 1 - matched - period]) matched += 1
    if (matched >= period && matched % period === 0) return { period, times: matched / period + 1 }
    if (matched >= period) return undefined
  }
  return undefined
}

/** Appended to the last result of a step that completes a repeated cycle. */
export function cycleReminder(tools: readonly string[], times: number, failing: boolean): string {
  const loop = tools.join(' → ')
  const what = failing ? 'and the calls keep failing the same way' : 'with the same results'
  return (
    `\n[reminder] You are in a loop: the last ${tools.length} steps (${loop}) repeat the same calls for the ${times}${ordinal(times)} time, ${what}. ` +
    'Repeating them will not change the outcome. Stop and rethink: re-read the error messages, check your assumptions ' +
    '(paths, file contents, the command itself), try a different approach, or finish and explain what is blocking you.'
  )
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th'
  return n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
}

export class Agent {
  private readonly maxOutputTokens: number
  private readonly temperature: number
  private readonly effort: string | undefined

  constructor(private readonly options: AgentOptions) {
    this.maxOutputTokens = options.maxOutputTokens ?? 4_096
    this.temperature = options.temperature ?? 0
    this.effort = options.effort
  }

  /** CP-10: loaded deferred tools; tolerant of test doubles without the method. */
  private activeTools(): ReadonlySet<string> {
    const tools = this.options.tools as Partial<Pick<ToolRuntime, 'activatedTools'>>
    return tools.activatedTools?.() ?? new Set<string>()
  }
  /**
   * Runs one user turn. `history` (from a previous result or `rebuildHistory`)
   * continues an earlier conversation: `hy chat` and `hy resume`.
   */
  async run(
    objective: string,
    history: readonly ChatMessage[] = [],
    images: ImageInput[] = [],
    source?: 'orchestrator' | 'worker' | 'system' | 'goal',
  ): Promise<AgentResult> {
    const objectiveMode = this.options.objective ?? false
    const ptc = this.options.ptc ?? false
    // CP-19: a userPromptSubmit hook may block the turn or add context.
    const submitted = await this.options.hooks?.userPromptSubmit({ objective, source: source ?? 'user' })
    if (submitted?.block) throw new AbortRunError(`the userPromptSubmit hook blocked this turn: ${submitted.block}`)
    const promptText = submitted?.context
      ? `${objective}\n\n<untrusted_hook_context>\n${submitted.context}\n</untrusted_hook_context>`
      : objective
    // CP-13: record the session shell state at each turn start. The cwd is
    // restored on resume by `restoreCwd`, so this is the durable snapshot.
    const snapshotTools = this.options.tools as Partial<Pick<ToolRuntime, 'currentCwd'>>
    this.options.sessionLog.append('session/snapshot', {
      cwd: snapshotTools.currentCwd?.() ?? '',
      workspaceRoot: this.options.workspaceRoot,
      provider: this.options.provider.name,
    })
    const extras: PromptExtras = {
      ...(this.options.skills ? { skills: this.options.skills } : {}),
      ...(this.options.mcpCatalog ? { mcpCatalog: this.options.mcpCatalog } : {}),
      ...(this.options.delegate ? { delegate: true } : {}),
      ...(this.options.roleInstruction ? { roleInstruction: this.options.roleInstruction } : {}),
      ...(this.options.allowTools ? { allowTools: this.options.allowTools } : {}),
      ...(this.options.web ? { web: true } : {}),
      ...(this.options.search ? { search: true } : {}),
      ...(this.options.lsp ? { lsp: true } : {}),
      ...(this.options.finalSchema ? { finalSchema: this.options.finalSchema } : {}),
      // The date and goal are not here: they change during a session, so they
      // travel in the session-context block (see `sessionContext` below).
      ...(this.options.ask ? { ask: true } : {}),
      ...(this.options.extraTools?.length ? { extraTools: this.options.extraTools } : {}),
      ...(this.options.memory ? { memory: true } : {}),
      ...(this.options.promptVariant ? { promptVariant: this.options.promptVariant } : {}),
    }
    // Native function calling when the provider supports it; a model that
    // rejects tools switches the turn to the JSON text protocol.
    let native = this.options.nativeTools === true
    const prompt = () => buildSystemPrompt(this.options.workspaceRoot, ptc, objectiveMode, { ...extras, native, activeTools: this.activeTools() })
    let base = prompt()
    let nudged = false
    // Set once a broken tool call has been retried (native mode).
    let brokenRetried = false
    let degenerateRetried = false
    // Goal mode: one nudge when a plan/promise arrives before any tool call.
    let goalNudged = false
    let performedToolCalls = 0
    // Set once an empty native reply (no tool call, no text) has been retried.
    let emptyReplied = false
    const ledger = this.options.ledger ?? new Ledger(discoverPinned(this.options.workspaceRoot))
    let messages: ChatMessage[] = [
      { role: 'system', content: base },
      ...history,
      { role: 'user', content: promptText, ...(images.length > 0 ? { images } : {}) },
    ]
    this.options.sessionLog.append('user/message', {
      content: objective,
      // What the model actually got, so a rebuilt history matches the cached prefix.
      ...(promptText !== objective ? { sent: promptText } : {}),
      ...(images.length > 0 ? { images: images.length } : {}),
      ...(source ? { source } : {}),
    })
    const usage: Usage = { inputTokens: 0, outputTokens: 0 }
    let cacheUsageComplete = true
    let lastInputTokens = 0
    // RepeatToolReminderGuard (design §2, DSH repeat-tool-reminder).
    let lastCall = ''
    let repeats = 0
    // Loop guard: the same multi-step sequence (A → B → C → A → B → C …).
    const stepHistory: string[] = []

    for (let step = 1; ; step++) {
      // CP-10: `tool_search` may have loaded a deferred tool; refresh the
      // tool section so the rest of the turn sees it.
      const nextBase = prompt()
      if (nextBase !== base) {
        base = nextBase
        messages[0] = { role: 'system', content: base }
      }
      if (this.options.signal?.aborted) throw new AbortRunError('turn cancelled')
      // WP-21: a steering message joins the conversation at the step boundary,
      // so the request built just below is the first one that carries it. The
      // log entry is written here (not when the user pressed send) so the log
      // order is exactly the order the model saw.
      for (const steer of this.options.steer?.drain() ?? []) {
        messages.push({
          role: 'user',
          content: steerMessage(steer.text),
          ...(steer.images?.length ? { images: steer.images } : {}),
        })
        this.options.sessionLog.append('user/steer', {
          content: steer.text,
          step,
          ...(steer.images?.length ? { images: steer.images.length } : {}),
        })
      }
      this.options.onEvent?.({ type: 'step-start', step, role: 'worker', model: this.options.provider.name })
      if (this.options.context) messages = await this.options.context.beforeRequest(messages, lastInputTokens)
      // Prefix cache (DSH "in-history" updates): the system prompt stays
      // byte-identical for the whole session. The date, goal, constraints,
      // notes and memory go into a session-context block appended to the
      // newest user message whenever it differs from the last block the
      // conversation holds. Compaction or pruning that drops that block makes
      // it differ, so the current block is always in the request (Goal 3).
      const context = sessionContextBlock({
        ...(this.options.workMode ? { workMode: this.options.workMode() } : {}),
        ...(this.options.interactionMode ? { interactionMode: this.options.interactionMode() } : {}),
        // The model's own sense of "now" is its training cutoff (DSH time context).
        date: new Date().toLocaleDateString('sv-SE'),
        ...(this.options.goal ? { goal: this.options.goal } : {}),
        sections: [ledger.render(), this.options.memory?.render() ?? ''],
      })
      if (lastSessionContext(messages) !== context) {
        const last = messages.at(-1)
        if (last?.role === 'user') messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${context}` }
        else messages.push({ role: 'user', content: context })
        this.options.sessionLog.append('context/update', { content: context })
      }
      messages[0] = { role: 'system', content: base }
      let completion: Completion
      // Time spent waiting on the provider (the benchmark separates it from the
      // harness's own time: provider speed varies a lot between requests).
      let requestStarted = Date.now()
      try {
        await this.options.hooks?.modelRequest({ step, model: this.options.provider.name, native })
        requestStarted = Date.now()
        completion = await this.options.provider.complete(messages, {
          // CP-18: live deltas for the GUI (the final message is logged as usual).
          ...(this.options.onEvent && featureEnabled(this.options.features, 'streaming')
            ? {
                onDelta: (delta: { content?: string; reasoning?: string }) =>
                  this.options.onEvent?.({ type: 'assistant-delta', step, ...delta }),
              }
            : {}),
          maxTokens: this.maxOutputTokens,
          temperature: this.temperature,
          ...(this.effort ? { effort: this.effort } : {}),
          ...(this.options.signal ? { signal: this.options.signal } : {}),
          ...(native ? { tools: nativeToolDefs(ptc, objectiveMode, { ...extras, activeTools: this.activeTools() }) } : {}),
        })
      } catch (error) {
        if (this.options.signal?.aborted) throw new AbortRunError('turn cancelled')
        if (native && error instanceof LlmError && error.status === 400 && /tool/i.test(error.message)) {
          native = false
          base = prompt()
          this.options.sessionLog.append('native-tools/off', { reason: error.message.slice(0, 300) })
          step -= 1
          continue
        }
        throw error
      }
      const latencyMs = Date.now() - requestStarted
      lastInputTokens = completion.usage.inputTokens
      // CP-22: let the context manager warm its next compaction in the background.
      this.options.context?.afterResponse?.(messages, { usage: { inputTokens: completion.usage.inputTokens } })
      // CP-23: record estimate vs actual so the coefficients can be checked.
      {
        const estimated = estimateTokens(messages.map((message) => message.content).join('\n'))
        const actual = completion.usage.inputTokens
        this.options.sessionLog.append('token/estimate', {
          step,
          estimated,
          actual,
          ...(estimated > 0 && actual > 0 ? { ratio: Math.round((actual / estimated) * 1000) / 1000 } : {}),
        })
      }
      // CP-12: get_context_remaining reads the last provider-reported usage.
      ;(this.options.tools as Partial<Pick<ToolRuntime, 'setUsage'>>).setUsage?.(completion.usage)
      usage.inputTokens += completion.usage.inputTokens
      usage.outputTokens += completion.usage.outputTokens
      if (completion.usage.cacheHitTokens === undefined || completion.usage.cacheMissTokens === undefined) cacheUsageComplete = false
      if (cacheUsageComplete) {
        usage.cacheHitTokens = (usage.cacheHitTokens ?? 0) + completion.usage.cacheHitTokens!
        usage.cacheMissTokens = (usage.cacheMissTokens ?? 0) + completion.usage.cacheMissTokens!
      } else {
        delete usage.cacheHitTokens
        delete usage.cacheMissTokens
      }
      // reasoningHistory full: this step's reasoning stays on its assistant
      // message, so later steps see why it acted (DSH / DeepSeek reasoning_content).
      const kept = this.options.reasoningHistory === 'full' && completion.reasoning?.trim() ? completion.reasoning : undefined
      const reply = (text: string): ChatMessage => (kept ? { role: 'assistant', content: text, reasoning: kept } : { role: 'assistant', content: text })
      if (completion.reasoning?.trim()) {
        const thinkingEvent = this.options.sessionLog.append('assistant/thinking', { content: completion.reasoning })
        this.options.onEvent?.({ type: 'thinking', step, content: truncate(completion.reasoning, 8_000), seq: thinkingEvent.seq })
      }
      this.options.sessionLog.append('step/end', {
        stepIndex: step,
        role: 'worker',
        model: this.options.provider.name,
        usage: completion.usage,
        latencyMs,
        // Detects prompt-template changes between steps (design §1).
        systemSha256: createHash('sha256').update(messages[0].content).digest('hex').slice(0, 16),
      })
      this.options.onEvent?.({ type: 'step-end', step, usage: completion.usage })

      // The stream was cut because the model looped on one fragment: the text
      // is not an answer and may hold half a tool call. Retry once with the
      // loop removed from the history; a second loop ends the turn plainly.
      if (completion.degenerate === 'repetition') {
        const cut = completion.content.trim()
        if (degenerateRetried) {
          const final = 'The model kept repeating the same text, so the reply was cut off. No further changes were made.'
          this.options.sessionLog.append('turn/end', { status: 'completed' })
          this.options.onEvent?.({ type: 'final', content: final })
          return { outcome: 'final', final, steps: step, usage, history: messages.slice(1) }
        }
        degenerateRetried = true
        if (cut) messages.push(reply(cut))
        messages.push({
          role: 'user',
          content:
            'Your last reply fell into a loop repeating the same characters and was cut off. Continue the task: make one complete tool call, or give a short plain-text summary if you are done.',
        })
        this.options.sessionLog.append('turn/retry', { step, reason: 'repetition', ...replay(messages, Boolean(cut)) })
        this.options.onEvent?.({ type: 'retry', step, reason: 'repetition', content: truncate(cut, 2_000) })
        continue
      }

      let content = completion.content.trim()
      let action: Action | undefined
      let calls: Call[] | undefined
      if (completion.toolCalls && completion.toolCalls.length > 0) {
        calls = completion.toolCalls.map((c) => ({ tool: c.name, args: c.args }))
        // History keeps one string per message: the calls in the text protocol's form.
        content = JSON.stringify(calls.length === 1 ? calls[0] : { calls })
      } else {
        // A call batch cut short by leaked template tags is restored, not
        // retried; history keeps the repaired text, as the model will see it.
        const recovered = recoverTemplateCall(content)
        if (recovered !== undefined) {
          this.options.sessionLog.append('reply/recovered', { step, reason: 'template-tail', removed: content.length - recovered.length })
          content = recovered
        }
        action = parseAction(content)
        // `{"tools":[...]}` is the same batch under another name. As valid JSON
        // it is not a broken call, so without this it was taken as the final
        // answer and the turn ended mid-task (security-holdout thorough #4).
        if (action && !Array.isArray(action.calls) && Array.isArray(action.tools) && action.final === undefined) action.calls = action.tools
        if (action && Array.isArray(action.calls)) {
          calls = action.calls.filter((c): c is Call => !!c && typeof (c as Call).tool === 'string')
        } else if (action && typeof action.tool === 'string') {
          calls = [{ tool: action.tool, args: action.args }]
        } else if (native && content && (!action || action.final === undefined)) {
          if (looksLikeBrokenToolCall(content)) {
            // A tool call the model failed to emit as a function call arrives
            // as plain content; showing it as the final answer would present a
            // broken call as the result. Retry once, then stop with a fixed text.
            messages.push(reply(content))
            if (brokenRetried) {
              const final = 'The model produced an invalid tool call. No changes were made.'
              this.options.sessionLog.append('turn/end', { status: 'completed' })
              this.options.onEvent?.({ type: 'final', content: final })
              return { outcome: 'final', final, steps: step, usage, history: messages.slice(1) }
            }
            brokenRetried = true
            messages.push({
              role: 'user',
              content:
                'Your reply looked like a broken tool call. Use a real function call for tools, or reply with a short plain-text summary when finished.',
            })
            this.options.sessionLog.append('turn/retry', { step, reason: 'broken-tool-call', ...replay(messages, true) })
            this.options.onEvent?.({ type: 'retry', step, reason: 'broken-tool-call', content: truncate(content, 2_000) })
            continue
          }
          // Goal mode: a plan, confirmation request or "I will proceed" is not
          // an answer. Nudge once to execute; if the model repeats it, accept
          // the reply as final instead of looping.
          if (this.options.goalMode && !goalNudged && performedToolCalls === 0) {
            goalNudged = true
            messages.push(reply(content))
            messages.push({
              role: 'user',
              content:
                'Goal mode: do not reply with a plan, a confirmation request, or a promise. Call a tool now and continue until the goal is complete or genuinely blocked. Use ask_user only for missing credentials or a destructive/irreversible decision.',
            })
            this.options.sessionLog.append('turn/retry', { step, reason: 'goal-plan-without-action', ...replay(messages, true) })
            this.options.onEvent?.({
              type: 'retry',
              step,
              reason: 'goal-plan-without-action',
              content: truncate(content, 2_000),
            })
            continue
          }
          // Native mode: a reply without a tool call is the final answer.
          action = { final: content }
        }
      }

      if (!action && !calls) {
        messages.push(reply(content))
        // Native mode has no JSON text protocol: an empty reply carries neither a
        // tool call nor text, so the text-protocol retry below cannot help it and
        // a model that answers with reasoning only would repeat it to the limit.
        if (native && !content) {
          if (emptyReplied) {
            const final = 'The model returned an empty reply twice. No changes were made.'
            this.options.sessionLog.append('turn/end', { status: 'completed' })
            this.options.onEvent?.({ type: 'final', content: final })
            return { outcome: 'final', final, steps: step, usage, history: messages.slice(1) }
          }
          emptyReplied = true
          messages.push({
            role: 'user',
            content:
              'Your reply had no tool call and no text. Call a tool with a function call, or reply with a short plain-text summary if the work is done.',
          })
          this.options.sessionLog.append('turn/retry', { step, reason: 'empty-reply', ...replay(messages, true) })
          this.options.onEvent?.({ type: 'retry', step, reason: 'empty-reply', content: '' })
          continue
        }
        const retry =
          'Your previous reply was not a single valid JSON object. Reply with exactly one JSON object: ' +
          '{"tool":"read_file","args":{"path":"..."}} or {"final":"..."}'
        messages.push({ role: 'user', content: retry })
        this.options.sessionLog.append('turn/retry', { step, reason: 'invalid-json', ...replay(messages, true) })
        this.options.onEvent?.({ type: 'retry', step, reason: 'invalid-json', content: truncate(content, 2_000) })
        continue
      }

      this.options.sessionLog.append('assistant/message', { content, ...(kept ? { withReasoning: true } : {}) })
      // Tool calls are rendered from the structured tool-start/tool events.
      // Sending the serialized call here as well lets a 4K truncation cut the
      // JSON in half, which the UI then shows as a broken tool call.
      this.options.onEvent?.({ type: 'assistant', step, content: calls ? '' : truncate(content, 4_000) })

      if (!calls && action && this.options.finalSchema && action.final !== undefined && !objectiveMode) {
        // Structured output: the final value must match the schema; a mismatch
        // is returned to the model like a tool error.
        let value = action.final
        if (typeof value === 'string') {
          try {
            value = JSON.parse(value)
          } catch {
            // Validated as the string itself below.
          }
        }
        const problems = validate(this.options.finalSchema, value, 'final')
        messages.push(reply(content))
        if (problems.length > 0) {
          const retry = `Your final answer does not match the required schema: ${problems.join('; ')}. Reply again with {"final": <JSON matching the schema>}.`
          messages.push({ role: 'user', content: retry })
          this.options.sessionLog.append('user/message', { content: retry })
          this.options.onEvent?.({ type: 'retry', step, reason: 'final-schema', content: retry })
          continue
        }
        const final = JSON.stringify(value)
        this.options.sessionLog.append('turn/end', { status: 'completed' })
        this.options.onEvent?.({ type: 'final', content: final })
        return { outcome: 'final', final, steps: step, usage, history: messages.slice(1) }
      }

      if (!calls && action && typeof action.final === 'string') {
        if (objectiveMode) {
          // A text-only reply is not a claim (OQ-4): one nudge, then a stall.
          if (nudged) {
            this.options.sessionLog.append('turn/end', { status: 'stalled' })
            messages.push(reply(content))
            return { outcome: 'stalled', final: action.final, steps: step, usage, history: messages.slice(1) }
          }
          nudged = true
          messages.push(reply(content))
          messages.push({
            role: 'user',
            content:
              'This run finishes only through claim_complete. If the objective is done and verified, call ' +
              '{"tool":"claim_complete","args":{"summary":"..."}}; otherwise keep working with tools.',
          })
          this.options.sessionLog.append('turn/nudge', { step, reason: 'final-without-claim', ...replay(messages, false) })
          continue
        }
        this.options.sessionLog.append('turn/end', { status: 'completed' })
        messages.push(reply(content))
        this.options.onEvent?.({ type: 'final', content: action.final })
        return { outcome: 'final', final: action.final, steps: step, usage, history: messages.slice(1) }
      }

      if (calls && calls.length > 0) {
        const key = JSON.stringify(calls)
        repeats = key === lastCall ? repeats + 1 : 1
        lastCall = key
        const reminder = repeats >= 2 ? repeatReminder(repeats) : ''
        if (reminder) this.options.sessionLog.append('guard/repeat', { tool: calls.map((c) => c.tool).join(','), times: repeats })
        messages.push(reply(content))
        const outcomes = await this.executeCalls(step, calls)
        performedToolCalls += calls.length
        // WP-30: `read_image` hands the bytes over out of band. They ride on the
        // tool-result message, so the assistant/user alternation (and the mock's
        // request shape) stays exactly as before.
        const images = this.options.tools.takeImages()
        stepHistory.push(JSON.stringify([calls, outcomes.map((o) => o.ok)]))
        if (stepHistory.length > 64) stepHistory.shift()
        let loopNote = ''
        const cycle = reminder ? undefined : detectCycle(stepHistory)
        if (cycle) {
          const lap = stepHistory.slice(-cycle.period).map((entry) => JSON.parse(entry) as [Array<{ tool: string }>, boolean[]])
          const tools = lap.map(([stepCalls]) => stepCalls.map((c) => c.tool).join('+'))
          const failing = lap.some(([, oks]) => oks.some((ok) => !ok))
          loopNote = cycleReminder(tools, cycle.times, failing)
          this.options.sessionLog.append('guard/cycle', { tools, period: cycle.period, times: cycle.times, failing })
        }
        const parts = outcomes.map((o, i) => {
          const tail = i === outcomes.length - 1 ? reminder + loopNote : ''
          const output = o.output + tail
          this.options.sessionLog.append('tool/result', {
            callId: o.callId,
            name: o.call.tool,
            output,
            isError: !o.ok,
            ...(o.ok && o.spillRef ? { spillRef: o.spillRef } : {}),
          })
          if (o.ok) this.options.onEvent?.({ type: 'tool', step, callId: o.callId, name: o.call.tool, args: o.call.args, result: o.result })
          else this.options.onEvent?.({ type: 'tool-error', step, callId: o.callId, name: o.call.tool, args: o.call.args, message: output, ...(o.denial ? { denial: o.denial } : {}) })
          return o.ok ? toolResultMessage(o.call.tool, output) : toolErrorMessage(o.call.tool, output)
        })
        const imageNote = images.length > 0 ? `\n\n[image attached: ${images.map((image) => image.label).join(', ')}]` : ''
        messages.push({
          role: 'user',
          content: `${parts.join('\n\n')}${imageNote}`,
          ...(images.length > 0 ? { images: images.map((image) => ({ mimeType: image.mimeType, data: image.data })) } : {}),
        })
        if (images.length > 0) this.options.sessionLog.append('image/attached', { step, files: images.map((image) => image.label) })
        // claim_complete, directly or from a run_code script, ends the session.
        const claim = this.options.tools.takeClaim()
        if (claim !== undefined) {
          this.options.sessionLog.append('objective/claim', { summary: claim })
          this.options.sessionLog.append('turn/end', { status: 'completed' })
          this.options.onEvent?.({ type: 'final', content: claim })
          return { outcome: 'claimed', final: claim, steps: step, usage, history: messages.slice(1) }
        }
        continue
      }

      messages.push(reply(content))
      messages.push({
        role: 'user',
        content: 'Reply with either {"tool":"<name>","args":{...}} or {"final":"..."} and nothing else.',
      })
      this.options.sessionLog.append('turn/retry', { step, reason: 'missing-tool-or-final', ...replay(messages, false) })
      this.options.onEvent?.({ type: 'retry', step, reason: 'missing-tool-or-final', content: truncate(content, 2_000) })
    }

  }

  /**
   * Runs one step's calls: all at once when every one is read-only, else in
   * order. Errors become tool errors except run-ending ones.
   */
  private async executeCalls(step: number, calls: Call[]) {
    const one = async (call: Call, i: number) => {
      const prefix = this.options.callIdPrefix ?? ''
      const callId = calls.length === 1 ? `${prefix}step-${step}` : `${prefix}step-${step}.${i + 1}`
      if (this.options.signal?.aborted) throw new AbortRunError('turn cancelled')
      this.options.onEvent?.({ type: 'tool-start', step, callId, name: call.tool, args: call.args })
      try {
        const result = await this.options.tools.execute(call.tool, call.args)
        const raw = JSON.stringify(result, null, 2)
        const view = this.options.context?.toolOutput(callId, raw) ?? { visible: truncate(raw) }
        return { call, callId, ok: true as const, result, output: view.visible, ...(view.spillRef ? { spillRef: view.spillRef } : {}) }
      } catch (error) {
        // Run-ending errors (e.g. Guardian's breaker) are not the model's to fix.
        if (error instanceof AbortRunError) throw error
        const message = error instanceof Error ? error.message : String(error)
        // CP-06: a denied call is recorded once, so the GUI and `hy sandbox
        // status` can explain what was blocked instead of showing a bare error.
        const denial: DenialInfo | undefined = classifyDenial(message)
        if (denial) {
          this.options.sessionLog.append('sandbox/denial', {
            callId,
            tool: call.tool,
            kind: denial.kind,
            detail: denial.detail,
            message: truncate(message, 2_000),
          })
        }
        return { call, callId, ok: false as const, output: message, ...(denial ? { denial } : {}) }
      }
    }
    const parallel = calls.length > 1 && calls.every((c) => this.options.tools.isReadOnly(c.tool))
    if (parallel) return Promise.all(calls.map(one))
    const out = []
    for (let i = 0; i < calls.length; i++) out.push(await one(calls[i]!, i))
    return out
  }
}
