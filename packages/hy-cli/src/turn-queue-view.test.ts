import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_TURN_QUEUE, MAX_QUEUED_IMAGES_PER_TURN, type QueuedTurn, type TurnQueueState } from './turn-queue.js'
import {
  MAX_QUEUED_MESSAGE_LENGTH,
  MAX_QUEUED_RUN_ID_LENGTH,
  MAX_QUEUED_TURN_ID_LENGTH,
  parseCancelRequest,
  parseEnqueueRequest,
  parseResolveRequest,
  parseRunIdRequest,
  turnQueueView,
} from './turn-queue-view.js'

function turn(id: string, message = `message ${id}`, images: QueuedTurn['images'] = []): QueuedTurn {
  return { id, message, images, queuedAt: 1 }
}

function image(index: number): { mimeType: string; data: string } {
  return { mimeType: 'image/png', data: `bytes-${index}` }
}

function withTurns(runId: string, turns: QueuedTurn[]): TurnQueueState {
  return { ...EMPTY_TURN_QUEUE, sessions: { [runId]: turns } }
}

/** Every parser must survive junk bodies without throwing. */
const JUNK_BODIES: unknown[] = [null, 42, [], { runId: {} }]

// --- turnQueueView ---------------------------------------------------------

test('turnQueueView of an unknown run is an empty, unpaused view', () => {
  const view = turnQueueView(EMPTY_TURN_QUEUE, 'run-unknown')
  assert.deepEqual(view, { runId: 'run-unknown', queued: [], running: null, uncertain: [], paused: false })
})

test('turnQueueView reports each waiting turn with an image count, not the payload', () => {
  const state = withTurns('run-a', [turn('t1'), turn('t2', 'second', [image(1), image(2)])])
  const view = turnQueueView(state, 'run-a')
  assert.equal(view.queued.length, 2)
  assert.deepEqual(
    view.queued.map((queued) => queued.id),
    ['t1', 't2'],
  )
  assert.equal(typeof view.queued[0]?.images, 'number')
  assert.equal(view.queued[0]?.images, 0)
  assert.equal(view.queued[1]?.images, 2)
  assert.equal(view.queued[0]?.message, 'message t1')
})

test('turnQueueView keeps the queue order the state holds', () => {
  const state = withTurns('run-a', ['t1', 't2', 't3'].map((id) => turn(id)))
  assert.deepEqual(
    turnQueueView(state, 'run-a').queued.map((queued) => queued.id),
    ['t1', 't2', 't3'],
  )
})

test('turnQueueView exposes the running id as a string', () => {
  const state: TurnQueueState = { ...withTurns('run-a', [turn('t1')]), running: { 'run-a': 't1' } }
  const view = turnQueueView(state, 'run-a')
  assert.equal(view.running, 't1')
  assert.equal(typeof view.running, 'string')
})

test('turnQueueView reports another session running as null', () => {
  const state: TurnQueueState = { ...withTurns('run-a', [turn('t1')]), running: { 'run-b': 't9' } }
  assert.equal(turnQueueView(state, 'run-a').running, null)
})

test('turnQueueView reflects a paused session', () => {
  const state: TurnQueueState = { ...withTurns('run-a', [turn('t1')]), paused: ['run-a'] }
  const view = turnQueueView(state, 'run-a')
  assert.equal(view.paused, true)
  assert.equal(turnQueueView(state, 'run-b').paused, false)
})

test('turnQueueView reflects uncertain ids', () => {
  const state: TurnQueueState = { ...withTurns('run-a', [turn('t1')]), uncertain: { 'run-a': ['t1'] } }
  assert.deepEqual(turnQueueView(state, 'run-a').uncertain, ['t1'])
})

test('turnQueueView copies the uncertain list instead of sharing it', () => {
  const state: TurnQueueState = { ...EMPTY_TURN_QUEUE, uncertain: { 'run-a': ['t1'] } }
  const view = turnQueueView(state, 'run-a')
  view.uncertain.push('t2')
  assert.deepEqual(state.uncertain['run-a'], ['t1'])
})

test('turnQueueView never serializes image data', () => {
  const state = withTurns('run-a', [turn('t1', 'with an image', [image(1)])])
  const serialized = JSON.stringify(turnQueueView(state, 'run-a'))
  assert.equal(serialized.includes('"data"'), false)
  assert.equal(serialized.includes('bytes-1'), false)
})
// --- parseEnqueueRequest ---------------------------------------------------

