import { createHash, randomUUID } from 'node:crypto'
import { statedContextLimit } from './llm-negotiate.js'
import { LlmError, parseLooseJsonObject, type ChatMessage, type CompleteOptions, type Completion, type ImageInput, type LlmProvider, type Usage } from './llm.js'
import type { SessionEvent, SessionLog } from './session-log.js'
import { buildSystemPrompt, lastSessionContext, nativeToolDefs, sessionContextBlock, type InteractionMode, type PromptExtras, type WorkMode } from './prompt.js'
import { AbortRunError, type ToolRuntime } from './tools.js'
import { Ledger, discoverPinned } from './ledger.js'
import type { SkillInfo } from './skills.js'
import type { MemoryStore } from './memory.js'
import { validate, type Schema, type ToolSpec } from './tool-registry.js'
import { discoverProjectChecks, renderProjectChecks } from './project-checks.js'
import { TurnProgress, stallNote, verificationNudge, verificationNoticeText } from './progress.js'
import { announcesNextStep, embedsCallInProse, hasCallsAfterFirstObject, looksLikeBrokenToolCall, recoverMalformedCall, recoverTemplateCall, recoverUnwrappedBatch, rememberToolNames } from './reply-guard.js'
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
/** A 400/413 whose body says the request exceeded the model's context window. */
function isContextOverflow(error: unknown): boolean {
  const status = (error as { status?: unknown }).status
  if (status !== 400 && status !== 413) return false
  const body = String((error as { body?: unknown }).body ?? (error as { message?: unknown }).message ?? '')
  if (!/context|prompt is too long|too many tokens|input is too long|reduce the length/i.test(body)) return false
  return /exceed|too (?:long|large|many)|maximum|limit|reduce/i.test(body)
}

/** A 400 that says the endpoint does not take function tools at all. */
function rejectsTools(message: string): boolean {
  return /tool/i.test(message) && /unsupported|not supported|does not support|unrecognized|unknown (?:field|parameter)|not available/i.test(message)
}

/** A native tool-call argument value as an object (string JSON, one-element array). */
function coerceArgs(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') return parseLooseJsonObject(value)
  if (Array.isArray(value) && value.length === 1) return coerceArgs(value[0])
  return undefined
}

export interface ContextManager {
  /** Every tool output passes through here before it enters the conversation. */
  toolOutput(callId: string, output: string): { visible: string; spillRef?: SpillRef }
  /**
   * Called before each request with the last provider-reported input tokens.
   * May return a compacted list; `messages[0]` (system) and `messages[1]`
   * (objective) stay first, and assistant/user pairs are never split.
   */
  beforeRequest(messages: ChatMessage[], lastInputTokens: number, replayTools?: CompleteOptions['tools']): Promise<ChatMessage[]>
  /**
   * Compacts now, regardless of the trigger. Used when the provider rejects a
   * request for exceeding the context window: the next attempt is made with a
   * shorter history instead of failing the turn.
   */
  forceCompact?(messages: ChatMessage[], replayTools?: CompleteOptions['tools']): Promise<ChatMessage[]>
  /** The provider stated the model's context window (smaller than configured). */
  learnContextWindow?(tokens: number): void
  /**
   * Called after each completion; a manager may prepare work in the background
   * (CP-22: warm the summary for the next request). Must not throw.
   */
  afterResponse?(messages: ChatMessage[], completion: { usage: { inputTokens: number } }, replayTools?: CompleteOptions['tools']): void
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
    | 'compaction'
    | 'step-start'
    | 'step-end'
    | 'tool-start'
    | 'steer-applied'
  [key: string]: unknown
}

type GoalContext = { objective: string; phase: string; blockerReason?: string }

