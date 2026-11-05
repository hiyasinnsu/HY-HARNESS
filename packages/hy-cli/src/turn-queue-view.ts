// Pure, HTTP-free helpers shared by the web server's turn-queue endpoints.
//
// Two jobs live here:
//  * `turnQueueView` turns the durable queue state into the small JSON shape
//    the GUI renders. It never carries base64 image data, so a chat can poll
//    it cheaply while a turn is running.
//  * The `parse*Request` functions validate request bodies with the same
//    granularity as `normalizeSessionTitle`: they return a discriminated union
//    instead of throwing, so the caller maps it to a status code and a message.
//
// Nothing here mutates the queue or touches the filesystem; `enqueueTurn` and
// friends in `turn-queue.ts` stay the only place that changes state.

import {
  MAX_QUEUED_IMAGES_PER_TURN,
  type QueuedImage,
  type QueuedTurn,
  type TurnQueueState,
} from './turn-queue.js'

/** One waiting message, without the image payloads. */
export interface QueuedTurnSummary {
  id: string
  message: string
  /** Number of attached images; the data itself is never exposed here. */
  images: number
  queuedAt: number
}

export interface TurnQueueView {
  runId: string
  queued: QueuedTurnSummary[]
  running: string | null
  uncertain: string[]
  paused: boolean
}

/** Longest accepted queued message, in characters (the same as a live send). */
export const MAX_QUEUED_MESSAGE_LENGTH = 32_000
/** Longest accepted `runId`. */
export const MAX_QUEUED_RUN_ID_LENGTH = 128
/** Longest accepted queued-turn id (a client-generated UUID is far shorter). */
export const MAX_QUEUED_TURN_ID_LENGTH = 256

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** Shared failure branch of every parser below. */
export type ParseFailure = { ok: false; status: number; error: string }

/**
 * A view of one session's queue. An unknown run id is not an error: the GUI
 * polls ids it has not seen yet (a fresh chat, an archived one), and a stale
 * link must render as "nothing queued" instead of a failed request.
 */
export function turnQueueView(state: TurnQueueState, runId: string): TurnQueueView {
  const turns = state.sessions[runId] ?? []
  return {
    runId,
    queued: turns.map((turn) => ({
      id: turn.id,
      message: turn.message,
      images: turn.images.length,
      queuedAt: turn.queuedAt,
    })),
    running: state.running[runId] ?? null,
    uncertain: [...(state.uncertain[runId] ?? [])],
    paused: state.paused.includes(runId),
  }
}

function asRecord(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  return body as Record<string, unknown>
}

function parseRunId(raw: unknown): { runId: string } | ParseFailure {
  if (typeof raw !== 'string') return { ok: false, status: 400, error: 'runId must be a string' }
  if (raw.length === 0) return { ok: false, status: 400, error: 'runId is required' }
  if (raw.length > MAX_QUEUED_RUN_ID_LENGTH) {
    return { ok: false, status: 400, error: `runId must be at most ${MAX_QUEUED_RUN_ID_LENGTH} characters` }
  }
  if (!RUN_ID_PATTERN.test(raw)) {
    return { ok: false, status: 400, error: 'runId may only contain letters, digits, dot, underscore and dash' }
  }
  return { runId: raw }
}

function parseTurnId(raw: unknown): { id: string } | ParseFailure {
  if (typeof raw !== 'string') return { ok: false, status: 400, error: 'id must be a string' }
  if (raw.length === 0) return { ok: false, status: 400, error: 'id is required' }
  if (raw.length > MAX_QUEUED_TURN_ID_LENGTH) {
    return { ok: false, status: 400, error: `id must be at most ${MAX_QUEUED_TURN_ID_LENGTH} characters` }
  }
  return { id: raw }
}

function parseMessage(raw: unknown): { message: string } | ParseFailure {
  if (typeof raw !== 'string') return { ok: false, status: 400, error: 'message must be a string' }
  if (!raw.trim()) return { ok: false, status: 400, error: 'message is required' }
  if (raw.length > MAX_QUEUED_MESSAGE_LENGTH) {
    return { ok: false, status: 400, error: `message must be at most ${MAX_QUEUED_MESSAGE_LENGTH} characters` }
  }
  return { message: raw }
}

