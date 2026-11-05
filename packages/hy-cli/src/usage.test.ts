import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '../../core/dist/index.js'
import { usageOf } from './usage.js'

const ev = (seq: number, type: string, payload: unknown, runId = 'run-test'): SessionEvent => ({
  v: 1,
  seq,
  ts: 1_000 + seq,
  sessionId: 's',
  runId,
  type,
  payload,
})

test('usageOf restores totals, cache and the last step after a restart', () => {
  const usage = usageOf(
    [
      ev(1, 'step/end', { usage: { inputTokens: 100, outputTokens: 5, cacheHitTokens: 0, cacheMissTokens: 100 } }),
      ev(2, 'step/end', { usage: { inputTokens: 120, outputTokens: 5, cacheHitTokens: 80, cacheMissTokens: 40 } }),
      ev(3, 'step/end', { usage: { inputTokens: 10, outputTokens: 1 } }, 'another-run'),
    ],
    'run-test',
  )
  assert.deepEqual(usage, {
    inputTokens: 220,
    outputTokens: 10,
    cacheHitTokens: 80,
    cacheMissTokens: 140,
    lastInputTokens: 120,
    lastOutputTokens: 5,
    lastCacheHitTokens: 80,
    lastCacheMissTokens: 40,
  })
  assert.equal((usage.cacheHitTokens / (usage.cacheHitTokens + usage.cacheMissTokens) * 100).toFixed(2), '36.36')
})

test('usageOf treats a missing cache split as a full miss', () => {
  const usage = usageOf(
    [ev(1, 'step/end', { usage: { inputTokens: 42, outputTokens: 7 } })],
    'run-test',
  )
  assert.equal(usage.inputTokens, 42)
  assert.equal(usage.cacheHitTokens, 0)
  assert.equal(usage.cacheMissTokens, 42)
})
