import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderTurnQueueHtml } from '../dist/turn-queue-view.js'

// Runs against the web build (`npx tsc -p packages/hy-cli/tsconfig.web.json`).
// The source is imported from dist because the src tree uses `.js` specifiers
// that Node's type stripping does not rewrite, while this file is plain ESM.
function view(overrides = {}) {
  return { runId: 'run-1', queued: [], running: null, uncertain: [], paused: false, ...overrides }
}

function turns(...messages) {
  return messages.map((message, i) => ({ id: `t${i + 1}`, message, images: 0, queuedAt: 1_700_000_000_000 + i }))
}

test('an empty queue renders nothing so the composer keeps its space', () => {
  assert.equal(renderTurnQueueHtml(view(), 'en'), '')
  assert.equal(renderTurnQueueHtml(view(), 'ja'), '')
})

test('three queued turns show the count', () => {
  assert.match(renderTurnQueueHtml(view({ queued: turns('one', 'two', 'three') }), 'ja'), /予約 3 件/)
})

test('the count is localised and differs between languages', () => {
  const data = view({ queued: turns('one', 'two', 'three') })
  assert.match(renderTurnQueueHtml(data, 'en'), /3 queued/)
  assert.notEqual(renderTurnQueueHtml(data, 'ja'), renderTurnQueueHtml(data, 'en'))
})

test('every queued row carries its id on the cancel button', () => {
  const html = renderTurnQueueHtml(view({ queued: turns('one', 'two') }), 'en')
  assert.match(html, /data-queue-action="cancel" data-queue-id="t1"/)
  assert.match(html, /data-queue-action="cancel" data-queue-id="t2"/)
})

test('a multi-line message is shown on one line', () => {
  assert.match(renderTurnQueueHtml(view({ queued: turns('first line\nsecond line') }), 'en'), /first line second line/)
})

test('a paused queue offers a resume button', () => {
  const html = renderTurnQueueHtml(view({ queued: turns('one'), paused: true }), 'ja')
  assert.match(html, /停止中/)
  assert.match(html, /data-queue-action="resume"/)
})

test('an uncertain turn offers resend and discard', () => {
  const html = renderTurnQueueHtml(view({ uncertain: ['t9'], paused: true }), 'ja')
  assert.match(html, /結果不明/)
  assert.match(html, /data-queue-action="resolve" data-queue-decision="resend" data-queue-id="t9"/)
  assert.match(html, /data-queue-action="resolve" data-queue-decision="discard" data-queue-id="t9"/)
})

test('an uncertain turn renders even when nothing else is queued', () => {
  assert.notEqual(renderTurnQueueHtml(view({ uncertain: ['t9'] }), 'en'), '')
})

test('a message containing script tags is escaped', () => {
  const html = renderTurnQueueHtml(view({ queued: turns('<script>alert(1)</script>') }), 'en')
  assert.ok(!html.includes('<script>'), 'the raw tag must never reach the DOM')
  assert.match(html, /&lt;script&gt;/)
})

test('clear-all is shown only when something is queued', () => {
  assert.match(renderTurnQueueHtml(view({ queued: turns('one') }), 'en'), /data-queue-action="cancel-all"/)
  assert.ok(!renderTurnQueueHtml(view({ paused: true }), 'en').includes('data-queue-action="cancel-all"'))
})

test('the number of attached images is reported', () => {
  const withImage = view({ queued: [{ id: 't1', message: 'with image', images: 2, queuedAt: 1 }] })
  assert.match(renderTurnQueueHtml(withImage, 'ja'), /画像 2 枚/)
})

test('no inline handlers are emitted', () => {
  const html = renderTurnQueueHtml(view({ queued: turns('one'), uncertain: ['t2'], paused: true }), 'en')
  assert.ok(!html.includes('onclick'), 'click handling stays in the delegated listener')
})