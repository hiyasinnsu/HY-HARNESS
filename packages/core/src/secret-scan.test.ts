import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findSecrets, redactSecrets } from './secret-scan.js'
import { redactMessage } from './llm.js'

const env = { OPENCODE_API_KEY: 'zz-custom-format-0123456789abcdef', HOME: '/home/user', DEBUG_TOKEN: '1', PATH: '/usr/bin' }

test('E1: provider tokens, private keys, URL and header credentials are masked; readable parts stay', () => {
  const text = [
    'key sk-ant-api03-abcdefghijklmnopqrstuvwx and AKIAABCDEFGHIJKLMNOP',
    'git remote https://alice:hunter2secret@example.com/r.git',
    'Authorization: Bearer abcdefghijklmnop0123',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
  ].join('\n')
  const out = redactSecrets(text, { env: {} })
  assert.doesNotMatch(out, /sk-ant-api03|AKIAABCD|hunter2secret|abcdefghijklmnop0123|AAAA/)
  assert.match(out, /https:\/\/alice:\[redacted\]@example\.com/)
  assert.match(out, /Authorization: Bearer \[redacted\]/)
  assert.deepEqual(findSecrets(text, { env: {} }).sort(), ['authorization', 'aws-access-key', 'openai-anthropic', 'private-key', 'url-credentials'])
})

test('E1: the value of a credential environment variable is masked in any format; ordinary values are not', () => {
  assert.equal(redactSecrets('echo zz-custom-format-0123456789abcdef', { env }), 'echo [redacted]')
  assert.deepEqual(findSecrets('token=zz-custom-format-0123456789abcdef', { env }), ['environment-credential'])
  assert.equal(redactSecrets('cd /home/user && echo 1', { env }), 'cd /home/user && echo 1')
})

test('E1: code that merely names a credential is left alone', () => {
  const code = 'const apiKey = process.env.OPENAI_API_KEY\nconst password = getPassword()\nconst jwt = "eyJhbGciOi.eyJzdWIi.sig"\nconst url = "https://example.com/a:b@c"'
  assert.equal(redactSecrets(code, { env: {} }), code)
  assert.deepEqual(findSecrets(code, { env: {} }), [])
})

test('E1: redactMessage masks every part the adapters send', () => {
  const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz'
  const masked = redactMessage({
    role: 'user',
    content: `TOOL RESULT (shell): ${secret}`,
    toolResults: { rendered: secret, entries: [{ id: 'c1', name: 'shell', text: secret }] },
  })
  assert.doesNotMatch(JSON.stringify(masked), /sk-proj-abc/)
})
