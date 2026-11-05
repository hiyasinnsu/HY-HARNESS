// A durable, per-session FIFO of turns the user sent while a turn was running.
//
// The queue lives next to `ui-state.json` in the state directory and is written
// atomically. Everything here is pure except `loadTurnQueue` / `saveTurnQueue`,
// so the web server decides *when* to run the next turn (only after the
// previous one completed and `busy` went back to false) while the queue itself
// stays testable without a server.
//
// Safety rules encoded here:
//  * Nothing is ever dropped silently. A save that would exceed the size cap
//    fails without touching the existing file, and without mutating the state
//    the caller holds; the caller turns that into a 4xx and the user keeps
//    their message.
//  * A turn leaves the FIFO only on `commitTurn`, after a turn that actually
//    completed. `beginTurn` records the in-flight id but keeps the message
//    queued, so a crash in the middle of a turn never loses it.
//  * A turn that was in flight when the process died becomes `uncertain`: the
//    process cannot know whether the agent's side effects already happened, so
//    it is never resent automatically. Only an explicit user decision
//    (`resolveUncertain`) resends or discards it.
//  * A failed or cancelled turn (`releaseTurn`) pauses its session. The user
//    resumes it; nothing restarts on its own. `beginTurn` refuses a paused
//    session, so the rule is enforced here and not only by the caller.
//  * A queue restored from disk is `paused`: a restart never resumes work on
//    its own.
//  * De-duplication covers queued, running, uncertain and the most recent
//    `MAX_COMPLETED_IDS_PER_SESSION` committed ids per session. Beyond that
//    window an old id is forgotten — the guarantee is bounded, not absolute.
//  * Images are kept in full (base64) but bounded per image, per turn and per
//    queue.

import fs from 'node:fs'
import path from 'node:path'

export interface QueuedImage {
  mimeType: string
  /** Base64 payload, exactly as the browser sent it. */
  data: string
}

export interface QueuedTurn {
  /** Client-provided id; also the de-duplication key. */
  id: string
  message: string
  images: QueuedImage[]
  queuedAt: number
}

export interface TurnQueueState {
  version: 1
  /** runId -> FIFO of turns still waiting for that session. */
  sessions: Record<string, QueuedTurn[]>
  /** runId -> id of the turn that is running right now. */
  running: Record<string, string>
  /**
   * runId -> ids that were running when a previous process died. Their outcome
   * is unknown, so they are never resent without an explicit user decision.
   */
  uncertain: Record<string, string[]>
  /** runId -> ids that already completed (bounded window). */
  completed: Record<string, string[]>
  /** Sessions that must not start a turn until the user resumes them. */
  paused: string[]
}

export const EMPTY_TURN_QUEUE: TurnQueueState = {
  version: 1,
  sessions: {},
  running: {},
  uncertain: {},
  completed: {},
  paused: [],
}

/** Turns one session may hold while its current turn runs. */
export const MAX_QUEUED_TURNS_PER_SESSION = 10
/** Images one queued turn may carry (the same cap as a live message). */
export const MAX_QUEUED_IMAGES_PER_TURN = 8
/** Bytes of one decoded image. */
export const MAX_QUEUED_IMAGE_BYTES = 8 * 1024 * 1024
/** Bytes of the whole queue file. Exceeding it is an error, never a silent drop. */
export const MAX_QUEUE_FILE_BYTES = 32 * 1024 * 1024
/** How many committed ids per session are remembered for de-duplication. */
export const MAX_COMPLETED_IDS_PER_SESSION = 50

export function turnQueuePath(stateDir: string): string {
  return path.join(stateDir, 'turn-queue.json')
}

function emptyQueue(): TurnQueueState {
  return { version: 1, sessions: {}, running: {}, uncertain: {}, completed: {}, paused: [] }
}

function decodedBytes(image: QueuedImage): number {
  try {
    return Buffer.byteLength(image.data, 'base64')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function sanitizeImage(raw: unknown): QueuedImage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const image = raw as { mimeType?: unknown; data?: unknown }
  if (typeof image.mimeType !== 'string' || !image.mimeType.startsWith('image/')) return undefined
  if (typeof image.data !== 'string' || image.data.length === 0) return undefined
  const value: QueuedImage = { mimeType: image.mimeType, data: image.data }
  return decodedBytes(value) <= MAX_QUEUED_IMAGE_BYTES ? value : undefined
}

function sanitizeTurn(raw: unknown): QueuedTurn | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const turn = raw as { id?: unknown; message?: unknown; images?: unknown; queuedAt?: unknown }
  if (typeof turn.id !== 'string' || turn.id.trim().length === 0) return undefined
  if (typeof turn.message !== 'string' || turn.message.trim().length === 0) return undefined
  const images = Array.isArray(turn.images)
    ? turn.images
        .map(sanitizeImage)
        .filter((image): image is QueuedImage => image !== undefined)
        .slice(0, MAX_QUEUED_IMAGES_PER_TURN)
    : []
  return {
    id: turn.id,
    message: turn.message,
    images,
    queuedAt: typeof turn.queuedAt === 'number' && Number.isFinite(turn.queuedAt) ? turn.queuedAt : Date.now(),
  }
}

