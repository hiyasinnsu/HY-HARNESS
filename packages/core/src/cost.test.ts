import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateCostUsd, pricingFor } from './cost.js'
import type { RoleConfig } from './config.js'

const role = (provider: string, model: string, pricing?: RoleConfig['pricing']) => ({ provider, model, ...(pricing ? { pricing } : {}) }) as unknown as RoleConfig

test('B1: cache hits are billed at the cached price; an unreported split is an upper bound', () => {
  const pricing = { inputPerMTokUsd: 1, cachedInputPerMTokUsd: 0.1, outputPerMTokUsd: 4 }
  const exact = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 100_000, cacheHitTokens: 900_000, cacheMissTokens: 100_000, cacheUsageComplete: true }, pricing)
  assert.equal(exact.approximate, false)
  assert.ok(Math.abs(exact.usd - (0.1 + 0.09 + 0.4)) < 1e-9)
  const bound = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheUsageComplete: false }, pricing)
  assert.deepEqual(bound, { usd: 1, approximate: true })
  // Without a cached price, hits cost the input price.
  assert.equal(estimateCostUsd({ inputTokens: 10, outputTokens: 0, cacheHitTokens: 10, cacheMissTokens: 0 }, { inputPerMTokUsd: 1, outputPerMTokUsd: 1 }).usd, 10 / 1_000_000)
})

test('B1: a role\'s own price is found for its provider + model; nothing is invented', () => {
  const priced = role('openai-compatible', 'm1', { inputPerMTokUsd: 2, outputPerMTokUsd: 8 })
  const config = { role: role('ollama', 'q'), orchestratorRole: priced, subagentRole: role('ollama', 'q'), graderRole: role('ollama', 'q'), compactorRole: role('ollama', 'q'), summarizerRole: role('ollama', 'q') }
  assert.deepEqual(pricingFor(config, 'openai-compatible', 'm1'), { inputPerMTokUsd: 2, outputPerMTokUsd: 8 })
  assert.equal(pricingFor(config, 'openai-compatible', 'unknown-model'), undefined)
})
