import fs from 'node:fs'
import path from 'node:path'
import { roleApiKey, type RoleConfig } from './config.js'
import { isSteerMessage, steerText } from './steering.js'
import { effortWithToolsFor, temperatureAllowedFor, tokenFieldFor } from './model-catalog.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Attached images (user messages; Codex `--image`). Not logged: the log records their paths. */
  images?: ImageInput[]
}

export interface ImageInput {
  mimeType: string
  /** Base64 data. */
  data: string
}

/** Messages in Ollama's shape: images as a base64 list beside the text. */
function ollamaMessages(messages: ChatMessage[]) {
  return messages.map((m) => (m.images?.length ? { role: m.role, content: m.content, images: m.images.map((i) => i.data) } : { role: m.role, content: m.content }))
}

/** Messages in the OpenAI Chat Completions shape: images as data-URL content parts. */
function openAiMessages(messages: ChatMessage[]) {
  return messages.map((m) =>
    m.images?.length
      ? {
          role: m.role,
          content: [
            { type: 'text', text: m.content },
            ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
          ],
        }
      : { role: m.role, content: m.content },
  )
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
}

/** A tool offered through native function calling (JSON Schema parameters, root type object). */
export interface NativeToolDef {
  name: string
  description: string
  parameters: unknown
}

export interface CompleteOptions {
  maxTokens: number
  temperature: number
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

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
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

const DEFAULT_RETRY: RetryOptions = { retries: 3, baseDelayMs: 500, maxDelayMs: 8_000 }

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
      await sleep(Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt), init.signal)
      continue
    }
    const text = await response.text()
    if (response.ok) return text
    const retriable = response.status === 429 || response.status >= 500
    if (!retriable || attempt >= retry.retries) {
      throw new LlmError(`${label} HTTP ${response.status}: ${text.slice(0, 800)}`, response.status, text)
    }
    const after = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(after) && after > 0 ? after * 1_000 : retry.baseDelayMs * 2 ** attempt
    await sleep(Math.min(retry.maxDelayMs, delay), init.signal)
  }
}

/**
 * CP-18: opens a streaming POST, retrying like `postWithRetry` (429, 5xx,
 * network errors; `Retry-After` honoured) until the response is OK. Nothing
 * has been streamed before the status is known, so a retry cannot duplicate
 * output. Returns the open response; its body is the caller's to read.
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
      await sleep(Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt), init.signal)
      continue
    }
    if (response.ok) return response
    const text = await response.text()
    const retriable = response.status === 429 || response.status >= 500
    if (!retriable || attempt >= retry.retries) {
      throw new LlmError(`${label} HTTP ${response.status}: ${text.slice(0, 300)}`, response.status, text.slice(0, 300))
    }
    const after = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(after) && after > 0 ? after * 1_000 : retry.baseDelayMs * 2 ** attempt
    await sleep(Math.min(retry.maxDelayMs, delay), init.signal)
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
      `${this.baseUrl}/api/chat`,
      {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.role.model,
          messages: ollamaMessages(messages),
          stream: false,
          think: false,
          // Constrained JSON and native tool calls exclude each other.
          ...(options.tools ? { tools: toolsField(options.tools) } : options.json === false ? {} : { format: 'json' }),
          options: {
            temperature: options.temperature,
            num_predict: options.maxTokens,
            // Without num_ctx Ollama uses its small server default, not the
            // context window recorded in the role.
            num_ctx: this.role.contextWindowTokens,
          },
        }),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      this.retry,
    )
    const body = JSON.parse(text) as {
      message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> }
      prompt_eval_count?: number
      eval_count?: number
    }
    const calls = (body.message?.tool_calls ?? []).filter((c) => c.function?.name)
    return {
      content: body.message?.content ?? '',
      usage: {
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
      },
      ...(calls.length > 0 ? { toolCalls: calls.map((c) => ({ name: c.function!.name!, args: parseArgs(c.function!.arguments) })) } : {}),
    }
  }
}

/** OpenAI's reasoning and GPT-5/6+ chat models require `max_completion_tokens`. */
function openAiTokenField(provider: string, model: string): 'max_tokens' | 'max_completion_tokens' {
  if (provider !== 'openai-compatible' && provider !== 'opencode' && provider !== 'openai-responses') return 'max_tokens'
  // WP-41: the model catalog owns the quirk; unknown models keep the heuristic.
  return tokenFieldFor(provider as RoleConfig['provider'], model)
}

