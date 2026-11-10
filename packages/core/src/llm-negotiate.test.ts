import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from './llm.js'
import { learnFromError, negotiate, negotiatedEffort, negotiatedMaxTokens, normalizeUsage, rejectedFields, requestHeaders, resetProviderStates, sharedProviderState, textOf } from './llm-negotiate.js'

test('rejectedFields: only a 400 that names an optional field counts', () => {
  assert.deepEqual([...rejectedFields(new LlmError('x', 400, "Unsupported parameter: 'max_tokens' is not supported with this model"))], ['tokenField'])
  assert.deepEqual([...rejectedFields(new LlmError('x', 400, 'reasoning_effort is not supported with function tools'))].sort(), ['effort'])
  assert.deepEqual([...rejectedFields(new LlmError('x', 400, 'unknown field stream_options'))], ['stream_options'])
  assert.deepEqual([...rejectedFields(new LlmError('x', 400, 'temperature is not supported for this model'))], ['temperature'])
  assert.deepEqual([...rejectedFields(new LlmError('x', 400, 'response_format json_object is not supported'))], ['response_format'])
  // Not about the request shape: nothing is dropped.
  assert.equal(rejectedFields(new LlmError('x', 401, 'invalid api key')).size, 0)
  assert.equal(rejectedFields(new LlmError('x', 400, 'invalid api key')).size, 0)
  assert.equal(rejectedFields(new LlmError('x', 429, 'unsupported max_tokens')).size, 0)
  assert.equal(rejectedFields(new Error('boom')).size, 0)
})

test('textOf: strings, content parts and unknown shapes', () => {
  assert.equal(textOf('hello'), 'hello')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { text: 'b' }, 'c']), 'abc')
  assert.equal(textOf(undefined), '')
  assert.equal(textOf(null), '')
  assert.equal(textOf(42), '')
  assert.equal(textOf([{ type: 'image' }]), '')
})

test('normalizeUsage: OpenAI, Anthropic-style and cache fields', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 5 }), { inputTokens: 100, outputTokens: 5 })
  assert.deepEqual(normalizeUsage({ input_tokens: 70, output_tokens: 3 }), { inputTokens: 70, outputTokens: 3 })
  assert.deepEqual(
    normalizeUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 }),
    { inputTokens: 100, outputTokens: 5, cacheHitTokens: 60, cacheMissTokens: 40 },
  )
  assert.deepEqual(
    normalizeUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 25 } }),
    { inputTokens: 100, outputTokens: 5, cacheHitTokens: 25, cacheMissTokens: 75 },
  )
  assert.deepEqual(
    normalizeUsage({ input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 80 }),
    { inputTokens: 100, outputTokens: 5, cacheHitTokens: 80, cacheMissTokens: 20 },
  )
  // Missing usage stays "unknown" (zero), which callers already handle.
  assert.deepEqual(normalizeUsage(undefined), { inputTokens: 0, outputTokens: 0 })
})

test('sharedProviderState: one state per endpoint, kept across provider instances', () => {
  const key = 'openai-compatible|http://127.0.0.1:1|m'
  const first = sharedProviderState(key)
  first.drop.add('temperature')
  first.echoReasoning = true
  const second = sharedProviderState(key)
  assert.equal(second, first, 'the same endpoint gets the same object')
  assert.ok(second.drop.has('temperature'))
  assert.equal(second.echoReasoning, true)
  // Another endpoint (a different base URL) starts clean.
  const other = sharedProviderState('openai-compatible|http://127.0.0.1:2|m')
  assert.equal(other.drop.size, 0)
  assert.equal(other.echoReasoning, undefined)
  resetProviderStates()
  assert.equal(sharedProviderState(key).drop.size, 0, 'the test hook clears what was learned')
})

test('requestHeaders: role headers win and ${apiKey} is substituted', () => {
  assert.deepEqual(requestHeaders({}, 'k', { Authorization: 'Bearer k' }), { Authorization: 'Bearer k' })
  assert.deepEqual(
    requestHeaders({ headers: { 'api-key': '${apiKey}', 'x-extra': 'v', Authorization: 'Token ${apiKey}' } }, 'secret', { Authorization: 'Bearer secret' }),
    { Authorization: 'Token secret', 'api-key': 'secret', 'x-extra': 'v' },
  )
})