function idList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const ids = raw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
  return [...new Set(ids)].slice(-MAX_COMPLETED_IDS_PER_SESSION)
}

function idRecord(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [runId, ids] of Object.entries(raw as Record<string, unknown>)) {
    const kept = idList(ids)
    if (runId && kept.length > 0) out[runId] = kept
  }
  return out
}

/**
 * Rebuilds a state from a parsed file. `running` is intentionally *not*
 * restored as running: the process that owned it is gone. Those ids move to
 * `uncertain`, which keeps them queued and blocked until the user decides.
 */
function sanitizeState(raw: unknown): TurnQueueState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyQueue()
  const parsed = raw as { version?: unknown; sessions?: unknown; running?: unknown; uncertain?: unknown; completed?: unknown }
  if (parsed.version !== 1) return emptyQueue()
  const sessions: Record<string, QueuedTurn[]> = {}
  if (parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)) {
    for (const [runId, turns] of Object.entries(parsed.sessions as Record<string, unknown>)) {
      if (!runId || !Array.isArray(turns)) continue
      const kept = turns
        .map(sanitizeTurn)
        .filter((turn): turn is QueuedTurn => turn !== undefined)
        .slice(0, MAX_QUEUED_TURNS_PER_SESSION)
      if (kept.length > 0) sessions[runId] = kept
    }
  }
  const uncertain = idRecord(parsed.uncertain)
  if (parsed.running && typeof parsed.running === 'object' && !Array.isArray(parsed.running)) {
    for (const [runId, id] of Object.entries(parsed.running as Record<string, unknown>)) {
      if (!runId || typeof id !== 'string' || !id.trim()) continue
      uncertain[runId] = [...new Set([...(uncertain[runId] ?? []), id])]
    }
  }
  return {
    version: 1,
    sessions,
    running: {},
    uncertain,
    completed: idRecord(parsed.completed),
    paused: [],
  }
}

/**
 * Reads the queue. Every session that still has turns, and every session with
 * an uncertain turn, is marked `paused`, so a restarted server never runs
 * queued work before the user asks for it. A missing, unreadable or malformed
 * file yields an empty queue rather than an error: a broken queue must not
 * stop the GUI from starting.
 */
export function loadTurnQueue(file: string): TurnQueueState {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  } catch {
    return emptyQueue()
  }
  const state = sanitizeState(raw)
  const paused = [...new Set([...Object.keys(state.sessions), ...Object.keys(state.uncertain)])].sort()
  return { ...state, paused }
}

function serialize(state: TurnQueueState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

/** Bytes the given state would occupy on disk. Pure; used before writing. */
export function serializedQueueBytes(state: TurnQueueState): number {
  return Buffer.byteLength(serialize(state), 'utf8')
}

/**
 * Writes the queue atomically. The state is never modified and nothing is
 * dropped: when the serialized form would exceed `MAX_QUEUE_FILE_BYTES` the
 * call throws *before* creating the temporary file, so the queue on disk is
 * exactly what it was and the caller still holds its own copy.
 */
export function saveTurnQueue(file: string, state: TurnQueueState): void {
  const body = serialize(state)
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_QUEUE_FILE_BYTES) {
    throw new Error(`the queued turns need ${bytes} bytes, over the ${MAX_QUEUE_FILE_BYTES} byte limit; nothing was saved`)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, body, 'utf8')
  fs.renameSync(tmp, file)
}

export type EnqueueResult = { ok: true; state: TurnQueueState } | { ok: false; error: string }

/** True when this id is queued, running, uncertain or recently completed. */
export function isTurnSeen(state: TurnQueueState, runId: string, id: string): boolean {
  if (state.running[runId] === id) return true
  if ((state.uncertain[runId] ?? []).includes(id)) return true
  if ((state.completed[runId] ?? []).includes(id)) return true
  return (state.sessions[runId] ?? []).some((queued) => queued.id === id)
}

/**
 * Appends a turn to one session's FIFO. An id that already ran, is running, is
 * uncertain, or is still queued is rejected rather than duplicated. The state
 * is never mutated, and a turn that would push the file over the size cap is
 * rejected here instead of being dropped later.
 */
