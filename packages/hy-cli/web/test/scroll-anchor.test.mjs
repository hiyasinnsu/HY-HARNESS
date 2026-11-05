import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STICK_TO_BOTTOM_THRESHOLD_PX,
  SCROLL_ANCHOR_AT_BOTTOM,
  anchorAfterRender,
  captureAnchor,
  shouldStickToBottom,
} from '../dist/scroll-anchor.js'

// Runs against the web build (`npx tsc -p packages/hy-cli/tsconfig.web.json`).
// The source is imported from dist because the src tree uses `.js` specifiers
// that Node's type stripping does not rewrite, while this file is plain ESM.
test('a view scrolled to the very bottom sticks to it', () => {
  assert.equal(shouldStickToBottom(700, 1500, 800), true)
})

test('a view within the threshold of the bottom still sticks', () => {
  assert.equal(shouldStickToBottom(652, 1500, 800), true)
  assert.equal(shouldStickToBottom(700 - STICK_TO_BOTTOM_THRESHOLD_PX, 1500, 800), true)
})

test('a view further than the threshold from the bottom does not stick', () => {
  assert.equal(shouldStickToBottom(651, 1500, 800), false)
  assert.equal(shouldStickToBottom(0, 1500, 800), false)
})

test('content that fits on screen always counts as the bottom', () => {
  assert.equal(shouldStickToBottom(0, 800, 800), true)
  assert.equal(shouldStickToBottom(0, 400, 800), true)
})

test('the threshold is 48 pixels', () => {
  assert.equal(STICK_TO_BOTTOM_THRESHOLD_PX, 48)
})

test('a missing anchor resolves to the top', () => {
  assert.equal(anchorAfterRender(undefined), 0)
})

test('a sticking anchor asks for the bottom', () => {
  assert.equal(anchorAfterRender({ top: 120, stick: true }), Number.POSITIVE_INFINITY)
})

test('a non-sticking anchor keeps its offset', () => {
  assert.equal(anchorAfterRender({ top: 120, stick: false }), 120)
})

test('top: 0 stuck to the bottom still asks for the bottom', () => {
  assert.equal(anchorAfterRender({ top: 0, stick: true }), Number.POSITIVE_INFINITY)
})

test('a chat opened for the first time starts at the bottom', () => {
  assert.equal(SCROLL_ANCHOR_AT_BOTTOM.stick, true)
  assert.equal(anchorAfterRender(SCROLL_ANCHOR_AT_BOTTOM), Number.POSITIVE_INFINITY)
})

test('capturing records the offset and whether it followed the bottom', () => {
  assert.deepEqual(captureAnchor(700, 1500, 800), { top: 700, stick: true })
  assert.deepEqual(captureAnchor(200, 1500, 800), { top: 200, stick: false })
})

test('capturing content that fits on screen marks it as sticking', () => {
  assert.deepEqual(captureAnchor(0, 300, 800), { top: 0, stick: true })
})