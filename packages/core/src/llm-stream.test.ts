import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { AnthropicProvider, GeminiProvider, OpenAiResponsesProvider, assembleAnthropicStream, assembleResponsesStream } from './llm.js'
import type { ChatMessage } from './llm.js'
import type { RoleConfig } from './config.js'

/** A one-shot server replying with server-sent events (or JSON when `json` is given). */
function sseServer(events: unknown[], json?: unknown): Promise<{ url: string; bodies: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const bodies: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      if (json !== undefined) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(json))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // Split events across writes, mid-line, as a real stream may.
      const text = events.map((event) => `event: ${String((event as { type?: string }).type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      const cut = Math.floor(text.length / 2)
      res.write(text.slice(0, cut))
      setTimeout(() => res.end(text.slice(cut)), 5)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, bodies, close: () => new Promise<void>((done) => server.close(() => done())) })
    })
  })
}

async function* from(events: Array<Record<string, unknown>>) {
  for (const event of events) yield event
}

const messages: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }]

const anthropicEvents = [
  { type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 40 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'read it.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading ' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'now.' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"README.md"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
  { type: 'message_stop' },
]

test('B3-1: an Anthropic stream rebuilds the same completion as a non-streaming reply', async () => {
  const deltas: Array<{ content?: string; reasoning?: string }> = []
  const completion = await assembleAnthropicStream(from(anthropicEvents), { onDelta: (d) => deltas.push(d) })
  assert.equal(completion.content, 'Reading now.')
  assert.equal(completion.reasoning, 'Let me read it.')
  assert.deepEqual(completion.toolCalls, [{ name: 'read_file', args: { path: 'README.md' }, id: 'toolu_1' }])
  assert.deepEqual(completion.thinkingBlocks, [{ type: 'thinking', thinking: 'Let me read it.', signature: 'sig' }])
  assert.deepEqual(completion.usage, { inputTokens: 50, outputTokens: 20, cacheHitTokens: 40, cacheMissTokens: 10 })
  assert.deepEqual(deltas.map((d) => d.content ?? `~${d.reasoning}`), ['~Let me ', '~read it.', 'Reading ', 'now.'])
  // A max_tokens stop is an output-limited reply; a stream cut before message_stop is an error.
  const limited = await assembleAnthropicStream(from([...anthropicEvents.slice(0, 10), { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } }, { type: 'message_stop' }]), {})
  assert.equal(limited.outputLimited, true)
  await assert.rejects(assembleAnthropicStream(from(anthropicEvents.slice(0, 9)), {}), /ended before the response was complete/)
  await assert.rejects(assembleAnthropicStream(from([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]), {}), /Overloaded/)
})

test('B3-1: a stream that loops on one fragment is cut early as a repetition', async () => {
  const loop = Array.from({ length: 3000 }, () => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "]}" } }))
  const completion = await assembleAnthropicStream(from([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...loop,
    { type: 'message_stop' },
  ]), {})
  assert.equal(completion.degenerate, 'repetition')
  const responses = await assembleResponsesStream(from(Array.from({ length: 3000 }, () => ({ type: "response.output_text.delta", delta: "]}" }))), {})
  assert.equal(responses.degenerate, 'repetition')
})

test('B3-1: a Responses stream emits deltas and parses the final response; incomplete is output-limited', async () => {
  const final = {
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan.' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'Hello there.' }] },
      { type: 'function_call', name: 'read_file', arguments: '{"path":"a"}', call_id: 'call_1' },
    ],
    usage: { input_tokens: 30, output_tokens: 7, input_tokens_details: { cached_tokens: 20 } },
  }
  const deltas: string[] = []
  const completion = await assembleResponsesStream(from([
    { type: 'response.created', response: {} },
    { type: 'response.reasoning_summary_text.delta', delta: 'Plan.' },
    { type: 'response.output_text.delta', delta: 'Hello ' },
    { type: 'response.output_text.delta', delta: 'there.' },
    { type: 'response.completed', response: final },
  ]), { onDelta: (d) => deltas.push(d.content ?? `~${d.reasoning}`) })
  assert.deepEqual(deltas, ['~Plan.', 'Hello ', 'there.'])
  assert.equal(completion.content, 'Hello there.')
  assert.deepEqual(completion.toolCalls, [{ name: 'read_file', args: { path: 'a' }, id: 'call_1' }])
  const incomplete = await assembleResponsesStream(from([{ type: 'response.incomplete', response: { ...final, incomplete_details: { reason: 'max_output_tokens' } } }]), {})
  assert.equal(incomplete.outputLimited, true)
  await assert.rejects(assembleResponsesStream(from([{ type: 'response.output_text.delta', delta: 'x' }]), {}), /ended before/)
  await assert.rejects(assembleResponsesStream(from([{ type: 'response.failed', response: { error: { message: 'server_error' } } }]), {}), /server_error/)
})

const role = (provider: string, url: string, extra: Partial<RoleConfig> = {}) => ({
  provider, model: 'm', baseUrl: url, apiKeyEnv: 'HY_TEST_STREAM_KEY', contextWindowTokens: 100_000, maxOutputTokens: 1_000, ...extra,
}) as unknown as RoleConfig

test('B3-1: over HTTP, Responses streams by default; Anthropic streams only when the role turns it on', async () => {
  process.env.HY_TEST_STREAM_KEY = 'k'
  const responses = await sseServer([
    { type: 'response.output_text.delta', delta: 'Hi' },
    { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi' }] }], usage: { input_tokens: 3, output_tokens: 1 } } },
  ])
  try {
    const seen: string[] = []
    const completion = await new OpenAiResponsesProvider(role('openai-responses', responses.url)).complete(messages, { maxTokens: 50, onDelta: (d) => d.content && seen.push(d.content) })
    assert.equal(completion.content, 'Hi')
    assert.deepEqual(seen, ['Hi'])
    assert.equal(responses.bodies[0]!.stream, true)
  } finally {
    await responses.close()
  }
  // Without role.streaming the Anthropic adapter keeps the verified non-streaming request.
  const plain = await sseServer([], { content: [{ type: 'text', text: 'plain' }], usage: { input_tokens: 1, output_tokens: 1 } })
  try {
    const completion = await new AnthropicProvider(role('anthropic', plain.url)).complete(messages, { maxTokens: 50, onDelta: () => {} })
    assert.equal(completion.content, 'plain')
    assert.equal(plain.bodies[0]!.stream, undefined)
  } finally {
    await plain.close()
  }
  const streamed = await sseServer(anthropicEvents)
  try {
    const completion = await new AnthropicProvider(role('anthropic', streamed.url, { streaming: true })).complete(messages, { maxTokens: 50, onDelta: () => {} })
    assert.equal(completion.content, 'Reading now.')
    assert.equal(streamed.bodies[0]!.stream, true)
  } finally {
    await streamed.close()
  }
})

test('B3-1: a Gemini interaction cut at its output limit is reported as output-limited', async () => {
  process.env.HY_TEST_STREAM_KEY = 'k'
  const server = await sseServer([], { id: 'i1', status: 'incomplete', steps: [{ type: 'thought', summary: [{ type: 'text', text: 'hmm' }] }], usage: { total_input_tokens: 9, total_output_tokens: 0, total_thought_tokens: 12 } })
  try {
    const completion = await new GeminiProvider(role('gemini', server.url)).complete(messages, { maxTokens: 16 })
    assert.equal(completion.outputLimited, true)
    assert.equal(completion.content, '')
  } finally {
    await server.close()
  }
})
