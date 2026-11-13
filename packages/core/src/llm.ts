import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { roleApiKey, type RoleConfig } from './config.js'
import { isSteerMessage, steerText } from './steering.js'
import { catalogForRole, effortWithToolsFor, reasoningEchoFor, rememberReportedVision, temperatureAllowedFor, tokenFieldFor } from './model-catalog.js'
import {
  learnFromError,
  negotiatedEffort,
  negotiatedMaxTokens,
  normalizeUsage,
  requestHeaders,
  requestSignal,
  sharedProviderState,
  textOf,
  type ProviderNegotiationState,
  type RawUsage,
} from './llm-negotiate.js'
import { estimateTokens } from './tokens.js'
import { redactSecrets } from './secret-scan.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Attached images (user messages; Codex `--image`). Not logged: the log records their paths. */
  images?: ImageInput[]
  /**
   * Assistant messages: the reasoning that produced this reply, kept when
   * `reasoningHistory` is `full` and sent back where the provider takes it
   * (DeepSeek `reasoning_content`).
   */
  reasoning?: string
  /** Provider continuation metadata. Local history remains authoritative. */
  gemini?: GeminiContinuation & { content: string }
  /**
   * Assistant messages: the native calls this reply made. `content` keeps them
   * in the text protocol's form (logs, the text-protocol fallback); adapters
   * that offer tools replay them in the API's own call shape instead, so the
   * model never sees its own calls as JSON prose to imitate.
   */
  toolCalls?: HistoryToolCall[]
  /** User messages: one result per call of the assistant message before it. */
  toolResults?: { entries: NativeToolResult[]; rendered: string }
  /** Assistant messages: signed thinking blocks (Anthropic), replayed before tool_use. */
  thinkingBlocks?: unknown[]
}

/** A native call kept on its assistant message (`ChatMessage.toolCalls`). */
export interface HistoryToolCall {
  id: string
  name: string
  args: unknown
}

/** One step's calls and the result text of each, in call order. */
interface ToolExchange {
  calls: HistoryToolCall[]
  results: Array<{ id: string; name: string; text: string }>
  /** Text that rode on the results message after the results (session context, notes). */
  extra: string
  images?: ImageInput[]
}

export type WireItem = { kind: 'message'; message: ChatMessage } | { kind: 'exchange'; message: ChatMessage; exchange: ToolExchange }

/**
 * The conversation with each tool step paired up: an assistant message that
 * made native calls, and the results that answered them. With `structured`
 * false (no tools offered: the text protocol) every message stays as it is.
 *
 * The results are taken per call when the results message is unchanged since
 * the step ran. Compaction rewrites old results into a locator; then the whole
 * message answers the first call, so every call still gets its answer (the
 * APIs reject a call without one) and nothing pruned comes back.
 */
export function wireItems(messages: readonly ChatMessage[], structured: boolean | ((message: ChatMessage) => boolean)): WireItem[] {
  const out: WireItem[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    const allowed = typeof structured === 'function' ? structured(message) : structured
    if (!allowed || message.role !== 'assistant' || !message.toolCalls?.length) {
      out.push({ kind: 'message', message })
      continue
    }
    const calls = message.toolCalls
    const next = messages[i + 1]?.role === 'user' ? messages[i + 1] : undefined
    const results = next?.toolResults
    const exact = next && results && next.content.startsWith(results.rendered) &&
      results.entries.length === calls.length && results.entries.every((entry, k) => entry.id === calls[k]!.id)
    const exchange: ToolExchange = exact
      ? {
          calls,
          results: results.entries.map(({ id, name, text }) => ({ id, name, text })),
          extra: next.content.slice(results.rendered.length).trim(),
          ...(next.images?.length ? { images: next.images } : {}),
        }
      : {
          calls,
          results: calls.map((call, k) => ({
            id: call.id,
            name: call.name,
            text: k === 0 ? next?.content || '(no result recorded)' : '(this result is included in the first result of this step)',
          })),
          extra: '',
          ...(next?.images?.length ? { images: next.images } : {}),
        }
    out.push({ kind: 'exchange', message, exchange })
    if (next) i += 1
  }
  return out
}

/**
 * Reasoning written into the reply text as `<think>…</think>` (models served
 * through chat templates that do not split it out) belongs in `reasoning`: left
 * in `content` it became the final answer, and a `{` inside it could be read as
 * a tool call. A reply that opens `<think>` and never closes it was cut off
 * while thinking; one that only closes it (`…</think>answer`) had the opening
 * tag eaten by the template.
 */
export function splitThinkTags(content: string): { content: string; reasoning?: string } {
  const open = /^\s*<think>/.exec(content)
  if (open) {
    const rest = content.slice(open[0].length)
    const close = rest.indexOf('</think>')
    if (close < 0) return { content: '', reasoning: rest.trim() }
    return { content: rest.slice(close + '</think>'.length).trim(), reasoning: rest.slice(0, close).trim() }
  }
  const close = content.indexOf('</think>')
  if (close >= 0 && !content.includes('<think>') && !content.slice(0, close).includes('```')) {
    return { content: content.slice(close + '</think>'.length).trim(), reasoning: content.slice(0, close).trim() }
  }
  return { content }
}

/** Joins reasoning from a separate channel and from `<think>` tags. */
function withThinkSplit(content: string, reasoning: string | undefined): { content: string; reasoning?: string } {
  const split = splitThinkTags(content)
  const joined = [reasoning, split.reasoning].filter((part) => part && part.trim()).join('\n')
  return { content: split.content, ...(joined ? { reasoning: joined } : {}) }
}

interface GeminiContinuation {
  id: string
  prefix: string
  callIds: string[]
}

interface NativeToolResult {
  id: string
  name: string
  text: string
}

export interface ImageInput {
  mimeType: string
  /** Base64 data. */
  data: string
}

/** Messages in Ollama's shape: images as a base64 list beside the text; tool steps as `tool_calls` / `role: tool`. */
function ollamaMessages(messages: ChatMessage[], structured = false) {
  const plain = (m: ChatMessage) => (m.images?.length ? { role: m.role, content: m.content, images: m.images.map((i) => i.data) } : { role: m.role, content: m.content })
  return wireItems(messages, structured).flatMap((item): unknown[] => {
    if (item.kind === 'message') return [plain(item.message)]
    const { calls, results, extra, images } = item.exchange
    return [
      { role: 'assistant', content: '', tool_calls: calls.map((call) => ({ function: { name: call.name, arguments: call.args ?? {} } })) },
      ...results.map((result) => ({ role: 'tool', content: result.text, tool_name: result.name })),
      ...(extra || images?.length ? [{ role: 'user', content: extra, ...(images?.length ? { images: images.map((i) => i.data) } : {}) }] : []),
    ]
  })
}

/** Messages in the OpenAI Chat Completions shape: images as data-URL content parts. */
/**
 * Chat Completions messages. `withReasoning`: assistant messages carry their
 * reasoning as `reasoning_content` (DeepSeek, including through OpenCode);
 * other OpenAI-compatible servers may reject the field, so it is opt-in.
 */
export function openAiMessages(messages: ChatMessage[], withReasoning = false, structured = false) {
  const withImages = (role: string, text: string, images: ImageInput[] | undefined) =>
    images?.length
      ? {
          role,
          content: [
            { type: 'text', text },
            ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
          ],
        }
      : { role, content: text }
  return wireItems(messages, structured).flatMap((item): unknown[] => {
    const m = item.message
    const reasoning = withReasoning && m.role === 'assistant' && m.reasoning ? { reasoning_content: m.reasoning } : {}
    if (item.kind === 'message') {
      return [reasoning.reasoning_content ? { role: m.role, content: m.content, ...reasoning } : withImages(m.role, m.content, m.images)]
    }
    const { calls, results, extra, images } = item.exchange
    return [
      {
        role: 'assistant',
        // An empty string, not null: several compatible servers reject null content.
        content: '',
        ...reasoning,
        tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })),
      },
      ...results.map((result) => ({ role: 'tool', tool_call_id: result.id, content: result.text })),
      ...(extra || images?.length ? [withImages('user', extra, images)] : []),
    ]
  })
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** Provider-reported prompt-cache hits (DeepSeek: prompt_cache_hit_tokens). */
  cacheHitTokens?: number
  /** Provider-reported prompt-cache misses. Derived from input - hit when absent. */
  cacheMissTokens?: number
}

/** One tool call returned through a provider's native function-calling interface. */
export interface ToolCall {
  name: string
  id?: string
  /** Parsed arguments (OpenAI sends a JSON string; an unparsable one is kept as the string). */
  args: unknown
}

export interface Completion {
  content: string
  usage: Usage
  /** DeepSeek / reasoning models may return their chain of thought separately. */
  reasoning?: string
  /** Native function calls, when the request offered `tools`. */
  toolCalls?: ToolCall[]
  /** The provider stopped at its output limit. A partial tool batch must never run. */
  outputLimited?: true
  gemini?: GeminiContinuation
  /** Signed thinking blocks to replay with this reply's tool calls (Anthropic). */
  thinkingBlocks?: unknown[]
  /**
   * Set when the harness cut the stream because the model fell into a loop
   * repeating a short fragment; `content` / `reasoning` end where the loop
   * began. Usage is then partial (the provider's final usage never arrived).
   */
  degenerate?: 'repetition'
}

/** How long a run of one short repeated fragment may grow before the stream is cut. */
export const REPETITION_LIMIT_CHARS = 4_000
const REPETITION_MAX_PERIOD = 512

/**
 * Where a runaway repetition at the end of `text` begins: the tail is one
 * fragment of at most 512 chars repeated over at least 4,000 chars (e.g.
 * `]}}]}}]}}…` or a repeated reasoning sentence). Undefined when the tail is
 * ordinary text.
 */
export function repetitionStart(text: string): number | undefined {
  if (text.length < REPETITION_LIMIT_CHARS) return undefined
  for (let period = 1; period <= REPETITION_MAX_PERIOD; period++) {
    let i = text.length - 1 - period
    while (i >= 0 && text[i] === text[i + period]) i--
    const start = i + 1
    if (text.length - start >= REPETITION_LIMIT_CHARS) {
      // Keep the first occurrence: it may complete what came before it.
      return Math.min(text.length, start + period)
    }
  }
  return undefined
}

/** A tool offered through native function calling (JSON Schema parameters, root type object). */
export interface NativeToolDef {
  name: string
  description: string
  parameters: unknown
}

export interface CompleteOptions {
  maxTokens: number
  /** Omitted: the provider's (model author's) default. */
  temperature?: number
  /** Provider-specific reasoning effort (`none` / `minimal` / `low` … `max`). */
  effort?: string
  signal?: AbortSignal
  /** Offer these tools natively; the reply may then carry `toolCalls`. */
  tools?: NativeToolDef[]
  /** Constrained JSON is the default for tool-less calls; set false for prose. */
  json?: boolean
  /** CP-18: receives incremental text while the reply streams (OpenAI-compatible adapters). */
  onDelta?: (delta: { content?: string; reasoning?: string }) => void
}