export function enqueueTurn(state: TurnQueueState, runId: string, turn: QueuedTurn): EnqueueResult {
  if (!runId) return { ok: false, error: 'runId is required' }
  if (!turn.id.trim()) return { ok: false, error: 'turn id is required' }
  // The live endpoint also requires text: images alone are not a message.
  if (!turn.message.trim()) return { ok: false, error: 'message is required' }
  if (turn.images.length > MAX_QUEUED_IMAGES_PER_TURN) {
    return { ok: false, error: `at most ${MAX_QUEUED_IMAGES_PER_TURN} images per message` }
  }
  for (const image of turn.images) {
    if (!image.mimeType.startsWith('image/')) return { ok: false, error: 'only images can be attached' }
    if (decodedBytes(image) > MAX_QUEUED_IMAGE_BYTES) {
      return { ok: false, error: `each image must be at most ${MAX_QUEUED_IMAGE_BYTES} bytes` }
    }
  }
  if (isTurnSeen(state, runId, turn.id)) return { ok: false, error: 'this message was already sent' }
  const turns = state.sessions[runId] ?? []
  if (turns.length >= MAX_QUEUED_TURNS_PER_SESSION) {
    return { ok: false, error: `at most ${MAX_QUEUED_TURNS_PER_SESSION} queued messages per chat` }
  }
  const next: TurnQueueState = {
    ...state,
    sessions: { ...state.sessions, [runId]: [...turns, turn] },
  }
  if (serializedQueueBytes(next) > MAX_QUEUE_FILE_BYTES) {
    return { ok: false, error: 'the queue is full; wait for the running turn to finish' }
  }
  return { ok: true, state: next }
}

/**
 * Returns the next turn a session may start, without removing it.
 *
 * Nothing is returned when the session is paused, when a turn is already
 * running, or when the head of the FIFO is an uncertain turn left over from a
 * crashed process. The caller must not work around any of those cases.
 */
export function peekNextTurn(state: TurnQueueState, runId: string): QueuedTurn | undefined {
  if (state.paused.includes(runId)) return undefined
  if (state.running[runId] !== undefined) return undefined
  const head = (state.sessions[runId] ?? [])[0]
  if (!head) return undefined
  if ((state.uncertain[runId] ?? []).includes(head.id)) return undefined
  return head
}

/**
 * Records that `id` is now running. Only the head of that session's FIFO may
 * start, only when nothing else is running for it, and only when the session
 * is not paused (a failed, cancelled or restored turn waits for the user).
 * Anything else is a programming error in the caller and throws instead of
 * corrupting the queue. The message stays queued so a crash cannot lose it.
 */
export function beginTurn(state: TurnQueueState, runId: string, id: string): TurnQueueState {
  if (state.paused.includes(runId)) {
    throw new Error(`session ${runId} is paused; resume it before starting a turn`)
  }
  if (state.running[runId] !== undefined) {
    throw new Error(`a turn is already running for ${runId}`)
  }
  const head = (state.sessions[runId] ?? [])[0]
  if (!head) throw new Error(`no queued turn for ${runId}`)
  if (head.id !== id) throw new Error(`only the first queued turn can start (${head.id}, not ${id})`)
  if ((state.uncertain[runId] ?? []).includes(id)) {
    throw new Error(`turn ${id} has an unknown outcome; resolve it before running it again`)
  }
  return { ...state, running: { ...state.running, [runId]: id } }
}

/**
 * Removes a turn that finished successfully, remembers its id so a resend is
 * rejected, and clears the pause. This is the only place a queued turn leaves
 * the FIFO on success. The turn must be the one recorded as running for that
 * session; anything else throws and leaves the state untouched, so a late
 * completion cannot drop another reservation.
 */
export function commitTurn(state: TurnQueueState, runId: string, id: string): TurnQueueState {
  // Only the turn that is actually running may be committed. Otherwise a late
  // or duplicated completion would silently drop a different reservation.
  if (state.running[runId] !== id) {
    throw new Error(`turn ${id} is not the running turn for ${runId}`)
  }
  const turns = (state.sessions[runId] ?? []).filter((turn) => turn.id !== id)
  const sessions = { ...state.sessions }
  if (turns.length > 0) sessions[runId] = turns
  else delete sessions[runId]
  const running = { ...state.running }
  if (running[runId] === id) delete running[runId]
  const uncertain = { ...state.uncertain }
  const remainingUncertain = (uncertain[runId] ?? []).filter((queued) => queued !== id)
  if (remainingUncertain.length > 0) uncertain[runId] = remainingUncertain
  else delete uncertain[runId]
  const completed = {
    ...state.completed,
    [runId]: [...new Set([...(state.completed[runId] ?? []), id])].slice(-MAX_COMPLETED_IDS_PER_SESSION),
  }
  return { ...state, sessions, running, uncertain, completed, paused: state.paused.filter((paused) => paused !== runId) }
}

/**
 * Clears the in-flight marker after a failure, cancellation or crash-like
 * error, and pauses the session: the queued turn stays, but nothing runs it
 * again until the user resumes. This is deliberate — a failed turn may have
 * had side effects, and the user decides whether to retry.
 */
