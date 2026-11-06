// WP-64 (handover 3-2): the message markup, without a DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderAssistantMessage, renderUserMessage, renderUserMessageEditor } from '../dist/message-view.js'

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

test('own messages: copy always; resend and edit only for a turn in an editable chat', () => {
  const plain = renderUserMessage({ id: 'msg-6', text: 'hi', ts, turn: 2 }, context)
  assert.match(plain, /data-turn="2"/)
  assert.match(plain, /data-action="copy-entry" data-entry-id="msg-6"/)
  assert.doesNotMatch(plain, /resend-entry|edit-entry/, 'not editable: running turn or a worker session')
  const editable = renderUserMessage({ id: 'msg-6', text: 'hi', ts, turn: 2 }, { ...context, editable: true })
  assert.match(editable, /data-action="resend-entry" data-entry-id="msg-6"/)
  assert.match(editable, /data-action="edit-entry" data-entry-id="msg-6"/)
  const steering = renderUserMessage({ id: 'msg-7', text: 'also', ts, steering: true }, { ...context, editable: true })
  assert.match(steering, /copy-entry/)
  assert.doesNotMatch(steering, /resend-entry|edit-entry/, 'a steering message opens no turn')
})

test('the inline editor holds the escaped text, the restore option and send / cancel', () => {
  const html = renderUserMessageEditor({ id: 'msg-8', text: 'fix <b>this</b>', ts, turn: 1 }, context)
  assert.match(html, /class="message user editing"/)
  assert.match(html, /<textarea class="message-edit-input" id="edit-input-msg-8" rows="4">fix &lt;b&gt;this&lt;\/b&gt;<\/textarea>/)
  assert.match(html, /id="edit-restore-msg-8"/)
  assert.match(html, /data-action="edit-send" data-entry-id="msg-8"/)
  assert.match(html, /data-action="edit-cancel" data-entry-id="msg-8"/)
})
