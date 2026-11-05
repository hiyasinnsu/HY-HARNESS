import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { entryMotionKey, settledFlags, wrapEntryHtml } from '../dist/entry-motion.js'

// Runs against the web build (`npx tsc -p packages/hy-cli/tsconfig.web.json`).

test('an entry animates on its first render only, so a per-frame re-render does not blink', () => {
  const seen = new Set()
  const first = [{ runId: 'r', id: 'tool-1' }, { runId: 'r', id: 'think-2' }].map(entryMotionKey)
  assert.deepEqual(settledFlags(seen, first), [false, false])
  // The next frame re-renders the same entries plus one new tool card.
  const next = [...first, entryMotionKey({ runId: 'r', id: 'tool-3' })]
  assert.deepEqual(settledFlags(seen, next), [true, true, false])
  assert.deepEqual(settledFlags(seen, next), [true, true, true])
})

test('the same entry id in another run is a different entry', () => {
  const seen = new Set()
  settledFlags(seen, [entryMotionKey({ runId: 'a', id: 'msg-1' })])
  assert.deepEqual(settledFlags(seen, [entryMotionKey({ runId: 'b', id: 'msg-1' })]), [false])
})

test('a settled entry is wrapped so CSS can switch its animation off', () => {
  assert.equal(wrapEntryHtml('<div class="tool-card"></div>', true), '<div class="entry settled"><div class="tool-card"></div></div>')
  assert.equal(wrapEntryHtml('<p>x</p>', false), '<div class="entry"><p>x</p></div>')
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.entry\s*\{\s*display:\s*contents;\s*\}/)
  assert.match(css, /\.entry\.settled\s*>\s*\*\s*\{\s*animation:\s*none;\s*\}/)
})
