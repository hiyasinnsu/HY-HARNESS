// Request-shape negotiation for every adapter (OpenAI-compatible, Responses,
// Anthropic, Gemini).
//
// The harness cannot know which optional fields a given endpoint accepts. It
// sends the fields it needs (a token limit, temperature, stream usage, JSON
// mode, reasoning effort) and, when an endpoint answers 400 naming one of
// them, drops exactly those fields and retries once. What was learned stays in
// a process-wide map keyed by endpoint, so it survives the provider instance
// (a provider is built per turn, per round and per retry).

/** Optional request fields that an endpoint may reject. */
export type DropField =
  | 'tokenField'
  | 'effort'
  | 'response_format'
  | 'stream_options'
  | 'temperature'
  | 'reasoning_content'
  | 'tools'

/** What one endpoint has taught the harness about the request shape it takes. */
export interface ProviderNegotiationState {
  /** Optional request fields this endpoint rejected with a 400. */
  readonly drop: Set<DropField>
  /**
   * Whether earlier assistant reasoning goes back as `reasoning_content`.
   * Undefined until a response carried reasoning (or a role/registry says).
   */
  echoReasoning?: boolean
  /** The output-token limit a 400 named (requests are capped to it). */
  maxOutputTokens?: number
  /** The effort values a 400 listed as valid (requests use the nearest). */
  effortValues?: string[]
}

const states = new Map<string, ProviderNegotiationState>()

/**
 * The negotiation state of one endpoint. Callers key it by
 * `${provider}|${baseUrl}|${model}`: credentials and prompts differ per turn,
 * the fields the endpoint accepts do not. Sharing it means one 400 teaches
 * every later request, including those of another worker or subagent.
 */
export function sharedProviderState(key: string): ProviderNegotiationState {
  let state = states.get(key)
  if (state === undefined) {
    state = { drop: new Set<DropField>() }
    states.set(key, state)
  }
  return state
}

/** Test hook: forgets everything learned, so cases cannot leak into each other. */
export function resetProviderStates(): void {
  states.clear()
}

/** The harness's effort scale, lowest first. */
export const EFFORT_SCALE = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** What one 400 teaches about the request shape. */
export interface Negotiation {
  /** Optional fields to leave out from now on. */
  drop: Set<DropField>
  /** The endpoint named a smaller output-token limit than the one sent. */
  maxOutputTokens?: number
  /** The endpoint listed the effort values it takes. */
  effortValues?: string[]
}

function errorBody(error: unknown): string | undefined {
  const status = (error as { status?: unknown }).status
  // 422 is how several validating gateways answer a bad request body.
  if (status !== 400 && status !== 422) return undefined
  const body = String((error as { body?: unknown }).body ?? (error as { message?: unknown }).message ?? '').toLowerCase()
  return body || undefined
}

/**
 * An output-token limit stated in a 400 body: a value that is too large is a
 * value problem, not an unsupported field. Covers "max_tokens must be less than
 * or equal to 8192", "…32768 > 8192, which is the maximum allowed", and the
 * context form "maximum context length is 32768 tokens … 30000 in the messages,
 * 8000 in the completion", where the room left for output is what counts.
 */
