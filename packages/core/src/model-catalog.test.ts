import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogForRole, catalogVision, effortWithToolsFor, findModel, reasoningEchoFor, setModelRegistry, temperatureAllowedFor, tokenFieldFor } from './model-catalog.js'
import { roleSupportsImages } from './config.js'

test('the registry holds exactly what the user registered', () => {
  setModelRegistry([
    {
      id: 'ignored',
      provider: 'openai-compatible',
      model: ' my-model ',
      label: 'My model',
      contextWindowTokens: 32_768,
      maxOutputTokens: 8_192,
      pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
      capabilities: { vision: true },
      compat: { tokenField: 'max_completion_tokens', effortWithTools: false, temperature: false, reasoningEcho: true },
    },
  ])
  const entry = findModel('openai-compatible', 'my-model')
  assert.ok(entry)
  // The id is derived from provider:model, not taken from the input.
  assert.equal(entry.id, 'openai-compatible:my-model')
  assert.equal(findModel('openai-compatible', 'nope'), undefined)
  assert.equal(catalogForRole({ provider: 'openai-compatible', model: 'my-model', contextWindowTokens: 1, maxOutputTokens: 1 })?.label, 'My model')
  setModelRegistry([])
})

test('unregistered models use the generic request shape', () => {
  setModelRegistry([])
  assert.equal(tokenFieldFor('openai-compatible', 'o4-mini'), 'max_tokens')
  assert.equal(tokenFieldFor('openai-compatible', 'gpt-5.2'), 'max_tokens')
  assert.equal(effortWithToolsFor('openai-compatible', 'gpt-6.1-terra'), true)
  assert.equal(temperatureAllowedFor('openai-compatible', 'o4-mini'), true)
  assert.equal(catalogVision('ollama', 'unknown-model'), undefined)
  assert.equal(reasoningEchoFor('openai-compatible', 'anything'), undefined)
})

test('registered compat flags win over the generic defaults', () => {
  setModelRegistry([
    { id: 'x', provider: 'openai-compatible', model: 'reasoner', label: 'R', compat: { tokenField: 'max_completion_tokens', effortWithTools: false, temperature: false, reasoningEcho: true } },
    { id: 'y', provider: 'ollama', model: 'llava', label: 'L', capabilities: { vision: true } },
  ])
  assert.equal(tokenFieldFor('openai-compatible', 'reasoner'), 'max_completion_tokens')
  assert.equal(effortWithToolsFor('openai-compatible', 'reasoner'), false)
  assert.equal(temperatureAllowedFor('openai-compatible', 'reasoner'), false)
  assert.equal(reasoningEchoFor('openai-compatible', 'reasoner'), true)
  assert.equal(catalogVision('ollama', 'llava'), true)
  assert.equal(roleSupportsImages({ provider: 'ollama', model: 'llava', contextWindowTokens: 1, maxOutputTokens: 1 }), true)
  assert.equal(roleSupportsImages({ provider: 'ollama', model: 'llava', contextWindowTokens: 1, maxOutputTokens: 1, vision: false }), false, 'an explicit role value wins')
  setModelRegistry([])
})

test('image support follows the adapter, not the provider name', () => {
  setModelRegistry([])
  const role = (provider: 'gemini' | 'openai-compatible' | 'opencode' | 'mock', model: string) => ({ provider, model, contextWindowTokens: 1, maxOutputTokens: 1 })
  // The Gemini adapter rejects image messages, so it must not advertise them.
  assert.equal(roleSupportsImages(role('gemini', 'gemini-3.8-flash')), false)
  assert.equal(roleSupportsImages(role('openai-compatible', 'any')), true)
  assert.equal(roleSupportsImages(role('opencode', 'deepseek-v4.1-flash')), true)
  assert.equal(roleSupportsImages(role('mock', 'mock')), true)
  assert.equal(roleSupportsImages({ ...role('openai-compatible', 'any'), vision: false }), false)
})