test('parseEnqueueRequest accepts a well-formed reservation', () => {
  const parsed = parseEnqueueRequest({ runId: 'run-a', id: 'turn-1', message: 'hello' })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.request.runId, 'run-a')
  assert.equal(parsed.request.turn.id, 'turn-1')
  assert.equal(parsed.request.turn.message, 'hello')
  assert.deepEqual(parsed.request.turn.images, [])
  assert.equal(typeof parsed.request.turn.queuedAt, 'number')
})

test('parseEnqueueRequest accepts images that are real images', () => {
  const parsed = parseEnqueueRequest({ runId: 'run-a', id: 'turn-1', message: 'look', images: [image(1)] })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.request.turn.images.length, 1)
  assert.equal(parsed.request.turn.images[0]?.mimeType, 'image/png')
})

test('parseEnqueueRequest ignores a client-supplied queuedAt', () => {
  const parsed = parseEnqueueRequest({ runId: 'run-a', id: 'turn-1', message: 'hello', queuedAt: 1 })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.notEqual(parsed.request.turn.queuedAt, 1)
})

test('parseEnqueueRequest rejects a missing or non-string runId', () => {
  for (const runId of [undefined, null, 42, {}]) {
    const parsed = parseEnqueueRequest({ runId, id: 'turn-1', message: 'hello' })
    assert.equal(parsed.ok, false)
    if (parsed.ok) continue
    assert.equal(parsed.status, 400)
    assert.equal(typeof parsed.error, 'string')
  }
})

test('parseEnqueueRequest rejects an empty runId', () => {
  const parsed = parseEnqueueRequest({ runId: '', id: 'turn-1', message: 'hello' })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.status, 400)
  assert.equal(parsed.error, 'runId is required')
})

test('parseEnqueueRequest rejects runIds with characters that are not path-safe', () => {
  for (const runId of ['../etc', 'run/a', 'run a', 'run:a']) {
    const parsed = parseEnqueueRequest({ runId, id: 'turn-1', message: 'hello' })
    assert.equal(parsed.ok, false, runId)
    if (parsed.ok) continue
    assert.equal(parsed.status, 400)
  }
})

test('parseEnqueueRequest rejects an over-long runId', () => {
  const parsed = parseEnqueueRequest({ runId: 'a'.repeat(MAX_QUEUED_RUN_ID_LENGTH + 1), id: 't', message: 'x' })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.status, 400)
})

test('parseEnqueueRequest rejects an empty or whitespace message', () => {
  for (const message of ['', '   ', '\n\t']) {
    const parsed = parseEnqueueRequest({ runId: 'run-a', id: 'turn-1', message })
    assert.equal(parsed.ok, false)
    if (parsed.ok) continue
    assert.equal(parsed.status, 400)
    assert.equal(parsed.error, 'message is required')
  }
})

test('parseEnqueueRequest rejects a non-string message', () => {
  const parsed = parseEnqueueRequest({ runId: 'run-a', id: 'turn-1', message: 5 })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.status, 400)
})

test('parseEnqueueRequest rejects an over-long message', () => {
  const parsed = parseEnqueueRequest({ runId: 'run-a', id: 'turn-1', message: 'x'.repeat(MAX_QUEUED_MESSAGE_LENGTH + 1) })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.status, 400)
})

test('parseEnqueueRequest rejects a missing, empty or over-long id', () => {
  for (const id of [undefined, '', 7, 'x'.repeat(MAX_QUEUED_TURN_ID_LENGTH + 1)]) {
    const parsed = parseEnqueueRequest({ runId: 'run-a', id, message: 'hello' })
    assert.equal(parsed.ok, false)
    if (parsed.ok) continue
    assert.equal(parsed.status, 400)
  }
})

test('parseEnqueueRequest rejects images that are not an array', () => {
  const parsed = parseEnqueueRequest({ runId: 'run-a', id: 'turn-1', message: 'hello', images: 'image/png' })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.status, 400)
  assert.equal(parsed.error, 'images must be an array')
})

test('parseEnqueueRequest rejects an attachment that is not an image mime type', () => {
  const parsed = parseEnqueueRequest({
    runId: 'run-a',
    id: 'turn-1',
    message: 'hello',
    images: [{ mimeType: 'application/pdf', data: 'x' }],
  })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.status, 400)
  assert.equal(parsed.error, 'only images can be attached')
})

