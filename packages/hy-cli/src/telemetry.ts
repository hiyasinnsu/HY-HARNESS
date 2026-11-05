/**
 * WP-62: opt-in OTel tracing over OTLP/JSON (DSH's `dsh-otel`).
 *
 * Default off. When enabled it posts spans to a **local** OTLP endpoint
 * (`http://127.0.0.1:4318` unless configured) and the spans carry identifiers,
 * timings and counts only — never a prompt, a message, tool arguments or tool
 * output. Turning it on is an explicit config choice (`telemetry.enabled` or
 * `--otel`), and nothing is retried forever: one flush per turn, best effort.
 */

export interface TelemetryConfig {
  enabled: boolean
  /** OTLP/HTTP base URL; `/v1/traces` is appended. */
  endpoint: string
  /** Shown as `service.name`. */
  serviceName: string
  /** 0..1; a span is sampled once at the start of its turn. */
  sampleRatio: number
}

export const DEFAULT_TELEMETRY: TelemetryConfig = {
  enabled: false,
  endpoint: 'http://127.0.0.1:4318',
  serviceName: 'hy-harness',
  sampleRatio: 1,
}

export class TelemetryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TelemetryError'
  }
}

/** Validates a user-supplied telemetry block. */
export function resolveTelemetryConfig(input: unknown): TelemetryConfig {
  if (input === undefined || input === null) return { ...DEFAULT_TELEMETRY }
  if (typeof input !== 'object' || Array.isArray(input)) throw new TelemetryError('telemetry must be an object')
  const raw = input as Record<string, unknown>
  const endpoint = typeof raw.endpoint === 'string' && raw.endpoint ? raw.endpoint : DEFAULT_TELEMETRY.endpoint
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new TelemetryError(`telemetry.endpoint is not a URL: ${endpoint}`)
  }
  // A remote collector would receive the identifiers too: local only.
  const host = url.hostname
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TelemetryError('telemetry.endpoint must be http(s)')
  if (!local && raw.allowRemote !== true) {
    throw new TelemetryError(`telemetry.endpoint must be on this machine (${host}); the spans are not content, but they stay local by default`)
  }
  const ratio = raw.sampleRatio === undefined ? DEFAULT_TELEMETRY.sampleRatio : Number(raw.sampleRatio)
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new TelemetryError('telemetry.sampleRatio must be between 0 and 1')
  return {
    enabled: raw.enabled === true,
    endpoint: endpoint.replace(/\/+$/, '').replace(/\/v1\/traces$/, ''),
    serviceName: typeof raw.serviceName === 'string' && raw.serviceName ? raw.serviceName : DEFAULT_TELEMETRY.serviceName,
    sampleRatio: ratio,
  }
}

/** One finished span, reduced to what is safe to export. */
export interface SpanRecord {
  name: string
  startMs: number
  endMs: number
  attributes: Record<string, string | number | boolean>
  status?: 'ok' | 'error'
}

/**
 * Builds the OTLP/JSON envelope. `resourceSpans` with one scope and one span per
 * record; timestamps are nanoseconds as the protocol requires.
 */
export function toOtlpPayload(spans: readonly SpanRecord[], config: TelemetryConfig, now = Date.now()): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: config.serviceName } },
            { key: 'telemetry.sdk.name', value: { stringValue: 'hy-harness' } },
            { key: 'telemetry.sdk.language', value: { stringValue: 'nodejs' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'hy-harness.agent', version: '1' },
            spans: spans.map((span, index) => ({
              traceId: traceIdFor(span, index),
              spanId: spanIdFor(span, index),
              name: span.name,
              kind: 1,
              startTimeUnixNano: `${Math.max(0, Math.round(span.startMs))}000000`,
              endTimeUnixNano: `${Math.max(0, Math.round(span.endMs))}000000`,
              attributes: Object.entries(span.attributes).map(([key, value]) => ({
                key,
                value:
                  typeof value === 'number'
                    ? Number.isInteger(value)
                      ? { intValue: `${value}` }
                      : { doubleValue: value }
                    : typeof value === 'boolean'
                      ? { boolValue: value }
                      : { stringValue: value },
              })),
              ...(span.status ? { status: { code: span.status === 'error' ? 2 : 1 } } : {}),
            })),
          },
        ],
      },
    ],
    ...(now ? {} : {}),
  }
}

/** Deterministic ids: a span has no cross-service parent here. */
function traceIdFor(span: SpanRecord, index: number): string {
  return hashHex(`${span.name}:${span.startMs}:${index}`, 32)
}

function spanIdFor(span: SpanRecord, index: number): string {
  return hashHex(`${span.name}:${span.endMs}:${index}`, 16)
}

function hashHex(text: string, length: number): string {
  // A tiny FNV-1a keeps ids stable without pulling in crypto in the browser.
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  let out = ''
  let state = hash
  while (out.length < length) {
    state = (Math.imul(state, 0x01000193) ^ out.length) >>> 0
    out += state.toString(16).padStart(8, '0')
  }
  return out.slice(0, length)
}

export interface TelemetrySink {
  /** Queues a span; a disabled sink drops it. */
  record(span: SpanRecord): void
  /** Posts what is queued; resolves to the number of spans sent. */
  flush(): Promise<number>
  readonly enabled: boolean
}

export interface SinkOptions {
  fetchImpl?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ ok: boolean; status: number; text?: () => Promise<string> }>
  /** Queue cap: a long session must not grow without bound. */
  maxQueued?: number
}

/** The exporter itself. `enabled` is false for the default configuration. */
export function createTelemetrySink(config: TelemetryConfig, options: SinkOptions = {}): TelemetrySink {
  let queue: SpanRecord[] = []
  const maxQueued = Math.max(1, options.maxQueued ?? 500)
  const enabled = config.enabled
  return {
    enabled,
    record(span) {
      if (!enabled) return
      if (queue.length >= maxQueued) queue.shift()
      queue.push(span)
    },
    async flush() {
      if (!enabled || queue.length === 0) return 0
      const batch = queue
      queue = []
      const payload = JSON.stringify(toOtlpPayload(batch, config))
      const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as SinkOptions['fetchImpl'])
      if (!fetchImpl) return 0
      try {
        const response = await fetchImpl(`${config.endpoint}/v1/traces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
        })
        // An unread body keeps the socket alive; the payload is fire-and-forget.
        try {
          await response.text?.()
        } catch {
          // A collector that dropped the body is not an error.
        }
        if (!response.ok) return 0
        return batch.length
      } catch {
        // A collector that is down must never disturb a run.
        return 0
      }
    },
  }
}