/** A 400 saying the chosen token-limit parameter is not supported by this model. */
function alternateTokenField(
  field: 'max_tokens' | 'max_completion_tokens',
  error: unknown,
): 'max_tokens' | 'max_completion_tokens' | undefined {
  if (!(error instanceof LlmError) || error.status !== 400) return undefined
  const body = (error.body ?? error.message).toLowerCase()
  if (!body.includes('unsupported') && !body.includes('not supported') && !body.includes('unknown')) return undefined
  if (field === 'max_tokens' && body.includes('max_completion_tokens')) return 'max_completion_tokens'
  if (field === 'max_completion_tokens' && body.includes('max_tokens')) return 'max_tokens'
  return undefined
}

/** gpt-6.1-terra rejects reasoning_effort together with function tools. */
function reasoningEffortConflict(error: unknown): boolean {
  if (!(error instanceof LlmError) || error.status !== 400) return false
  const body = (error.body ?? error.message).toLowerCase()
  return body.includes('reasoning_effort') && body.includes('function tools')
}

export class OpenAiProvider implements LlmProvider {
  readonly name: string
  private readonly baseUrl: string
  private readonly apiKey: string
  /** Set for models known to reject effort + tools, or after the first 400. */
  private omitEffortWithTools: boolean

  constructor(
    private readonly role: RoleConfig,
    private readonly retry: RetryOptions = DEFAULT_RETRY,
    private readonly sessionId?: string,
  ) {
    this.name = `${role.provider}:${role.model}`
    this.baseUrl = (role.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    this.omitEffortWithTools = !effortWithToolsFor(role.provider, role.model)
    const key = roleApiKey(role)
    if (!key) {
      throw new LlmError(
        `missing API key: set ${role.apiKeyEnv ?? (role.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : role.provider === 'opencode' ? 'OPENCODE_API_KEY' : 'OPENAI_API_KEY')}`,
      )
    }
    this.apiKey = key
  }


  /**
   * CP-18: one streaming request. Parses `data:` chunks, emits deltas and
   * assembles the same `Completion` the non-streaming path returns.
   */
  private async completeStreaming(messages: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    const opencodeSession = this.sessionId && (this.role.provider === 'opencode' || isOpenCodeHost(this.baseUrl))
      ? `ses_${this.sessionId.replace(/^ses_/, '').replace(/[^a-zA-Z0-9_-]/g, '_')}`
      : undefined
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'text/event-stream',
      ...(opencodeSession ? { 'x-opencode-session': opencodeSession, 'User-Agent': 'HY-HARNESS/0.1.0' } : {}),
    }
    const tokenField = openAiTokenField(this.role.provider, this.role.model)
    const withTemperature = temperatureAllowedFor(this.role.provider, this.role.model)
    const omitEffort = this.omitEffortWithTools
    const body = JSON.stringify({
      model: this.role.model,
      messages: openAiMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      [tokenField]: options.maxTokens,
      ...(withTemperature ? { temperature: options.temperature } : {}),
      ...(options.effort && !(options.tools && omitEffort) ? { reasoning_effort: options.effort } : {}),
      ...(options.tools ? { tools: toolsField(options.tools) } : options.json === false ? {} : { response_format: { type: 'json_object' } }),
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('stream timed out')), 600_000)
    const signal = options.signal
      ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, controller.signal]) : options.signal)
      : controller.signal
    try {
      const response = await openStreamWithRetry(this.role.provider, `${this.baseUrl}/chat/completions`, { headers, body, signal }, this.retry)
      const reader = response.body?.getReader()
      if (!reader) throw new LlmError(`${this.role.provider}: the streaming response has no body`)
      const decoder = new TextDecoder()
      let buffer = ''
      let content = ''
      let reasoning = ''
      const calls = new Map<number, { name: string; args: string }>()
      let usage: Usage = { inputTokens: 0, outputTokens: 0 }
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
          if (payload === '' || payload === '[DONE]') continue
          let chunk: {
            error?: { message?: string }
            usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
            choices?: Array<{
              delta?: {
                content?: string | null
                reasoning_content?: string | null
                reasoning?: string | null
                tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }>
              }
            }>
          }
          try {
            chunk = JSON.parse(payload) as typeof chunk
          } catch {
            continue
          }
          if (chunk.error?.message) throw new LlmError(`${this.role.provider}: ${chunk.error.message}`)
          if (chunk.usage) {
            const input = chunk.usage.prompt_tokens ?? 0
            const cached = chunk.usage.prompt_cache_hit_tokens ?? chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
            usage = {
              inputTokens: input,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              ...(cached > 0 ? { cacheHitTokens: cached, cacheMissTokens: chunk.usage.prompt_cache_miss_tokens ?? Math.max(0, input - cached) } : {}),
            }
          }
          const delta = chunk.choices?.[0]?.delta
          if (!delta) continue
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            content += delta.content
            options.onDelta?.({ content: delta.content })
          }
          const thought = delta.reasoning_content ?? delta.reasoning
          if (typeof thought === 'string' && thought.length > 0) {
            reasoning += thought
            options.onDelta?.({ reasoning: thought })
          }
          for (const [i, call] of (delta.tool_calls ?? []).entries()) {
            const index = call.index ?? i
            const current = calls.get(index) ?? { name: '', args: '' }
            if (call.function?.name) current.name += call.function.name
            if (call.function?.arguments) current.args += call.function.arguments
            calls.set(index, current)
          }
        }
      }
      const toolCalls = [...calls.values()].filter((call) => call.name.length > 0).map((call) => ({ name: call.name, args: parseArgs(call.args) }))
      return {
        content,
        ...(reasoning.length > 0 ? { reasoning } : {}),
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
    const opencodeSession = this.sessionId && (this.role.provider === 'opencode' || isOpenCodeHost(this.baseUrl))
      ? `ses_${this.sessionId.replace(/^ses_/, '').replace(/[^a-zA-Z0-9_-]/g, '_')}`
      : undefined
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...(opencodeSession ? { 'x-opencode-session': opencodeSession, 'User-Agent': 'HY-HARNESS/0.1.0' } : {}),
    }
    const payload = (
      tokenField: 'max_tokens' | 'max_completion_tokens',
      withTemperature: boolean,
      omitEffort = this.omitEffortWithTools,
    ): string =>
      JSON.stringify({
        model: this.role.model,
        messages: openAiMessages(messages),
        [tokenField]: options.maxTokens,
        ...(withTemperature ? { temperature: options.temperature } : {}),
        ...(options.effort && !(options.tools && omitEffort) ? { reasoning_effort: options.effort } : {}),
        ...(options.tools ? { tools: toolsField(options.tools) } : options.json === false ? {} : { response_format: { type: 'json_object' } }),
      })
    const tokenField = openAiTokenField(this.role.provider, this.role.model)
    // OpenAI's newest reasoning models only accept the default temperature.
    const withTemperature = temperatureAllowedFor(this.role.provider, this.role.model)
    let text: string
    try {
      text = await postWithRetry(
        this.role.provider,
        `${this.baseUrl}/chat/completions`,
        { headers, body: payload(tokenField, withTemperature), ...(options.signal !== undefined ? { signal: options.signal } : {}) },
        this.retry,
      )
    } catch (error) {
      const alternate = alternateTokenField(tokenField, error)
      const omitEffort = reasoningEffortConflict(error)
      if (!alternate && !omitEffort) throw error
      if (omitEffort) this.omitEffortWithTools = true
      const nextField = alternate ?? tokenField
      text = await postWithRetry(
        this.role.provider,
        `${this.baseUrl}/chat/completions`,
        {
          headers,
          body: payload(nextField, nextField === 'max_tokens', omitEffort || this.omitEffortWithTools),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
        this.retry,
      )
    }
    const body = JSON.parse(text) as {
      choices?: Array<{
        message?: {
          content?: string | null
          reasoning_content?: string | null
          reasoning?: string | null
          tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>
        }
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
    }
    const message = body.choices?.[0]?.message
    const calls = (message?.tool_calls ?? []).filter((c) => c.function?.name)
    const inputTokens = body.usage?.prompt_tokens ?? 0
    const hasCache =
      body.usage?.prompt_cache_hit_tokens !== undefined ||
      body.usage?.prompt_cache_miss_tokens !== undefined ||
      body.usage?.prompt_tokens_details?.cached_tokens !== undefined
    const cacheHitTokens = body.usage?.prompt_cache_hit_tokens ?? body.usage?.prompt_tokens_details?.cached_tokens ?? 0
    const cacheMissTokens = body.usage?.prompt_cache_miss_tokens ?? Math.max(0, inputTokens - cacheHitTokens)
    const reasoning = message?.reasoning_content?.trim()
      ? message.reasoning_content
      : message?.reasoning?.trim()
        ? message.reasoning
        : undefined
    return {
      content: message?.content ?? '',
      usage: {
        inputTokens,
        outputTokens: body.usage?.completion_tokens ?? 0,
        ...(hasCache ? { cacheHitTokens, cacheMissTokens } : {}),
      },
      ...(reasoning ? { reasoning } : {}),
      ...(calls.length > 0 ? { toolCalls: calls.map((c) => ({ name: c.function!.name!, args: parseArgs(c.function!.arguments) })) } : {}),
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
function lastPrompt(messages: ChatMessage[]): string {
  return [...messages].reverse().find((m) => m.role === 'user' && !m.content.startsWith('TOOL '))?.content ?? ''
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
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
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
      content = JSON.stringify({ final: `first: ${messages[1]?.content ?? ''}` })
    } else if (prompt.startsWith('Review the changes')) {
      // hy review: proves the diff reached the reviewer.
      const added = prompt.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
      content = JSON.stringify({ final: `review: ${added} added line(s); no findings` })
    } else if (prompt.startsWith('Create an AGENTS.md')) {
      content = JSON.stringify({ tool: 'apply_patch', args: { file: 'AGENTS.md', content: '# AGENTS\n\nBuild: none.\n' } })
    } else if (prompt.startsWith('CALL ')) {
      content = JSON.stringify(scriptedCall(prompt))
    } else if (/^TOOL (RESULT|ERROR) \(/.test(last) && stripContext(lastPrompt(messages)).startsWith('CALL ')) {
      content = JSON.stringify({ final: `called: ${last.split('\n').join(' ').slice(0, 400)}` })
    } else if (prompt.startsWith('ASK ')) {
      content = JSON.stringify({ tool: 'ask_user', args: { question: prompt.slice(4) } })
    } else if (last.startsWith('TOOL RESULT (ask_user)') || last.startsWith('TOOL ERROR (ask_user)')) {
      content = JSON.stringify({ final: `user said: ${last.split('\n').slice(1).join(' ').trim()}` })
    } else if (last.includes('[plan mode: read-only.') && prompt === 'Create the demo file') {
      // In plan mode the mock still tries to write, to prove the tool is refused.
      content = JSON.stringify({ tool: 'apply_patch', args: { file: 'PLAN_ATTEMPT.md', content: 'x\n' } })
    } else if (last.startsWith('TOOL ERROR (apply_patch)') && last.includes('not allowed')) {
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

/**
 * Gemini through the Interactions API (`POST /v1beta/interactions`,
 * verification/sources/gemini_thinking.txt and gemini_tokens.txt).
 *
 * Each request is a single-turn interaction: the system prompt goes in
 * `system_instruction` and the conversation is flattened into `input` with
 * role labels. Stateless multi-turn use would require resending every
 * `thought` block exactly as received, and the agent rewrites its history on
 * compaction; a single turn has no earlier model turns to carry. Usage counts
 * thinking as output, because thinking is billed as output.
 */
export class GeminiProvider implements LlmProvider {
  readonly name: string
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(
    private readonly role: RoleConfig,
    private readonly retry: RetryOptions = DEFAULT_RETRY,
  ) {
    this.name = `gemini:${role.model}`
    this.baseUrl = (role.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
    const key = roleApiKey(role)
    if (!key) throw new LlmError(`missing API key: set ${role.apiKeyEnv ?? 'GEMINI_API_KEY'}`)
    this.apiKey = key
  }

  async complete(messages: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    if (messages.some((m) => m.images?.length)) throw new LlmError('the Gemini adapter does not send images yet; use an Ollama or OpenAI-compatible vision model')
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const turns = messages.filter((m) => m.role !== 'system')
    const input =
      turns.length === 1
        ? turns[0]!.content
        : turns.map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${m.content}`).join('\n\n') + '\n\nASSISTANT:'
    const text = await postWithRetry(
      'gemini',
      `${this.baseUrl}/interactions`,
      {
        // The key goes in a header, never in the URL.
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          model: this.role.model,
          input,
          ...(system ? { system_instruction: system } : {}),
          // Caps thinking and output together; thinking_level selects the
          // official low/medium/high effort for Gemini 3.8 Flash.
          generation_config: {
            max_output_tokens: options.maxTokens,
            ...(options.effort && /^(low|medium|high)$/.test(options.effort)
              ? { thinking_level: options.effort }
              : {}),
          },
        }),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      this.retry,
    )
    const body = JSON.parse(text) as {
      steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>
      usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number }
    }
    const content = (body.steps ?? [])
      .filter((s) => s.type === 'model_output')
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    return {
      content,
      usage: {
        inputTokens: body.usage?.total_input_tokens ?? 0,
        outputTokens: (body.usage?.total_output_tokens ?? 0) + (body.usage?.total_thought_tokens ?? 0),
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

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** The Messages API wants alternating roles; the harness can emit two user turns. */
export function anthropicMessages(messages: readonly ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  const out: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  for (const message of messages) {
    if (message.role === 'system') continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks: AnthropicBlock[] = []
    if (message.content) blocks.push({ type: 'text', text: message.content })
    for (const image of message.images ?? []) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })
    }
    if (blocks.length === 0) continue
    const previous = out.at(-1)
    if (previous && previous.role === role) previous.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  return out
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
    const key = roleApiKey(role)
    if (!key) throw new LlmError(`missing API key: set ${role.apiKeyEnv ?? 'ANTHROPIC_API_KEY'}`)
    this.apiKey = key
  }

  async complete(messages: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    const system = messages.find((message) => message.role === 'system')?.content ?? ''
    const body = {
      model: this.role.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      ...(system ? { system } : {}),
      messages: anthropicMessages(messages),
      ...(options.tools && options.tools.length > 0
        ? { tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) }
        : {}),
    }
    const text = await postWithRetry(
      this.name,
      `${this.baseUrl}/v1/messages`,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      this.retry,
    )
    return parseAnthropicResponse(text)
  }
}

/** Parses one Messages API response (exported for the contract test). */
export function parseAnthropicResponse(text: string): Completion {
  let body: {
    content?: Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>
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
  const toolCalls: Array<{ name: string; args: unknown }> = []
  let reasoning = ''
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text)
    else if (block.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking
    else if (block.type === 'tool_use' && typeof block.name === 'string') toolCalls.push({ name: block.name, args: block.input ?? {} })
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
    usage,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
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
    const key = roleApiKey(role)
    if (!key) throw new LlmError(`missing API key: set ${role.apiKeyEnv ?? 'OPENAI_API_KEY'}`)
    this.apiKey = key
  }

  async complete(messages: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    const instructions = messages.find((message) => message.role === 'system')?.content
    const input = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role,
        content:
          message.images && message.images.length > 0
            ? [
                ...(message.content ? [{ type: 'input_text' as const, text: message.content }] : []),
                ...message.images.map((image) => ({
                  type: 'input_image' as const,
                  image_url: `data:${image.mimeType};base64,${image.data}`,
                })),
              ]
            : message.content,
      }))
    const body = {
      model: this.role.model,
      input,
      max_output_tokens: options.maxTokens,
      ...(instructions ? { instructions } : {}),
      ...(options.effort || this.role.reasoningSummary
        ? {
            reasoning: {
              ...(options.effort ? { effort: options.effort } : {}),
              ...(this.role.reasoningSummary ? { summary: this.role.reasoningSummary } : {}),
            },
          }
        : {}),
      ...(this.role.verbosity ? { text: { verbosity: this.role.verbosity } } : {}),
      ...(this.role.serviceTier ? { service_tier: this.role.serviceTier } : {}),
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
    const text = await postWithRetry(
      this.name,
      `${this.baseUrl}/responses`,
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      this.retry,
    )
    return parseOpenAiResponses(text)
  }
}

/** Parses one Responses API reply (exported for the contract test). */
export function parseOpenAiResponses(text: string): Completion {
  let body: {
    output?: Array<{
      type?: string
      content?: Array<{ type?: string; text?: string }>
      name?: string
      arguments?: string
      call_id?: string
    }>
    output_text?: string
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
  const toolCalls: Array<{ name: string; args: unknown }> = []
  for (const item of body.output ?? []) {
    if (item.type === 'message') {
      for (const block of item.content ?? []) {
        if (block.type === 'output_text' && typeof block.text === 'string') parts.push(block.text)
      }
    } else if (item.type === 'function_call' && typeof item.name === 'string') {
      toolCalls.push({ name: item.name, args: parseArgs(item.arguments) })
    }
  }
  const inputTokens = body.usage?.input_tokens ?? 0
  const cached = body.usage?.input_tokens_details?.cached_tokens ?? 0
  return {
    content: parts.length > 0 ? parts.join('') : (body.output_text ?? ''),
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
    data?: Array<{ id?: string; name?: string }>
    models?: Array<{ name?: string; id?: string }>
  }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    throw new LlmError(`${role.provider} returned non-JSON for its model list`)
  }
  const names = (body.data ?? body.models ?? [])
    .map((entry) => (typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : ''))
    .filter((name) => name.length > 0)
  return [...new Set(names)].sort()
}
export function createProvider(role: RoleConfig, workspaceRoot: string, sessionId?: string): LlmProvider {
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
