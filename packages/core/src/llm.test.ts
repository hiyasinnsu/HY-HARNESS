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
import { GeminiProvider, LazyProvider, LlmError, MockCompactorProvider, OllamaProvider, OpenAiProvider, createProvider, isOpenCodeHost, repetitionStart, withModelBudget, type ChatMessage } from './llm.js'
import { resetProviderStates } from './llm-negotiate.js'
import { setModelRegistry } from './model-catalog.js'
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

test('OpenAI-compatible: unregistered models start with max_tokens; the registry can switch it', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const s = await serve([{ status: 200, body: fixture('openai-chat.json') }, { status: 200, body: fixture('openai-chat.json') }])
  try {
    // No name heuristic: an unregistered reasoning model is not guessed from its name.
    await new OpenAiProvider({ ...role('openai-compatible', s.base), model: 'gpt-6-luna' }, fast).complete(messages, {
      maxTokens: 32,
      temperature: 0,
    })
    assert.equal(s.seen[0]!.body.max_tokens, 32)
    assert.equal(s.seen[0]!.body.max_completion_tokens, undefined)
    // The user registers what the endpoint takes.
    setModelRegistry([{ id: 'x', provider: 'openai-compatible', model: 'gpt-6-luna', label: 'Luna', compat: { tokenField: 'max_completion_tokens' } }])
    await new OpenAiProvider({ ...role('openai-compatible', s.base), model: 'gpt-6-luna' }, fast).complete(messages, {
      maxTokens: 32,
      temperature: 0,
    })
    assert.equal(s.seen[1]!.body.max_completion_tokens, 32)
    assert.equal(s.seen[1]!.body.max_tokens, undefined)
  } finally {
    setModelRegistry([])
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

test('reasoning is echoed after the endpoint returns it, or when the role/registry says so', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const history = [
    ...messages,
    { role: 'assistant' as const, content: '{"tool":"read_file","args":{"path":"a"}}', reasoning: 'read a first' },
    { role: 'user' as const, content: 'TOOL RESULT (read_file):\nx' },
  ]
  const sentReasoning = (seen: { body: { messages?: unknown } }): unknown =>
    (seen.body.messages as Array<{ role: string; reasoning_content?: string }>).find((m) => m.role === 'assistant')?.reasoning_content
  const acceptsReasoning = {
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: 'ok', reasoning_content: 'thought' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
  }
  try {
    // Default: nothing is echoed on the first request (no name heuristic).
    const first = await serve([{ status: 200, body: fixture('openai-chat.json') }, { status: 200, body: fixture('openai-chat.json') }])
    try {
      const provider = new OpenAiProvider({ ...role('openai-compatible', ''), baseUrl: first.base }, fast, 'run-r')
      await provider.complete(history, { maxTokens: 32, temperature: 0 })
      assert.equal(sentReasoning(first.seen[0]!), undefined)
    } finally {
      await first.close()
    }

    // The endpoint returned reasoning: the next request echoes it.
    const learned = await serve([acceptsReasoning, acceptsReasoning])
    try {
      const provider = new OpenAiProvider({ ...role('openai-compatible', ''), baseUrl: learned.base }, fast, 'run-r')
      await provider.complete(messages, { maxTokens: 32, temperature: 0 })
      await provider.complete(history, { maxTokens: 32, temperature: 0 })
      assert.equal(sentReasoning(learned.seen[1]!), 'read a first')
    } finally {
      await learned.close()
    }

    // The role can force it from the first request.
    const forced = await serve([{ status: 200, body: fixture('openai-chat.json') }])
    try {
      const provider = new OpenAiProvider({ ...role('openai-compatible', ''), baseUrl: forced.base, reasoningEcho: true }, fast, 'run-r')
      await provider.complete(history, { maxTokens: 32, temperature: 0 })
      assert.equal(sentReasoning(forced.seen[0]!), 'read a first')
    } finally {
      await forced.close()
    }

    // A server that rejects the field makes one failed request; the field is
    // dropped from then on and the request succeeds.
    const rejects = await serve([
      { status: 400, body: JSON.stringify({ error: { message: 'Unrecognized field: reasoning_content' } }) },
      { status: 200, body: fixture('openai-chat.json') },
      { status: 200, body: fixture('openai-chat.json') },
    ])
    try {
      const provider = new OpenAiProvider({ ...role('openai-compatible', ''), baseUrl: rejects.base, reasoningEcho: true }, fast, 'run-r')
      await provider.complete(history, { maxTokens: 32, temperature: 0 })
      assert.equal(sentReasoning(rejects.seen[1]!), undefined)
    } finally {
      await rejects.close()
    }
  } finally {
    delete process.env.HY_TEST_API_KEY
  }
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
    assert.deepEqual(r.usage, { inputTokens: 523, outputTokens: 127, cacheHitTokens: 0, cacheMissTokens: 523 })
    const first = s.seen[0]!
    assert.equal(first.url, '/interactions')
    assert.equal(first.headers['x-goog-api-key'], 'g-test')
    assert.ok(!first.url.includes('key='))
    // A temperature the caller sets is sent; none is sent when it is omitted.
    assert.deepEqual(first.body, { model: 'm', input: 'do it', system_instruction: 'SYS', generation_config: { max_output_tokens: 77, temperature: 0 } })
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

test('Gemini: native tools, function_call steps, thought summaries, and empty assistant filtering', async () => {
  process.env.HY_TEST_API_KEY = 'g-test'
  const s = await serve([
    {
      status: 200,
      body: JSON.stringify({
        steps: [
          { type: 'thought', summary: [{ type: 'text', text: 'Checking file status first.' }] },
          { type: 'function_call', name: 'read_file', arguments: { path: 'a.txt' }, id: 'fc-1' },
        ],
        usage: { total_input_tokens: 100, total_output_tokens: 20, total_thought_tokens: 30 },
      }),
    },
  ])
  try {
    const p = new GeminiProvider(role('gemini', s.base), fast)
    const r = await p.complete(
      [
        ...messages,
        { role: 'assistant', content: '' },
        { role: 'user', content: 'retry prompt' },
      ],
      {
        maxTokens: 128,
        temperature: 0,
        tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      },
    )
    assert.equal(r.content, '')
    assert.equal(r.reasoning, 'Checking file status first.')
    assert.deepEqual(r.toolCalls, [{ name: 'read_file', args: { path: 'a.txt' }, id: 'fc-1' }])
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 50 })
    const sent = s.seen[0]!.body
    assert.equal(sent.input, 'USER:\ndo it\n\nUSER:\nretry prompt\n\nASSISTANT:', 'empty assistant messages are omitted from input')
    assert.deepEqual(sent.tools, [
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ])
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('Gemini continues with typed results, accounts for cache and reseeds rewritten history', async () => {
  const s = await serve([
    { status: 200, body: JSON.stringify({ id: 'i1', steps: [{ type: 'function_call', id: 'c1', name: 'read_file', arguments: { path: 'a' } }], usage: { total_input_tokens: 80, total_cached_tokens: 0 } }) },
    { status: 200, body: JSON.stringify({ id: 'i2', usage: { total_input_tokens: 100, total_cached_tokens: 80 } }) },
    { status: 200, body: JSON.stringify({ usage: { total_input_tokens: 10 } }) },
  ])
  try {
    const p = new GeminiProvider({ ...role('gemini', s.base), apiKey: 'fixture' }, fast)
    const options = { maxTokens: 100, temperature: 0 }
    const first = await p.complete(messages, options)
    assert.equal(first.usage.cacheHitTokens, 0)
    const content = '{"tool":"read_file","args":{"path":"a"}}'
    const rendered = 'TOOL RESULT (read_file): content'
    const history: ChatMessage[] = [...messages, {
      role: 'assistant', content, gemini: { ...first.gemini!, content },
    }, {
      role: 'user', content: rendered + '\n\nNew context',
      toolResults: { rendered, entries: [{ id: 'c1', name: 'read_file', text: rendered }] },
    }]
    const second = await p.complete(history, options)
    assert.equal(second.usage.cacheHitTokens, 80)
    assert.equal(second.usage.cacheMissTokens, 20)
    assert.equal(s.seen[1]!.body.previous_interaction_id, 'i1')
    assert.deepEqual(s.seen[1]!.body.input, [
      { type: 'function_result', name: 'read_file', call_id: 'c1', result: [{ type: 'text', text: rendered }] },
      { type: 'user_input', content: [{ type: 'text', text: 'New context' }] },
    ])
    history[1] = { role: 'user', content: 'Compacted history' }
    const third = await p.complete(history, options)
    assert.equal(s.seen[2]!.body.previous_interaction_id, undefined)
    assert.equal(typeof s.seen[2]!.body.input, 'string')
    assert.equal(third.usage.cacheHitTokens, undefined)
  } finally {
    await s.close()
  }
})

test('repetitionStart detects multi-sentence reasoning loops up to 512 chars', () => {
  const unit =
    'Need maybe include logs/memory_watchdog.log file. Need maybe include scratch/ability_retention/ directory. Need maybe include checkpoints/v3_1/rebuild_a_v1_colab/g3cv/ directory. Need maybe include scratch/matrix_next_20261109/ directory. '
  assert.ok(unit.length > 200 && unit.length <= 512)
  const prefix = 'Normal reasoning about worker scope.\n'
  const text = prefix + unit.repeat(25)
  const cut = repetitionStart(text)
  assert.equal(cut, prefix.length + unit.length)
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
      { name: 'read_file', args: { path: 'README.md' }, id: 'call_1' },
      { name: 'shell', args: 'not json', id: 'call_2' },
    ])
    assert.equal(s.seen[0]!.body.response_format, undefined)
    assert.deepEqual(s.seen[0]!.body.tools, [{ type: 'function', function: tools[0] }])
  } finally {
    await s.close()
  }
})

test('OpenAI-compatible: a registered effort/tool conflict omits reasoning_effort', async () => {
  process.env.HY_TEST_API_KEY = 'k'
  const s = await serve([{ status: 200, body: fixture('openai-tool-calls.json') }])
  try {
    setModelRegistry([{ id: 'x', provider: 'openai-compatible', model: 'strict-model', label: 'S', compat: { effortWithTools: false } }])
    await new OpenAiProvider({ ...role('openai-compatible', s.base), model: 'strict-model' }, fast).complete(messages, {
      maxTokens: 64,
      temperature: 0,
      effort: 'high',
      tools,
    })
    assert.equal(s.seen.length, 1)
    assert.equal(s.seen[0]!.body.reasoning_effort, undefined)
    assert.ok(s.seen[0]!.body.tools)
  } finally {
    setModelRegistry([])
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
      res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'length' }] })}\n\n`)
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
    assert.equal(completion.outputLimited, true)
    assert.deepEqual(completion.usage, { inputTokens: 10, outputTokens: 2 })
    assert.deepEqual(deltas, [{ content: 'Hel' }, { content: 'lo' }, { reasoning: 'think' }])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
test('streaming usage distinguishes a reported zero cache hit from missing cache data', async () => {
  const stream = (usage: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`
  const s = await serve([
    { status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: stream({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 0 }) },
    { status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: stream({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_miss_tokens: 4 }) },
    { status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: stream({ prompt_tokens: 10, completion_tokens: 2 }) },
  ])
  try {
    const provider = new OpenAiProvider({ ...role('openai-compatible', s.base), apiKey: 'test-key' }, fast)
    const options = { maxTokens: 32, temperature: 0, onDelta: () => {} }
    assert.deepEqual((await provider.complete(messages, options)).usage, { inputTokens: 10, outputTokens: 2, cacheHitTokens: 0, cacheMissTokens: 10 })
    assert.deepEqual((await provider.complete(messages, options)).usage, { inputTokens: 10, outputTokens: 2, cacheHitTokens: 6, cacheMissTokens: 4 })
    assert.deepEqual((await provider.complete(messages, options)).usage, { inputTokens: 10, outputTokens: 2 })
  } finally {
    await s.close()
  }
})

