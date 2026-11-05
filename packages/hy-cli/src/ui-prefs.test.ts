import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PREFS, normalizePrefs } from './ui-prefs.js'

test('CP-36: preferences are normalised, unknown values dropped', () => {
  assert.deepEqual(normalizePrefs(undefined), DEFAULT_PREFS)
  assert.deepEqual(normalizePrefs('nope'), DEFAULT_PREFS)
  assert.deepEqual(
    normalizePrefs({
      statusline: ['model', 'bogus', 'model', 'context', 3],
      codeTheme: 'monokai',
      vimMode: true,
      shortcuts: { palette: 'Ctrl+P', 'bad id!': 'Ctrl+X', find: 'not an accelerator', stopTurn: 7 },
    }),
    { statusline: ['model', 'context'], codeTheme: 'monokai', vimMode: true, shortcuts: { palette: 'Ctrl+P' } },
  )
  assert.equal(normalizePrefs({ codeTheme: 'neon' }).codeTheme, 'auto')
  assert.equal(normalizePrefs({ vimMode: 'yes' }).vimMode, false)
  assert.deepEqual(normalizePrefs({ statusline: [] }).statusline, [], 'an empty statusline is a valid choice')
})
