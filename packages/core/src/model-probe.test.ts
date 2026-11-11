import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeModel } from './model-probe.js'
import { LlmError, type ChatMessage, type CompleteOptions, type Completion } from './llm.js'
import { setModelRegistry } from './model-catalog.js'
import { usesNativeTools, type RoleConfig } from './config.js'

type Reply = (messages: ChatMessage[], options: CompleteOptions) => Completion
const usage = { inputTokens: 10, outputTokens: 2 }

function provider(reply: Reply) {
  return { name: 'fake/model', complete: async (messages: ChatMessage[], options: CompleteOptions) => reply(messages, options) }
}

test('A1: a capable endpoint is measured as such, including parallel calls and the cache split', async () => {
  const report = await probeModel(provider((messages, options) => {
    const text = messages.at(-1)!.content
    if (options.tools && /twice/.test(text)) return { content: '', usage, toolCalls: [{ name: 'record_value', args: { value: 'red' } }, { name: 'record_value', args: '{"value":"blue"}' }] }
    if (options.tools) return { content: '', usage, toolCalls: [{ name: 'record_value', args: { value: 'alpha' } }] }
    if (messages.at(-1)!.images?.length) return { content: 'Red and blue.', usage }
    return { content: 'ready', reasoning: 'thinking', usage: { ...usage, cacheHitTokens: 0, cacheMissTokens: 10 } }
  }))
  assert.deepEqual(report.steps.map((step) => [step.name, step.supported]), [['text', true], ['tools', true], ['parallel-tools', true], ['vision', true]])
  assert.deepEqual(report.capabilities, { cache: true, reasoning: true, tools: true, vision: true })
  assert.deepEqual(report.advice, [])
})

test('A1: a text-only endpoint without vision gets "no" and advice; an outage stays unknown', async () => {
  const limited = await probeModel(provider((messages) => {
    if (messages.at(-1)!.images?.length) throw new LlmError('HTTP 400: image input is not supported', 400)
    return { content: 'ready', usage }
  }))
  assert.equal(limited.capabilities.tools, false)
  assert.equal(limited.capabilities.vision, false)
  assert.equal(limited.steps.some((step) => step.name === 'parallel-tools'), false, 'no parallel probe without tools')
  assert.ok(limited.advice.some((line) => /nativeTools: false/.test(line)))
  assert.ok(limited.advice.some((line) => /does not report cache hits/.test(line)))

  const flaky = await probeModel(provider((messages) => {
    if (messages.at(-1)!.images?.length) throw new LlmError('HTTP 503: upstream unavailable', 503)
    return { content: 'ready', usage }
  }))
  assert.equal(flaky.capabilities.vision, undefined, 'a 503 is not a missing capability')

  const down = await probeModel(provider(() => { throw new LlmError('HTTP 401: bad key', 401) }))
  assert.equal(down.steps.length, 1)
  assert.match(down.advice[0]!, /basic text request failed/)
})

test('G-7: a registered capabilities.tools decides native tool calling unless the role says otherwise', () => {
  const role = { provider: 'openai-compatible', model: 'probe-test-model' } as unknown as RoleConfig
  try {
    setModelRegistry([{ provider: 'openai-compatible', model: 'probe-test-model', capabilities: { tools: false } } as never])
    assert.equal(usesNativeTools(role), false)
    assert.equal(usesNativeTools({ ...role, nativeTools: true } as RoleConfig), true)
  } finally {
    setModelRegistry([])
  }
  assert.equal(usesNativeTools(role), true)
})