function statedOutputLimit(body: string): number | undefined {
  const context = /maximum context length is (\d+)/.exec(body)
  const inMessages = /(\d+) (?:tokens )?in the messages/.exec(body)
  if (context && inMessages && /in the completion/.test(body)) {
    const room = Number(context[1]) - Number(inMessages[1]) - 64
    return room > 0 ? room : undefined
  }
  if (!/max_(?:completion_|output_|new_)?tokens|max_output_tokens|output tokens/.test(body)) return undefined
  const patterns = [
    /(?:less than or equal to|at most|<=|≤|not exceed|no (?:more|greater) than|maximum(?: value)?(?: allowed)?(?: is| of)?|up to|must be below)\s*:?\s*\[?(\d{3,})/,
    /between \d+ and (\d{3,})/,
    /range[^0-9]{0,20}\d+\s*(?:-|to|,)\s*(\d{3,})/,
    /(\d{3,})\s*,?\s*(?:which is|is) the maximum/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(body)
    if (match) return Number(match[1])
  }
  return undefined
}

/**
 * The model's context window as an overflow error states it ("maximum context
 * length is 32768 tokens", "prompt is too long: 250000 tokens > 200000
 * maximum", "exceeds the context window of 131072 tokens"). Undefined when the
 * error names no window.
 */
export function statedContextLimit(error: unknown): number | undefined {
  const body = String((error as { body?: unknown }).body ?? (error as { message?: unknown }).message ?? '').toLowerCase()
  const patterns = [
    /maximum context length is (\d{3,})/,
    /prompt is too long:\s*\d+ tokens?\s*>\s*(\d{3,})/,
    /context (?:window|length|size|limit)(?: of| is)?\s*:?\s*\(?(\d{3,})/,
    /exceeds? (?:the )?(?:model'?s? )?(?:maximum |max )?(?:context|input)[^0-9]{0,40}(\d{3,})/,
    /(\d{3,}) (?:token )?(?:context window|context length)/,
    // llama.cpp server: "exceeds the available context size … (n_ctx 8192)".
    /n_ctx(?:_slot)?\s*[:=]?\s*(\d{3,})/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(body)
    if (match) return Number(match[1])
  }
  return undefined
}

/** Effort values a 400 lists as valid ("must be one of 'low', 'medium', 'high'"). */
function statedEffortValues(body: string): string[] | undefined {
  // `\b` keeps "invalid value for reasoning_effort: 'xhigh'" from reading as a list.
  const list = /\b(?:one of|supported values?(?: are| is)?|allowed values?(?: are| is)?|expected|valid values?(?: are| is)?|must be)\s*:?\s*([^\n.]{0,200})/.exec(body)
  if (!list) return undefined
  const values = EFFORT_SCALE.filter((value) => new RegExp(`(^|[^a-z])${value}([^a-z]|$)`).test(list[1]!))
  return values.length > 0 ? [...values] : undefined
}

/**
 * What a 400 (or 422) body teaches: the optional fields it names as
 * unsupported, a smaller output-token limit, or the effort values it takes.
 * Empty when the error is not about the request shape, so unrelated 400s
 * still fail.
 */
export function negotiate(error: unknown): Negotiation {
  const out: Negotiation = { drop: new Set<DropField>() }
  const body = errorBody(error)
  if (!body) return out
  const limit = statedOutputLimit(body)
  if (limit !== undefined) out.maxOutputTokens = limit
  if (!/unsupported|not supported|does not support|unrecognized|unknown|unexpected|invalid|not allowed|must be|should be|extra inputs/.test(body)) return out
  // The token field is dropped only when its name is refused, not its value.
  if (limit === undefined && (body.includes('max_completion_tokens') || body.includes('max_tokens')) &&
    /unsupported|not supported|unrecognized|unknown|unexpected|not allowed|extra inputs|use '?max_(?:completion_)?tokens'? instead/.test(body)) out.drop.add('tokenField')
  // The thinking *field* (Anthropic `thinking`, Gemini `thinking_level`), not
  // prose about thinking mode ("reasoning_content in the thinking mode must…").
  if (/reasoning_effort|reasoning\.effort|thinking_level|budget_tokens|thinking\.type|[`'"]thinking[`'"]|(^|[^a-z_])effort([^a-z_]|$)/.test(body)) {
    const values = /reasoning_effort|effort|thinking_level/.test(body) ? statedEffortValues(body) : undefined
    if (values) out.effortValues = values
    else out.drop.add('effort')
  }
  if (body.includes('stream_options') || body.includes('include_usage')) out.drop.add('stream_options')
  if (body.includes('response_format') || body.includes('json_object') || body.includes('json mode')) out.drop.add('response_format')
  if (/(^|[^a-z_])temperature([^a-z_]|$)/.test(body)) out.drop.add('temperature')
  if (body.includes('reasoning_content') || body.includes('reasoning block')) out.drop.add('reasoning_content')
  // "reasoning_effort with function tools" is about the combination: drop the
  // effort, not the tools.
  if (!/reasoning_effort|effort|thinking_level/.test(body) && /(^|[^a-z])tools?([^a-z]|$)/.test(body) && /unsupported|not supported|does not support/.test(body)) out.drop.add('tools')
  return out
}

/** The optional fields a 400 names (see `negotiate`). */
export function rejectedFields(error: unknown): Set<DropField> {
  return negotiate(error).drop
}

/**
 * Records what `error` teaches in `state`; true when something new was
 * learned (so one retry is worth it).
 */
export function learnFromError(state: ProviderNegotiationState, error: unknown): boolean {
  const lesson = negotiate(error)
  let learned = false
  for (const field of lesson.drop) {
    if (state.drop.has(field)) continue
    state.drop.add(field)
    learned = true
  }
  if (lesson.maxOutputTokens !== undefined && lesson.maxOutputTokens > 0 && (state.maxOutputTokens === undefined || lesson.maxOutputTokens < state.maxOutputTokens)) {
    state.maxOutputTokens = lesson.maxOutputTokens
    learned = true
  }
  if (lesson.effortValues && JSON.stringify(lesson.effortValues) !== JSON.stringify(state.effortValues)) {
    state.effortValues = lesson.effortValues
    learned = true
  }
  return learned
}

/**
 * The effort to send: the requested value, or the nearest one the endpoint
 * listed as valid (ties go up: the caller asked for reasoning). `none` that
 * the endpoint does not list means "send no effort"; so does a dropped field.
 */
export function negotiatedEffort(state: ProviderNegotiationState, effort: string | undefined): string | undefined {
  if (effort === undefined || state.drop.has('effort')) return undefined
  const allowed = state.effortValues
  if (!allowed || allowed.includes(effort)) return effort
  if (effort === 'none') return undefined
  const rank = (value: string) => EFFORT_SCALE.indexOf(value as (typeof EFFORT_SCALE)[number])
  const wanted = rank(effort)
  if (wanted < 0) return allowed.at(-1)
  return [...allowed].sort((a, b) => Math.abs(rank(a) - wanted) - Math.abs(rank(b) - wanted) || rank(b) - rank(a))[0]
}

/** The output-token value to send: the requested one, capped by what the endpoint said it takes. */
export function negotiatedMaxTokens(state: ProviderNegotiationState, requested: number): number {
  return state.maxOutputTokens !== undefined ? Math.min(requested, state.maxOutputTokens) : requested
}

/** Text from `content` whether the endpoint sends a string or content parts. */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  let out = ''
  for (const part of value) {
    if (typeof part === 'string') out += part
    else if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') out += (part as { text: string }).text
  }
  return out
}

export interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  input_tokens?: number
  output_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  cache_read_input_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  input_tokens_details?: { cached_tokens?: number }
}

/**
 * Provider usage in one shape. Endpoints name the same numbers differently
 * (OpenAI, DeepSeek, Anthropic-style gateways); unknown fields mean 0, which
 * callers already treat as "unknown".
 */
export function normalizeUsage(raw: RawUsage | undefined): {
  inputTokens: number
  outputTokens: number
  cacheHitTokens?: number
  cacheMissTokens?: number
} {
  const inputTokens = raw?.prompt_tokens ?? raw?.input_tokens ?? 0
  const outputTokens = raw?.completion_tokens ?? raw?.output_tokens ?? 0
  const cached =
    raw?.prompt_cache_hit_tokens ??
    raw?.prompt_tokens_details?.cached_tokens ??
    raw?.input_tokens_details?.cached_tokens ??
    raw?.cache_read_input_tokens
  if (raw?.prompt_cache_miss_tokens !== undefined) {
    const cacheMissTokens = raw.prompt_cache_miss_tokens
    return { inputTokens, outputTokens, cacheHitTokens: cached ?? Math.max(0, inputTokens - cacheMissTokens), cacheMissTokens }
  }
  if (cached === undefined) return { inputTokens, outputTokens }
  return { inputTokens, outputTokens, cacheHitTokens: cached, cacheMissTokens: Math.max(0, inputTokens - cached) }
}

/**
 * Headers for a request: the adapter defaults, then the role's own headers
 * (`${apiKey}` is replaced), then the adapter's per-call extras.
 */
export function requestSignal(signal: AbortSignal | undefined, timeoutMs = 600_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal
}

export function requestHeaders(
  role: { headers?: Record<string, string> },
  apiKey: string,
  defaults: Record<string, string>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const custom: Record<string, string> = {}
  for (const [name, value] of Object.entries(role.headers ?? {})) {
    custom[name] = value.replaceAll('${apiKey}', apiKey)
  }
  return { ...defaults, ...custom, ...extra }
}