export function releaseTurn(state: TurnQueueState, runId: string): TurnQueueState {
  const running = { ...state.running }
  delete running[runId]
  const paused = state.paused.includes(runId) ? state.paused : [...state.paused, runId]
  return { ...state, running, paused }
}

export type UncertainDecision = 'resend' | 'discard'

/**
 * Resolves a turn whose outcome is unknown (it was running when a previous
 * process died). `resend` unblocks it so the user's next resume may run it;
 * `discard` removes it and remembers the id so it is never queued again. The
 * call is explicit on purpose: nothing decides this automatically.
 */
export function resolveUncertain(state: TurnQueueState, runId: string, id: string, decision: UncertainDecision): TurnQueueState {
  const uncertainIds = state.uncertain[runId] ?? []
  if (!uncertainIds.includes(id)) {
    throw new Error(`turn ${id} is not uncertain for ${runId}`)
  }
  const uncertain = { ...state.uncertain }
  const remaining = uncertainIds.filter((queued) => queued !== id)
  if (remaining.length > 0) uncertain[runId] = remaining
  else delete uncertain[runId]

  if (decision === 'resend') {
    // Keep the message queued; unpause so an explicit resume can start it.
    const paused = state.paused.filter((pausedId) => pausedId !== runId || remaining.length > 0)
    return { ...state, uncertain, paused }
  }

  const turns = (state.sessions[runId] ?? []).filter((turn) => turn.id !== id)
  const sessions = { ...state.sessions }
  if (turns.length > 0) sessions[runId] = turns
  else delete sessions[runId]
  const completed = {
    ...state.completed,
    [runId]: [...new Set([...(state.completed[runId] ?? []), id])].slice(-MAX_COMPLETED_IDS_PER_SESSION),
  }
  const paused = state.paused.filter((pausedId) => pausedId !== runId || remaining.length > 0 || turns.length > 0)
  return { ...state, sessions, uncertain, completed, paused }
}

/**
 * Drops queued turns (one session, or all of them).
 *
 * A turn that is running is kept in the FIFO: it is not "waiting", and
 * dropping it would make its later commit silently lose the record. Clearing
 * one session is an explicit delete for that session, so its uncertain ids go
 * with it. A full clear keeps the `running` markers, the uncertain ids and the
 * completed history of every session: losing them would make a crash right
 * after the clear impossible to reconcile, and would let an id that already
 * finished be queued twice.
 */
export function clearQueuedTurns(state: TurnQueueState, runId?: string): TurnQueueState {
  if (runId === undefined) {
    // Same rule as the single-session clear, applied to every session: the
    // turn that is running stays in the FIFO with its `running` marker, while
    // waiting turns are dropped. `uncertain` and `completed` are never cleared
    // here; only resolving an uncertain turn removes it.
    const sessions: Record<string, QueuedTurn[]> = {}
    for (const [id, turns] of Object.entries(state.sessions)) {
      const runningId = state.running[id]
      const uncertainIds = state.uncertain[id] ?? []
      if (runningId === undefined && uncertainIds.length === 0) continue
      // The running turn and every uncertain turn stay: the first is in
      // flight, the others still need an explicit resend/discard decision.
      const kept = turns.filter((turn) => turn.id === runningId || uncertainIds.includes(turn.id))
      if (kept.length > 0) sessions[id] = kept
    }
    const paused = state.paused.filter((id) => sessions[id] !== undefined || state.uncertain[id] !== undefined)
    return {
      version: 1,
      sessions,
      running: { ...state.running },
      uncertain: { ...state.uncertain },
      completed: { ...state.completed },
      paused,
    }
  }
  const runningId = state.running[runId]
  const kept = runningId === undefined ? [] : (state.sessions[runId] ?? []).filter((turn) => turn.id === runningId)
  const sessions = { ...state.sessions }
  if (kept.length > 0) sessions[runId] = kept
  else delete sessions[runId]
  const uncertain = { ...state.uncertain }
  delete uncertain[runId]
  const paused = state.paused.filter((id) => id !== runId || kept.length > 0)
  return { ...state, sessions, uncertain, paused }
}

/** Lets a paused session run its queued turns again (explicit user action). */
export function resumeSession(state: TurnQueueState, runId: string): TurnQueueState {
  if (!state.paused.includes(runId)) return state
  return { ...state, paused: state.paused.filter((id) => id !== runId) }
}

export function isPaused(state: TurnQueueState, runId: string): boolean {
  return state.paused.includes(runId)
}

export function isUncertain(state: TurnQueueState, runId: string, id: string): boolean {
  return (state.uncertain[runId] ?? []).includes(id)
}

export function queuedTurnCount(state: TurnQueueState, runId: string): number {
  return (state.sessions[runId] ?? []).length
}
