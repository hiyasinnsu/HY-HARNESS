import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR, ProtocolRpcError } from './protocol.js'
import { turnCancelMethod, turnStartMethod, turnStatusMethod, turnSteerMethod } from './protocol-turn.js'

test('CP-25: turn/start validates params, streams events and returns the result', async () => {
  const notes: Array<{ method: string; params: unknown }> = []
  const method = turnStartMethod(
    {
      start: async (message, images, onEvent, threadId) => {
        onEvent({ type: 'assistant-delta', step: 1, content: 'hi' })
        return { threadId: threadId ?? `thread-${message.length}-${images.length}`, final: 'done' }
      },
    },
    (name, params) => notes.push({ method: name, params }),
  )
  const result = await method.request!({ message: ' hello ', images: [{ mimeType: 'image/png', data: 'AA==' }] })
  assert.deepEqual(result, { threadId: 'thread-5-1', final: 'done' })
  assert.equal(notes.length, 1)
  assert.equal(notes[0]!.method, 'turn/event')
  await assert.rejects(
    async () => method.request!({}),
    (error: unknown) => error instanceof ProtocolRpcError && error.code === ERROR.invalidParams,
  )
  assert.deepEqual(await method.request!({ message: 'x', threadId: 'run-existing' }), { threadId: 'run-existing', final: 'done' })
  await assert.rejects(
    async () => method.request!({ message: 'x', threadId: '' }),
    /threadId must be a non-empty string/,
  )
})

test('CP-25: turn/cancel aborts a running thread and rejects bad ids', async () => {
  const asked: string[] = []
  const method = turnCancelMethod({
    start: async () => ({ threadId: 'x', final: '' }),
    cancel: (threadId) => {
      asked.push(threadId)
      return threadId === 'run-1'
    },
  })
  assert.deepEqual(await method.request!({ threadId: 'run-1' }), { threadId: 'run-1', cancelled: true })
  await assert.rejects(async () => method.request!({ threadId: 'nope' }), /no running turn for thread nope/)
  await assert.rejects(async () => method.request!({}), /threadId is required/)
  await assert.rejects(async () => method.request!(null), /params must be an object/)
  assert.deepEqual(asked, ['run-1', 'nope'])
})

test('CP-25: turn/steer queues a message for a running thread', async () => {
  const steered: Array<[string, string]> = []
  const method = turnSteerMethod({
    start: async () => ({ threadId: 'x', final: '' }),
    steer: (threadId, message) => {
      steered.push([threadId, message])
      return threadId === 'run-1'
    },
  })
  assert.deepEqual(await method.request!({ threadId: 'run-1', message: ' faster ' }), { threadId: 'run-1', steered: true })
  await assert.rejects(async () => method.request!({ threadId: 'nope', message: 'x' }), /no running turn for thread nope/)
  await assert.rejects(async () => method.request!({ threadId: 'run-1' }), /message is required/)
  assert.deepEqual(steered, [
    ['run-1', 'faster'],
    ['nope', 'x'],
  ])
})

test('CP-25: turn/status reports whether a turn is in flight', async () => {
  const method = turnStatusMethod({
    start: async () => ({ threadId: 'x', final: '' }),
    running: (threadId) => threadId === 'run-1',
  })
  assert.deepEqual(await method.request!({ threadId: 'run-1' }), { threadId: 'run-1', running: true })
  assert.deepEqual(await method.request!({ threadId: 'run-2' }), { threadId: 'run-2', running: false })
  await assert.rejects(async () => method.request!({}), /threadId is required/)
})