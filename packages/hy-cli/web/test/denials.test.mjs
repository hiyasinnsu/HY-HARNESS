import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sumDenials } from '../dist/denials.js'

test('CP-06: denials are counted by mechanism, most frequent first', () => {
  const entries = [
    { kind: 'tool', denial: 'sandbox' },
    { kind: 'tool', denial: 'policy' },
    { kind: 'tool', denial: 'sandbox' },
    { kind: 'tool' },
    { kind: 'assistant' },
    { kind: 'tool', denial: '' },
  ]
  assert.deepEqual(sumDenials(entries), [
    { kind: 'sandbox', count: 2 },
    { kind: 'policy', count: 1 },
  ])
  assert.deepEqual(sumDenials([]), [])
})