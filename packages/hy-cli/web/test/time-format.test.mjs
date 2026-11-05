// WP-64 (handover 3-1): relative and absolute time formatting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatClock,
  formatDay,
  formatRelative,
  formatTimestamp,
  messageTimeHtml,
  timeAttributes,
} from '../dist/time-format.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const now = new Date('2026-11-05T10:33:00').getTime()

test('the relative form covers every boundary', () => {
  assert.equal(formatRelative(now, now, 'en'), 'just now')
  assert.equal(formatRelative(now, now - 59_000, 'en'), 'just now')
  assert.equal(formatRelative(now, now - MINUTE, 'en'), '1 min ago')
  assert.equal(formatRelative(now, now - 59 * MINUTE, 'en'), '59 min ago')
  assert.equal(formatRelative(now, now - HOUR, 'en'), '1 h ago')
  assert.equal(formatRelative(now, now - 23 * HOUR, 'en'), '23 h ago')
  assert.equal(formatRelative(now, now - DAY, 'en'), '1 d ago')
  assert.equal(formatRelative(now, now - 6 * DAY, 'en'), '6 d ago')
  // Older than a week: a date, not "9 d ago".
  assert.equal(formatRelative(now, now - 9 * DAY, 'en'), formatDay(now - 9 * DAY, 'en'))
  // A clock slightly ahead of the server reads as "just now", never "-1 min ago".
  assert.equal(formatRelative(now, now + 30_000, 'en'), 'just now')
})

test('the relative form is localized', () => {
  assert.equal(formatRelative(now, now - 5 * MINUTE, 'ja'), '5分前')
  assert.equal(formatRelative(now, now - 2 * HOUR, 'ja'), '2時間前')
  assert.equal(formatRelative(now, now - 3 * DAY, 'zh'), '3 天前')
  assert.equal(formatRelative(now, now - 5 * MINUTE, 'en'), '5 min ago')
  // An unknown locale falls back to English rather than to the key.
  assert.equal(formatRelative(now, now - 5 * MINUTE, 'xx'), '5 min ago')
})

test('an unusable timestamp renders as empty, not as "Invalid Date"', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null, 'yesterday']) {
    assert.equal(formatRelative(now, value, 'en'), '')
    assert.equal(formatClock(value, 'en'), '')
    assert.equal(formatTimestamp(value, 'en', now), '')
    assert.deepEqual(timeAttributes(value), { iso: '', title: '' })
  }
  assert.equal(formatRelative(Number.NaN, now, 'en'), '')
})

test('absolute time is a clock today and a date plus clock otherwise', () => {
  const today = new Date('2026-11-05T09:05:00').getTime()
  assert.match(formatTimestamp(today, 'en', now), /09:05/)
  const earlier = new Date('2026-11-02T18:40:00').getTime()
  const label = formatTimestamp(earlier, 'en', now)
  assert.match(label, /09:05|18:40/)
  assert.equal(label.includes(':'), true)
  assert.notEqual(label, formatClock(earlier, 'en'), 'a different day adds the date')
})

test('the message time element carries the ISO value and a tooltip', () => {
  const ts = new Date('2026-11-05T09:05:00').getTime()
  const html = messageTimeHtml(ts, 'en', now)
  assert.match(html, /^<time class="msg-time" datetime="2026-11-05T/)
  assert.match(html, /title="/)
  assert.match(html, />09:05</)
  assert.equal(messageTimeHtml(Number.NaN, 'en', now), '')
  const attributes = timeAttributes(ts)
  assert.equal(attributes.iso, new Date(ts).toISOString())
})
