import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sameSecret } from './web-server.js'

test('sameSecret compares tokens exactly and handles missing or different-length input', () => {
  const token = 'a1b2c3d4'
  assert.equal(sameSecret('a1b2c3d4', token), true)
  assert.equal(sameSecret('a1b2c3d5', token), false)
  assert.equal(sameSecret('a1b2c3d', token), false, 'a prefix is not the token')
  assert.equal(sameSecret('a1b2c3d4x', token), false)
  assert.equal(sameSecret('', token), false)
  assert.equal(sameSecret(undefined, token), false)
  assert.equal(sameSecret(null, token), false)
})
