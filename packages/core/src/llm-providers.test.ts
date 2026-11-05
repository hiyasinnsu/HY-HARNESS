import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { AnthropicProvider, OpenAiResponsesProvider, anthropicMessages, parseAnthropicResponse, parseOpenAiResponses } from './llm.js'
import type { ChatMessage } from './llm.js'
import type { RoleConfig } from './config.js'

/** A one-shot HTTP server that records the request and replies with `body`. */
function stubServer(reply: unknown): Promise<{ url: string; requests: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>; close: () => Promise<void> }> {
  const requests: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({ path: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

const history: ChatMessage[] = [
  { role: 'system', content: 'You are a coding agent.' },
  { role: 'user', content: 'read README.md' },
  { role: 'assistant', content: '{"tool":"read_file","args":{"path":"README.md"}}' },
  { role: 'user', content: 'TOOL RESULT (read_file):\n# Hi' },
  { role: 'user', content: 'and look at this', images: [{ mimeType: 'image/png', data: 'AA==' }] },
]

test('the Anthropic adapter sends Messages API requests and parses tool_use', async () => {
  const stub = await stubServer({
    content: [
      { type: 'thinking', thinking: 'I should read it.' },
      { type: 'text', text: 'Reading now.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } },
    ],
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100 },
    stop_reason: 'tool_use',
  })
  const role: RoleConfig = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    baseUrl: stub.url,
    apiKeyEnv: 'HY_TEST_ANTHROPIC_KEY',
    contextWindowTokens: 200_000,
    maxOutputTokens: 1_024,
    temperature: 0,
  }
  process.env.HY_TEST_ANTHROPIC_KEY = 'test-key'
  try {
    const provider = new AnthropicProvider(role)
    const completion = await provider.complete(history, {
      maxTokens: 512,
      temperature: 0,
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    })
    assert.equal(completion.content, 'Reading now.')
    assert.equal(completion.reasoning, 'I should read it.')
    assert.deepEqual(completion.toolCalls, [{ name: 'read_file', args: { path: 'README.md' } }])
    assert.deepEqual(completion.usage, { inputTokens: 120, outputTokens: 30, cacheHitTokens: 100, cacheMissTokens: 20 })

    const sent = stub.requests[0]!
    assert.equal(sent.path, '/v1/messages')
    assert.equal(sent.headers['x-api-key'], 'test-key')
    assert.equal(sent.headers['anthropic-version'], '2023-06-01')
    assert.equal(sent.body.model, 'claude-sonnet-4-5')
    assert.equal(sent.body.max_tokens, 512)
    assert.equal(sent.body.system, 'You are a coding agent.')
    // The two consecutive user messages (tool result, then an image) are merged.
    const messages = sent.body.messages as Array<{ role: string; content: Array<{ type: string }> }>
    assert.deepEqual(
      messages.map((m) => m.role),
      ['user', 'assistant', 'user'],
    )
    assert.ok(messages[2]!.content.some((block) => block.type === 'image'))
    assert.equal((sent.body.tools as Array<{ name: string }>)[0]!.name, 'read_file')
  } finally {
    await stub.close()
  }
})

test('the Anthropic adapter reports API errors', async () => {
  const stub = await stubServer({ error: { type: 'invalid_request_error', message: 'max_tokens is too large' } })
  process.env.HY_TEST_ANTHROPIC_KEY = 'test-key'
  const provider = new AnthropicProvider({
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    baseUrl: stub.url,
    apiKeyEnv: 'HY_TEST_ANTHROPIC_KEY',
    contextWindowTokens: 200_000,
    maxOutputTokens: 1_024,
  })
  try {
    await assert.rejects(provider.complete(history, { maxTokens: 512, temperature: 0 }), /max_tokens is too large/)
  } finally {
    await stub.close()
  }
})

test('the Responses adapter sends /responses and parses function_call', async () => {
  const stub = await stubServer({
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Reading now.' }] },
      { type: 'function_call', name: 'read_file', arguments: '{"path":"README.md"}', call_id: 'call_1' },
    ],
    usage: { input_tokens: 90, output_tokens: 12, input_tokens_details: { cached_tokens: 64 } },
  })
  process.env.HY_TEST_OPENAI_KEY = 'test-key'
  const provider = new OpenAiResponsesProvider(
    {
      provider: 'openai-responses',
      model: 'gpt-4.1-mini',
      baseUrl: stub.url,
      apiKeyEnv: 'HY_TEST_OPENAI_KEY',
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 4_096,
      // CP-24 / CP-23: reasoning controls and a stable cache key.
      reasoningSummary: 'concise',
      verbosity: 'low',
      serviceTier: 'priority',
    },
    undefined,
    'run-test',
  )
  try {
    const completion = await provider.complete(history, {
      maxTokens: 512,
      temperature: 0,
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
    })
    assert.equal(completion.content, 'Reading now.')
    assert.deepEqual(completion.toolCalls, [{ name: 'read_file', args: { path: 'README.md' } }])
    assert.deepEqual(completion.usage, { inputTokens: 90, outputTokens: 12, cacheHitTokens: 64, cacheMissTokens: 26 })
    const sent = stub.requests[0]!
    assert.equal(sent.path, '/responses')
    assert.equal(sent.headers.authorization, 'Bearer test-key')
    assert.equal(sent.body.model, 'gpt-4.1-mini')
    assert.equal(sent.body.max_output_tokens, 512)
    assert.equal(sent.body.instructions, 'You are a coding agent.')
    assert.deepEqual(sent.body.reasoning, { summary: 'concise' })
    assert.deepEqual(sent.body.text, { verbosity: 'low' })
    assert.equal(sent.body.service_tier, 'priority')
    assert.equal(sent.body.prompt_cache_key, 'hy-run-test')
    const input = sent.body.input as Array<{ role: string; content: unknown }>
    assert.equal(input[0]!.role, 'user')
    assert.ok(Array.isArray(input.at(-1)!.content), 'the image becomes input_image parts')
  } finally {
    await stub.close()
  }
})

test('the response parsers are defensive about odd payloads', () => {
  assert.deepEqual(parseAnthropicResponse('{"content":[{"type":"text","text":"hi"}]}').content, 'hi')
  assert.throws(() => parseAnthropicResponse('not json'), /non-JSON/)
  assert.throws(() => parseAnthropicResponse('{"error":{"message":"boom"}}'), /boom/)
  assert.equal(parseOpenAiResponses('{"output_text":"plain"}').content, 'plain')
  assert.throws(() => parseOpenAiResponses('<html>'), /non-JSON/)
  // Consecutive same-role messages are merged for the Messages API.
  const merged = anthropicMessages([
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
  ])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged[0]!.content, [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ])
})