test('repetitionStart finds a runaway loop of one short fragment and nothing else', () => {
  const head = '{"tool":"shell","args":{"command":"dir"}}'
  const loop = head + ']}}'.repeat(2_000)
  // The run starts where the text first becomes periodic (here inside the
  // head's closing `}}`); one period of it is kept.
  const cut = repetitionStart(loop)!
  assert.ok(cut >= head.length && cut <= head.length + 3, `cut at ${cut}`)
  assert.equal(repetitionStart(head + ']}}'.repeat(1_000)), undefined, 'below the limit')
  const prose = Array.from({ length: 400 }, (_, i) => `line ${i}: the quick brown fox ${i * 7}\n`).join('')
  assert.equal(repetitionStart(prose), undefined, 'ordinary long text')
  assert.equal(repetitionStart('|---|'.repeat(200) + 'x'), undefined, 'a long table rule that ends normally')
})

test('a stream looping on one fragment is cut at once and marked degenerate', async () => {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"tool":"shell","args":{"command":"dir"}}' } }] })}\n\n`)
      // Never finishes on its own: the client has to stop it.
      const timer = setInterval(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ']}}' } }] })}\n\n`), 0)
      res.on('close', () => clearInterval(timer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  const provider = new OpenAiProvider(
    { provider: 'openai-compatible', model: 'm', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', contextWindowTokens: 10_000, maxOutputTokens: 100 },
    { retries: 0, baseDelayMs: 1, maxDelayMs: 5 },
  )
  try {
    const started = Date.now()
    const done = await provider.complete([{ role: 'user', content: 'hi' }], { maxTokens: 8, temperature: 0, onDelta: () => undefined })
    assert.equal(done.degenerate, 'repetition')
    assert.ok(done.content.startsWith('{"tool":"shell","args":{"command":"dir"}}'))
    assert.ok(done.content.length <= 44, done.content)
    assert.ok(Date.now() - started < 20_000)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a stream cut off before [DONE] or a finish_reason is an error, not a short answer', async () => {
  let complete = false
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`)
      if (complete) res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  const provider = new OpenAiProvider(
    { provider: 'openai-compatible', model: 'm', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', contextWindowTokens: 10_000, maxOutputTokens: 100 },
    { retries: 0, baseDelayMs: 1, maxDelayMs: 5 },
  )
  const ask = () => provider.complete([{ role: 'user', content: 'hi' }], { maxTokens: 8, temperature: 0, onDelta: () => undefined })
  try {
    await assert.rejects(ask(), /stream ended before the response was complete/)
    complete = true
    assert.equal((await ask()).content, 'partial', 'a finish_reason without [DONE] is complete')
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

const sentReasoning = (seen: Seen): unknown =>
  (seen.body.messages as Array<{ role: string; reasoning_content?: string }>).find((m) => m.role === 'assistant')?.reasoning_content

test('a 400-learned field drop is shared by later providers of the same endpoint', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  resetProviderStates()
  const s = await serve([
    { status: 400, body: JSON.stringify({ error: { message: 'temperature is not supported for this model' } }) },
    { status: 200, body: fixture('openai-chat.json') },
  ])
  try {
    const sharedRole = { ...role('openai-compatible', s.base), model: 'shared-drop' }
    await new OpenAiProvider(sharedRole, fast).complete(messages, { maxTokens: 32, temperature: 0.5 })
    assert.equal(s.seen[0]!.body.temperature, 0.5, 'the first request tries temperature')
    // A new turn builds a new provider: it starts from what the first learned.
    await new OpenAiProvider(sharedRole, fast).complete(messages, { maxTokens: 32, temperature: 0.5 })
    assert.equal(s.seen.length, 3, 'the second provider did not provoke another 400')
    assert.equal(s.seen[2]!.body.temperature, undefined)
  } finally {
    resetProviderStates()
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('reasoning echo learned by one provider is used by the next provider of the same endpoint', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  resetProviderStates()
  const answer = {
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: 'ok', reasoning_content: 'thought' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
  }
  const history = [
    ...messages,
    { role: 'assistant' as const, content: '{"tool":"read_file","args":{"path":"a"}}', reasoning: 'read a first' },
    { role: 'user' as const, content: 'TOOL RESULT (read_file):\nx' },
  ]
  const s = await serve([answer, answer, answer])
  try {
    const sharedRole = { ...role('openai-compatible', s.base), model: 'shared-echo' }
    await new OpenAiProvider(sharedRole, fast).complete(messages, { maxTokens: 32, temperature: 0 })
    assert.equal(sentReasoning(s.seen[0]!), undefined, 'nothing is echoed before the endpoint returns reasoning')
    const second = new OpenAiProvider(sharedRole, fast)
    await second.complete(history, { maxTokens: 32, temperature: 0 })
    assert.equal(sentReasoning(s.seen[1]!), 'read a first', 'the next provider echoes without learning again')
    const explicitOff = new OpenAiProvider({ ...sharedRole, reasoningEcho: false }, fast)
    await explicitOff.complete(history, { maxTokens: 32, temperature: 0 })
    assert.equal(sentReasoning(s.seen[2]!), undefined, 'an explicit role setting wins over what was learned')
  } finally {
    resetProviderStates()
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('createProvider settles the whole reservation when the endpoint reports no usage', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const s = await serve([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }])
  try {
    const reserved: number[] = []
    const settled: number[] = []
    const result = await withModelBudget(
      (maximum) => {
        reserved.push(maximum)
        return (amount: number) => {
          settled.push(amount)
        }
      },
      () =>
        createProvider({ ...role('openai-compatible', s.base), pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 } }, process.cwd()).complete(
          messages,
          { maxTokens: 8, temperature: 0 },
        ),
    )
    assert.equal(result.content, 'ok')
    assert.equal(reserved.length, 1)
    assert.deepEqual(settled, reserved, 'the reservation is charged in full, not left checked out')
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('a degenerate stream also settles its reservation', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"tool":"shell","args":{"command":"dir"}}' } }] })}\n\n`)
      const timer = setInterval(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ']}}' } }] })}\n\n`), 0)
      res.on('close', () => clearInterval(timer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  try {
    const reserved: number[] = []
    const settled: number[] = []
    const result = await withModelBudget(
      (maximum) => {
        reserved.push(maximum)
        return (amount: number) => {
          settled.push(amount)
        }
      },
      () =>
        createProvider(
          {
            provider: 'openai-compatible',
            model: 'm',
            baseUrl: `http://127.0.0.1:${port}`,
            apiKey: 'k',
            contextWindowTokens: 10_000,
            maxOutputTokens: 100,
            pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 1 },
          },
          process.cwd(),
        ).complete([{ role: 'user', content: 'hi' }], { maxTokens: 8, temperature: 0, onDelta: () => undefined }),
    )
    assert.equal(result.degenerate, 'repetition')
    assert.deepEqual(settled, reserved)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('under a USD budget a 503 is retried, not failed (a 5xx is assumed unbilled)', async () => {
  process.env.HY_TEST_API_KEY = 'sk-test'
  const s = await serve([
    { status: 503, body: 'busy' },
    { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) },
  ])
  try {
    const settled: number[] = []
    const result = await withModelBudget(
      () => (amount: number) => {
        settled.push(amount)
      },
      () =>
        createProvider({ ...role('openai-compatible', s.base), pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 1 } }, process.cwd()).complete(
          messages,
          { maxTokens: 8, temperature: 0 },
        ),
    )
    assert.equal(result.content, 'ok')
    assert.equal(s.seen.length, 2, 'the 5xx was retried')
    assert.equal(settled.length, 1, 'the successful attempt was settled once')
  } finally {
    delete process.env.HY_TEST_API_KEY
    await s.close()
  }
})