/** The OpenAI / Ollama `tools` request field. */
function toolsField(tools: NativeToolDef[]) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
}

function escapeStringControlChars(text: string): string {
  let out = ''
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      if (escape) {
        escape = false
        out += c
      } else if (c === '\\') {
        escape = true
        out += c
      } else if (c === '"') {
        inString = false
        out += c
      } else if (c === '\n') {
        out += '\\n'
      } else if (c === '\r') {
        out += '\\r'
      } else if (c === '\t') {
        out += '\\t'
      } else {
        out += c
      }
      continue
    }
    if (c === '"') inString = true
    out += c
  }
  return out
}

/**
 * Recovers a JSON argument object when a model's tool-call arguments string has
 * minor syntax noise: leaked template closing tags, raw newlines inside string
 * literals, an extra closing brace (`{...}}`), or a second concatenated call
 * after an accidentally escaped quote (`...\"}},{"tool":...`).
 */
export function parseLooseJsonObject(raw: string): Record<string, unknown> | undefined {
  let s = raw.trim()
  if (!s.startsWith('{')) return undefined
  const cut = s.search(/<\/(?:｜|\||tool_calls?(?:[:>])|arg_value(?:[:>])|function(?:[:>])|invoke>|parameter>)/)
  if (cut > 0) s = s.slice(0, cut).trimEnd()
  const tryParse = (candidate: string): Record<string, unknown> | undefined => {
    for (const variant of [candidate, escapeStringControlChars(candidate)]) {
      try {
        const parsed = JSON.parse(variant) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        // try next
      }
    }
    return undefined
  }
  const direct = tryParse(s)
  if (direct) return direct
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
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
        const first = tryParse(s.slice(0, i + 1))
        if (first) return first
        break
      }
    }
  }
  const concatMatch = /\\"\}\s*\}\s*,\s*\{\s*"tool"\s*:/.exec(s)
  if (concatMatch && concatMatch.index > 0) {
    const fromConcat = tryParse(`${s.slice(0, concatMatch.index)}"}`)
    if (fromConcat) return fromConcat
  }
  return undefined
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return parseLooseJsonObject(raw) ?? raw
  }
}

export interface LlmProvider {
  readonly name: string
  complete(messages: ChatMessage[], options: CompleteOptions): Promise<Completion>
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

export interface RetryOptions {
  retries: number
  baseDelayMs: number
  maxDelayMs: number
}

// An overloaded provider (OpenCode "server is overloaded", HTTP 429) used to
// fail a whole turn after ~3.5 s of retries (benchmark 2026-11-07). Six retries
// with jittered backoff wait up to ~45 s, close to DeepSeek Harness (5 retries).
const DEFAULT_RETRY: RetryOptions = { retries: 6, baseDelayMs: 1_000, maxDelayMs: 15_000 }

/** Exponential backoff with ±25% jitter, so parallel sessions do not retry in step. */
export function backoffMs(retry: RetryOptions, attempt: number, random = Math.random()): number {
  return Math.round(Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt) * (0.75 + random * 0.5))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })
}

/**
 * POSTs and returns the response text, retrying 429 and 5xx (honoring
 * `Retry-After`) and network errors with exponential backoff (design §9).
 * Other HTTP errors fail at once with `LlmError`.
 *
 * Retries are not suppressed when a USD budget is active: a 5xx or a failed
 * connection is assumed not to have been billed, so retrying does not spend
 * past the reservation. This is provider-dependent — a provider may bill a
 * request that failed after it was received — hence the caller's settlement:
 * a request that returns no usage is settled at the full reservation.
 */
export async function postWithRetry(
  label: string,
  url: string,
  init: { headers: Record<string, string>; body: string; signal?: AbortSignal },
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: init.headers,
        body: init.body,
        ...(init.signal !== undefined ? { signal: init.signal } : {}),
      })
    } catch (error) {
      if (init.signal?.aborted || attempt >= retry.retries) throw error
      await sleep(backoffMs(retry, attempt), init.signal)
      continue
    }
    const text = await response.text()
    if (response.ok) return text
    const retriable = response.status === 429 || response.status >= 500
    if (!retriable || attempt >= retry.retries) {
      throw new LlmError(`${label} HTTP ${response.status}: ${text.slice(0, 800)}`, response.status, text)
    }
    const after = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(after) && after > 0 ? Math.min(retry.maxDelayMs, after * 1_000) : backoffMs(retry, attempt)
    await sleep(delay, init.signal)
  }
}

/**
 * CP-18: opens a streaming POST, retrying like `postWithRetry` (429, 5xx,
 * network errors; `Retry-After` honoured) until the response is OK. Nothing
 * has been streamed before the status is known, so a retry cannot duplicate
 * output. Returns the open response; its body is the caller's to read. The
 * billing assumption behind retrying under a USD budget is stated on
 * `postWithRetry`.
 */
export async function openStreamWithRetry(
  label: string,
  url: string,
  init: { headers: Record<string, string>; body: string; signal?: AbortSignal },
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, ...(init.signal !== undefined ? { signal: init.signal } : {}) })
    } catch (error) {
      if (init.signal?.aborted || attempt >= retry.retries) throw error
      await sleep(backoffMs(retry, attempt), init.signal)
      continue
    }
    if (response.ok) return response
    const text = await response.text()
    const retriable = response.status === 429 || response.status >= 500
    if (!retriable || attempt >= retry.retries) {
      throw new LlmError(`${label} HTTP ${response.status}: ${text.slice(0, 300)}`, response.status, text.slice(0, 300))
    }
    const after = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(after) && after > 0 ? Math.min(retry.maxDelayMs, after * 1_000) : backoffMs(retry, attempt)
    await sleep(delay, init.signal)
  }
}

export class OllamaProvider implements LlmProvider {
  readonly name: string
  private readonly baseUrl: string

  constructor(
    private readonly role: RoleConfig,
    private readonly retry: RetryOptions = DEFAULT_RETRY,
  ) {
    this.name = `ollama:${role.model}`
    this.baseUrl = (role.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
  }

  async complete(messages: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    const text = await postWithRetry(
      'ollama',
      `${this.baseUrl}${this.role.apiPath ?? '/api/chat'}`,
      {
        headers: requestHeaders(this.role, '', { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          model: this.role.model,
          messages: ollamaMessages(messages, Boolean(options.tools?.length)),
          stream: false,
          // Local reasoning models are opt-in: `think` stays off unless the
          // role asks for it through `effort`.
          think: options.effort !== undefined && options.effort !== 'none',
          // Constrained JSON and native tool calls exclude each other.
          ...(options.tools ? { tools: toolsField(options.tools) } : options.json === false ? {} : { format: 'json' }),
          options: {
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
            num_predict: options.maxTokens,
            // Without num_ctx Ollama uses its small server default, not the
            // context window recorded in the role.
            num_ctx: this.role.contextWindowTokens,
          },
          ...(this.role.extraBody ?? {}),
        }),
        signal: requestSignal(options.signal, this.role.requestTimeoutMs),
      },
      this.retry,
    )
    const body = JSON.parse(text) as {
      message?: { content?: string; thinking?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> }
      done_reason?: string
      prompt_eval_count?: number
      eval_count?: number
    }
    const calls = (body.message?.tool_calls ?? []).filter((c) => c.function?.name)
    // Ollama returns reasoning in `thinking` when `think` is on, and in
    // `<think>` tags inside the content on older servers and templates.
    const split = withThinkSplit(body.message?.content ?? '', body.message?.thinking)
    return {
      content: split.content,
      ...(split.reasoning ? { reasoning: split.reasoning } : {}),
      ...(body.done_reason === 'length' ? { outputLimited: true } : {}),
      usage: {
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
      },
      ...(calls.length > 0 ? { toolCalls: calls.map((c) => ({ name: c.function!.name!, args: parseArgs(c.function!.arguments) })) } : {}),
    }
  }
}

export class OpenAiProvider implements LlmProvider {
  readonly name: string
  private readonly baseUrl: string
  private readonly apiKey: string
  /** Set for models the registry knows reject effort + tools. */
  private omitEffortWithTools: boolean
  /**
   * What this endpoint has taught the harness: rejected request fields and
   * whether reasoning goes back. Shared per `${provider}|${baseUrl}|${model}`,
   * so the provider of the next turn (or worker, or retry) starts from what
   * earlier ones learned instead of provoking the same 400 again.
   */
  private readonly state: ProviderNegotiationState
  /** The token-limit field the endpoint takes (switched after a 400). */
  private tokenField: 'max_tokens' | 'max_completion_tokens'
  /**
   * Whether earlier reasoning is sent back as `reasoning_content`. Turned on
   * by the first response that carries reasoning, unless the role says no.
   */
  private echoReasoning: boolean

