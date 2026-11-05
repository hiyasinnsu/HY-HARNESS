import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSecretRef, protectSecret, resolveSecretRef, SECRET_PREFIX, type SecretCodec } from './secrets.js'

const fake: SecretCodec = {
  protect: (value) => `${SECRET_PREFIX}fake:${Buffer.from(value).toString('base64')}`,
  unprotect: (reference) => {
    const encoded = reference.slice(`${SECRET_PREFIX}fake:`.length)
    return Buffer.from(encoded, 'base64').toString('utf8')
  },
}

test('CP-08: a plaintext key is returned unchanged; a dpapi reference is decrypted', () => {
  assert.equal(isSecretRef('sk-live'), false)
  assert.equal(resolveSecretRef('sk-live', fake), 'sk-live')
  const reference = protectSecret('sk-live-123', fake)
  assert.equal(isSecretRef(reference), true)
  assert.equal(resolveSecretRef(reference, fake), 'sk-live-123')
})

test('CP-08: a decryption failure never leaks the ciphertext', () => {
  const broken: SecretCodec = {
    protect: () => `${SECRET_PREFIX}broken`,
    unprotect: () => {
      throw new Error('CryptUnprotectData: access denied')
    },
  }
  assert.throws(
    () => resolveSecretRef(`${SECRET_PREFIX}c2VjcmV0`, broken, 'worker apiKey'),
    (error: Error) =>
      /worker apiKey: cannot decrypt/.test(error.message) &&
      /access denied/.test(error.message) &&
      !error.message.includes('c2VjcmV0'),
  )
})

test('CP-08: an empty secret is rejected before reaching DPAPI', () => {
  assert.throws(() => protectSecret('   ', fake), /empty/)
})