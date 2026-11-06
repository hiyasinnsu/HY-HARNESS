// WP-63: every literal translation key the client uses is declared in English,
// and the keys added for M5/M6 are actually translated (not left as English).
//
// The scan reads the built bundle rather than the sources, so a key that only
// exists in a dead branch shows up too. Dynamic keys (`tr(`x_${y}`)`) cannot be
// checked statically and are skipped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasTranslation, translate } from '../dist/i18n.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.join(here, '..', 'dist', 'app.js')
const helperBundles = ['turn-queue-view.js', 'turn-queue-intent.js', 'phone-view.js'].map((file) => path.join(here, '..', 'dist', file))

function keysIn(file) {
  if (!fs.existsSync(file)) return new Set()
  const text = fs.readFileSync(file, 'utf8')
  const keys = new Set()
  for (const match of text.matchAll(/\btr\('([^']+)'\)/g)) keys.add(match[1])
  for (const match of text.matchAll(/\btranslate\([^,]+,\s*'([^']+)'/g)) keys.add(match[1])
  return keys
}

test('every literal key in the client bundle is declared in English', () => {
  const keys = keysIn(bundle)
  assert.ok(keys.size > 100, `expected the bundle's keys, got ${keys.size}`)
  const missing = [...keys].filter((key) => !hasTranslation('en', key)).sort()
  assert.deepEqual(missing, [], `missing English keys: ${missing.join(', ')}`)
})

test('the queue helpers only use declared keys', () => {
  for (const file of helperBundles) {
    for (const key of keysIn(file)) {
      assert.equal(hasTranslation('en', key), true, `${path.basename(file)}: missing key ${key}`)
    }
  }
})

test('the M5/M6 keys are translated, not left as English', () => {
  const keys = [
    'onboardingTitle',
    'updateCheck',
    'generateTitle',
    'statsTitle',
    'forkChat',
    'turnOutline',
    'feedbackTitle',
    'shortcuts',
    'openIn',
    'maskSecretsLabel',
    'appearance',
    'statLlm',
  ]
  for (const key of keys) {
    assert.equal(hasTranslation('en', key), true, `en is missing ${key}`)
    assert.notEqual(translate('ja', key), key, `ja is missing ${key}`)
    assert.notEqual(translate('zh', key), key, `zh is missing ${key}`)
    assert.notEqual(translate('ja', key), translate('en', key), `ja and en are identical for ${key}`)
  }
})