test('OpenAI-compatible: a too-large max_tokens is capped and retried; no temperature unless set', async () => {
  resetProviderStates()
  const ok = JSON.stringify({ choices: [{ message: { content: 'fine' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
  const s = await serve([
    { status: 400, body: JSON.stringify({ error: { message: 'max_tokens must be less than or equal to 8192 (invalid_request_error)' } }) },
    { status: 200, body: ok },
  ])
  try {
    const p = new OpenAiProvider({ ...role('openai-compatible', s.base), model: 'cap-test', apiKey: 'k' }, fast)
    const done = await p.complete(messages, { maxTokens: 32768 })
    assert.equal(done.content, 'fine')
    assert.equal(s.seen[0]!.body.max_tokens, 32768)
    assert.equal(s.seen[1]!.body.max_tokens, 8192, 'same field, smaller value')
    assert.equal('max_completion_tokens' in s.seen[1]!.body, false)
    assert.equal('temperature' in s.seen[1]!.body, false)
  } finally {
    await s.close()
  }
})

test('B12: a request reserves its own estimate with a margin, not the whole window', async () => {
  const { reservedInputTokens } = await import('./llm.js')
  const small = reservedInputTokens([{ role: 'user', content: 'x'.repeat(4_000) }], {}, 1_000_000)
  assert.ok(small > 1_000 && small < 5_000, String(small))
  const withImage = reservedInputTokens([{ role: 'user', content: 'x'.repeat(4_000), images: [{ mimeType: 'image/png', data: 'AA==' }] }], {}, 1_000_000)
  assert.equal(withImage - small, 2_400)
  assert.equal(reservedInputTokens([{ role: 'user', content: 'x'.repeat(4_000_000) }], {}, 128_000), 128_000, 'never above the window')
  const withTools = reservedInputTokens([{ role: 'user', content: 'hi' }], { tools: [{ name: 't', description: 'd'.repeat(4_000), parameters: {} }] }, 1_000_000)
  assert.ok(withTools > 1_000, String(withTools))
})