  constructor(
    private readonly role: RoleConfig,
    private readonly retry: RetryOptions = DEFAULT_RETRY,
    private readonly sessionId?: string,
  ) {
    this.name = `${role.provider}:${role.model}`
    this.baseUrl = (role.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    this.state = sharedProviderState(`${role.provider}|${this.baseUrl}|${role.model}`)
    this.omitEffortWithTools = !effortWithToolsFor(role.provider, role.model)
    this.tokenField = tokenFieldFor(role.provider, role.model)
    // An explicit role setting wins; then what earlier providers for this
    // endpoint learned; then the model registry.
    this.echoReasoning = role.reasoningEcho ?? this.state.echoReasoning ?? reasoningEchoFor(role.provider, role.model) ?? false
    const key = roleApiKey(role)
    if (!key) {
      throw new LlmError(
        `missing API key: set ${role.apiKeyEnv ?? (role.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : role.provider === 'opencode' ? 'OPENCODE_API_KEY' : 'OPENAI_API_KEY')}`,
      )
    }
    this.apiKey = key
  }

  /**
   * The request body, shaped by the role, the model registry and what this
   * endpoint has already rejected (see `learnFrom`).
   */
  private payload(messages: ChatMessage[], options: CompleteOptions, streaming: boolean): string {
    const { drop } = this.state
    const tokenField = drop.has('tokenField')
      ? this.tokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
      : this.tokenField
    const json = options.json !== false && !options.tools && !drop.has('response_format')
    // Echo reasoning once this endpoint has returned some, unless the role or
    // the model registry says otherwise. A server that rejects the field makes
    // the request fail once; `learnFrom` drops it from then on.
    const echo = this.role.reasoningEcho ?? this.echoReasoning
    const effort = negotiatedEffort(this.state, options.effort)
    return JSON.stringify({
      model: this.role.model,
      // Tool steps go back as `tool_calls` / `role: tool` while tools are offered.
      messages: openAiMessages(messages, echo && !drop.has('reasoning_content'), Boolean(options.tools?.length) && !drop.has('tools')),
      ...(streaming ? { stream: true, ...(drop.has('stream_options') ? {} : { stream_options: { include_usage: true } }) } : {}),
      [tokenField]: negotiatedMaxTokens(this.state, options.maxTokens),
      // Temperature only when the role sets one: a model's own default is its
      // author's recommendation, and reasoning models reject or degrade on 0.
      ...(options.temperature === undefined || drop.has('temperature') || !temperatureAllowedFor(this.role.provider, this.role.model) ? {} : { temperature: options.temperature }),
      // A learned "effort is rejected" applies to every request, not only tool
      // calls; a learned list of valid values maps the effort onto the nearest.
      ...(effort && !(options.tools && this.omitEffortWithTools) ? { reasoning_effort: effort } : {}),
      ...(options.tools && !drop.has('tools') ? { tools: toolsField(options.tools) } : json ? { response_format: { type: 'json_object' } } : {}),
      ...(this.role.extraBody ?? {}),
    })
  }

  /** Records what a 400 taught (fields, output limit, effort values); true when anything new was learned. */
  private learnFrom(error: unknown): boolean {
    return learnFromError(this.state, error)
  }

  /**
   * The endpoint returned reasoning: send it back from now on. Shared, so the
   * next provider for this endpoint echoes from its first request.
   */
  private learnReasoningEcho(): void {
    this.echoReasoning = true
    this.state.echoReasoning = true
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const opencodeSession = this.sessionId && (this.role.provider === 'opencode' || isOpenCodeHost(this.baseUrl))
      ? `ses_${this.sessionId.replace(/^ses_/, '').replace(/[^a-zA-Z0-9_-]/g, '_')}`
      : undefined
    return requestHeaders(this.role, this.apiKey, { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }, {
      ...(opencodeSession ? { 'x-opencode-session': opencodeSession, 'User-Agent': 'HY-HARNESS/0.1.0' } : {}),
      ...extra,
    })
  }

  private chatUrl(): string {
    return `${this.baseUrl}${this.role.apiPath ?? '/chat/completions'}`
  }


  /**
   * CP-18: one streaming request. Parses `data:` chunks, emits deltas and
   * assembles the same `Completion` the non-streaming path returns.
   */
  private async completeStreaming(messages: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('stream timed out')), this.role.requestTimeoutMs ?? 600_000)
    const signal = options.signal
      ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, controller.signal]) : options.signal)
      : controller.signal
    try {
      const open = () => openStreamWithRetry(
        this.role.provider,
        this.chatUrl(),
        { headers: this.headers({ Accept: 'text/event-stream' }), body: this.payload(messages, options, true), signal },
        this.retry,
      )
      let response: Awaited<ReturnType<typeof open>>
      try {
        response = await open()
      } catch (error) {
        // The endpoint named an optional field it does not take: drop it and retry once.
        if (!this.learnFrom(error)) throw error
        response = await open()
      }
      const reader = response.body?.getReader()
      if (!reader) throw new LlmError(`${this.role.provider}: the streaming response has no body`)
      const decoder = new TextDecoder()
      let buffer = ''
      let content = ''
      let reasoning = ''
      const calls = new Map<number, { name: string; args: string; id?: string }>()
      let usage: Usage = { inputTokens: 0, outputTokens: 0 }
      // A stream that ends without `[DONE]` or a finish_reason was cut off
      // (a dropped connection, a proxy timeout): its partial answer must not
      // pass for a complete one.
      let finished = false
      let outputLimited = false
      // A model stuck repeating one fragment (`]}}]}}…`) would stream until the
      // 600 s timer and fail the whole run; it is cut here instead, and the
      // agent retries the step.
      let degenerate = false
      let checkedContent = 0
      let checkedReasoning = 0
      const cutRepetition = (): boolean => {
        if (content.length - checkedContent >= 1_000) {
          checkedContent = content.length
          const start = repetitionStart(content)
          if (start !== undefined) return ((content = content.slice(0, start)), true)
        }
        if (reasoning.length - checkedReasoning >= 1_000) {
          checkedReasoning = reasoning.length
          const start = repetitionStart(reasoning)
          if (start !== undefined) return ((reasoning = reasoning.slice(0, start)), true)
        }
        return false
      }
      // Live deltas: text inside a leading `<think>…</think>` is shown as
      // reasoning, not as the answer. Up to 7 characters are held back while a
      // tag may still be arriving.
      let thinkState: 'pending' | 'in' | 'out' = 'pending'
      let shown = 0
      const emitContent = () => {
        if (!options.onDelta) return
        if (thinkState === 'pending') {
          const head = content.trimStart()
          if (head.length < '<think>'.length && '<think>'.startsWith(head)) return
          thinkState = head.startsWith('<think>') ? 'in' : 'out'
          if (thinkState === 'in') shown = content.indexOf('<think>') + '<think>'.length
        }
        if (thinkState === 'in') {
          const close = content.indexOf('</think>', shown)
          if (close < 0) {
            const safe = content.length - '</think>'.length
            if (safe > shown) options.onDelta({ reasoning: content.slice(shown, safe) })
            shown = Math.max(shown, safe)
            return
          }
          if (close > shown) options.onDelta({ reasoning: content.slice(shown, close) })
          shown = close + '</think>'.length
          thinkState = 'out'
        }
        if (content.length > shown) {
          options.onDelta({ content: content.slice(shown) })
          shown = content.length
        }
      }
      for (;;) {
        if (degenerate) break
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') finished = true
          if (payload === '' || payload === '[DONE]') continue
          let chunk: {
            error?: { message?: string }
            usage?: RawUsage
            choices?: Array<{
              finish_reason?: string | null
              delta?: {
                content?: unknown
                reasoning_content?: unknown
                reasoning?: unknown
                tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
              }
            }>
          }
          try {
            chunk = JSON.parse(payload) as typeof chunk
          } catch {
            continue
          }
          if (chunk.error?.message) throw new LlmError(`${this.role.provider}: ${chunk.error.message}`)
          if (chunk.usage) usage = normalizeUsage(chunk.usage)
          if (chunk.choices?.[0]?.finish_reason) {
            finished = true
            outputLimited ||= /^(length|max_tokens)$/.test(chunk.choices[0].finish_reason)
          }
          const delta = chunk.choices?.[0]?.delta
          if (!delta) continue
          const piece = textOf(delta.content)
          if (piece.length > 0) {
            content += piece
            emitContent()
          }
          const thought = textOf(delta.reasoning_content) || textOf(delta.reasoning)
          if (thought.length > 0) {
            reasoning += thought
            // The endpoint returns reasoning: send it back on later requests.
            if (this.role.reasoningEcho === undefined) this.learnReasoningEcho()
            options.onDelta?.({ reasoning: thought })
          }
          for (const [i, call] of (delta.tool_calls ?? []).entries()) {
            const index = call.index ?? i
            const current = calls.get(index) ?? { name: '', args: '' }
            if (call.id && !current.id) current.id = call.id
            if (call.function?.name) current.name += call.function.name
            if (call.function?.arguments) current.args += call.function.arguments
            calls.set(index, current)
          }
          if (cutRepetition()) {
            degenerate = true
            break
          }
        }
      }
      if (degenerate) {
        await reader.cancel().catch(() => {})
        // The provider's usage never arrived: output is estimated, input and
        // cache are unknown (left out, so cache totals show as unavailable).
        return {
          content,
          ...(reasoning.length > 0 ? { reasoning } : {}),
          usage: { inputTokens: usage.inputTokens, outputTokens: Math.max(usage.outputTokens, estimateTokens(content + reasoning)) },
          degenerate: 'repetition',
        }
      }
      if (!finished) throw new LlmError(`${this.role.provider}: the stream ended before the response was complete`)
      const toolCalls = [...calls.values()].filter((call) => call.name.length > 0).map((call) => ({ name: call.name, args: parseArgs(call.args), ...(call.id ? { id: call.id } : {}) }))
      const split = withThinkSplit(content, reasoning || undefined)
      return {
        content: split.content,
        ...(split.reasoning ? { reasoning: split.reasoning } : {}),
        ...(outputLimited ? { outputLimited: true } : {}),
        usage,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      }
    } finally {
      clearTimeout(timeout)
    }
  }
  async complete(messages: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    // CP-18: stream when the caller wants live deltas.
    if (options.onDelta) return this.completeStreaming(messages, options)
    const post = () => postWithRetry(
      this.role.provider,
      this.chatUrl(),
      { headers: this.headers(), body: this.payload(messages, options, false), signal: requestSignal(options.signal, this.role.requestTimeoutMs) },
      this.retry,
    )
    let text: string
    try {
      text = await post()
    } catch (error) {
      // The endpoint named an optional field it does not take: drop it and retry once.
      if (!this.learnFrom(error)) throw error
      text = await post()
    }
    const body = JSON.parse(text) as {
      choices?: Array<{
        finish_reason?: string
        message?: {
          content?: unknown
          reasoning_content?: unknown
          reasoning?: unknown
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>
        }
      }>
      usage?: RawUsage
    }
    const message = body.choices?.[0]?.message
    const calls = (message?.tool_calls ?? []).filter((c) => c.function?.name)
    const channel = textOf(message?.reasoning_content) || textOf(message?.reasoning) || undefined
    // The endpoint returns reasoning: send it back on later requests.
    if (channel && this.role.reasoningEcho === undefined) this.learnReasoningEcho()
    const split = withThinkSplit(textOf(message?.content), channel)
    return {
      content: split.content,
      ...(/^(length|max_tokens)$/.test(body.choices?.[0]?.finish_reason ?? '') ? { outputLimited: true } : {}),
      usage: normalizeUsage(body.usage),
      ...(split.reasoning ? { reasoning: split.reasoning } : {}),
      ...(calls.length > 0 ? { toolCalls: calls.map((c) => ({ name: c.function!.name!, args: parseArgs(c.function!.arguments), ...(c.id ? { id: c.id } : {}) })) } : {}),
    }
  }
}

export function isOpenCodeHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'opencode.ai' || host.endsWith('.opencode.ai')
  } catch {
    return false
  }
}

/** The latest user message that is not a tool result. */
/** A user message without the trailing `<hy_session_context>` block the agent appends. */
function withoutSessionContext(text: string): string {
  return text.replace(/(?:\n\n)?<hy_session_context>\n[\s\S]*<\/hy_session_context>\s*$/, '')
}

function lastPrompt(messages: ChatMessage[]): string {
  const prompts = [...messages].reverse().map((m) => (m.role === 'user' ? withoutSessionContext(m.content) : undefined))
  return prompts.find((text) => text !== undefined && text !== '' && !text.startsWith('TOOL ')) ?? ''
}

/**
 * The one tool call a `FETCH` / `MCP` / `CALL` probe prompt asks for, or
 * undefined for any other prompt.
 */