test('negotiate: a value that is too large caps the value and keeps the field', () => {
  const tooLarge = negotiate(new LlmError('x', 400, 'max_tokens must be less than or equal to 8192, got 32768 (invalid)'))
  assert.equal(tooLarge.maxOutputTokens, 8192)
  assert.equal(tooLarge.drop.has('tokenField'), false)
  assert.equal(negotiate(new LlmError('x', 400, 'Invalid max_tokens value: 32768 > 16384, which is the maximum allowed')).maxOutputTokens, 16384)
  // The context form: the room left after the messages is the limit.
  const context = negotiate(new LlmError('x', 400, "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens (8000 in the messages, 32000 in the completion)."))
  assert.equal(context.maxOutputTokens, 32768 - 8000 - 64)
  // Only a refused field name drops the field.
  assert.deepEqual([...negotiate(new LlmError('x', 400, "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.")).drop], ['tokenField'])
})

test('negotiate: listed effort values map to the nearest; prose about thinking mode drops nothing', () => {
  const lesson = negotiate(new LlmError('x', 400, "Invalid value for reasoning_effort: 'xhigh'. Supported values are: 'low', 'medium', and 'high'."))
  assert.deepEqual(lesson.effortValues, ['low', 'medium', 'high'])
  assert.equal(lesson.drop.has('effort'), false)
  const state = { drop: new Set<never>() } as Parameters<typeof negotiatedEffort>[0]
  assert.equal(learnFromError(state, new LlmError('x', 400, "reasoning_effort must be one of 'low', 'high'")), true)
  assert.equal(negotiatedEffort(state, 'max'), 'high')
  assert.equal(negotiatedEffort(state, 'minimal'), 'low')
  assert.equal(negotiatedEffort(state, 'medium'), 'high', 'ties go up')
  assert.equal(negotiatedEffort(state, 'none'), undefined, 'an unlisted none sends no effort')
  assert.equal(learnFromError(state, new LlmError('x', 400, "reasoning_effort must be one of 'low', 'high'")), false, 'nothing new: no second retry')
  // An unsupported effort field with no list is dropped.
  assert.deepEqual([...negotiate(new LlmError('x', 400, 'Unrecognized request argument supplied: reasoning_effort')).drop], ['effort'])
  // DeepSeek's thinking-mode message is about reasoning_content, not the effort field.
  const deepseek = negotiate(new LlmError('x', 400, 'The `reasoning_content` in the thinking mode must be passed back to the API.'))
  assert.deepEqual([...deepseek.drop], ['reasoning_content'])
  // Anthropic: the thinking field itself.
  assert.ok(negotiate(new LlmError('x', 400, '`thinking` is not supported for this model (invalid_request_error)')).drop.has('effort'))
  const capped = { drop: new Set<never>(), maxOutputTokens: 1000 } as Parameters<typeof negotiatedMaxTokens>[0]
  assert.equal(negotiatedMaxTokens(capped, 4000), 1000)
  assert.equal(negotiatedMaxTokens(capped, 500), 500)
})

test('statedContextLimit reads the window from overflow errors', async () => {
  const { statedContextLimit } = await import('./llm-negotiate.js')
  assert.equal(statedContextLimit(new LlmError('x', 400, "This model's maximum context length is 32768 tokens. However, your messages resulted in 40000 tokens.")), 32768)
  assert.equal(statedContextLimit(new LlmError('x', 400, 'prompt is too long: 250000 tokens > 200000 maximum')), 200000)
  assert.equal(statedContextLimit(new LlmError('x', 400, 'the request exceeds the available context size, try increasing it (n_ctx 8192)')), 8192)
  assert.equal(statedContextLimit(new LlmError('x', 400, 'Input exceeds the context window of 131072 tokens')), 131072)
})
