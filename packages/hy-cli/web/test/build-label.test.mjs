import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLabel, buildTime } from '../dist/build-label.js'

// Runs against the web build (`npx tsc -p packages/hy-cli/tsconfig.web.json`).

test('two builds of one version are told apart by commit and build time', () => {
  const iso = new Date(2026, 10, 6, 6, 22).toISOString()
  assert.equal(buildTime(iso), '11/06 06:22')
  assert.equal(buildLabel('0.4.1', { commit: 'ada5158', builtAt: iso }).text, 'v0.4.1 · ada5158 · 11/06 06:22')
  assert.equal(buildLabel('0.4.1', { commit: 'ada5158', dirty: true }).text, 'v0.4.1 · ada5158+')
  assert.match(buildLabel('0.4.1', { commit: 'ada5158', dirty: true }).title, /uncommitted/)
})

test('an unknown build still shows the version', () => {
  assert.equal(buildLabel('0.4.1', undefined).text, 'v0.4.1')
  assert.equal(buildLabel(undefined, {}).text, 'vunknown')
  assert.equal(buildTime('not a date'), '')
})
