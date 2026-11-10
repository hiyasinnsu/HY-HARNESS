// Request-shape negotiation for OpenAI-compatible endpoints.
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

/**
 * The fields a 400 body names as unsupported (or invalid). Empty when the
 * error is not about the request shape, so unrelated 400s still fail.
 */
export function rejectedFields(error: unknown): Set<DropField> {
  const out = new Set<DropField>()
  const status = (error as { status?: unknown }).status
  if (status !== 400) return out
  const body = String((error as { body?: unknown }).body ?? (error as { message?: unknown }).message ?? '').toLowerCase()
  if (!body) return out
  if (!/unsupported|not supported|does not support|unrecognized|unknown|unexpected|invalid/.test(body)) return out
  if (body.includes('max_completion_tokens') || body.includes('max_tokens')) out.add('tokenField')
  if (body.includes('reasoning_effort')) out.add('effort')
  if (body.includes('stream_options') || body.includes('include_usage')) out.add('stream_options')
  if (body.includes('response_format') || body.includes('json_object') || body.includes('json mode')) out.add('response_format')
  if (/(^|[^a-z_])temperature([^a-z_]|$)/.test(body)) out.add('temperature')
  if (body.includes('reasoning_content') || body.includes('reasoning block')) out.add('reasoning_content')
  // "reasoning_effort with function tools" is about the combination: drop the
  // effort, not the tools.
  if (!body.includes('reasoning_effort') && /(^|[^a-z])tools?([^a-z]|$)/.test(body) && /unsupported|not supported|does not support/.test(body)) out.add('tools')
  return out
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
