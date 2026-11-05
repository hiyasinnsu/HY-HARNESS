import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_CATALOG, catalogForRole, catalogVision, effortWithToolsFor, findModel, temperatureAllowedFor, tokenFieldFor } from './model-catalog.js'

test('the catalog is well formed and searchable', () => {
  assert.ok(MODEL_CATALOG.length >= 5)
  const ids = new Set(MODEL_CATALOG.map((entry) => entry.id))
  assert.equal(ids.size, MODEL_CATALOG.length, 'no duplicate ids')
  for (const entry of MODEL_CATALOG) {
    assert.equal(entry.id, `${entry.provider}:${entry.model}`)
    assert.ok(entry.contextWindowTokens > 0)
    assert.ok(entry.maxOutputTokens > 0)
    assert.ok(entry.maxOutputTokens <= entry.contextWindowTokens)
    assert.ok(entry.label.length > 0)
  }
  const sonnet = findModel('anthropic', 'claude-sonnet-4-5')
  assert.ok(sonnet)
  assert.equal(sonnet.capabilities.vision, true)
  assert.equal(findModel('anthropic', 'nope'), undefined)
  assert.equal(catalogForRole({ provider: 'mock', model: 'mock', contextWindowTokens: 1, maxOutputTokens: 1 })?.id, 'mock:mock')
})

test('compat flags come from the catalog and fall back to the heuristic', () => {
  // Catalog entry wins: the Responses adapter uses max_tokens for gpt-4.1-mini.
  assert.equal(tokenFieldFor('openai-responses', 'gpt-4.1-mini'), 'max_tokens')
  // Unknown model keeps the historical heuristic.
  assert.equal(tokenFieldFor('openai-compatible', 'gpt-4.1-mini'), 'max_tokens')
  assert.equal(tokenFieldFor('openai-compatible', 'o4-mini'), 'max_completion_tokens')
  assert.equal(tokenFieldFor('openai-compatible', 'gpt-5.2'), 'max_completion_tokens')
  assert.equal(tokenFieldFor('ollama', 'qwen2.5:3b'), 'max_tokens')
  // Reasoning effort with tools: the catalog entry says gpt-6.1-terra cannot.
  assert.equal(effortWithToolsFor('openai-compatible', 'anything'), true)
  assert.equal(effortWithToolsFor('openai-compatible', 'gpt-6.1-terra'), false)
  // Temperature: only the default for reasoning-style models.
  assert.equal(temperatureAllowedFor('openai-compatible', 'gpt-4.1-mini'), true)
  assert.equal(temperatureAllowedFor('openai-compatible', 'o4-mini'), false)
  assert.equal(temperatureAllowedFor('openai-responses', 'gpt-4.1-mini'), false)
  // Vision capability is reported only for listed models.
  assert.equal(catalogVision('anthropic', 'claude-sonnet-4-5'), true)
  assert.equal(catalogVision('ollama', 'qwen2.5:3b'), false)
  assert.equal(catalogVision('ollama', 'unknown-model'), undefined)
})