export interface AgentOptions {
  provider: LlmProvider
  tools: ToolRuntime
  sessionLog: SessionLog
  workspaceRoot: string
  maxOutputTokens?: number
  /** Goal mode: a prose-only plan/confirmation must not end the turn before acting. */
  goalMode?: boolean
  /** When true, ending a turn with plain text is allowed to yield and wait for async background work. */
  allowWaitingReply?: () => boolean
  /** `full`: assistant messages keep their reasoning, which the provider gets back (HarnessConfig.reasoningHistory). */
  reasoningHistory?: 'none' | 'full'
  /** The compactor can reuse this provider's native request prefix. */
  cacheCompaction?: boolean
  /** System-prompt variant (benchmark experiments; HarnessConfig.promptVariant). */
  promptVariant?: 'lean' | 'legacy' | 'lean2' | 'lean3' | 'lean4'
  /** Send the detailed tool descriptions (default true; prompt.ts decides). */
  richToolDocs?: boolean
  /** Extra "announced the next step and stopped" patterns (user-registered). */
  announcePatterns?: readonly string[]
  /** Safety cap on the steps of one turn (default: no cap). */
  maxSteps?: number
  /**
   * Send a final answer that follows an unchecked code edit back once, asking
   * for a check or an explicit "not verified" (default true).
   */
  verifyGate?: boolean
  /**
   * Consecutive steps with no successful edit and no new tool result before the
   * first change-of-approach note; the second note comes at twice this and the
   * turn stops at three times (default 8, 0 turns it off).
   */
  stallSteps?: number
  workMode?: () => WorkMode
  /** How the agent involves the user (session context, like the work mode). */
  interactionMode?: () => InteractionMode
  /** CP-38: resolved feature flags (streaming can be turned off). */
  features?: Readonly<Record<string, boolean>>
  /** CP-19: lifecycle hooks (userPromptSubmit, modelRequest, …). Default: none. */
  hooks?: Hooks
  /** Current goal shown in the system prompt. */
  goal?: GoalContext | (() => GoalContext | undefined)
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
  /**
   * MCP tool catalog (`McpManager.renderCatalog()`); set (even empty) when MCP
   * servers are configured, which offers `mcp_call`. The text travels in the
   * session context, not the system prompt: which servers started can differ
   * between launches, and a resumed session whose system prompt changed lost
   * its whole cached prefix (154K uncached tokens in one step).
   */
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
  sessionContext?: () => string
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

/** The native calls of a logged reply: its text-protocol calls zipped with the logged ids. */
function loggedToolCalls(content: string, ids: readonly unknown[]): ChatMessage['toolCalls'] {
  try {
    const parsed = JSON.parse(content) as { tool?: unknown; args?: unknown; calls?: unknown }
    const list = Array.isArray(parsed.calls) ? parsed.calls as Array<{ tool?: unknown; args?: unknown }> : [parsed]
    if (list.length !== ids.length || !list.every((call) => typeof call.tool === 'string') || !ids.every((id) => typeof id === 'string')) return undefined
    return list.map((call, i) => ({ id: ids[i] as string, name: call.tool as string, args: call.args }))
  } catch {
    return undefined
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
        if (files.length > 0 && prev?.role === 'user') {
          // The note is part of the rendered results, as in the running agent.
          const rendered = prev.toolResults && prev.content === prev.toolResults.rendered
          prev.content = `${prev.content}\n\n[image attached: ${files.join(', ')}]`
          if (rendered) prev.toolResults = { ...prev.toolResults!, rendered: prev.content }
        }
        break
      }
      case 'turn/retry':
      case 'turn/nudge':
      case 'turn/failure':
        // A rejected reply and the correction the agent sent back.
        if (typeof p.nudge === 'string') {
          if (typeof p.assistant === 'string') history.push(reply(p.assistant, p.withReasoning))
          history.push({ role: 'user', content: p.nudge })
        }
        break
      case 'user/steer':
        // Logged raw (the transcript shows what the user typed); the marker is
        // added the same way the running agent adds it.
        history.push({ role: 'user', content: steerMessage(String(p.content ?? ''), p.source as 'orchestrator' | 'worker' | undefined) })
        break
      case 'assistant/thinking':
        lastThinking = String(p.content ?? '')
        break
      case 'assistant/message': {
        const message = reply(String(p.content ?? ''), p.withReasoning)
        const toolCalls = Array.isArray(p.toolCallIds) ? loggedToolCalls(message.content, p.toolCallIds) : undefined
        history.push(toolCalls ? { ...message, toolCalls } : message)
        break
      }
      case 'compaction/prune': {
        // Older logs only recorded a count. Preserve the original results in that case.
        if (!Array.isArray(p.replacements)) break
        const replacements = new Map<string, Map<number, string>>()
        for (const item of p.replacements) {
          if (typeof item?.sourceSha256 !== 'string' || typeof item?.content !== 'string') continue
          const matches = replacements.get(item.sourceSha256) ?? new Map<number, string>()
          const occurrence = Number.isSafeInteger(item.occurrence) && item.occurrence > 0 ? item.occurrence : matches.size + 1
          matches.set(occurrence, item.content)
          replacements.set(item.sourceSha256, matches)
        }
        const seen = new Map<string, number>()
        for (let i = 1; i < history.length && replacements.size > 0; i++) {
          const message = history[i]!
          if (message.role !== 'user' || !/^TOOL (RESULT|ERROR) \(/.test(message.content)) continue
          const hash = createHash('sha256').update(message.content).digest('hex')
          const matches = replacements.get(hash)
          if (!matches) continue
          const occurrence = (seen.get(hash) ?? 0) + 1
          seen.set(hash, occurrence)
          const content = matches.get(occurrence)
          if (content === undefined) continue
          history[i] = { role: 'user', content }
          matches.delete(occurrence)
          if (matches.size === 0) replacements.delete(hash)
        }
        break
      }
      case 'compaction/summary': {
        const rawSummary = String(p.summaryMarkdown ?? '')
        let summaryText = rawSummary.trim()
        if (summaryText.startsWith('{')) {
          try {
            const parsed = JSON.parse(summaryText) as { summary?: unknown }
            if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
              summaryText = parsed.summary.trim()
            }
          } catch {
            // Keep raw text when not valid JSON.
          }
        }
        if (history.length > 0 && summaryText) {
          const SUMMARY_OPEN = '<session_summary>'
          const SUMMARY_CLOSE = '</session_summary>'
          const segments: ChatMessage[][] = []
          for (const message of history.slice(1)) {
            if (message.role === 'assistant' || segments.length === 0) segments.push([message])
            else segments.at(-1)!.push(message)
          }
          const pairs = typeof p.pairs === 'number' && p.pairs > 0 ? p.pairs : segments.length
          const keep = Math.max(0, segments.length - pairs)
          const recent = segments.slice(segments.length - keep)

          const first = history[0]!
          const clean = first.content.includes(SUMMARY_OPEN)
            ? first.content.slice(0, first.content.indexOf(SUMMARY_OPEN)).trimEnd()
            : first.content
          history[0] = {
            ...first,
            content: `${clean}\n\n${SUMMARY_OPEN}\nSummary of earlier steps (written by the compactor):\n${summaryText}\n${SUMMARY_CLOSE}`,
          }
          history.length = 1
          for (const seg of recent) {
            history.push(...seg)
          }
          for (const [turn, idx] of turnStarts.entries()) {
            if (idx > history.length) turnStarts.set(turn, history.length)
          }
        }
        break
      }
      case 'tool/result': {
        const name = String(p.name ?? '')
        const output = String(p.output ?? '')
        const text = p.isError === true ? toolErrorMessage(name, output) : toolResultMessage(name, output)
        // Results of one step's several calls share one user message.
        const prev = history.at(-1)
        const entry = typeof p.toolCallId === 'string' ? { id: p.toolCallId, name, text } : undefined
        if (prevType === 'tool/result' && prev?.role === 'user') {
          prev.content = `${prev.content}\n\n${text}`
          if (prev.toolResults && entry) prev.toolResults = { entries: [...prev.toolResults.entries, entry], rendered: prev.content }
          else delete prev.toolResults
        } else {
          history.push({ role: 'user', content: text, ...(entry ? { toolResults: { entries: [entry], rendered: text } } : {}) })
        }
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

function callFingerprint(call: Call): string {
  const json = JSON.stringify(call, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value)
  return createHash('sha256').update(json).digest('hex')
}

const ACTION_ENVELOPE_KEYS = new Set(['tool', 'name', 'args', 'arguments', 'calls', 'tools', 'final'])
const NON_TOOL_SHORTHAND_KEYS = new Set(['tool', 'name', 'args', 'arguments', 'calls', 'tools', 'final', 'note', 'error', 'result', 'content'])

function isCallEntry(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  if (typeof obj.tool === 'string' || (typeof obj.name === 'string' && ('args' in obj || 'arguments' in obj))) return true
  const keys = Object.keys(obj)
  if (keys.length === 1 && !NON_TOOL_SHORTHAND_KEYS.has(keys[0]!) && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(keys[0]!)) {
    const inner = obj[keys[0]!]
    return !!inner && typeof inner === 'object' && !Array.isArray(inner)
  }
  return false
}

/**
 * Normalizes a tool-call object into `{ tool, args }`:
 * - folds top-level argument fields beside `"tool"` into `args`
 * - accepts `"arguments"` as an alias for `"args"`
 * - unwraps single-key shorthand `{"shell":{"command":"..."}}` inside a batch.
 */
function normalizeCall(raw: Record<string, unknown>): Call {
  const name = typeof raw.tool === 'string' ? raw.tool : raw.name
  if (typeof name !== 'string') {
    const [onlyKey] = Object.keys(raw)
    if (onlyKey) return { tool: onlyKey, args: raw[onlyKey] }
  }
  const tool = String(name)
  const rawArgs = raw.args !== undefined ? raw.args : raw.arguments
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!ACTION_ENVELOPE_KEYS.has(k) && v !== undefined) extra[k] = v
  }
  if (Object.keys(extra).length === 0) return { tool, args: rawArgs }
  const base =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {}
  return { tool, args: { ...extra, ...base } }
}

interface Action {
  tool?: string
  name?: string
  args?: unknown
  arguments?: unknown
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

/** The reply as one JSON object (a whole-reply fence allowed), or undefined. */
function parseWholeAction(text: string): Action | undefined {
  try {
    const parsed = JSON.parse(stripFence(text)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Action) : undefined
  } catch {
    return undefined
  }
}

/** Sent once when a native reply wrote a complete tool call inside its prose. */
export const EMBEDDED_CALL_NUDGE =
  'Your reply contains tool-call JSON in its text. Nothing ran: text is never executed as a tool call. ' +
  'To call a tool, use a function call. If the JSON is only an example in your answer, put it in a code block and reply again.'

function parseAction(text: string): Action | undefined {
  const t = stripFence(text)
  try {
    const parsed = JSON.parse(t) as unknown
    if (parsed && typeof parsed === 'object') return parsed as Action
  } catch {
    // Fall through to the first balanced object.
  }
  if (t.startsWith('<') && looksLikeBrokenToolCall(t)) return undefined
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

/** Tools that hand work to another session; its report arrives later. */
const DELEGATING_TOOLS: ReadonlySet<string> = new Set(['orchestrator_spawn', 'orchestrator_send', 'delegate', 'send_message'])

const TEXT_PROTOCOL_RETRY =
  'Your previous reply was not a single valid JSON object. Reply with exactly one JSON object: ' +
  '{"tool":"read_file","args":{"path":"..."}} or {"final":"..."}'

/** Keep the text-mode cache intact, but do not send its repair exchanges to a native session. */
function withoutTextProtocolRetries(history: readonly ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = []
  for (const message of history) {
    if (message.role === 'user' && (message.content === TEXT_PROTOCOL_RETRY || message.content.startsWith(TEXT_PROTOCOL_RETRY + '\n\n<hy_session_context>'))) {
      if (kept.at(-1)?.role === 'assistant') kept.pop()
      const context = message.content.slice(TEXT_PROTOCOL_RETRY.length).trimStart()
      if (context) kept.push({ role: 'user', content: context })
    } else {
      kept.push(message)
    }
  }
  return kept
}

/** Sent once when a final answer announced the agent's next step instead of taking it. */
export const ANNOUNCED_WITHOUT_ACTION =
  'Your reply ends by announcing something you are about to do, but it has no tool call, so nothing was done and the turn would end here. ' +
  'If that work should happen now, do it with a tool call. If you are waiting for the user, a running job or a worker, or are only offering, reply with a final answer that says so plainly.'

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
  /** Undefined: the provider's (model author's) default temperature. */
  private readonly temperature: number | undefined
  private readonly effort: string | undefined

  constructor(private readonly options: AgentOptions) {
    this.maxOutputTokens = options.maxOutputTokens ?? 4_096
    this.temperature = options.temperature
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
    const mcpSpecs = (this.options.tools as Partial<ToolRuntime>).mcpToolSpecs?.() ?? []
    const extraTools = [...(this.options.extraTools ?? []), ...mcpSpecs]
    const runtimeFeatures = (this.options.tools as Partial<ToolRuntime>).toolFeatures?.()
    const extras: PromptExtras = {
      ...(runtimeFeatures ? { features: runtimeFeatures } : {}),
      ...(this.options.skills ? { skills: this.options.skills } : {}),
      ...(this.options.mcpCatalog !== undefined ? { mcp: true } : {}),
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
      ...(extraTools.length ? { extraTools } : {}),
      ...(this.options.memory ? { memory: true } : {}),
      ...(this.options.promptVariant ? { promptVariant: this.options.promptVariant } : {}),
      ...(this.options.richToolDocs !== undefined ? { richToolDocs: this.options.richToolDocs } : {}),
      ...((this.options.tools as Partial<ToolRuntime>).foregroundShell?.() ? { foregroundShell: true } : {}),
    }
    // Native function calling when the provider supports it; a model that
    // rejects tools switches the turn to the JSON text protocol.
    let native = this.options.nativeTools === true
    const prompt = () => buildSystemPrompt(this.options.workspaceRoot, ptc, objectiveMode, { ...extras, native, activeTools: this.activeTools() })
    let base = prompt()
    let nudged = false
    // Set once a broken tool call has been retried (native mode).
    let brokenRetried = false
    let protocolFallback = false
    let limitedRetried = false
    // Forced compactions this turn after the provider rejected a request for the
    // context length. Each must shorten the request; a few are allowed because
    // one pass under a wrongly configured window may not be enough.
    let forcedCompactions = 0
    let invalidTextRetried = false
    let degenerateRetried = false
    // Set once a reply that announced its next step without acting was nudged.
    let announceNudged = false
    // The previous step handed work to a worker or subagent: a final that
    // describes that work ("回帰テストまで行います") is the right way to end
    // the turn and wait for the report, not an empty announcement.
    let lastStepDelegated = false
    // Goal mode: one nudge when a plan/promise arrives before any tool call.
    let goalNudged = false
    let performedToolCalls = 0
    // Set once an empty native reply (no tool call, no text) has been retried.
    let emptyReplied = false
    // Set once a native reply with a call written inside its prose was sent back.
    let embeddedNudged = false
    const ledger = this.options.ledger ?? new Ledger(discoverPinned(this.options.workspaceRoot))
    // A7: read once per turn; a session that edits its manifests sees the change next turn.
    const projectChecks = renderProjectChecks(discoverProjectChecks(this.options.workspaceRoot))
    let messages: ChatMessage[] = [
      { role: 'system', content: base },
      ...(native ? withoutTextProtocolRetries(history) : history),
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
    const unchanged = new Map<string, { result: string; count: number; step: number }>()
    let blockedSteps = 0
    const progress = new TurnProgress(this.options.stallSteps ?? 8)
    // Set once a final answer after an unchecked edit was sent back.
    let verifyNudged = false
    const failReply = (step: number, reason: string, detail: string, assistantAdded = true): AgentResult => {
      // A stall ran its calls; every other failure here stopped before running them.
      const final = reason === 'no-progress'
        ? `The task is incomplete: ${detail}. The turn was stopped; results and changes so far are preserved.`
        : `The task is incomplete: ${detail}. The failed calls did not run; earlier results and changes are preserved.`
      messages.push({ role: 'user', content: final })
      this.options.sessionLog.append('turn/failure', { step, reason, ...replay(messages, assistantAdded) })
      this.options.sessionLog.append('turn/end', { status: 'stalled', reason })
      this.options.onEvent?.({ type: 'final', content: final })
      return { outcome: 'stalled', final, steps: step, usage, history: messages.slice(1) }
    }

    // User-registered "announced the next step" patterns (any language), in
    // addition to the built-in Japanese and English detection.
    const announcePatterns = (this.options.announcePatterns ?? []).flatMap((pattern) => {
      try {
        return [new RegExp(pattern, 'iu')]
      } catch {
        return []
      }
    })
    for (let step = 1; ; step++) {
      if (this.options.maxSteps !== undefined && step > this.options.maxSteps) {
        return failReply(step - 1, 'max-steps', `the turn reached its step limit (${this.options.maxSteps})`)
      }
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
      const instructions = this.options.steer?.drain() ?? []
      if (instructions.some((message) => message.interrupt !== false)) {
        unchanged.clear()
        blockedSteps = 0
        progress.resetStall()
        brokenRetried = false
        limitedRetried = false
        invalidTextRetried = false
      }
      for (const steer of instructions) {
        messages.push({
          role: 'user',
          content: steerMessage(steer.text, steer.source),
          ...(steer.images?.length ? { images: steer.images } : {}),
        })
        this.options.sessionLog.append('user/steer', {
          content: steer.text,
          step,
          ...(steer.id ? { id: steer.id } : {}),
          ...(steer.source ? { source: steer.source } : {}),
          ...(steer.images?.length ? { images: steer.images.length } : {}),
        })
      }
      this.options.onEvent?.({ type: 'step-start', step, role: 'worker', model: this.options.provider.name })
      const offeredDefs = nativeToolDefs(ptc, objectiveMode, { ...extras, activeTools: this.activeTools() })
      const requestTools = native ? offeredDefs : undefined
      // Plugin and MCP tool names join the built-ins for text-call recovery.
      rememberToolNames(offeredDefs.map((tool) => tool.name))
      const replayTools = this.options.cacheCompaction ? requestTools : undefined
      if (this.options.context) messages = await this.options.context.beforeRequest(messages, lastInputTokens, replayTools)
      // Prefix cache (DSH "in-history" updates): the system prompt stays
      // byte-identical for the whole session. The date, goal, constraints,
      // notes and memory go into a session-context block appended to the
      // newest user message whenever it differs from the last block the
      // conversation holds. Compaction or pruning that drops that block makes
      // it differ, so the current block is always in the request (Goal 3).
      const goal = typeof this.options.goal === 'function' ? this.options.goal() : this.options.goal
      const context = sessionContextBlock({
        ...(this.options.workMode ? { workMode: this.options.workMode() } : {}),
        ...(this.options.interactionMode ? { interactionMode: this.options.interactionMode() } : {}),
        // The model's own sense of "now" is its training cutoff (DSH time context).
        date: new Date().toLocaleDateString('sv-SE'),
        ...(goal ? { goal } : {}),
        sections: [ledger.render(), this.options.memory?.render() ?? '', native && mcpSpecs.length ? '' : this.options.mcpCatalog ?? '', projectChecks, this.options.sessionContext?.() ?? ''],
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
          ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
          ...(this.effort ? { effort: this.effort } : {}),
          ...(this.options.signal ? { signal: this.options.signal } : {}),
          ...(requestTools ? { tools: requestTools } : {}),
        })
      } catch (error) {
        if (this.options.signal?.aborted) throw new AbortRunError('turn cancelled')
        // The endpoint refused the request because of the context length: compact
        // now (once) and retry, instead of losing the turn.
        if (isContextOverflow(error) && this.options.context?.forceCompact && forcedCompactions < 3) {
          forcedCompactions += 1
          // The error may state the real window (an unregistered model): compact for that one.
          const window = statedContextLimit(error)
          if (window !== undefined) this.options.context.learnContextWindow?.(window)
          this.options.sessionLog.append('context/forced-compaction', { step, reason: error instanceof Error ? error.message.slice(0, 300) : 'context overflow', ...(window !== undefined ? { window } : {}) })
          const before = estimateTokens(messages.map((message) => message.content).join('\n'))
          messages = await this.options.context.forceCompact(messages, requestTools)
          // Nothing left to shorten: another identical request would fail the same way.
          if (estimateTokens(messages.map((message) => message.content).join('\n')) >= before) forcedCompactions = 3
          step -= 1
          continue
        }
        // A capability rejection, not any 400 that mentions a tool: switch the
        // turn to the JSON text protocol.
        if (native && error instanceof LlmError && error.status === 400 && rejectsTools(error.message)) {
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
      this.options.context?.afterResponse?.(messages, { usage: { inputTokens: completion.usage.inputTokens } }, replayTools)
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
      // Native arguments arrive as an object on most endpoints, but some send a
      // JSON string or a one-element array; coerce before deciding they are broken.
      // Every native call gets an id (the provider's, else one of ours), so the
      // adapters can replay the step in the API's own call/result shape.
      const nativeCalls = completion.toolCalls?.map(({ name, args, id }) => ({ tool: name, args: coerceArgs(args), id: id || `call_${randomUUID().replace(/-/g, '').slice(0, 16)}` }))
      const wireCalls = nativeCalls?.flatMap((call) => (call.args === undefined ? [] : [{ tool: call.tool, args: call.args }]))
      const historyCalls = nativeCalls?.length && wireCalls?.length === nativeCalls.length
        ? nativeCalls.map((call) => ({ id: call.id, name: call.tool, args: call.args }))
        : undefined
      const wireReply = wireCalls?.length ? JSON.stringify(wireCalls.length === 1 ? wireCalls[0] : { calls: wireCalls }) : completion.content.trim()
      const reply = (text: string): ChatMessage => ({
        role: 'assistant', content: text,
        ...(kept ? { reasoning: kept } : {}),
        ...(completion.gemini && text === wireReply ? { gemini: { ...completion.gemini, content: text } } : {}),
        ...(historyCalls && text === wireReply ? { toolCalls: historyCalls } : {}),
        ...(historyCalls && text === wireReply && completion.thinkingBlocks?.length ? { thinkingBlocks: completion.thinkingBlocks } : {}),
      })
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
        replyChannel: wireCalls?.length ? 'native' : wireReply ? 'text' : 'empty',
        ...(completion.outputLimited ? { outputLimited: true } : {}),
        // Detects prompt-template changes between steps (design §1).
        systemSha256: createHash('sha256').update(messages[0].content).digest('hex').slice(0, 16),
      })
      this.options.onEvent?.({ type: 'step-end', step, usage: completion.usage })
      for (const instruction of instructions) this.options.onEvent?.({ type: 'steer-applied', step, id: instruction.id, source: instruction.source })

      const retryReply = (reason: string, nudge: string) => {
        messages.push({ role: 'user', content: nudge })
        this.options.sessionLog.append('turn/retry', { step, reason, ...replay(messages, false) })
        this.options.onEvent?.({ type: 'retry', step, reason, content: truncate(wireReply, 2_000) })
      }
      if (completion.outputLimited) {
        if (limitedRetried) return failReply(step, 'output-limit', 'the provider cut off two replies at its output limit', false)
        limitedRetried = true
        retryReply('output-limit', 'The provider cut off your reply at its output limit. None of its calls ran. Continue from the last confirmed result and send one smaller, complete action. ' +
          'Split large edits into separate calls; write a large new file in parts: create it with the first part, then add each further part with its own edit.')
        continue
      }
      limitedRetried = false
      const retryProtocol = (reason: string) => {
        if (brokenRetried && native) {
          native = false
          protocolFallback = true
          // The downgrade is a fresh start for the text protocol: its first
          // format mistake gets its own retry. Keeping the native-mode flag
          // ended the turn on the first text reply that was neither a call nor
          // a final, before the model could follow the new instructions
          // (verify-agent-budget 4-a).
          brokenRetried = false
          this.options.sessionLog.append('native-tools/off', { step, reason })
          retryReply('tool-protocol-fallback', 'Native tool replies were invalid. No calls from those replies ran. Use the current JSON text protocol and send one complete action from the last confirmed result.')
        } else {
          brokenRetried = true
          retryReply(reason, native
            ? 'The tool reply was invalid and none of its calls ran. Send one complete native function call with object arguments, continuing from the last confirmed result.'
            : TEXT_PROTOCOL_RETRY)
        }
      }
      // The stream was cut because the model looped on one fragment: the text
      // is not an answer and may hold half a tool call. Retry once with the
      // loop removed from the history; a second loop ends the turn plainly.
      if (completion.degenerate === 'repetition') {
        const cut = completion.content.trim()
        if (cut) messages.push(reply(cut))
        if (degenerateRetried) {
          return failReply(step, 'repetition', 'repeated model output prevented continuation', Boolean(cut))
        }
        degenerateRetried = true
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
      if (nativeCalls && nativeCalls.length > 0) {
        if (nativeCalls.some(({ args }) => args === undefined)) {
          if (brokenRetried && !native) return failReply(step, 'tool-protocol', 'invalid native tool arguments prevented continuation', false)
          retryProtocol('invalid-native-arguments')
          continue
        }
        calls = wireCalls
        // History keeps one string per message: the calls in the text protocol's form.
        content = wireReply
      } else {
        // A call batch cut short by leaked template tags is restored, not
        // retried; history keeps the repaired text, as the model will see it.
        const recovered = recoverTemplateCall(content)
        if (recovered !== undefined) {
          this.options.sessionLog.append('reply/recovered', { step, reason: 'template-tail', removed: content.length - recovered.length })
          content = recovered
        }
        // A batch written without its `{"calls":[` opener: every call runs.
        const batch = recoverUnwrappedBatch(content)
        if (batch !== undefined) {
          this.options.sessionLog.append('reply/recovered', { step, reason: 'unwrapped-batch' })
          content = batch
        }
        // A call or `{"calls":[...]}` batch with a missing closing `}` / `]` or
        // raw newlines inside string literals.
        const malformed = recoverMalformedCall(content)
        if (malformed !== undefined) {
          this.options.sessionLog.append('reply/recovered', { step, reason: 'malformed-call' })
          content = malformed
        }
        // Only a whole reply runs. When just its first object parses and more
        // calls follow, running that object alone dropped the rest silently
        // (an orchestrator then reported four workers that never started).
        const partial = hasCallsAfterFirstObject(content)
        // Native mode runs a text call only when the whole reply is that call
        // (a model that wrote its call as text, or leaked a template tail).
        // `parseAction`'s "first balanced object" fallback is for the text
        // protocol: in native mode it ran a call quoted inside a prose answer.
        action = partial ? undefined : native ? parseWholeAction(content) : parseAction(content)
        // Native mode: one whole JSON value is an answer, but a body cut off
        // after a readable object (`{"final":"ok"}…`) is not — without this it
        // ended the turn with the truncated text.
        if (native && action !== undefined && action.final !== undefined && looksLikeBrokenToolCall(content)) action = undefined
        // `{"tools":[...]}` is the same batch under another name. As valid JSON
        // it is not a broken call, so without this it was taken as the final
        // answer and the turn ended mid-task (security-holdout thorough #4).
        if (action && !Array.isArray(action.calls) && Array.isArray(action.tools) && action.final === undefined) action.calls = action.tools
        // A batch with an entry that is not a call ({"note":...}, a string):
        // running the rest would drop that entry without a word.
        const badEntry = !!action && Array.isArray(action.calls) && action.calls.some((c) => !isCallEntry(c))
        if (badEntry) action = undefined
        if (action && Array.isArray(action.calls)) {
          calls = action.calls.filter(isCallEntry).map(normalizeCall)
        } else if (action && (typeof action.tool === 'string' || (action.final === undefined && typeof action.name === 'string' && (action.args !== undefined || action.arguments !== undefined)))) {
          calls = [normalizeCall(action as unknown as Record<string, unknown>)]
        } else if (native && content && (!action || action.final === undefined)) {
          if (partial || badEntry || looksLikeBrokenToolCall(content)) {
            retryProtocol('broken-tool-call')
            continue
          }
          // A complete call written inside prose never runs: ask once for a
          // real function call (or a fenced example); a repeat is the answer.
          if (!embeddedNudged && embedsCallInProse(content)) {
            embeddedNudged = true
            messages.push(reply(content))
            messages.push({ role: 'user', content: EMBEDDED_CALL_NUDGE })
            this.options.sessionLog.append('turn/retry', { step, reason: 'call-in-prose', ...replay(messages, true) })
            this.options.onEvent?.({ type: 'retry', step, reason: 'call-in-prose', content: truncate(content, 2_000) })
            continue
          }
          // Goal mode: a plan, confirmation request or "I will proceed" is not
          // an answer. Nudge once to execute; if the model repeats it, accept
          // the reply as final instead of looping. Exempt when yielding to wait
          // for active async workers.
          if (this.options.goalMode && !goalNudged && performedToolCalls === 0 && !this.options.allowWaitingReply?.()) {
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
        if (protocolFallback && brokenRetried) {
          return failReply(step, 'tool-protocol', 'invalid tool replies persisted after switching protocols', false)
        }
        if (!native && content && looksLikeBrokenToolCall(content)) {
          if (brokenRetried) return failReply(step, 'tool-protocol', 'consecutive invalid tool calls prevented continuation', false)
          retryProtocol('broken-tool-call')
          continue
        }
        messages.push(reply(content))
        // Two consecutive empty replies (in either native or text mode) stop
        // the turn instead of looping to the step limit.
        if (!content && emptyReplied) {
          return failReply(step, 'empty-reply', 'the model returned an empty reply twice')
        }
        // Native mode has no JSON text protocol: an empty reply carries neither a
        // tool call nor text, so the text-protocol retry below cannot help it and
        // a model that answers with reasoning only would repeat it to the limit.
        if (native && !content) {
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
        if (!native && invalidTextRetried) {
          return failReply(step, 'invalid-json', 'two replies did not conform to the text tool protocol')
        }
        invalidTextRetried = !native
        emptyReplied = !content
        messages.push({ role: 'user', content: TEXT_PROTOCOL_RETRY })
        this.options.sessionLog.append('turn/retry', { step, reason: 'invalid-json', ...replay(messages, true) })
        this.options.onEvent?.({ type: 'retry', step, reason: 'invalid-json', content: truncate(content, 2_000) })
        continue
      }
      emptyReplied = false
      invalidTextRetried = false

      if (!calls && this.options.steer?.hasInterrupt()) {
        messages.push(reply(content))
        messages.push({ role: 'user', content: 'A newer instruction arrived while this reply was being generated. Read it before completing the turn; the previous reply was not delivered as final.' })
        this.options.sessionLog.append('turn/retry', { step, reason: 'pending-instruction', ...replay(messages, true) })
        continue
      }
      // Native call ids are logged so a resumed session replays the steps in
      // the same structured form (`rebuildHistory`).
      const loggedCallIds = calls && historyCalls && content === wireReply ? historyCalls.map((call) => call.id) : undefined
      this.options.sessionLog.append('assistant/message', { content, ...(kept ? { withReasoning: true } : {}), ...(loggedCallIds ? { toolCallIds: loggedCallIds } : {}) })
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

      // A final answer that ends by announcing the agent's own next step
      // ("ここを確認します。", "I'll add the test now.") did nothing: the turn
      // would stop and leave the user waiting. Nudge once, in every mode; the
      // model either acts or says plainly that it is waiting.
      const announcedStep =
        action !== undefined &&
        typeof action.final === 'string' &&
        (announcesNextStep(action.final) || announcePatterns.some((pattern) => pattern.test(action.final as string)))
      if (!calls && action && typeof action.final === 'string' && !objectiveMode && !announceNudged && !lastStepDelegated && !this.options.allowWaitingReply?.() && announcedStep) {
        announceNudged = true
        messages.push(reply(content))
        messages.push({ role: 'user', content: ANNOUNCED_WITHOUT_ACTION })
        this.options.sessionLog.append('turn/nudge', { step, reason: 'announced-without-action', ...replay(messages, false) })
        this.options.onEvent?.({ type: 'retry', step, reason: 'announced-without-action', content: truncate(action.final, 2_000) })
        continue
      }

      // A final answer right after a code edit that nothing has checked: send it
      // back once. The model either runs a check or says what is unverified; a
      // second final is accepted either way (the summary below records which).
      const unchecked = !calls && action && typeof action.final === 'string' && !objectiveMode ? progress.uncheckedEdits() : []
      if (unchecked.length > 0 && this.options.verifyGate !== false && !verifyNudged && !lastStepDelegated && !this.options.allowWaitingReply?.()) {
        verifyNudged = true
        messages.push(reply(content))
        messages.push({ role: 'user', content: verificationNudge(unchecked) })
        this.options.sessionLog.append('turn/nudge', { step, reason: 'final-without-verification', files: unchecked.slice(0, 20), ...replay(messages, false) })
        this.options.onEvent?.({ type: 'retry', step, reason: 'final-without-verification', content: truncate(String(action!.final), 2_000) })
        continue
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
        const verification = this.recordVerification(progress)
        this.options.sessionLog.append('turn/end', { status: 'completed' })
        messages.push(reply(content))
        this.options.onEvent?.({ type: 'final', content: action.final, ...(verification ? { verification } : {}) })
        return { outcome: 'final', final: action.final, steps: step, usage, history: messages.slice(1) }
      }

      if (calls && calls.length > 0) {
        const key = JSON.stringify(calls)
        repeats = key === lastCall ? repeats + 1 : 1
        lastCall = key
        messages.push(reply(content))
        for (const [key, entry] of unchanged) if (step - entry.step > 32) unchanged.delete(key)
        const outcomes = await this.executeCalls(step, calls, unchanged)
        const reminder = repeats >= 2 && calls.every((call) => (unchanged.get(callFingerprint(call))?.count ?? 0) >= 2)
          ? repeatReminder(repeats) : ''
        if (reminder) this.options.sessionLog.append('guard/repeat', { tool: calls.map((c) => c.tool).join(','), times: repeats })
        if (outcomes.some((outcome) => outcome.ok)) {
          brokenRetried = false
          // The no-progress guard counts *consecutive* steps without progress:
          // a successful call in between means the turn is moving, so two
          // all-blocked steps elsewhere in the turn are not a stall
          // (verify-agent-budget 4-c).
          blockedSteps = 0
        }
        lastStepDelegated = outcomes.some((o) => o.ok && DELEGATING_TOOLS.has(o.call.tool))
        performedToolCalls += calls.length
        const stall = progress.record(step, outcomes)
        if (stall.level > 0) this.options.sessionLog.append('guard/stall', { step, steps: stall.steps, level: stall.level })
        // WP-30: `read_image` hands the bytes over out of band. They ride on the
        // tool-result message, so the assistant/user alternation (and the mock's
        // request shape) stays exactly as before.
        const images = this.options.tools.takeImages()
        stepHistory.push(JSON.stringify([calls, outcomes.map((o) => o.ok), calls.map((call) => unchanged.get(callFingerprint(call))?.result)]))
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
        const waiting = this.options.allowWaitingReply?.() === true
        const waitingHint = (reminder || loopNote || stall.level > 0) && waiting
          ? '\n[waiting hint] Async workers are currently active. Stop calling tools to poll or fill time—reply briefly in plain text without tool calls to end this turn and wait for automatic wakeup.'
          : ''
        const stallHint = !waiting && (stall.level === 1 || stall.level === 2) ? stallNote(stall, this.options.ask === true) : ''
        // The step's native calls, matched one to one with its results.
        const structuredCalls = historyCalls?.length === outcomes.length ? historyCalls : undefined
        const parts = outcomes.map((o, i) => {
          const tail = i === outcomes.length - 1 ? reminder + loopNote + stallHint + waitingHint : ''
          const output = o.output + tail
          this.options.sessionLog.append('tool/result', {
            callId: o.callId,
            ...(structuredCalls ? { toolCallId: structuredCalls[i]!.id } : {}),
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
        const toolResultText = `${parts.join('\n\n')}${imageNote}`
        messages.push({
          role: 'user',
          content: toolResultText,
          ...(structuredCalls ? {
            toolResults: {
              entries: structuredCalls.map((call, i) => ({ id: call.id, name: call.name, text: parts[i]! })),
              rendered: toolResultText,
            },
          } : {}),
          ...(images.length > 0 ? { images: images.map((image) => ({ mimeType: image.mimeType, data: image.data })) } : {}),
        })
        if (images.length > 0) this.options.sessionLog.append('image/attached', { step, files: images.map((image) => image.label) })
        if (outcomes.every((outcome) => outcome.blocked)) {
          if (this.options.allowWaitingReply?.() && !this.options.steer?.hasInterrupt()) {
            const final = 'Waiting for the active workers. Their reports will resume this turn’s work.'
            // The turn ends on this text, so the conversation must end on an
            // assistant message: without it the history and the reloaded log ended
            // with the tool result and the waiting line vanished from the
            // transcript (verify-agent-budget 4-b).
            messages.push(reply(final))
            this.options.sessionLog.append('assistant/message', { content: final, ...(kept ? { withReasoning: true } : {}) })
            this.options.sessionLog.append('turn/end', { status: 'completed', reason: 'waiting-for-workers' })
            this.options.onEvent?.({ type: 'final', content: final })
            return { outcome: 'final', final, steps: step, usage, history: messages.slice(1) }
          }
          if (++blockedSteps >= 2 && !this.options.steer?.hasInterrupt()) {
            return failReply(step, 'tool-no-progress', 'repeated tool calls produced no new result', false)
          }
        }
        if (stall.level === 3 && !waiting && !this.options.steer?.hasInterrupt()) {
          return failReply(step, 'no-progress', `${stall.steps} consecutive steps made no progress (no successful edit and no new tool result)`, false)
        }
        // claim_complete, directly or from a run_code script, ends the session.
        const claim = this.options.tools.takeClaim()
        if (claim !== undefined) {
          this.recordVerification(progress)
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

  /** Logs the turn's verification summary; returns the GUI notice for it. */
  private recordVerification(progress: TurnProgress): { text: string; level: 'info' | 'warn' } | undefined {
    const summary = progress.summary()
    if (summary.editedFiles.length === 0 && summary.checks.length === 0) return undefined
    this.options.sessionLog.append('turn/verification', { ...summary })
    return verificationNoticeText(summary)
  }

  /**
   * Runs one step's calls: all at once when every one is read-only, else in
   * order. Errors become tool errors except run-ending ones.
   */
  private async executeCalls(step: number, calls: Call[], unchanged: Map<string, { result: string; count: number; step: number }>) {
    const one = async (call: Call, i: number) => {
      const prefix = this.options.callIdPrefix ?? ''
      const callId = calls.length === 1 ? `${prefix}step-${step}` : `${prefix}step-${step}.${i + 1}`
      if (this.options.signal?.aborted) throw new AbortRunError('turn cancelled')
      this.options.onEvent?.({ type: 'tool-start', step, callId, name: call.tool, args: call.args })
      const key = callFingerprint(call)
      const previous = unchanged.get(key)
      const observe = (output: string) => {
        const result = createHash('sha256').update(output).digest('hex')
        unchanged.set(key, { result, count: previous?.result === result ? previous.count + 1 : 1, step })
      }
      try {
        if (this.options.steer?.hasInterrupt()) throw new Error('A newer instruction arrived; this call did not run. Read the instruction before continuing.')
        if ((previous?.count ?? 0) >= 3) {
          this.options.sessionLog.append('guard/no-progress', { step, tool: call.tool, times: previous!.count })
          return { call, callId, ok: false as const, blocked: true, denial: undefined, output: 'This call did not run. It already returned the same result three times without a changed prerequisite. Use a different action or wait for new evidence.' }
        }
        const result = await this.options.tools.execute(call.tool, call.args)
        const raw = JSON.stringify(result, null, 2)
        const shellFailed = call.tool === 'shell' && (result.timedOut === true || typeof result.exitCode === 'number' && result.exitCode !== 0)
        const changedCwd = call.tool === 'working_directory' && !!(call.args as { path?: string } | undefined)?.path
        if (changedCwd || ['apply_patch', 'write_file', 'edit_file'].includes(call.tool)) {
          // Workspace edits and cwd changes can invalidate prior file checks.
          unchanged.clear()
        } else if (call.tool === 'shell') {
          if (result.status !== 'backgrounded') {
            // A command that succeeded may have changed anything, so every other
            // tool's earlier observation is stale and is dropped. The call's own
            // entry is written again by `observe` with the count it already had,
            // so repeating the same command is still detected
            // (verify-agent-budget 4-c).
            if (!shellFailed) unchanged.clear()
            observe(JSON.stringify([result.exitCode, result.timedOut, result.stdout, result.stderr]))
          }
        } else if (call.tool === 'run_code') {
          // A script can change anything, same as a shell command.
          unchanged.clear()
          observe(raw)
        } else if (this.options.tools.isReadOnly?.(call.tool) || call.tool === 'mcp_call' ||
                   call.tool.startsWith('browser_') || call.tool.startsWith('mcp_')) {
          observe(raw)
        }
        const view = this.options.context?.toolOutput(callId, raw) ?? { visible: truncate(raw) }
        if (shellFailed) {
          return { call, callId, ok: false as const, output: view.visible }
        }
        return { call, callId, ok: true as const, result, output: view.visible, ...(view.spillRef ? { spillRef: view.spillRef } : {}) }
      } catch (error) {
        // Run-ending errors (e.g. Guardian's breaker) are not the model's to fix.
        if (error instanceof AbortRunError) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (!this.options.steer?.hasInterrupt()) observe(message)
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
    const parallel = calls.length > 1 && new Set(calls.map(callFingerprint)).size === calls.length && calls.every((c) => this.options.tools.isReadOnly(c.tool))
    if (parallel) return Promise.all(calls.map(one))
    const out = []
    for (let i = 0; i < calls.length; i++) out.push(await one(calls[i]!, i))
    return out
  }
}