function scriptedCall(prompt: string): { tool: string; args: unknown } | undefined {
  if (prompt.startsWith('FETCH ')) return { tool: 'web_fetch', args: { url: prompt.slice(6) } }
  if (prompt.startsWith('MCP ')) {
    // `MCP <server> <tool> <json args>` → one mcp_call.
    const [, server, tool, ...rest] = prompt.split(' ')
    return { tool: 'mcp_call', args: { server, tool, args: JSON.parse(rest.join(' ') || '{}') } }
  }
  if (prompt.startsWith('CALL ')) {
    // `CALL <tool> <json args>`: one call of any tool (plugins, lsp, …).
    // Orchestration tests append assignment context after the JSON, so parse
    // the first complete object rather than the whole remainder.
    const [, tool, ...rest] = prompt.split(' ')
    const raw = rest.join(' ') || '{}'
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    return { tool: tool ?? '', args: JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw) }
  }
  return undefined
}

/** Removes the harness's `[session goal: …]` / `[plan mode: …]` / root catalog context. */
function stripContext(text: string): string {
  return text
    .replace(/^\[workspace roots\]\n[\s\S]*?\n\n/, '')
    .replace(/^(?:\[[^\]]*\]\n\n)+/, '')
}

/**
 * Deterministic provider used by the offline E2E test and `--mock`.
 * It demonstrates the full tool path without a model server.
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock:scripted'
  private step = 0

  constructor(private readonly workspaceRoot: string) {}

  async complete(messages: ChatMessage[]): Promise<Completion> {
    this.step += 1
    // `HY_MOCK_DUMP=<file>` records what the scripted model was asked, which is
    // the only way to see the request shape in a `--mock` E2E run.
    if (process.env.HY_MOCK_DUMP) {
      fs.appendFileSync(process.env.HY_MOCK_DUMP, `${JSON.stringify(messages.map((m) => [m.role, m.content.slice(0, 120)]))}\n`)
    }
    // The session-context block the agent appends is not part of what was asked.
    const last = withoutSessionContext([...messages].reverse().find((m) => m.role === 'user' && withoutSessionContext(m.content) !== '')?.content ?? '')
    const prompt = stripContext(last)
    let content: string
    // Goal smoke tests: a `COMPLETE ...` objective exercises get_goal,
    // update_goal and the host grader. Other goal rounds keep the normal demo.
    const goalRoundObjective = (() => {
      if (!prompt.startsWith('<goal_round')) return ''
      const match = /objective="((?:[^"\\]|\\.)*)"/.exec(prompt)
      if (!match) return ''
      try {
        return JSON.parse(`"${match[1]}"`) as string
      } catch {
        return ''
      }
    })()
    if (goalRoundObjective.startsWith('COMPLETE ')) {
      return { content: JSON.stringify({ tool: 'get_goal', args: {} }), usage: { inputTokens: 0, outputTokens: 0 } }
    }
    if (last.startsWith('TOOL RESULT (get_goal)')) {
      const start = last.indexOf('{')
      try {
        const body = JSON.parse(last.slice(start)) as { goal?: { id?: unknown; revision?: unknown } }
        if (body.goal && typeof body.goal.id === 'string' && typeof body.goal.revision === 'number') {
          return {
            content: JSON.stringify({
              tool: 'update_goal',
              args: {
                goal_id: body.goal.id,
                revision: body.goal.revision,
                action: 'complete',
                summary: 'The mock goal round completed and verified the objective.',
              },
            }),
            usage: { inputTokens: 0, outputTokens: 0 },
          }
        }
      } catch {
        // Fall through to the normal demo.
      }
    }
    if (last.startsWith('TOOL RESULT (update_goal)')) {
      return { content: JSON.stringify({ final: 'goal completed' }), usage: { inputTokens: 0, outputTokens: 0 } }
    }
    if (last.startsWith('TOOL ERROR (update_goal)')) {
      return { content: JSON.stringify({ final: 'goal not complete' }), usage: { inputTokens: 0, outputTokens: 0 } }
    }
    // Multi-turn probes for `hy chat` / `hy resume` tests: `SAY <text>` answers
    // with the text; `REPEAT FIRST` answers with the conversation's first
    // user message, which proves the history was carried over.
    //
    // WP-21: a steering message is the newest user message, so answering it here
    // echoes the text back — that is how the HTTP test proves the message reached
    // the model at a step boundary.
    const notLoaded = /^TOOL ERROR \((\w+)\): \1 is not loaded; call tool_search/.exec(last)
    const retry = last.startsWith('TOOL RESULT (tool_search)') ? scriptedCall(stripContext(lastPrompt(messages))) : undefined
    if (isSteerMessage(prompt)) {
      content = JSON.stringify({ final: `steer: ${steerText(prompt)}` })
    } else if (notLoaded) {
      // CP-10: a deferred tool is loaded with tool_search first, as a model
      // does after this error; the next step retries the call.
      content = JSON.stringify({ tool: 'tool_search', args: { query: notLoaded[1] } })
    } else if (retry && retry.tool !== 'tool_search') {
      content = JSON.stringify(retry)
    } else if (prompt.startsWith('SAY ')) {
      content = JSON.stringify({ final: prompt.slice(4) })
    } else if (prompt.startsWith('BLOCK ')) {
      const reason = prompt.slice(6).split('\n')[0]?.trim() || 'blocked by the worker'
      content = JSON.stringify({ final: `STATUS: blocked\nBLOCKED_BY: ${reason}` })
    } else if (prompt.startsWith('PARTIAL ')) {
      const reason = prompt.slice(8).split('\n')[0]?.trim() || 'partially done'
      content = JSON.stringify({ final: `STATUS: partial\nBLOCKED_BY: ${reason}` })
    } else if (prompt.startsWith('DONE ')) {
      // A complete worker report, so orchestration tests exercise the review
      // state instead of only the legacy "waiting without a report" path.
      const summary = prompt.slice(5).split('\n')[0]?.trim() || 'done'
      content = JSON.stringify({ final: `STATUS: done\n\n${summary}` })
    } else if (prompt === 'REPEAT FIRST') {
      content = JSON.stringify({ final: `first: ${withoutSessionContext(messages[1]?.content ?? '')}` })
    } else if (prompt.startsWith('Review the changes')) {
      // hy review: proves the diff reached the reviewer.
      const added = prompt.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
      content = JSON.stringify({ final: `review: ${added} added line(s); no findings` })
    } else if (prompt.startsWith('Create an AGENTS.md')) {
      content = JSON.stringify({ tool: 'apply_patch', args: { file: 'AGENTS.md', content: '# AGENTS\n\nBuild: none.\n' } })
    } else if (prompt.startsWith('CALL ')) {
      content = JSON.stringify(scriptedCall(prompt))
    } else if (/^TOOL (RESULT|ERROR) \(/.test(last) && stripContext(lastPrompt(messages)).startsWith('CALL ')) {
      const report = messages[0]?.content.includes('# Worker role')
        ? last.startsWith('TOOL ERROR ') ? 'STATUS: partial\nBLOCKED_BY: Tool failed\n\n' : 'STATUS: done\n\n'
        : ''
      content = JSON.stringify({ final: `${report}called: ${last.split('\n').join(' ').slice(0, 400)}` })
    } else if (prompt.startsWith('ASK ')) {
      content = JSON.stringify({ tool: 'ask_user', args: { question: prompt.slice(4) } })
    } else if (last.startsWith('TOOL RESULT (ask_user)') || last.startsWith('TOOL ERROR (ask_user)')) {
      content = JSON.stringify({ final: `user said: ${last.split('\n').slice(1).join(' ').trim()}` })
    } else if (last.includes('[plan mode: read-only.') && prompt === 'Create the demo file') {
      // In plan mode the mock still tries to write, to prove the tool is refused.
      content = JSON.stringify({ tool: 'apply_patch', args: { file: 'PLAN_ATTEMPT.md', content: 'x\n' } })
    } else if (last.startsWith('TOOL ERROR (apply_patch)') && /not allowed|while plan mode is on/.test(last)) {
      content = JSON.stringify({ final: 'plan: write HY_DEMO.md after approval' })
    } else if (prompt.startsWith('JSON ')) {
      // Structured output probe: the rest is the final value as raw JSON.
      content = `{"final": ${prompt.slice(5)}}`
    } else if (prompt.startsWith('Your final answer does not match')) {
      content = '{"final": {"ok": true}}'
    } else if (prompt.startsWith('FETCH ')) {
      content = JSON.stringify(scriptedCall(prompt))
    } else if (last.startsWith('TOOL RESULT (web_fetch)') || last.startsWith('TOOL ERROR (web_fetch)')) {
      content = JSON.stringify({ final: `web said: ${last.split('\n').slice(0, 8).join(' ')}` })
    } else if (prompt.startsWith('DELEGATE ')) {
      content = JSON.stringify({ tool: 'delegate', args: { task: prompt.slice(9) } })
    } else if (last.startsWith('TOOL RESULT (orchestrator_') || last.startsWith('TOOL ERROR (orchestrator_')) {
      content = JSON.stringify({ final: `orchestrator tool finished: ${last.split('\n').slice(0, 6).join(' ').slice(0, 600)}` })
    } else if (prompt.startsWith('[worker report]') || prompt.startsWith('[worker approval request]') || prompt.startsWith('[worker heartbeat]')) {
      content = JSON.stringify({ final: 'orchestrator reviewed the worker event' })
    } else if (last.startsWith('TOOL RESULT (delegate)') || last.startsWith('TOOL ERROR (delegate)')) {
      content = JSON.stringify({ final: `delegate said: ${last.split('\n').slice(0, 4).join(' ')}` })
    } else if (prompt.startsWith('MCP ')) {
      content = JSON.stringify(scriptedCall(prompt))
    } else if (last.startsWith('TOOL RESULT (mcp_call)') || last.startsWith('TOOL ERROR (mcp_call)')) {
      content = JSON.stringify({ final: `mcp said: ${last.split('\n').slice(0, 6).join(' ')}` })
    } else if (last.startsWith('TOOL ERROR (apply_patch)') && last.includes('HY_DEMO.md')) {
      // A second run in the same workspace finds HY_DEMO.md already there and
      // the read-before-edit rule refuses the create-style patch. Finish instead
      // of looping: the deterministic demo has nothing left to do.
      content = JSON.stringify({ final: 'Demo complete: HY_DEMO.md already exists.' })
    } else if (last.includes('TOOL RESULT (read_file)')) {
      content = JSON.stringify({
        tool: 'apply_patch',
        args: {
          patch:
            '--- /dev/null\n' +
            '+++ b/HY_DEMO.md\n' +
            '@@ -0,0 +1,3 @@\n' +
            '+# HY-HARNESS demo\n' +
            '+\n' +
            '+Created by the mock provider.\n',
        },
      })
    } else if (last.includes('TOOL RESULT (apply_patch)')) {
      content = JSON.stringify({ tool: 'shell', args: { command: 'git status --short' } })
    } else if (last.includes('TOOL RESULT (shell)')) {
      // In a hy ralph session the only way to finish is claim_complete (OQ-4).
      const objective = messages[0]?.content.includes('claim_complete(') ?? false
      content = objective
        ? JSON.stringify({ tool: 'claim_complete', args: { summary: 'Demo complete: HY_DEMO.md was created.' } })
        : JSON.stringify({ final: 'Demo complete: HY_DEMO.md was created.' })
    } else {
      const candidate = ['README.md', 'package.json', 'Cargo.toml'].find((p) =>
        fs.existsSync(path.join(this.workspaceRoot, p)),
      )
      content = JSON.stringify({
        tool: 'read_file',
        args: { path: candidate ?? 'README.md' },
      })
    }
    return {
      content,
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }
}

/** Deterministic compactor for `--mock` runs. */
export class MockCompactorProvider implements LlmProvider {
  readonly name = 'mock:compactor'

