// WP-61: the shortcut parser and the device-local binding store.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SHORTCUT_ACTIONS,
  matchesAccelerator,
  normalizeAccelerator,
  resolveShortcuts,
  shortcutConflicts,
} from '../dist/shortcuts.js'

test('accelerators normalize to one canonical spelling', () => {
  assert.equal(normalizeAccelerator('ctrl+k'), 'Ctrl+K')
  assert.equal(normalizeAccelerator('Shift+Ctrl+K'), 'Ctrl+Shift+K')
  assert.equal(normalizeAccelerator('control + alt + p'), 'Ctrl+Alt+P')
  assert.equal(normalizeAccelerator('Ctrl+,'), 'Ctrl+,')
  assert.equal(normalizeAccelerator('ctrl+arrowup'), 'Ctrl+ArrowUp')
  assert.equal(normalizeAccelerator('esc'), 'Escape')
  assert.equal(normalizeAccelerator('ctrl+shift'), null, 'modifiers alone are not a chord')
  assert.equal(normalizeAccelerator('ctrl+a+b'), null, 'two keys are not a chord')
  assert.equal(normalizeAccelerator(''), null)
})

test('a chord matches only the exact modifier set', () => {
  const event = { key: 'K', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }
  assert.equal(matchesAccelerator(event, 'Ctrl+K'), true)
  assert.equal(matchesAccelerator(event, 'Ctrl+Shift+K'), false)
  assert.equal(matchesAccelerator(event, 'Alt+K'), false)
  assert.equal(matchesAccelerator({ key: 'k', ctrlKey: true }, 'Ctrl+K'), true, 'the letter is case-insensitive')
  assert.equal(matchesAccelerator({ key: ',', ctrlKey: true }, 'Ctrl+,'), true)
  assert.equal(matchesAccelerator({ key: 'Escape' }, 'Escape'), true)
})

test('stored bindings merge over the defaults and drop junk', () => {
  const defaults = resolveShortcuts(undefined)
  assert.equal(defaults.palette, 'Ctrl+K')
  assert.equal(Object.keys(defaults).length, SHORTCUT_ACTIONS.length)

  const custom = resolveShortcuts({ palette: 'alt+p', newSession: 'nonsense+', outline: 42 })
  assert.equal(custom.palette, 'Alt+P')
  assert.equal(custom.newSession, 'Ctrl+N', 'an invalid override falls back to the default')
  assert.equal(custom.outline, 'Ctrl+Shift+O')
  assert.equal(resolveShortcuts(['not', 'an', 'object']).palette, 'Ctrl+K')
})

test('conflicts are reported, not silently resolved', () => {
  assert.deepEqual(shortcutConflicts(resolveShortcuts(undefined)), [])
  const clash = resolveShortcuts({ palette: 'Ctrl+N' })
  const conflicts = shortcutConflicts(clash)
  assert.equal(conflicts.length, 1)
  assert.match(conflicts[0], /palette|newSession/)
  assert.match(conflicts[0], /Ctrl\+N/)
})
