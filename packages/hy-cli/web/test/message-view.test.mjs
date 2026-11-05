// WP-64 (handover 3-2): the message markup, without a DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderAssistantMessage, renderUserMessage } from '../dist/message-view.js'

const now = new Date('2026-11-05T10:33:00').getTime()
const ts = new Date('2026-11-05T09:05:00').getTime()
const context = { locale: 'en', mask: true, now }

test('a user message shows its text and an absolute time', () => {
  const html = renderUserMessage({ id: 'msg-1', text: 'Inspect the repository', ts }, context)
  assert.match(html, /^<article class="message user" data-entry-id="msg-1">/)
  assert.match(html, /Inspect the repository/)
  assert.match(html, /<time class="msg-time" datetime="2026-11-05T/)
  assert.match(html, />09:05</)
})

test('steering and image markers survive the extraction', () => {
  const steering = renderUserMessage({ id: 'msg-2', text: 'also this', ts, steering: true }, context)
  assert.match(steering, /class="message user steering"/)
  assert.match(steering, /class="steer-badge"/)
  const images = renderUserMessage({ id: 'msg-3', text: 'look', ts, images: 2 }, context)
  assert.match(images, /class="message-attachments"/)
  assert.match(images, / 2 images</)
  assert.match(renderUserMessage({ id: 'msg-4', text: 'one', ts, images: 1 }, context), / 1 image</)
})

test('an assistant message carries the copy and feedback actions', () => {
  const html = renderAssistantMessage({ id: 'msg-5', text: 'Done.', ts }, context)
  assert.match(html, /^<article class="message assistant" data-entry-id="msg-5">/)
  assert.match(html, /data-action="copy-entry"/)
  assert.match(html, /data-action="feedback-up"/)
  assert.match(html, /data-action="feedback-down"/)
  assert.match(html, /<time class="msg-time"/)
})

test('masking is display-only and can be turned off', () => {
  const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
  const masked = renderAssistantMessage({ id: 'msg-6', text: `key ${key}`, ts }, context)
  assert.equal(masked.includes(key), false)
  assert.match(masked, /sk-pro•+/)
  const plain = renderAssistantMessage({ id: 'msg-7', text: `key ${key}`, ts }, { ...context, mask: false })
  assert.equal(plain.includes(key), true)
})

test('markdown still renders (and HTML is escaped)', () => {
  const html = renderUserMessage({ id: 'msg-8', text: '**bold** <script>alert(1)</script>', ts }, context)
  assert.match(html, /<strong>bold<\/strong>/)
  assert.equal(html.includes('<script>'), false)
})
