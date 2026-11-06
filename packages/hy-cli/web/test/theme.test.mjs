import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextTheme, resolveTheme, themeToggleView } from '../dist/theme.js'

// Runs against the web build (`npx tsc -p packages/hy-cli/tsconfig.web.json`).

test('every entry point cycles light → dark → system → light', () => {
  assert.equal(nextTheme('light'), 'dark')
  assert.equal(nextTheme('dark'), 'system')
  assert.equal(nextTheme('system'), 'light')
})

test('system resolves to the OS preference; <html data-theme> is never "system"', () => {
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('light', true), 'light')
  assert.equal(resolveTheme('dark', false), 'dark')
})

test('the toggle shows the current choice and names the next one', () => {
  assert.deepEqual(themeToggleView('light'), { icon: 'sun', labelKey: 'light', nextKey: 'theme_dark' })
  assert.deepEqual(themeToggleView('dark'), { icon: 'moon', labelKey: 'dark', nextKey: 'theme_system' })
  assert.deepEqual(themeToggleView('system'), { icon: 'desktop', labelKey: 'themeSystemShort', nextKey: 'theme_light' })
})
