import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STEER_PREFIX, createSteerInbox, isSteerMessage, steerMessage, steerText } from './steering.js'

test('the inbox drains in order and empties itself', () => {
  const inbox = createSteerInbox()
  assert.equal(inbox.size(), 0)
  assert.deepEqual(inbox.drain(), [])
  assert.equal(inbox.push({ text: 'first' }), 1)
  assert.equal(inbox.push({ text: 'second', images: [{ mimeType: 'image/png', data: 'AA==' }] }), 2)
  assert.equal(inbox.size(), 2)
  const drained = inbox.drain()
  assert.deepEqual(
    drained.map((m) => m.text),
    ['first', 'second'],
  )
  assert.equal(drained[1]?.images?.[0]?.mimeType, 'image/png')
  assert.equal(inbox.size(), 0, 'a drained inbox is empty')
  assert.deepEqual(inbox.drain(), [], 'draining twice yields nothing')
})

test('the history marker round-trips', () => {
  const marked = steerMessage('also fix the typo')
  assert.ok(marked.startsWith(`${STEER_PREFIX}\n`))
  assert.ok(isSteerMessage(marked))
  assert.equal(steerText(marked), 'also fix the typo')
})

test('a normal message is not mistaken for a steering one', () => {
  assert.equal(isSteerMessage('also fix the typo'), false)
  assert.equal(isSteerMessage(`quoted ${STEER_PREFIX} inside`), false)
  // steerText passes anything else through, for the log/projection paths.
  assert.equal(steerText('plain text'), 'plain text')
})
