import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TELEMETRY,
  TelemetryError,
  createTelemetrySink,
  resolveTelemetryConfig,
  toOtlpPayload,
  type SpanRecord,
} from './telemetry.js'

const span = (name: string, attributes: SpanRecord['attributes'] = {}): SpanRecord => ({
  name,
  startMs: 1_000,
  endMs: 1_250,
  attributes: { 'hy.run_id': 'run-1', ...attributes },
  status: 'ok',
})

test('telemetry is off unless asked for', () => {
  assert.deepEqual(resolveTelemetryConfig(undefined), DEFAULT_TELEMETRY)
  assert.equal(DEFAULT_TELEMETRY.enabled, false)
  const enabled = resolveTelemetryConfig({ enabled: true })
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.endpoint, 'http://127.0.0.1:4318')
  assert.equal(enabled.sampleRatio, 1)
  // A trailing path is normalized so `/v1/traces` is appended once.
  assert.equal(resolveTelemetryConfig({ endpoint: 'http://127.0.0.1:4318/v1/traces/' }).endpoint, 'http://127.0.0.1:4318')
  assert.equal(resolveTelemetryConfig({ endpoint: 'http://localhost:9999' }).endpoint, 'http://localhost:9999')
})

test('a remote collector is refused unless it is explicit', () => {
  assert.throws(() => resolveTelemetryConfig({ endpoint: 'https://collector.example:4318' }), (error: unknown) => {
    assert.ok(error instanceof TelemetryError)
    assert.match(error.message, /must be on this machine/)
    return true
  })
  assert.equal(resolveTelemetryConfig({ endpoint: 'https://collector.example', allowRemote: true }).endpoint, 'https://collector.example')
  assert.throws(() => resolveTelemetryConfig({ endpoint: 'not a url' }), /not a URL/)
  assert.throws(() => resolveTelemetryConfig({ endpoint: 'file:///tmp/x' }), /http\(s\)/)
  assert.throws(() => resolveTelemetryConfig({ sampleRatio: 2 }), /between 0 and 1/)
  assert.throws(() => resolveTelemetryConfig([]), /must be an object/)
})

test('the payload is OTLP/JSON with nanosecond timestamps and typed values', () => {
  const config = resolveTelemetryConfig({ enabled: true, serviceName: 'hy-test' })
  const payload = toOtlpPayload([span('hy.turn', { 'hy.turns': 1, 'hy.ratio': 0.5, 'hy.ok': true })], config)
  const json = payload as {
    resourceSpans: Array<{
      resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
      scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>
    }>
  }
  const resource = json.resourceSpans[0]!.resource.attributes
  assert.equal(resource.find((attribute) => attribute.key === 'service.name')?.value.stringValue, 'hy-test')
  const exported = json.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
  assert.equal(exported.name, 'hy.turn')
  assert.equal(exported.startTimeUnixNano, '1000000000')
  assert.equal(exported.endTimeUnixNano, '1250000000')
  assert.equal((exported.spanId as string).length, 16)
  assert.equal((exported.traceId as string).length, 32)
  const attributes = exported.attributes as Array<{ key: string; value: Record<string, unknown> }>
  assert.deepEqual(attributes.find((attribute) => attribute.key === 'hy.turns')?.value, { intValue: '1' })
  assert.deepEqual(attributes.find((attribute) => attribute.key === 'hy.ratio')?.value, { doubleValue: 0.5 })
  assert.deepEqual(attributes.find((attribute) => attribute.key === 'hy.ok')?.value, { boolValue: true })
  assert.deepEqual((exported.status as { code: number }).code, 1)
})

test('a disabled sink records nothing and never calls the network', async () => {
  let calls = 0
  const sink = createTelemetrySink(DEFAULT_TELEMETRY, {
    fetchImpl: async () => {
      calls += 1
      return { ok: true, status: 200 }
    },
  })
  sink.record(span('hy.turn'))
  assert.equal(await sink.flush(), 0)
  assert.equal(calls, 0)
  assert.equal(sink.enabled, false)
})

test('an enabled sink batches spans and survives a broken collector', async () => {
  const config = resolveTelemetryConfig({ enabled: true })
  const bodies: string[] = []
  let failing = true
  const sink = createTelemetrySink(config, {
    fetchImpl: async (url, init) => {
      assert.match(url, /\/v1\/traces$/)
      assert.equal(init.method, 'POST')
      bodies.push(init.body)
      return failing ? { ok: false, status: 503 } : { ok: true, status: 200 }
    },
  })
  sink.record(span('hy.step', { 'hy.step': 1 }))
  sink.record(span('hy.tool', { 'hy.tool': 'read_file', 'hy.ok': true }))
  // A down collector: nothing is thrown and the queue is dropped.
  assert.equal(await sink.flush(), 0)
  assert.equal(bodies.length, 1)
  failing = false
  sink.record(span('hy.turn'))
  assert.equal(await sink.flush(), 1)
  const payload = JSON.parse(bodies[1]!) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> }
  assert.equal(payload.resourceSpans[0]!.scopeSpans[0]!.spans.length, 1)
  // Nothing to send is zero, not an error.
  assert.equal(await sink.flush(), 0)
})

test('the queue is capped so a long session cannot grow without bound', async () => {
  const config = resolveTelemetryConfig({ enabled: true })
  let sent = 0
  const sink = createTelemetrySink(config, {
    maxQueued: 3,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> }
      sent = payload.resourceSpans[0]!.scopeSpans[0]!.spans.length
      return { ok: true, status: 200 }
    },
  })
  for (let index = 0; index < 10; index++) sink.record(span(`hy.step.${index}`))
  assert.equal(await sink.flush(), 3)
  assert.equal(sent, 3)
})

test('a span carries identifiers and counts, never content', () => {
  const config = resolveTelemetryConfig({ enabled: true })
  const payload = JSON.stringify(
    toOtlpPayload([span('hy.tool', { 'hy.tool': 'shell', 'hy.bytes': 120, 'hy.ok': false })], config),
  )
  // The shape is safe by construction: the caller never passes text, and the
  // exporter has no field for it.
  assert.equal(payload.includes('output'), false)
  assert.equal(payload.includes('content'), false)
  assert.match(payload, /hy\.bytes/)
})
