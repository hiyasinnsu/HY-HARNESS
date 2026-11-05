import { test } from 'node:test'
import assert from 'node:assert/strict'
import { containsSecret, maskSecrets } from './secret-mask.js'

test('API keys are masked but keep a recognisable prefix', () => {
  const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
  const result = maskSecrets(`my key is ${key} ok`)
  assert.equal(result.masked, 1)
  assert.deepEqual(result.kinds, ['sk'])
  assert.match(result.text, /^my key is sk-pro•+ ok$/)
  assert.equal(result.text.includes(key), false)
  // The original is untouched (the caller keeps it).
  assert.equal(key, 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789')
})

test('the common token shapes are covered', () => {
  const cases: Array<[string, string]> = [
    ['ghp_' + 'a'.repeat(36), 'github'],
    ['github_pat_' + 'b'.repeat(30), 'github'],
    ['AKIA' + 'C'.repeat(16), 'aws'],
    ['xoxb-' + '1'.repeat(12), 'slack'],
    ['AIza' + 'd'.repeat(35), 'google'],
    ['Authorization: Bearer ' + 'e'.repeat(40), 'bearer'],
  ]
  for (const [value, kind] of cases) {
    const result = maskSecrets(`see ${value} end`)
    assert.equal(result.masked, 1, `${kind}: ${result.text}`)
    assert.ok(result.kinds.includes(kind), `${kind} not in ${result.kinds.join(',')}`)
    assert.equal(result.text.includes(value), false, `${kind} leaked: ${result.text}`)
  }
})

test('assignments keep the parameter name readable', () => {
  const result = maskSecrets('OPENAI_API_KEY=sk-abcdefghijklmnop1234 password: "hunter2hunter2"')
  assert.equal(result.masked, 2)
  assert.match(result.text, /OPENAI_API_KEY=••••/)
  assert.match(result.text, /password: "?••••/)
  assert.equal(result.text.includes('hunter2hunter2'), false)
})

test('a PEM private key is replaced whole', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----'
  const result = maskSecrets(`before\n${pem}\nafter`)
  assert.equal(result.masked, 1)
  assert.equal(result.text.includes('MIIEow'), false)
  assert.match(result.text, /^before\n••••\nafter$/)
})

test('ordinary text and short values are left alone', () => {
  for (const text of ['', 'just a message', 'sk-short', 'the password field is empty', 'AKIA1234', 'Bearer short']) {
    const result = maskSecrets(text)
    assert.equal(result.masked, 0, `${text}: ${result.text}`)
    assert.equal(result.text, text)
  }
  assert.equal(containsSecret('token: ghp_' + 'z'.repeat(36)), true)
  assert.equal(containsSecret('nothing to see'), false)
})

test('the replacement is configurable', () => {
  const result = maskSecrets('sk-abcdefghijklmnopqrstuvwx', { replacement: '[secret]' })
  assert.equal(result.text, '[secret]')
})
