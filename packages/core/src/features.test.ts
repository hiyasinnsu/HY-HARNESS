import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FEATURES, assertFeatureName, featureEnabled, resolveFeatures } from './features.js'

test('CP-38: registry defaults and user overrides resolve together', () => {
  assert.equal(FEATURES.length >= 3, true)
  const defaults = resolveFeatures()
  assert.equal(defaults.streaming, true)
  const off = resolveFeatures({ streaming: false })
  assert.equal(off.streaming, false)
  assert.equal(off['tool-search'], true, 'other features keep their defaults')
  assert.equal(featureEnabled(undefined, 'streaming'), true)
  assert.equal(featureEnabled({ streaming: false }, 'streaming'), false)
  assert.equal(featureEnabled({}, 'unknown-feature'), false, 'an unknown feature is off')
})

test('CP-38: unknown feature names are rejected for writers', () => {
  assert.doesNotThrow(() => assertFeatureName('streaming'))
  assert.throws(() => assertFeatureName('nope'), /unknown feature "nope"; known: streaming/)
})