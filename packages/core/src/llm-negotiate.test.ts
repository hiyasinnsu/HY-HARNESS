import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from './llm.js'
import { normalizeUsage, rejectedFields, requestHeaders, resetProviderStates, sharedProviderState, textOf } from './llm-negotiate.js'

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