  async complete(): Promise<Completion> {
    return { content: '- (mock summary of earlier steps)', usage: { inputTokens: 0, outputTokens: 0 } }
  }
}

export class MockGraderProvider implements LlmProvider {
  readonly name = 'mock:grader'

  async complete(): Promise<Completion> {
    return {
      content: JSON.stringify({ pass: true, reasoning: 'mock grader accepted the claim', rollbackRecommended: false }),
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }
}

/** Deterministic guardian for `--mock` runs: approves with a low risk score. */
export class MockGuardianProvider implements LlmProvider {
  readonly name = 'mock:guardian'

  async complete(): Promise<Completion> {
    return {
      content: JSON.stringify({ decision: 'approve', riskScore: 10, reason: 'mock guardian approved the command' }),
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }
}

/** Gemini's official effort values; the harness's wider scale is mapped onto them. */
function geminiThinkingLevel(effort: string | undefined): 'low' | 'medium' | 'high' | undefined {
  if (effort === undefined || effort === 'none') return undefined
  if (effort === 'minimal' || effort === 'low') return 'low'
  if (effort === 'medium') return 'medium'
  if (effort === 'high' || effort === 'xhigh' || effort === 'max') return 'high'
  return undefined
}

/**
 * Gemini through the Interactions API (`POST /v1beta/interactions`,
 * verification/sources/gemini_thinking.txt and gemini_tokens.txt).
 *
 * Continue an unchanged local prefix on the server. On resume, compaction,
 * or an expired interaction, seed a new chain from the authoritative local history.
 */
export class GeminiProvider implements LlmProvider {
  readonly name: string
  /** What 400s from this endpoint taught (shared with every provider for it). */
  private readonly state: ProviderNegotiationState
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(
    private readonly role: RoleConfig,
    private readonly retry: RetryOptions = DEFAULT_RETRY,
  ) {
    this.name = `gemini:${role.model}`
    this.baseUrl = (role.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
    this.state = sharedProviderState(`${role.provider}|${this.baseUrl}|${role.model}`)
    const key = roleApiKey(role)
    if (!key) throw new LlmError(`missing API key: set ${role.apiKeyEnv ?? 'GEMINI_API_KEY'}`)
    this.apiKey = key
  }

  async complete(messages: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    if (messages.some((m) => m.images?.length)) throw new LlmError('the Gemini adapter does not send images yet; use an Ollama or OpenAI-compatible vision model')
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    // Drop empty assistant messages left behind by failed/empty steps so they
    // do not appear as `ASSISTANT:\n\n` few-shot examples of an empty reply.
    const turns = messages.filter((m) => m.role !== 'system' && !(m.role === 'assistant' && !m.content.trim()))
    const prefix = (history: ChatMessage[]) => createHash('sha256').update(JSON.stringify([
      this.baseUrl, this.role.model, system, history.map(({ role, content }) => [role, content]),
    ])).digest('hex')
    const anchor = turns.findLastIndex((m) => m.role === 'assistant')
    const checkpoint = turns[anchor]?.gemini
    const tail = turns.slice(anchor + 1)
    const results = tail[0]?.toolResults
    const continuing = checkpoint && checkpoint.content === turns[anchor]?.content &&
      checkpoint.prefix === prefix(turns.slice(0, anchor)) && tail.length > 0 &&
      tail.every((m) => m.role === 'user' && (!m.toolResults || m.content.startsWith(m.toolResults.rendered))) &&
      checkpoint.callIds.length === (results?.entries.length ?? 0) &&
      checkpoint.callIds.every((id, i) => id === results?.entries[i]?.id)
    const continuationInput = tail.flatMap((message): unknown[] => {
      const userInput = (text: string) => ({ type: 'user_input', content: [{ type: 'text', text }] })
      if (!message.toolResults) return [userInput(message.content)]
      const { entries, rendered } = message.toolResults
      return [
        ...entries.map(({ id, name, text }) => ({
          type: 'function_result', name, call_id: id, result: [{ type: 'text', text }],
        })),
        ...(message.content.length > rendered.length ? [userInput(message.content.slice(rendered.length).trim())] : []),
      ]
    })
    const fullInput = () =>
      turns.length === 1
        ? turns[0]!.content
        : turns.map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${m.content}`).join('\n\n') + '\n\nASSISTANT:'
    const send = (previous?: string) => postWithRetry(
      'gemini',
      `${this.baseUrl}${this.role.apiPath ?? '/interactions'}`,
      {
        // The key goes in a header, never in the URL.
        headers: requestHeaders(this.role, this.apiKey, { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey }),
        body: JSON.stringify({
          model: this.role.model,
          input: previous ? continuationInput : fullInput(),
          ...(previous ? { previous_interaction_id: previous } : {}),
          ...(system ? { system_instruction: system } : {}),
          ...(options.tools && options.tools.length > 0
            ? {
                tools: options.tools.map((t) => ({
                  type: 'function',
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                })),
              }
            : {}),
          // Caps thinking and output together; thinking_level selects the
          // official low/medium/high effort for Gemini 3.8 Flash.
          generation_config: {
            max_output_tokens: negotiatedMaxTokens(this.state, options.maxTokens),
            ...(geminiThinkingLevel(negotiatedEffort(this.state, options.effort)) ? { thinking_level: geminiThinkingLevel(negotiatedEffort(this.state, options.effort)) } : {}),
            ...(options.temperature !== undefined && !this.state.drop.has('temperature') && temperatureAllowedFor(this.role.provider, this.role.model) ? { temperature: options.temperature } : {}),
          },
          ...(this.role.extraBody ?? {}),
        }),
        signal: requestSignal(options.signal, this.role.requestTimeoutMs),
      },
      this.retry,
    )
    let text: string
    try {
      text = await send(continuing ? checkpoint.id : undefined)
    } catch (error) {
      if (learnFromError(this.state, error)) {
        // A field or value the endpoint refuses: learn it and retry once.
        text = await send(continuing ? checkpoint.id : undefined)
      } else {
        if (!continuing || !(error instanceof LlmError) ||
            !(error.status === 404 || error.status === 400 && /previous.interaction|call.id|function.result/i.test(error.message))) throw error
        text = await send()
      }
    }
    const body = JSON.parse(text) as {
      id?: string
      steps?: Array<{
        id?: string
        type?: string
        name?: string
        arguments?: unknown
        summary?: Array<{ type?: string; text?: string }>
        content?: Array<{ type?: string; text?: string }>
      }>
      usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number; total_cached_tokens?: number }
      status?: string
    }
    const steps = body.steps ?? []
    const content = steps
      .filter((s) => s.type === 'model_output')
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    const reasoning = steps
      .filter((s) => s.type === 'thought')
      .flatMap((s) => s.summary ?? s.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    const toolCalls = steps
      .filter((s) => s.type === 'function_call' && typeof s.name === 'string' && s.name.length > 0)
      .map((s) => ({ name: s.name!, args: parseArgs(s.arguments), ...(s.id ? { id: s.id } : {}) }))
    const inputTokens = body.usage?.total_input_tokens ?? 0
    const cached = body.usage?.total_cached_tokens
    return {
      content,
      ...(reasoning ? { reasoning } : {}),
      // B3-1: an interaction cut at max_output_tokens reports status
      // "incomplete" (measured: 12 thought tokens, 0 output tokens at a limit
      // of 16). Without this the empty or partial reply passed as complete.
      ...(body.status === 'incomplete' ? { outputLimited: true as const } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(body.id && toolCalls.every((call) => call.id)
        ? { gemini: { id: body.id, prefix: prefix(turns), callIds: toolCalls.map((call) => call.id!) } } : {}),
      usage: {
        inputTokens,
        outputTokens: (body.usage?.total_output_tokens ?? 0) + (body.usage?.total_thought_tokens ?? 0),
        ...(typeof cached === 'number' && cached >= 0 && cached <= inputTokens
          ? { cacheHitTokens: cached, cacheMissTokens: inputTokens - cached } : {}),
      },
    }
  }
}

/**
 * Defers provider construction until the role is actually used. The compactor
 * is only needed once context overflows, so a missing key for that role must
 * not block ordinary chat turns.
 */
export class LazyProvider implements LlmProvider {
  private provider: LlmProvider | undefined

  constructor(private readonly factory: () => LlmProvider) {}

  get name(): string {
    return this.provider?.name ?? 'lazy'
  }

  async complete(messages: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    this.provider ??= this.factory()
    return this.provider.complete(messages, options)
  }
}

// ---------------------------------------------------------------------------
// WP-40: additional provider protocols (Anthropic Messages, OpenAI Responses).
// The harness history stays in its own text protocol, so these adapters only
// translate the request envelope and the response blocks.
// ---------------------------------------------------------------------------

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Extended-thinking budget for a harness effort value (undefined = off). The
 * API needs `budget_tokens` smaller than `max_tokens`.
 */
function anthropicThinkingBudget(effort: string | undefined, maxTokens: number): number | undefined {
  if (effort === undefined || effort === 'none') return undefined
  const wanted = effort === 'minimal' ? 1_024 : effort === 'low' ? 2_048 : effort === 'medium' ? 8_192 : effort === 'high' ? 16_384 : 32_768
  const budget = Math.min(wanted, maxTokens - 1_024)
  return budget >= 1_024 ? budget : maxTokens >= 2_048 ? 1_024 : undefined
}

type CacheControl = { cache_control?: { type: 'ephemeral' } }
type AnthropicBlock =
  | ({ type: 'text'; text: string } & CacheControl)
  | ({ type: 'image'; source: { type: 'base64'; media_type: string; data: string } } & CacheControl)
  | ({ type: 'tool_use'; id: string; name: string; input: unknown } & CacheControl)
  | ({ type: 'tool_result'; tool_use_id: string; content: string } & CacheControl)
  | ({ type: 'thinking'; thinking: string; signature: string } & CacheControl)
  | ({ type: 'redacted_thinking'; data: string } & CacheControl)

/**
 * Anthropic caches a prefix only up to a block marked with `cache_control`
 * (DeepSeek and OpenAI cache automatically). Marks the system prompt (which
 * also covers the tool definitions before it) and the last block of the last
 * two user messages: each request writes the cache at its end and reads the
 * one the previous request wrote. 3 of the 4 allowed breakpoints.
 */
export function withAnthropicCacheBreakpoints(
  messages: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }>,
): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  let marked = 0
  for (let i = messages.length - 1; i >= 0 && marked < 2; i--) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    const last = message.content.at(-1)
    if (!last) continue
    message.content[message.content.length - 1] = { ...last, cache_control: { type: 'ephemeral' } }
    marked += 1
  }
  return messages
}

/** Tool ids from another provider's history, made valid for the Messages API (`^[a-zA-Z0-9_-]+$`). */
function anthropicToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'call'
}

/**
 * The Messages API wants alternating roles; the harness can emit two user
 * turns. With `structured` (tools offered), tool steps become `tool_use` /
 * `tool_result` blocks. With extended thinking on, a `tool_use` must follow its
 * signed thinking block, so a step without one (a resumed session, another
 * provider's history) stays text.
 */
export function anthropicMessages(
  messages: readonly ChatMessage[],
  structured: boolean | ((message: ChatMessage) => boolean) = false,
): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  const out: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return
    const previous = out.at(-1)
    if (previous && previous.role === role) previous.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  const images = (list: ImageInput[] | undefined): AnthropicBlock[] =>
    (list ?? []).map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }))
  for (const item of wireItems(messages.filter((message) => message.role !== 'system'), structured)) {
    if (item.kind === 'message') {
      const message = item.message
      push(message.role === 'assistant' ? 'assistant' : 'user', [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...images(message.images),
      ])
      continue
    }
    const { calls, results, extra } = item.exchange
    push('assistant', [
      ...((item.message.thinkingBlocks ?? []) as AnthropicBlock[]),
      ...calls.map((call): AnthropicBlock => ({
        type: 'tool_use',
        id: anthropicToolId(call.id),
        name: call.name,
        input: call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {},
      })),
    ])
    push('user', [
      ...results.map((result): AnthropicBlock => ({ type: 'tool_result', tool_use_id: anthropicToolId(result.id), content: result.text })),
      ...(extra ? [{ type: 'text' as const, text: extra }] : []),
      ...images(item.exchange.images),
    ])
  }
  return out
}

/**
 * B3-1: the JSON payload of each `data:` line of a server-sent-event stream.
 * Lines that are not JSON (`[DONE]`, keep-alives) are skipped.
 */
async function* sseData(response: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new LlmError('the streaming response has no body')
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const parsed: unknown = JSON.parse(payload)
          if (parsed && typeof parsed === 'object') yield parsed as Record<string, unknown>
        } catch {
          // Not JSON: skip it.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/**
 * B3-1: watches streamed text for a runaway repetition (the same check the
 * OpenAI-compatible stream uses), every 1,000 new characters.
 */
class RepetitionWatch {
  content = ''
  reasoning = ''
  private checkedContent = 0
  private checkedReasoning = 0

  /** Adds text; true once either stream has fallen into a loop (then trimmed to where it began). */
  add(kind: 'content' | 'reasoning', text: string): boolean {
    this[kind] += text
    const checked = kind === 'content' ? this.checkedContent : this.checkedReasoning
    if (this[kind].length - checked < 1_000) return false
    if (kind === 'content') this.checkedContent = this[kind].length
    else this.checkedReasoning = this[kind].length
    const start = repetitionStart(this[kind])
    if (start === undefined) return false
    this[kind] = this[kind].slice(0, start)
    return true
  }

  /** The completion for a cut stream: the provider's usage never arrived. */
  degenerate(inputTokens: number): Completion {
    return {
      content: this.content,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      usage: { inputTokens, outputTokens: estimateTokens(this.content + this.reasoning) },
      degenerate: 'repetition',
    }
  }
}

/**
 * B3-1: opens a stream with the same retry and timeout as a plain request, and
 * one retry after a 400 that taught the endpoint's limits.
 */
async function openNegotiatedStream(
  label: string,
  url: string,
  headers: Record<string, string>,
  body: () => unknown,
  state: ProviderNegotiationState,
  options: CompleteOptions,
  role: RoleConfig,
  retry: RetryOptions,
): Promise<Response> {
  const open = () => openStreamWithRetry(
    label,
    url,
    { headers: { ...headers, Accept: 'text/event-stream' }, body: JSON.stringify(body()), signal: requestSignal(options.signal, role.requestTimeoutMs ?? 600_000) },
    retry,
  )
  try {
    return await open()
  } catch (error) {
    if (!learnFromError(state, error)) throw error
    return await open()
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name: string
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(
    private readonly role: RoleConfig,
    private readonly retry: RetryOptions = DEFAULT_RETRY,
  ) {
    this.name = `${role.provider}:${role.model}`
    this.baseUrl = (role.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')
    this.state = sharedProviderState(`${role.provider}|${this.baseUrl}|${role.model}`)
    const key = roleApiKey(role)
    if (!key) throw new LlmError(`missing API key: set ${role.apiKeyEnv ?? 'ANTHROPIC_API_KEY'}`)
    this.apiKey = key
  }

  /** What 400s from this endpoint taught (shared with every provider for it). */
  private readonly state: ProviderNegotiationState

  async complete(messages: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    if (options.onDelta && this.role.streaming === true) return this.completeStreaming(messages, options)
    const send = () => postWithRetry(
      this.name,
      `${this.baseUrl}${this.role.apiPath ?? '/v1/messages'}`,
      {
        headers: requestHeaders(this.role, this.apiKey, {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        }),
        body: JSON.stringify(this.body(messages, options)),
        signal: requestSignal(options.signal, this.role.requestTimeoutMs),
      },
      this.retry,
    )
    let text: string
    try {
      text = await send()
    } catch (error) {
      // A field or value this endpoint refuses: learn it and retry once.
      if (!learnFromError(this.state, error)) throw error
      text = await send()
    }
    return parseAnthropicResponse(text)
  }

  /**
   * B3-1: the Messages API stream, rebuilt into the non-streaming response
   * body and parsed by `parseAnthropicResponse`, so both paths agree. Off by
   * default (`role.streaming`) until verified against the live API.
   */
  private async completeStreaming(messages: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    const response = await openNegotiatedStream(
      this.name,
      `${this.baseUrl}${this.role.apiPath ?? '/v1/messages'}`,
      requestHeaders(this.role, this.apiKey, { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION }),
      () => ({ ...this.body(messages, options), stream: true }),
      this.state,
      options,
      this.role,
      this.retry,
    )
    return assembleAnthropicStream(sseData(response), options)
  }

  private body(messages: ChatMessage[], options: CompleteOptions) {
    const system = messages.find((message) => message.role === 'system')?.content ?? ''
    const maxTokens = negotiatedMaxTokens(this.state, options.maxTokens)
    // Extended thinking needs the default temperature and a budget below max_tokens.
    const thinking = anthropicThinkingBudget(negotiatedEffort(this.state, options.effort), maxTokens)
    const temperature = options.temperature !== undefined && !this.state.drop.has('temperature') && temperatureAllowedFor(this.role.provider, this.role.model)
      ? { temperature: options.temperature } : {}
    return {
      model: this.role.model,
      max_tokens: maxTokens,
      ...(thinking === undefined ? temperature : { thinking: { type: 'enabled', budget_tokens: thinking } }),
      // Prompt caching: explicit breakpoints (see withAnthropicCacheBreakpoints).
      ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
      messages: withAnthropicCacheBreakpoints(anthropicMessages(
        messages,
        (message) => Boolean(options.tools?.length) && (thinking === undefined || Boolean(message.thinkingBlocks?.length)),
      )),
      ...(options.tools && options.tools.length > 0
        ? { tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) }
        : {}),
      ...(this.role.extraBody ?? {}),
    }
  }
}

/**
 * B3-1: rebuilds a Messages API response from its stream events and parses it
 * like a non-streaming reply. Emits text and thinking deltas, and stops early
 * on a runaway repetition. A stream that ends before `message_stop` is an error.
 */
export async function assembleAnthropicStream(events: AsyncIterable<Record<string, unknown>>, options: Pick<CompleteOptions, 'onDelta'>): Promise<Completion> {
  type Block = { type?: string; text?: string; thinking?: string; signature?: string; data?: string; id?: string; name?: string; input?: unknown; json?: string }
  const blocks: Block[] = []
  let usage: Record<string, unknown> = {}
  let stopReason: string | undefined
  let finished = false
  const watch = new RepetitionWatch()
  for await (const event of events) {
    const type = event.type
    if (type === 'error') throw new LlmError(`Anthropic: ${String((event.error as { message?: unknown } | undefined)?.message ?? 'stream error')}`)
    if (type === 'message_start') usage = { ...((event.message as { usage?: Record<string, unknown> } | undefined)?.usage ?? {}) }
    else if (type === 'content_block_start') {
      const index = Number(event.index)
      blocks[index] = { ...(event.content_block as Block) }
    } else if (type === 'content_block_delta') {
      const block = blocks[Number(event.index)]
      const delta = (event.delta ?? {}) as { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string }
      if (!block) continue
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        block.text = (block.text ?? '') + delta.text
        options.onDelta?.({ content: delta.text })
        if (watch.add('content', delta.text)) return watch.degenerate(Number(usage.input_tokens ?? 0))
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        block.thinking = (block.thinking ?? '') + delta.thinking
        options.onDelta?.({ reasoning: delta.thinking })
        if (watch.add('reasoning', delta.thinking)) return watch.degenerate(Number(usage.input_tokens ?? 0))
      } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
        block.signature = (block.signature ?? '') + delta.signature
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        block.json = (block.json ?? '') + delta.partial_json
      }
    } else if (type === 'message_delta') {
      const delta = (event.delta ?? {}) as { stop_reason?: string }
      if (delta.stop_reason) stopReason = delta.stop_reason
      usage = { ...usage, ...((event.usage as Record<string, unknown> | undefined) ?? {}) }
    } else if (type === 'message_stop') finished = true
  }
  if (!finished) throw new LlmError('Anthropic: the stream ended before the response was complete')
  const content = blocks.filter(Boolean).map(({ json, ...block }) => {
    if (block.type !== 'tool_use') return block
    let input: unknown = {}
    try {
      input = json ? JSON.parse(json) : (block.input ?? {})
    } catch {
      input = undefined
    }
    return { ...block, input }
  })
  return parseAnthropicResponse(JSON.stringify({ content, ...(stopReason ? { stop_reason: stopReason } : {}), usage }))
}

/**
 * B3-1: a Responses API stream. Text and reasoning-summary deltas are emitted
 * live; the final `response.completed` / `response.incomplete` event carries
 * the whole response, which `parseOpenAiResponses` reads as in the
 * non-streaming path.
 */
export async function assembleResponsesStream(events: AsyncIterable<Record<string, unknown>>, options: Pick<CompleteOptions, 'onDelta'>): Promise<Completion> {
  const watch = new RepetitionWatch()
  for await (const event of events) {
    const type = String(event.type ?? '')
    if (type === 'error') throw new LlmError(`OpenAI Responses: ${String(event.message ?? 'stream error')}`)
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      options.onDelta?.({ content: event.delta })
      if (watch.add('content', event.delta)) return watch.degenerate(0)
    } else if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') && typeof event.delta === 'string') {
      options.onDelta?.({ reasoning: event.delta })
      if (watch.add('reasoning', event.delta)) return watch.degenerate(0)
    } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const response = event.response as { error?: { message?: unknown } } | undefined
      if (type === 'response.failed') throw new LlmError(`OpenAI Responses: ${String(response?.error?.message ?? 'the response failed')}`)
      return parseOpenAiResponses(JSON.stringify(response ?? {}))
    }
  }
  throw new LlmError('OpenAI Responses: the stream ended before the response was complete')
}

/** Parses one Messages API response (exported for the contract test). */
export function parseAnthropicResponse(text: string): Completion {
  let body: {
    content?: Array<{ type?: string; text?: string; thinking?: string; signature?: string; data?: string; id?: string; name?: string; input?: unknown }>
    stop_reason?: string
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
    error?: { type?: string; message?: string }
  }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    throw new LlmError(`Anthropic returned non-JSON: ${text.slice(0, 200)}`)
  }
  if (body.error?.message) throw new LlmError(`Anthropic: ${body.error.message}`)
  const blocks = body.content ?? []
  const textParts: string[] = []
  const toolCalls: Array<{ name: string; args: unknown; id?: string }> = []
  const thinkingBlocks: unknown[] = []
  let reasoning = ''
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text)
    else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      reasoning += block.thinking
      // Replayed before this reply's tool_use blocks (required with thinking on).
      if (typeof block.signature === 'string') thinkingBlocks.push({ type: 'thinking', thinking: block.thinking, signature: block.signature })
    } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') thinkingBlocks.push({ type: 'redacted_thinking', data: block.data })
    else if (block.type === 'tool_use' && typeof block.name === 'string') toolCalls.push({ name: block.name, args: block.input ?? {}, ...(block.id ? { id: block.id } : {}) })
  }
  const inputTokens = body.usage?.input_tokens ?? 0
  const cacheHitTokens = body.usage?.cache_read_input_tokens ?? 0
  const cacheWriteTokens = body.usage?.cache_creation_input_tokens ?? 0
  const usage: Usage = {
    inputTokens,
    outputTokens: body.usage?.output_tokens ?? 0,
    ...(cacheHitTokens > 0 || cacheWriteTokens > 0
      ? { cacheHitTokens, cacheMissTokens: Math.max(0, inputTokens - cacheHitTokens) }
      : {}),
  }
  return {
    content: textParts.join(''),
    ...(body.stop_reason === 'max_tokens' ? { outputLimited: true } : {}),
    usage,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(toolCalls.length > 0 && thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
  }
}

/**
 * OpenAI's Responses API (`POST /v1/responses`), which differs from Chat
 * Completions in both the request shape and the `output` items it returns.
 */
export class OpenAiResponsesProvider implements LlmProvider {
  readonly name: string
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(
    private readonly role: RoleConfig,
    private readonly retry: RetryOptions = DEFAULT_RETRY,
    private readonly sessionId?: string,
  ) {
    this.name = `${role.provider}:${role.model}`
    this.baseUrl = (role.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    this.state = sharedProviderState(`${role.provider}|${this.baseUrl}|${role.model}`)
    const key = roleApiKey(role)
    if (!key) throw new LlmError(`missing API key: set ${role.apiKeyEnv ?? 'OPENAI_API_KEY'}`)
    this.apiKey = key
  }

  /** What 400s from this endpoint taught (shared with every provider for it). */
  private readonly state: ProviderNegotiationState

  async complete(messages: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    const instructions = messages.find((message) => message.role === 'system')?.content
    const turn = (role: string, text: string, images: ImageInput[] | undefined) => ({
      role,
      content:
        images && images.length > 0
          ? [
              ...(text ? [{ type: 'input_text' as const, text }] : []),
              ...images.map((image) => ({
                type: 'input_image' as const,
                image_url: `data:${image.mimeType};base64,${image.data}`,
              })),
            ]
          : text,
    })
    // Tool steps go back as `function_call` / `function_call_output` items while tools are offered.
    const input = wireItems(messages.filter((message) => message.role !== 'system'), Boolean(options.tools?.length)).flatMap((item): unknown[] => {
      if (item.kind === 'message') return [turn(item.message.role, item.message.content, item.message.images)]
      const { calls, results, extra, images } = item.exchange
      return [
        ...calls.map((call) => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args ?? {}) })),
        ...results.map((result) => ({ type: 'function_call_output', call_id: result.id, output: result.text })),
        ...(extra || images?.length ? [turn('user', extra, images)] : []),
      ]
    })
    const body = () => {
      const effort = negotiatedEffort(this.state, options.effort)
      return {
      model: this.role.model,
      input,
      max_output_tokens: negotiatedMaxTokens(this.state, options.maxTokens),
      ...(instructions ? { instructions } : {}),
      ...(effort || this.role.reasoningSummary
        ? {
            reasoning: {
              ...(effort ? { effort } : {}),
              ...(this.role.reasoningSummary ? { summary: this.role.reasoningSummary } : {}),
            },
          }
        : {}),
      ...(this.role.verbosity ? { text: { verbosity: this.role.verbosity } } : {}),
      ...(this.role.serviceTier ? { service_tier: this.role.serviceTier } : {}),
      // Reasoning models take the default temperature only; none is sent unless the role sets one.
      ...(effort || options.temperature === undefined || this.state.drop.has('temperature') || !temperatureAllowedFor(this.role.provider, this.role.model)
        ? {} : { temperature: options.temperature }),
      ...(this.role.extraBody ?? {}),
      // CP-23: a stable cache key lets the provider reuse the prompt prefix.
      ...(this.sessionId ? { prompt_cache_key: `hy-${this.sessionId}` } : {}),
      ...(options.tools && options.tools.length > 0
        ? {
            tools: options.tools.map((tool) => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          }
        : {}),
      }
    }
    // B3-1: stream when the caller wants live deltas (role.streaming: false turns it off).
    if (options.onDelta && this.role.streaming !== false) {
      const response = await openNegotiatedStream(
        this.name,
        `${this.baseUrl}${this.role.apiPath ?? '/responses'}`,
        requestHeaders(this.role, this.apiKey, { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }),
        () => ({ ...body(), stream: true }),
        this.state,
        options,
        this.role,
        this.retry,
      )
      return assembleResponsesStream(sseData(response), options)
    }
    const send = () => postWithRetry(
      this.name,
      `${this.baseUrl}${this.role.apiPath ?? '/responses'}`,
      {
        headers: requestHeaders(this.role, this.apiKey, { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }),
        body: JSON.stringify(body()),
        signal: requestSignal(options.signal, this.role.requestTimeoutMs),
      },
      this.retry,
    )
    let text: string
    try {
      text = await send()
    } catch (error) {
      // A field or value this endpoint refuses: learn it and retry once.
      if (!learnFromError(this.state, error)) throw error
      text = await send()
    }
    return parseOpenAiResponses(text)
  }
}

/** Parses one Responses API reply (exported for the contract test). */
export function parseOpenAiResponses(text: string): Completion {
  let body: {
    output?: Array<{
      type?: string
      content?: Array<{ type?: string; text?: string }>
      summary?: Array<{ type?: string; text?: string }>
      name?: string
      arguments?: string
      call_id?: string
    }>
    output_text?: string
    incomplete_details?: { reason?: string }
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }
    error?: { message?: string }
  }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    throw new LlmError(`OpenAI Responses returned non-JSON: ${text.slice(0, 200)}`)
  }
  if (body.error?.message) throw new LlmError(`OpenAI Responses: ${body.error.message}`)
  const parts: string[] = []
  const toolCalls: Array<{ name: string; args: unknown; id?: string }> = []
  let reasoning = ''
  for (const item of body.output ?? []) {
    if (item.type === 'message') {
      for (const block of item.content ?? []) {
        if (block.type === 'output_text' && typeof block.text === 'string') parts.push(block.text)
      }
    } else if (item.type === 'reasoning') {
      for (const part of item.summary ?? []) {
        if (typeof part.text === 'string') reasoning += part.text
      }
    } else if (item.type === 'function_call' && typeof item.name === 'string') {
      toolCalls.push({ name: item.name, args: parseArgs(item.arguments), ...(item.call_id ? { id: item.call_id } : {}) })
    }
  }
  const inputTokens = body.usage?.input_tokens ?? 0
  const cached = body.usage?.input_tokens_details?.cached_tokens ?? 0
  return {
    content: parts.length > 0 ? parts.join('') : (body.output_text ?? ''),
    ...(reasoning ? { reasoning } : {}),
    ...(body.incomplete_details?.reason === 'max_output_tokens' ? { outputLimited: true } : {}),
    usage: {
      inputTokens,
      outputTokens: body.usage?.output_tokens ?? 0,
      ...(cached > 0 ? { cacheHitTokens: cached, cacheMissTokens: Math.max(0, inputTokens - cached) } : {}),
    },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  }
}

/**
 * WP-41: asks the provider which models it currently offers, so the model list
 * is not limited to the catalog or the user's config. Mock has no endpoint.
 */
export async function listProviderModels(role: RoleConfig): Promise<string[]> {
  const names = (await fetchModelEntries(role)).map((entry) => entry.id)
  return [...new Set(names)].sort()
}

/** A model as the provider's own listing describes it (limits when it states them). */
export interface DiscoveredModel {
  id: string
  contextWindowTokens?: number
  maxOutputTokens?: number
}

function positiveInt(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = typeof value === 'string' ? Number(value) : value
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n
  }
  return undefined
}

/**
 * Reads the limits a listing entry states, whatever the server calls them:
 * OpenRouter `context_length` / `top_provider.max_completion_tokens`, vLLM
 * `max_model_len`, LM Studio `max_context_length`, Gemini `inputTokenLimit` /
 * `outputTokenLimit`, and the plain `context_window` / `max_output_tokens`.
 */
export function modelEntryLimits(entry: Record<string, unknown>): Omit<DiscoveredModel, 'id'> {
  const top = (entry.top_provider && typeof entry.top_provider === 'object' ? entry.top_provider : {}) as Record<string, unknown>
  const context = positiveInt(entry.context_length, entry.max_model_len, entry.context_window, entry.max_context_length, entry.inputTokenLimit, entry.max_input_tokens, top.context_length)
  const output = positiveInt(entry.max_output_tokens, entry.max_completion_tokens, entry.outputTokenLimit, top.max_completion_tokens)
  return { ...(context ? { contextWindowTokens: context } : {}), ...(output ? { maxOutputTokens: output } : {}) }
}

/**
 * The limits the provider itself states for `model`, or `{}` when it states
 * none (or cannot be reached). Used when the user picks a model the registry
 * does not describe, instead of a table of model names kept in the harness.
 */
export async function discoverModelLimits(role: RoleConfig): Promise<Omit<DiscoveredModel, 'id'>> {
  try {
    if (role.provider === 'ollama') {
      const base = (role.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
      const response = await fetch(`${base}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: role.model }), signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return {}
      const body = (await response.json()) as { model_info?: Record<string, unknown>; capabilities?: unknown }
      // Newer servers list what the model takes ("completion", "tools", "vision", "thinking").
      if (Array.isArray(body.capabilities)) rememberReportedVision(role.provider, role.model, body.capabilities.includes('vision'))
      const key = Object.keys(body.model_info ?? {}).find((name) => name.endsWith('.context_length'))
      const context = key ? positiveInt(body.model_info![key]) : undefined
      return context ? { contextWindowTokens: context } : {}
    }
    const entries = await cachedModelEntries(role)
    const found = entries?.find((entry) => entry.id === role.model)
    return found ? { ...(found.contextWindowTokens ? { contextWindowTokens: found.contextWindowTokens } : {}), ...(found.maxOutputTokens ? { maxOutputTokens: found.maxOutputTokens } : {}) } : {}
  } catch {
    return {}
  }
}

