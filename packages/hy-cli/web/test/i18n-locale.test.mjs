// WP-61: the runtime locale registry (built-ins plus merged dictionaries) and
// the client masking module, which must behave exactly like the server one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localeChoices, registeredLocales, registerLocaleMessages, translate } from '../dist/i18n.js'
import { maskSecrets as webMask } from '../dist/secret-mask.js'
import * as serverMask from '../../dist/secret-mask.js'

test('a registered locale is used and falls back to English for missing keys', () => {
  assert.deepEqual(registeredLocales(), [])
  registerLocaleMessages('de', { newChat: 'Neuer Chat' }, 'Deutsch')
  assert.deepEqual(registeredLocales(), ['de'])
  assert.equal(translate('de', 'newChat'), 'Neuer Chat')
  // A missing key falls back to English, not to the key.
  assert.equal(translate('de', 'settings'), translate('en', 'settings'))
  // An unknown locale and unknown key are visible, never blank.
  assert.equal(translate('xx', 'newChat'), 'New chat')
  assert.equal(translate('en', 'no-such-key'), 'no-such-key')
  // The settings select lists the built-ins and the registered one.
  const ids = localeChoices().map((choice) => choice.id)
  assert.deepEqual(ids.sort(), ['de', 'en', 'ja', 'zh'])
  assert.equal(localeChoices().find((choice) => choice.id === 'de')?.label, 'Deutsch')
})

test('the client masker matches the server one on a corpus', () => {
  const corpus = [
    'plain text with no secrets',
    'key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 here',
    'ghp_' + 'a'.repeat(36),
    'AKIA' + 'C'.repeat(16),
    'xoxb-' + '1'.repeat(12),
    'AIza' + 'd'.repeat(35),
    'Authorization: Bearer ' + 'e'.repeat(40),
    'OPENAI_API_KEY=sk-abcdefghijklmnop1234',
    'password: "hunter2hunter2"',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    'sk-short and AKIA1234 are not keys',
  ]
  for (const text of corpus) {
    assert.equal(webMask(text).text, serverMask.maskSecrets(text).text, text)
    assert.equal(webMask(text).masked, serverMask.maskSecrets(text).masked, text)
  }
})
