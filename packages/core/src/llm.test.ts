// Adapter contract tests (design §9): each adapter against a fixture served by
// a local HTTP server, checking what it sends and what it parses, plus the
// shared retry policy. ollama-chat.json was recorded from a real Ollama
// (qwen2.5:3b); the OpenAI-compatible and Gemini fixtures follow the
// documented response shapes (see their `_note`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { GeminiProvider, LazyProvider, LlmError, MockCompactorProvider, OllamaProvider, OpenAiProvider, isOpenCodeHost } from './llm.js'
import type { RoleConfig } from './config.js'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8')
const fast = { retries: 2, baseDelayMs: 1, maxDelayMs: 5 }

interface Seen {
  url: string
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}

/** Serves `responses` in order (the last one repeats) and records requests. */
async function serve(responses: Array<{ status: number; body: string; headers?: Record<string, string> }>) {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} })
      const r = responses[Math.min(seen.length - 1, responses.length - 1)]!
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.headers ?? {}) })
      res.end(r.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { seen, base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const role = (provider: RoleConfig['provider'], baseUrl: string): RoleConfig => ({
  provider,
  model: 'm',
  baseUrl,
  apiKeyEnv: 'HY_TEST_API_KEY',
  contextWindowTokens: 8_192,
  maxOutputTokens: 256,
})
const messages = [
  { role: 'system' as const, content: 'SYS' },
  { role: 'user' as const, content: 'do it' },
]

test('Ollama: request shape and the recorded response', async () => {
  const s = await serve([{ status: 200, body: fixture('ollama-chat.json') }])
  try {
    const r = await new OllamaProvider(role('ollama', s.base), fast).complete(messages, { maxTokens: 64, temperature: 0 })
    assert.equal(r.content, '{"final":"ok"}')
    assert.deepEqual(r.usage, { inputTokens: 27, outputTokens: 6 })
    assert.equal(s.seen[0]!.url, '/api/chat')
    assert.equal(s.seen[0]!.body.format, 'json')
    assert.equal(s.seen[0]!.body.stream, false)
    assert.deepEqual(s.seen[0]!.body.options, { temperature: 0, num_predict: 64, num_ctx: 8_192 })
  } finally {
    await s.close()
  }
})

test('Ollama: json=false asks for plain prose instead of constrained JSON', async () => {
  const s = await serve([{ status: 200, body: fixture('ollama-chat.json') }])
  try {
    await new OllamaProvider(role('ollama', s.base), fast).complete(messages, { maxTokens: 64, temperature: 0, json: false })
    assert.equal(s.seen[0]!.body.format, undefined)
  } finally {
    await s.close()
  }
})

test('OpenAI-compatible: json=false omits response_format', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const s = await serve([{ status: 200, body: fixture('openai-chat.json') }])
  try {
    await new OpenAiProvider(role('deepseek', s.base), fast).complete(messages, { maxTokens: 32, temperature: 0, json: false })
    assert.equal(s.seen[0]!.body.response_format, undefined)
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('OpenAI-compatible: GPT-5/6 and o-series use max_completion_tokens', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const s = await serve([{ status: 200, body: fixture('openai-chat.json') }])
  try {
    await new OpenAiProvider({ ...role('openai-compatible', s.base), model: 'gpt-6-luna' }, fast).complete(messages, {
      maxTokens: 32,
      temperature: 0,
    })
    assert.equal(s.seen[0]!.body.max_completion_tokens, 32)
    assert.equal(s.seen[0]!.body.max_tokens, undefined)
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('OpenAI-compatible: retries with max_completion_tokens when max_tokens is rejected', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const s = await serve([
    {
      status: 400,
      body: JSON.stringify({
        error: {
          message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          type: 'invalid_request_error',
          param: 'max_tokens',
          code: 'unsupported_parameter',
        },
      }),
    },
    { status: 200, body: fixture('openai-chat.json') },
  ])
  try {
    const r = await new OpenAiProvider(role('openai-compatible', s.base), fast).complete(messages, {
      maxTokens: 32,
      temperature: 0,
    })
    assert.equal(r.content, '{"tool":"read_file","args":{"path":"README.md"}}')
    assert.equal(s.seen.length, 2)
    assert.equal(s.seen[0]!.body.max_tokens, 32)
    assert.equal(s.seen[1]!.body.max_completion_tokens, 32)
    assert.equal(s.seen[1]!.body.max_tokens, undefined)
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('OpenAI-compatible: bearer auth, JSON mode, usage', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const s = await serve([{ status: 200, body: fixture('openai-chat.json') }])
  try {
    const r = await new OpenAiProvider(role('deepseek', s.base), fast).complete(messages, { maxTokens: 99, temperature: 0 })
    assert.equal(r.content, '{"tool":"read_file","args":{"path":"README.md"}}')
    assert.deepEqual(r.usage, { inputTokens: 412, outputTokens: 19 })
    assert.equal(s.seen[0]!.url, '/chat/completions')
    assert.equal(s.seen[0]!.headers.authorization, 'Bearer sk-test')
    assert.deepEqual(s.seen[0]!.body.response_format, { type: 'json_object' })
    assert.equal(s.seen[0]!.body.max_tokens, 99)
    assert.deepEqual(s.seen[0]!.body.messages, messages)
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('LazyProvider defers the compactor until it is used', async () => {
  let built = 0
  const lazy = new LazyProvider(() => {
    built += 1
    return new MockCompactorProvider()
  })
  assert.equal(built, 0)
  assert.equal(lazy.name, 'lazy')
  const r = await lazy.complete(messages, { maxTokens: 32, temperature: 0 })
  assert.equal(built, 1)
  assert.equal(lazy.name, 'mock:compactor')
  assert.match(r.content, /mock summary/)
  await lazy.complete(messages, { maxTokens: 32, temperature: 0 })
  assert.equal(built, 1)
})

test('OpenCode hosts are detected so any OpenAI-compatible role sends the session header', () => {
  assert.equal(isOpenCodeHost('https://opencode.ai/inference/go/openai/v1'), true)
  assert.equal(isOpenCodeHost('https://api.opencode.ai/v1'), true)
  assert.equal(isOpenCodeHost('https://api.deepseek.com/v1'), false)
  assert.equal(isOpenCodeHost('not a url'), false)
})

test('cache routing: every session of a workspace shares one provider cache key', async () => {
  const { cacheRouteKey } = await import('./llm.js')
  const a = cacheRouteKey('C:\\work\\alpha', 'run-1')
  assert.match(a!, /^hy-ws-[0-9a-f]{16}$/)
  assert.equal(cacheRouteKey('c:\\WORK\\alpha\\', 'run-2'), a, 'another run, same workspace (case and trailing slash ignored)')
  assert.notEqual(cacheRouteKey('C:\\work\\beta', 'run-1'), a, 'another workspace, another key')
  assert.equal(cacheRouteKey('C:\\work\\alpha', undefined), undefined, 'no run, no key (as before)')
  process.env.HY_CACHE_ROUTING = 'session'
  try {
    assert.equal(cacheRouteKey('C:\\work\\alpha', 'run-1'), 'run-1', 'opt-out: one key per run')
  } finally {
    delete process.env.HY_CACHE_ROUTING
  }
})

test('OpenCode: sends the stable session and user-agent headers', async () => {  process.env.HY_TEST_API_KEY = 'sk-test'
  const s = await serve([{ status: 200, body: fixture('openai-chat.json') }])
  try {
    const r = await new OpenAiProvider(role('opencode', s.base), fast, 'run-abc123').complete(messages, {
      maxTokens: 32,
      temperature: 0,
    })
    assert.equal(r.content, '{"tool":"read_file","args":{"path":"README.md"}}')
    assert.equal(s.seen[0]!.headers['x-opencode-session'], 'ses_run-abc123')
    assert.equal(s.seen[0]!.headers['user-agent'], 'HY-HARNESS/0.1.0')
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('DeepSeek models get earlier reasoning back as reasoning_content; other servers do not', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const history = [
    ...messages,
    { role: 'assistant' as const, content: '{"tool":"read_file","args":{"path":"a"}}', reasoning: 'read a first' },
    { role: 'user' as const, content: 'TOOL RESULT (read_file):\nx' },
  ]
  for (const [r, expected] of [
    [{ ...role('opencode', ''), model: 'deepseek-v4.1-flash' }, 'read a first'],
    [{ ...role('deepseek', ''), model: 'deepseek-chat' }, 'read a first'],
    [role('openai-compatible', ''), undefined],
  ] as const) {
    const s = await serve([{ status: 200, body: fixture('openai-chat.json') }])
    try {
      await new OpenAiProvider({ ...r, baseUrl: s.base }, fast, 'run-r').complete(history, { maxTokens: 32, temperature: 0 })
      const sent = (s.seen[0]!.body.messages as Array<{ role: string; reasoning_content?: string }>).find((m) => m.role === 'assistant')!
      assert.equal(sent.reasoning_content, expected, r.provider)
    } finally {
      await s.close()
    }
  }
  delete process.env.HY_TEST_API_KEY
})

test('OpenAI-compatible: prompt cache usage is parsed', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const s = await serve([
    {
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: '{"final":"ok"}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 },
      }),
    },
  ])
  try {
    const r = await new OpenAiProvider(role('deepseek', s.base), fast).complete(messages, { maxTokens: 32, temperature: 0 })
    assert.equal(r.usage.cacheHitTokens, 60)
    assert.equal(r.usage.cacheMissTokens, 40)
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('OpenAI-compatible: an empty reasoning_content falls back to reasoning', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const s = await serve([
    {
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: 'done', reasoning_content: '', reasoning: 'fallback thought' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    },
  ])
  try {
    const r = await new OpenAiProvider(role('deepseek', s.base), fast).complete(messages, {
      maxTokens: 32,
      temperature: 0,
      effort: 'high',
    })
    assert.equal(r.reasoning, 'fallback thought')
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('OpenAI-compatible: reasoning effort and reasoning_content', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const s = await serve([
    {
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: 'done', reasoning_content: 'checked the files first' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    },
  ])
  try {
    const r = await new OpenAiProvider(role('deepseek', s.base), fast).complete(messages, { maxTokens: 32, temperature: 0, effort: 'high' })
    assert.equal(r.content, 'done')
    assert.equal(r.reasoning, 'checked the files first')
    assert.equal(s.seen[0]!.body.reasoning_effort, 'high')
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('Gemini: Interactions API shape; thinking counts as output; key never in the URL', async () => {
  process.env.HY_TEST_API_KEY = 'g-test'
  const s = await serve([{ status: 200, body: fixture('gemini-interaction.json') }])
  try {
    const p = new GeminiProvider(role('gemini', s.base), fast)
    const r = await p.complete(messages, { maxTokens: 77, temperature: 0 })
    assert.equal(r.content, '{"final":"ok"}', 'text blocks of model_output steps; thought steps ignored')
    assert.deepEqual(r.usage, { inputTokens: 523, outputTokens: 127 })
    const first = s.seen[0]!
    assert.equal(first.url, '/interactions')
    assert.equal(first.headers['x-goog-api-key'], 'g-test')
    assert.ok(!first.url.includes('key='))
    assert.deepEqual(first.body, { model: 'm', input: 'do it', system_instruction: 'SYS', generation_config: { max_output_tokens: 77 } })
    await p.complete(
      [...messages, { role: 'assistant', content: '{"tool":"x"}' }, { role: 'user', content: 'TOOL RESULT (x): 1' }],
      { maxTokens: 10, temperature: 0 },
    )
    assert.equal(s.seen[1]!.body.input, 'USER:\ndo it\n\nASSISTANT:\n{"tool":"x"}\n\nUSER:\nTOOL RESULT (x): 1\n\nASSISTANT:')
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('backoff doubles up to the cap, with ±25% jitter', async () => {
  const { backoffMs } = await import('./llm.js')
  const retry = { retries: 6, baseDelayMs: 1_000, maxDelayMs: 15_000 }
  assert.equal(backoffMs(retry, 0, 0.5), 1_000)
  assert.equal(backoffMs(retry, 3, 0.5), 8_000)
  assert.equal(backoffMs(retry, 5, 0.5), 15_000, 'capped')
  assert.equal(backoffMs(retry, 2, 0), 3_000, '-25%')
  assert.equal(backoffMs(retry, 2, 1), 5_000, '+25%')
  // The default schedule waits long enough for a briefly overloaded provider.
  const total = [0, 1, 2, 3, 4, 5].reduce((sum, attempt) => sum + backoffMs(retry, attempt, 0.5), 0)
  assert.ok(total >= 40_000 && total <= 50_000, `${total} ms`)
})

test('retries 429 and 5xx (honoring Retry-After), not other errors', async () => {
  const ok = fixture('ollama-chat.json')
  const flaky = await serve([
    { status: 429, body: 'slow down', headers: { 'Retry-After': '0' } },
    { status: 503, body: 'busy' },
    { status: 200, body: ok },
  ])
  try {
    const r = await new OllamaProvider(role('ollama', flaky.base), fast).complete(messages, { maxTokens: 1, temperature: 0 })
    assert.equal(r.content, '{"final":"ok"}')
    assert.equal(flaky.seen.length, 3)
  } finally {
    await flaky.close()
  }
  const bad = await serve([{ status: 400, body: 'bad request' }])
  try {
    await assert.rejects(new OllamaProvider(role('ollama', bad.base), fast).complete(messages, { maxTokens: 1, temperature: 0 }), (e: unknown) =>
      e instanceof LlmError && e.status === 400,
    )
    assert.equal(bad.seen.length, 1)
  } finally {
    await bad.close()
  }
  const down = await serve([{ status: 500, body: 'down' }])
  try {
    await assert.rejects(new OllamaProvider(role('ollama', down.base), fast).complete(messages, { maxTokens: 1, temperature: 0 }), /HTTP 500/)
    assert.equal(down.seen.length, 3, 'one try plus two retries')
  } finally {
    await down.close()
  }
})

test('a missing API key fails before any request', () => {
  delete process.env.HY_TEST_API_KEY
  assert.throws(() => new GeminiProvider(role('gemini', 'http://127.0.0.1:9')), /missing API key: set HY_TEST_API_KEY/)
  assert.throws(() => new OpenAiProvider(role('openai-compatible', 'http://127.0.0.1:9')), /missing API key/)
})

const tools = [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]

test('Ollama: native tools replace format=json; recorded tool_calls are parsed', async () => {
  const s = await serve([{ status: 200, body: fixture('ollama-tool-calls.json') }])
  try {
    const r = await new OllamaProvider(role('ollama', s.base), fast).complete(messages, { maxTokens: 64, temperature: 0, tools })
    assert.deepEqual(r.toolCalls, [
      { name: 'read_file', args: { path: 'README.md' } },
      { name: 'read_file', args: { path: 'a.ts' } },
    ])
    assert.equal(s.seen[0]!.body.format, undefined)
    assert.deepEqual(s.seen[0]!.body.tools, [{ type: 'function', function: tools[0] }])
    assert.deepEqual(r.usage, { inputTokens: 137, outputTokens: 42 })
  } finally {
    await s.close()
  }
})

test('OpenAI-compatible: native tools replace response_format; string arguments are parsed', async () => {
  process.env.HY_TEST_API_KEY = 'k'
  const s = await serve([{ status: 200, body: fixture('openai-tool-calls.json') }])
  try {
    const r = await new OpenAiProvider(role('openai-compatible', s.base), fast).complete(messages, { maxTokens: 64, temperature: 0, tools })
    assert.equal(r.content, '')
    assert.deepEqual(r.toolCalls, [
      { name: 'read_file', args: { path: 'README.md' } },
      { name: 'shell', args: 'not json' },
    ])
    assert.equal(s.seen[0]!.body.response_format, undefined)
    assert.deepEqual(s.seen[0]!.body.tools, [{ type: 'function', function: tools[0] }])
  } finally {
    await s.close()
  }
})

test('OpenAI-compatible: gpt-6.1-terra omits reasoning_effort when tools are sent', async () => {
  process.env.HY_TEST_API_KEY = 'k'
  const s = await serve([{ status: 200, body: fixture('openai-tool-calls.json') }])
  try {
    await new OpenAiProvider({ ...role('openai-compatible', s.base), model: 'gpt-6.1-terra' }, fast).complete(messages, {
      maxTokens: 64,
      temperature: 0,
      effort: 'high',
      tools,
    })
    assert.equal(s.seen.length, 1)
    assert.equal(s.seen[0]!.body.reasoning_effort, undefined)
    assert.ok(s.seen[0]!.body.tools)
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('OpenAI-compatible: an effort/tool 400 is retried without reasoning_effort', async () => {
  process.env.HY_TEST_API_KEY = 'k'
  const s = await serve([
    {
      status: 400,
      body: JSON.stringify({
        error: {
          message:
            "Function tools with reasoning_effort are not supported for gpt-6.2-terra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
          type: 'invalid_request_error',
        },
      }),
    },
    { status: 200, body: fixture('openai-tool-calls.json') },
  ])
  try {
    const r = await new OpenAiProvider({ ...role('openai-compatible', s.base), model: 'gpt-6.2-terra' }, fast).complete(messages, {
      maxTokens: 64,
      temperature: 0,
      effort: 'high',
      tools,
    })
    assert.equal(r.toolCalls?.[0]?.name, 'read_file')
    assert.equal(s.seen.length, 2)
    assert.equal(s.seen[0]!.body.reasoning_effort, 'high')
    assert.equal(s.seen[1]!.body.reasoning_effort, undefined)
    assert.ok(s.seen[1]!.body.tools)
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('images: Ollama gets a base64 list, OpenAI-compatible gets data-URL parts, Gemini refuses', async () => {
  process.env.HY_TEST_API_KEY = 'k'
  const withImage = [
    { role: 'system' as const, content: 'SYS' },
    { role: 'user' as const, content: 'what is this?', images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }] },
  ]
  const o = await serve([{ status: 200, body: fixture('ollama-chat.json') }])
  try {
    await new OllamaProvider(role('ollama', o.base), fast).complete(withImage, { maxTokens: 8, temperature: 0 })
    const sent = o.seen[0]!.body.messages as Array<Record<string, unknown>>
    assert.deepEqual(sent[1], { role: 'user', content: 'what is this?', images: ['iVBORw0KGgo='] })
    assert.deepEqual(sent[0], { role: 'system', content: 'SYS' })
  } finally {
    await o.close()
  }
  const a = await serve([{ status: 200, body: fixture('openai-chat.json') }])
  try {
    await new OpenAiProvider(role('openai-compatible', a.base), fast).complete(withImage, { maxTokens: 8, temperature: 0 })
    const sent = a.seen[0]!.body.messages as Array<Record<string, unknown>>
    assert.deepEqual(sent[1], {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ],
    })
  } finally {
    await a.close()
  }
  await assert.rejects(
    new GeminiProvider(role('gemini', 'http://127.0.0.1:9'), fast).complete(withImage, { maxTokens: 8, temperature: 0 }),
    /does not send images yet/,
  )
})

test('CP-18: the OpenAI-compatible adapter streams deltas and assembles the reply', async () => {
  const seen: Record<string, unknown>[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      const sent = JSON.parse(body) as Record<string, unknown>
      seen.push(sent)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: Record<string, unknown>) =>
        res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      chunk({ content: 'Hel' })
      chunk({ content: 'lo' })
      chunk({ reasoning_content: 'think' })
      chunk({ tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{"path":"a"}' } }] })
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  try {
    const provider = new OpenAiProvider(
      {
        provider: 'openai-compatible',
        model: 'test-model',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'test-key',
        contextWindowTokens: 10_000,
        maxOutputTokens: 1_000,
      },
      undefined,
      'session-1',
    )
    const deltas: Array<{ content?: string; reasoning?: string }> = []
    const completion = await provider.complete(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      { maxTokens: 64, temperature: 0, tools: [], onDelta: (delta) => deltas.push(delta) },
    )
    assert.equal(seen[0]!.stream, true, 'the request asks for a stream')
    assert.equal(completion.content, 'Hello')
    assert.equal(completion.reasoning, 'think')
    assert.deepEqual(completion.toolCalls, [{ name: 'read_file', args: { path: 'a' } }])
    assert.deepEqual(completion.usage, { inputTokens: 10, outputTokens: 2 })
    assert.deepEqual(deltas, [{ content: 'Hel' }, { content: 'lo' }, { reasoning: 'think' }])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
test('CP-18: a streaming request retries 503 and 429 before the stream starts; 400 fails at once', async () => {
  let calls = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      calls += 1
      if (req.url?.includes('bad')) {
        res.writeHead(400).end('bad request')
        return
      }
      if (calls === 1) return void res.writeHead(503).end('busy')
      if (calls === 2) return void res.writeHead(429, { 'retry-after': '0' }).end('slow down')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  const make = (suffix: string) =>
    new OpenAiProvider(
      { provider: 'openai-compatible', model: 'm', baseUrl: `http://127.0.0.1:${port}${suffix}`, apiKey: 'k', contextWindowTokens: 10_000, maxOutputTokens: 100 },
      { retries: 3, baseDelayMs: 1, maxDelayMs: 5 },
    )
  try {
    const deltas: string[] = []
    const done = await make('').complete([{ role: 'user', content: 'hi' }], { maxTokens: 8, temperature: 0, onDelta: (d) => deltas.push(d.content ?? '') })
    assert.equal(done.content, 'ok')
    assert.equal(calls, 3, 'two retries, then the stream')
    assert.deepEqual(deltas, ['ok'], 'no output was duplicated by the retries')
    calls = 0
    await assert.rejects(make('/bad').complete([{ role: 'user', content: 'hi' }], { maxTokens: 8, temperature: 0, onDelta: () => undefined }), /HTTP 400/)
    assert.equal(calls, 1)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