const modelListCache = new Map<string, { at: number; entries: DiscoveredModel[] }>()

/** The endpoint's listing, kept 5 minutes; undefined when it cannot be read. */
async function cachedModelEntries(role: RoleConfig): Promise<DiscoveredModel[] | undefined> {
  if (role.provider === 'mock') return undefined
  const key = `${role.provider}|${role.baseUrl ?? ''}`
  const cached = modelListCache.get(key)
  if (cached && Date.now() - cached.at <= 5 * 60_000) return cached.entries
  try {
    const entries = await fetchModelEntries(role)
    modelListCache.set(key, { at: Date.now(), entries })
    return entries
  } catch {
    return undefined
  }
}

/**
 * Whether the endpoint lists `model`: true / false from its own listing,
 * undefined when it has no listing or cannot be reached (then nothing is
 * claimed). Replaces per-gateway lists of unavailable model names.
 */
export async function endpointOffersModel(role: RoleConfig, model: string): Promise<boolean | undefined> {
  const entries = await cachedModelEntries(role)
  if (!entries || entries.length === 0) return undefined
  return entries.some((entry) => entry.id === model)
}

async function fetchModelEntries(role: RoleConfig): Promise<DiscoveredModel[]> {
  const base = (role.baseUrl ?? '').replace(/\/+$/, '')
  const key = role.provider === 'ollama' ? undefined : roleApiKey(role)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let url: string
  if (role.provider === 'ollama') {
    url = `${base || 'http://127.0.0.1:11434'}/api/tags`
  } else if (role.provider === 'anthropic') {
    url = `${base || 'https://api.anthropic.com'}/v1/models`
    if (key) headers['x-api-key'] = key
    headers['anthropic-version'] = ANTHROPIC_VERSION
  } else if (role.provider === 'gemini') {
    url = `${base || 'https://generativelanguage.googleapis.com/v1beta'}/models`
    if (key) headers['x-goog-api-key'] = key
  } else if (role.provider === 'mock') {
    throw new LlmError('the mock provider has no model list')
  } else {
    url = `${base || 'https://api.openai.com/v1'}/models`
    if (key) headers.Authorization = `Bearer ${key}`
  }
  let response: Response
  try {
    response = await fetch(url, { headers })
  } catch (error) {
    throw new LlmError(`could not list models from ${role.provider}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  if (!response.ok) {
    throw new LlmError(`could not list models from ${role.provider}: ${response.status} ${text.slice(0, 200)}`, response.status, text)
  }
  let body: {
    data?: Array<Record<string, unknown>>
    models?: Array<Record<string, unknown>>
  }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    throw new LlmError(`${role.provider} returned non-JSON for its model list`)
  }
  return (body.data ?? body.models ?? []).flatMap((entry) => {
    // Gemini lists `models/<id>`; the API takes the bare id.
    const raw = typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : ''
    const id = role.provider === 'gemini' ? raw.replace(/^models\//, '') : raw
    return id ? [{ id, ...modelEntryLimits(entry) }] : []
  })
}
/**
 * The routing / cache key sent to providers that keep their prompt cache per
 * key (OpenCode's `x-opencode-session`, OpenAI's `prompt_cache_key`). Measured
 * on OpenCode (2026-11-07): an identical prompt from another session id never
 * hits, the same id does. So every session of a workspace (chats, workers,
 * subagents) shares one key, and a new session reuses the cached system prompt
 * and tool definitions the previous one wrote (they are identical up to the
 * per-session tail, see `buildSystemPrompt`). `HY_CACHE_ROUTING=session` keeps
 * one key per run instead.
 */
export function cacheRouteKey(workspaceRoot: string, sessionId?: string): string | undefined {
  if (sessionId === undefined) return undefined
  if (process.env.HY_CACHE_ROUTING === 'session') return sessionId
  const root = path.resolve(workspaceRoot).replace(/[\\/]+$/, '').toLowerCase()
  return `hy-ws-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`
}

type ReserveModelCost = (maximum: number) => (settled: number) => void
const modelBudget = new AsyncLocalStorage<ReserveModelCost>()

export function withModelBudget<T>(reserve: ReserveModelCost, run: () => T): T {
  return modelBudget.run(reserve, run)
}

/**
 * USD pricing for a role. The harness ships none: prices change and differ by
 * plan, so they are user data — set `pricing` on the role or on the model in
 * `models[]`. Without it a USD cap cannot be enforced and the run is refused
 * before any request is sent.
 */
function modelPricing(role: RoleConfig): RoleConfig['pricing'] | undefined {
  return role.pricing ?? catalogForRole(role)?.pricing
}

/**
 * A message with credentials (E1: GitHub and other providers' tokens, private
 * keys, URL and header credentials, the harness's own key values) masked in
 * every part the adapters send:
 * the text, the reasoning, and the structured calls and results (which repeat
 * the text and would otherwise carry the credential past the mask). Other
 * fields (provider continuation, images) are kept.
 */
export function redactMessage(message: ChatMessage): ChatMessage {
  const content = redactSecrets(message.content)
  const reasoning = message.reasoning === undefined ? undefined : redactSecrets(message.reasoning)
  let toolCalls = message.toolCalls
  if (toolCalls) {
    try {
      const masked = toolCalls.map((call) => ({ ...call, args: JSON.parse(redactSecrets(JSON.stringify(call.args ?? {}))) as unknown }))
      toolCalls = JSON.stringify(masked) === JSON.stringify(toolCalls) ? toolCalls : masked
    } catch {
      // The masked arguments are not JSON: the step goes back as (masked) text.
      toolCalls = undefined
    }
  }
  const toolResults = message.toolResults && {
    rendered: redactSecrets(message.toolResults.rendered),
    entries: message.toolResults.entries.map((entry) => ({ ...entry, text: redactSecrets(entry.text) })),
  }
  const resultsChanged = toolResults !== undefined &&
    (toolResults.rendered !== message.toolResults!.rendered || toolResults.entries.some((entry, i) => entry.text !== message.toolResults!.entries[i]!.text))
  if (content === message.content && reasoning === message.reasoning && toolCalls === message.toolCalls && !resultsChanged) return message
  const { toolCalls: _calls, toolResults: _results, ...rest } = message
  return {
    ...rest,
    content,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(toolCalls ? { toolCalls } : {}),
    ...(toolResults ? { toolResults } : {}),
  }
}

export function createProvider(role: RoleConfig, workspaceRoot: string, runId?: string): LlmProvider {
  const provider = createUnbudgetedProvider(role, workspaceRoot, runId)
  return {
    name: provider.name,
    async complete(messages, options) {
      // Old sessions can contain credentials from before the Git host boundary.
      const safeMessages = messages.map(redactMessage)
      const reserve = modelBudget.getStore()
      if (!reserve || role.provider === 'mock' || role.provider === 'ollama') return provider.complete(safeMessages, options)
      const pricing = modelPricing(role)
      if (!pricing) {
        throw new LlmError(
          `No USD pricing for ${provider.name}: set roles.*.pricing or add a "pricing" entry for this model in "models", or run without a USD cap.`,
        )
      }
      const context = role.contextWindowTokens
      const maximum = (context * pricing.inputPerMTokUsd + options.maxTokens * pricing.outputPerMTokUsd) / 1_000_000
      const settle = reserve(maximum)
      let result: Completion
      try {
        result = await provider.complete(safeMessages, options)
      } catch (error) {
        // An interrupted response may have incurred charges without returning usage.
        settle(maximum)
        throw error
      }
      // A degenerate stream and a response without usable usage (an endpoint
      // that refused `stream_options` reports none) both leave the real cost
      // unknown, so the whole reservation is charged. Settling here instead of
      // returning early is what keeps the reservation from staying checked out
      // for the rest of the orchestration, where it would silently lower every
      // later call's ceiling until the turn fails on a phantom overspend.
      const usage = result.usage
      if (
        result.degenerate ||
        !usage ||
        !Number.isFinite(usage.inputTokens) ||
        !Number.isFinite(usage.outputTokens) ||
        usage.inputTokens <= 0 ||
        usage.outputTokens < 0
      ) {
        settle(maximum)
        return result
      }
      const { inputTokens, outputTokens, cacheHitTokens = 0 } = usage
      const cached = Math.min(inputTokens, Math.max(0, Number.isFinite(cacheHitTokens) ? cacheHitTokens : 0))
      settle(((inputTokens - cached) * pricing.inputPerMTokUsd + cached * (pricing.cachedInputPerMTokUsd ?? pricing.inputPerMTokUsd) +
        outputTokens * pricing.outputPerMTokUsd) / 1_000_000)
      return result
    },
  }
}

function createUnbudgetedProvider(role: RoleConfig, workspaceRoot: string, runId?: string): LlmProvider {
  const sessionId = cacheRouteKey(workspaceRoot, runId)
  switch (role.provider) {
    case 'mock':
      return new MockProvider(workspaceRoot)
    case 'ollama':
      return new OllamaProvider(role)
    case 'deepseek':
    case 'openai-compatible':
    case 'opencode':
      return new OpenAiProvider(role, undefined, sessionId)
    case 'gemini':
      return new GeminiProvider(role)
    case 'anthropic':
      return new AnthropicProvider(role)
    case 'openai-responses':
      return new OpenAiResponsesProvider(role, undefined, sessionId)
  }
}