test('parseEnqueueRequest rejects more images than a live message may carry', () => {
  const images = Array.from({ length: MAX_QUEUED_IMAGES_PER_TURN + 1 }, (_unused, index) => image(index))
  const parsed = parseEnqueueRequest({ runId: 'run-a', id: 'turn-1', message: 'hello', images })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.status, 400)
})

test('parseEnqueueRequest rejects an image without base64 data', () => {
  const parsed = parseEnqueueRequest({
    runId: 'run-a',
    id: 'turn-1',
    message: 'hello',
    images: [{ mimeType: 'image/png', data: '' }],
  })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.status, 400)
  assert.equal(parsed.error, 'each image needs base64 data')
})

test('parseEnqueueRequest rejects an image entry that is not an object', () => {
  const parsed = parseEnqueueRequest({ runId: 'run-a', id: 'turn-1', message: 'hello', images: ['image/png'] })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.status, 400)
})
// --- parseRunIdRequest -----------------------------------------------------

test('parseRunIdRequest accepts a valid run id', () => {
  assert.deepEqual(parseRunIdRequest({ runId: 'run-a' }), { ok: true, runId: 'run-a' })
})

test('parseRunIdRequest rejects junk bodies and bad ids', () => {
  for (const body of [null, 42, [], { runId: {} }, { runId: '' }, { runId: 'run/a' }, {}]) {
    const parsed = parseRunIdRequest(body)
    assert.equal(parsed.ok, false)
    if (parsed.ok) continue
    assert.equal(parsed.status, 400)
    assert.equal(typeof parsed.error, 'string')
  }
})

// --- parseCancelRequest ----------------------------------------------------

test('parseCancelRequest accepts an omitted id, which cancels every waiting turn', () => {
  const parsed = parseCancelRequest({ runId: 'run-a' })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.runId, 'run-a')
  assert.equal('id' in parsed, false)
})

test('parseCancelRequest accepts one id', () => {
  const parsed = parseCancelRequest({ runId: 'run-a', id: 'turn-1' })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.id, 'turn-1')
})

test('parseCancelRequest rejects an empty id instead of cancelling everything', () => {
  const parsed = parseCancelRequest({ runId: 'run-a', id: '' })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.status, 400)
})

test('parseCancelRequest rejects junk bodies and a missing runId', () => {
  for (const body of [null, 42, [], { runId: {} }, { id: 'turn-1' }, {}]) {
    const parsed = parseCancelRequest(body)
    assert.equal(parsed.ok, false)
    if (parsed.ok) continue
    assert.equal(parsed.status, 400)
  }
})
// --- parseResolveRequest ---------------------------------------------------

test('parseResolveRequest accepts both decisions', () => {
  for (const decision of ['resend', 'discard'] as const) {
    const parsed = parseResolveRequest({ runId: 'run-a', id: 'turn-1', decision })
    assert.equal(parsed.ok, true)
    if (!parsed.ok) continue
    assert.equal(parsed.runId, 'run-a')
    assert.equal(parsed.id, 'turn-1')
    assert.equal(parsed.decision, decision)
  }
})

test('parseResolveRequest rejects any other decision', () => {
  for (const decision of ['retry', 'RESEND', '', 42, undefined, null]) {
    const parsed = parseResolveRequest({ runId: 'run-a', id: 'turn-1', decision })
    assert.equal(parsed.ok, false, String(decision))
    if (parsed.ok) continue
    assert.equal(parsed.status, 400)
    assert.equal(parsed.error, 'decision must be "resend" or "discard"')
  }
})

test('parseResolveRequest rejects a missing id before looking at the decision', () => {
  const parsed = parseResolveRequest({ runId: 'run-a', decision: 'resend' })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.status, 400)
  assert.equal(parsed.error, 'id must be a string')
})

// --- junk input never throws ----------------------------------------------

test('every parser returns a failure instead of throwing on junk bodies', () => {
  for (const body of JUNK_BODIES) {
    for (const parse of [parseEnqueueRequest, parseRunIdRequest, parseCancelRequest, parseResolveRequest]) {
      const parsed = parse(body)
      assert.equal(parsed.ok, false)
      if (parsed.ok) continue
      assert.equal(parsed.status, 400)
      assert.equal(typeof parsed.error, 'string')
    }
  }
})

test('turnQueueView tolerates junk run ids without throwing', () => {
  for (const runId of ['', '../etc', 'missing']) {
    const view = turnQueueView(EMPTY_TURN_QUEUE, runId)
    assert.deepEqual(view.queued, [])
    assert.equal(view.running, null)
    assert.equal(view.paused, false)
  }
})