/**
 * Images are optional, but an attached image that cannot be replayed is
 * rejected rather than dropped: the user would otherwise send a message that
 * silently loses its attachment. The cap is the queued-turn cap, not a new
 * number, so the live and queued paths cannot drift apart.
 */
function parseImages(raw: unknown): { images: QueuedImage[] } | ParseFailure {
  if (raw === undefined || raw === null) return { images: [] }
  if (!Array.isArray(raw)) return { ok: false, status: 400, error: 'images must be an array' }
  if (raw.length > MAX_QUEUED_IMAGES_PER_TURN) {
    return { ok: false, status: 400, error: `at most ${MAX_QUEUED_IMAGES_PER_TURN} images per message` }
  }
  const images: QueuedImage[] = []
  for (const item of raw) {
    const record = asRecord(item)
    if (!record) return { ok: false, status: 400, error: 'each image must be an object' }
    if (typeof record.mimeType !== 'string' || !record.mimeType.startsWith('image/')) {
      return { ok: false, status: 400, error: 'only images can be attached' }
    }
    if (typeof record.data !== 'string' || record.data.length === 0) {
      return { ok: false, status: 400, error: 'each image needs base64 data' }
    }
    images.push({ mimeType: record.mimeType, data: record.data })
  }
  return { images }
}

/**
 * Validates a request to reserve a turn. It does not enqueue anything: the
 * caller applies `enqueueTurn`, so the queue state keeps a single owner.
 */
export function parseEnqueueRequest(
  body: unknown,
): { ok: true; request: { runId: string; turn: QueuedTurn } } | ParseFailure {
  const record = asRecord(body)
  if (!record) return { ok: false, status: 400, error: 'body must be a JSON object' }
  const runId = parseRunId(record.runId)
  if (!('runId' in runId)) return runId
  const id = parseTurnId(record.id)
  if (!('id' in id)) return id
  const message = parseMessage(record.message)
  if (!('message' in message)) return message
  const images = parseImages(record.images)
  if (!('images' in images)) return images
  return {
    ok: true,
    request: {
      runId: runId.runId,
      // `queuedAt` from the client is ignored on purpose: the server clock is
      // the only one that orders turns across tabs and restarts.
      turn: { id: id.id, message: message.message, images: images.images, queuedAt: Date.now() },
    },
  }
}

/** Validates `{ runId }` (resume, and the GET query parameter). */
export function parseRunIdRequest(body: unknown): { ok: true; runId: string } | ParseFailure {
  const record = asRecord(body)
  if (!record) return { ok: false, status: 400, error: 'body must be a JSON object' }
  const runId = parseRunId(record.runId)
  if (!('runId' in runId)) return runId
  return { ok: true, runId: runId.runId }
}

/** Validates `{ runId, id? }`: a missing `id` cancels every waiting turn. */
export function parseCancelRequest(body: unknown): { ok: true; runId: string; id?: string } | ParseFailure {
  const record = asRecord(body)
  if (!record) return { ok: false, status: 400, error: 'body must be a JSON object' }
  const runId = parseRunId(record.runId)
  if (!('runId' in runId)) return runId
  if (record.id === undefined) return { ok: true, runId: runId.runId }
  const id = parseTurnId(record.id)
  if (!('id' in id)) return id
  return { ok: true, runId: runId.runId, id: id.id }
}

/** Validates `{ runId, id, decision }` for a turn whose outcome is unknown. */
export function parseResolveRequest(
  body: unknown,
): { ok: true; runId: string; id: string; decision: 'resend' | 'discard' } | ParseFailure {
  const record = asRecord(body)
  if (!record) return { ok: false, status: 400, error: 'body must be a JSON object' }
  const runId = parseRunId(record.runId)
  if (!('runId' in runId)) return runId
  const id = parseTurnId(record.id)
  if (!('id' in id)) return id
  if (record.decision !== 'resend' && record.decision !== 'discard') {
    return { ok: false, status: 400, error: 'decision must be "resend" or "discard"' }
  }
  return { ok: true, runId: runId.runId, id: id.id, decision: record.decision }
}