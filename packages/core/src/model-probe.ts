// A1: measure what an endpoint actually does, with a handful of tiny requests,
// instead of learning it from failures in the middle of real work.
//
// Each probe is one short request (a few dozen tokens out). The result is what
// the endpoint did, not what a model name suggests, and is shaped so it can be
// saved as the model's `models[]` capabilities. Nothing here guesses from the
// model's name, and a probe that errors records the error rather than a "no":
// an outage must not be mistaken for a missing capability.

import type { ChatMessage, Completion, LlmProvider, NativeToolDef } from './llm.js'

export interface ProbeStep {
  name: 'text' | 'tools' | 'parallel-tools' | 'vision'
  /** true / false: the endpoint did / did not; undefined: the probe failed. */
  supported?: boolean
  latencyMs: number
  detail?: string
  error?: string
}

export interface ProbeReport {
  model: string
  steps: ProbeStep[]
  /** Usage fields the endpoint reported on the text probe. */
  usage?: { input: boolean; output: boolean; cacheSplit: boolean }
  /** Returned reasoning separately from the answer. */
  reasoning?: boolean
  /** The `capabilities` entry for `models[]`: only what a probe established. */
  capabilities: { tools?: boolean; vision?: boolean; reasoning?: boolean; cache?: boolean }
  /** Plain-language advice derived from the results. */
  advice: string[]
}

const ECHO_TOOL: NativeToolDef = {
  name: 'record_value',
  description: 'Records one value. Call it whenever the user asks you to record a value.',
  parameters: { type: 'object', properties: { value: { type: 'string', description: 'The value to record.' } }, required: ['value'], additionalProperties: false },
}

// A 16x8 PNG: left half red, right half blue. Small enough to cost nothing, large enough
// that an endpoint which drops images cannot answer by chance.
const PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAIAAAB/FOjAAAAAFklEQVR42mP4z8CAFeEQ/s8wqoEWGgClN3+BkZs1VQAAAABJRU5ErkJggg=='

async function timed(run: () => Promise<Completion>): Promise<{ completion?: Completion; latencyMs: number; error?: string }> {
  const started = Date.now()
  try {
    const completion = await run()
    return { completion, latencyMs: Date.now() - started }
  } catch (error) {
    return { latencyMs: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }
  }
}

function argValue(args: unknown): string | undefined {
  let value = args
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const field = (value as { value?: unknown } | undefined)?.value
  return typeof field === 'string' ? field : undefined
}

export async function probeModel(provider: LlmProvider, options: { signal?: AbortSignal; vision?: boolean } = {}): Promise<ProbeReport> {
  const steps: ProbeStep[] = []
  const base = { maxTokens: 256, ...(options.signal ? { signal: options.signal } : {}) }
  const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage[] => [
    { role: 'system', content: 'You are being tested by a harness. Follow the instruction exactly.' },
    { role: 'user', content, ...extra },
  ]
  const report: ProbeReport = { model: provider.name, steps, capabilities: {}, advice: [] }

  const text = await timed(() => provider.complete(user('Reply with exactly the word: ready'), { ...base, json: false }))
  if (text.completion) {
    const u = text.completion.usage
    report.usage = { input: u.inputTokens > 0, output: u.outputTokens > 0, cacheSplit: u.cacheHitTokens !== undefined && u.cacheMissTokens !== undefined }
    report.reasoning = Boolean(text.completion.reasoning?.trim())
    if (report.usage.cacheSplit) report.capabilities.cache = true
    if (report.reasoning) report.capabilities.reasoning = true
    steps.push({ name: 'text', supported: /ready/i.test(text.completion.content), latencyMs: text.latencyMs, detail: text.completion.content.trim().slice(0, 80) })
  } else {
    steps.push({ name: 'text', latencyMs: text.latencyMs, ...(text.error ? { error: text.error } : {}) })
    report.advice.push('The basic text request failed; check the base URL, model name and API key before anything else.')
    return report
  }

  const tools = await timed(() => provider.complete(user('Record the value "alpha" with the record_value tool.'), { ...base, tools: [ECHO_TOOL] }))
  if (tools.completion) {
    const call = tools.completion.toolCalls?.find((c) => c.name === ECHO_TOOL.name)
    const native = call !== undefined && argValue(call.args) === 'alpha'
    steps.push({ name: 'tools', supported: native, latencyMs: tools.latencyMs, detail: native ? 'native function call with the right argument' : call ? 'called with wrong arguments' : 'no native call (answered in text)' })
    report.capabilities.tools = native
  } else {
    steps.push({ name: 'tools', latencyMs: tools.latencyMs, ...(tools.error ? { error: tools.error } : {}) })
  }

  if (report.capabilities.tools) {
    const parallel = await timed(() => provider.complete(user('Record the values "red" and "blue": call record_value twice in this one reply, once for each value.'), { ...base, tools: [ECHO_TOOL] }))
    if (parallel.completion) {
      const values = (parallel.completion.toolCalls ?? []).filter((c) => c.name === ECHO_TOOL.name).map((c) => argValue(c.args))
      const both = values.includes('red') && values.includes('blue')
      steps.push({ name: 'parallel-tools', supported: both, latencyMs: parallel.latencyMs, detail: `${values.length} call(s) in one reply` })
    } else {
      steps.push({ name: 'parallel-tools', latencyMs: parallel.latencyMs, ...(parallel.error ? { error: parallel.error } : {}) })
    }
  }

  if (options.vision !== false) {
    const image = await timed(() => provider.complete(
      user('The attached image is split into two colored halves. Name the two colors in one short line.', { images: [{ mimeType: 'image/png', data: PROBE_PNG }] }),
      { ...base, json: false },
    ))
    if (image.completion) {
      const sees = /red/i.test(image.completion.content) && /blue/i.test(image.completion.content)
      steps.push({ name: 'vision', supported: sees, latencyMs: image.latencyMs, detail: image.completion.content.trim().slice(0, 80) })
      report.capabilities.vision = sees
    } else {
      // A rejected image is the usual "no vision" answer (HTTP 400); anything
      // else (timeout, 5xx) leaves the capability unknown.
      const rejected = /\b400\b|image|vision|multimodal|unsupported/i.test(image.error ?? '')
      steps.push({ name: 'vision', ...(rejected ? { supported: false } : {}), latencyMs: image.latencyMs, ...(image.error ? { error: image.error } : {}) })
      if (rejected) report.capabilities.vision = false
    }
  }

  if (report.capabilities.tools === false) report.advice.push('No native function calling: set nativeTools: false (or save these capabilities) so turns use the JSON text protocol from the start.')
  if (steps.find((step) => step.name === 'parallel-tools')?.supported === false) report.advice.push('Only one call per reply: batches will run step by step, which is slower but correct.')
  if (report.usage && !report.usage.cacheSplit) report.advice.push('The endpoint does not report cache hits: cost shown is an upper bound and cache diagnostics are unavailable.')
  if (report.capabilities.vision === false) report.advice.push('No image input: read_image will be refused for this model; pair it with a vision role if images matter.')
  if (steps.some((step) => step.error && step.name !== 'vision')) report.advice.push('Some probes failed with errors rather than answers; rerun before saving the result.')
  return report
}
