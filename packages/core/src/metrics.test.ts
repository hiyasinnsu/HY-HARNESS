import { test } from 'node:test'
import assert from 'node:assert/strict'
import { metricsSnapshot } from './metrics.js'

test('CP-39: a metrics snapshot rounds and clamps negative values', () => {
  assert.deepEqual(metricsSnapshot({ uptimeSeconds: 12.6, sessions: 2, rssBytes: 1024.4 }), {
    uptimeSeconds: 13,
    sessions: 2,
    rssBytes: 1024,
  })
  assert.deepEqual(metricsSnapshot({ uptimeSeconds: -1, sessions: -3, rssBytes: Number.NaN }), {
    uptimeSeconds: 0,
    sessions: 0,
    rssBytes: 0,
  })
})