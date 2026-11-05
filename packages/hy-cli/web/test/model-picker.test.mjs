// CP-35: the model picker shows capabilities and only offers the session's provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilityTags, formatTokens, pickerModels, renderModelRows } from '../dist/model-picker.js'

const models = [
  { id: 'ollama:qwen2.5:3b', provider: 'ollama', model: 'qwen2.5:3b', label: 'Qwen 2.5 3B (local)', contextWindowTokens: 32_768, maxOutputTokens: 8_192, capabilities: { tools: true, vision: false, reasoning: false, cache: false } },
  { id: 'ollama:llava', provider: 'ollama', model: 'llava', label: 'LLaVA', contextWindowTokens: 4_096, maxOutputTokens: 2_048, capabilities: { tools: false, vision: true, reasoning: false, cache: false } },
  { id: 'deepseek:flash', provider: 'deepseek', model: 'deepseek-v4.1-flash', label: 'DeepSeek <Flash>', contextWindowTokens: 1_048_576, maxOutputTokens: 262_144, capabilities: { tools: true, vision: true, reasoning: true, cache: true } },
]
const labels = { tools: 'tools', vision: 'vision', reasoning: 'reasoning', cache: 'cache', current: 'current', otherProvider: 'other provider', context: 'ctx' }

test('CP-35: token sizes and capability tags', () => {
  assert.equal(formatTokens(32_768), '32K')
  assert.equal(formatTokens(1_048_576), '1M')
  assert.equal(formatTokens(200_000), '200K')
  assert.equal(formatTokens(128_000), '128K')
  assert.equal(formatTokens(1_000_000), '1M')
  assert.equal(formatTokens(262_144), '256K')
  assert.deepEqual(capabilityTags(models[2]), ['tools', 'vision', 'reasoning', 'cache'])
  assert.deepEqual(capabilityTags(models[1]), ['vision'])
})

test('CP-35: same-provider models first, filtering on label, model and provider', () => {
  assert.deepEqual(pickerModels(models, 'ollama').map((m) => m.model), ['llava', 'qwen2.5:3b', 'deepseek-v4.1-flash'])
  assert.deepEqual(pickerModels(models, 'deepseek').map((m) => m.provider), ['deepseek', 'ollama', 'ollama'])
  assert.deepEqual(pickerModels(models, 'ollama', 'flash').map((m) => m.model), ['deepseek-v4.1-flash'])
  assert.deepEqual(pickerModels(models, 'ollama', 'zzz'), [])
})

test('CP-35: rows mark the current model and disable other providers', () => {
  const html = renderModelRows(models, { provider: 'ollama', model: 'qwen2.5:3b' }, labels)
  const rows = html.split('<button').slice(1)
  assert.equal(rows.length, 3)
  assert.match(rows[0], /model-row active/)
  assert.match(rows[0], /current/)
  assert.doesNotMatch(rows[1], /disabled/)
  assert.match(rows[2], /disabled/)
  assert.match(rows[2], /other provider/)
  assert.match(rows[2], /DeepSeek &lt;Flash&gt;/, 'labels are escaped')
  assert.match(rows[2], /cap-reasoning/)
  assert.match(rows[0], /ctx 32K/)
})
