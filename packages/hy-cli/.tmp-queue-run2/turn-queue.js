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
//  * An id is delivered at most once. `completed` records ids that already ran
//    and `running` records the one in flight, so a retried HTTP request (or a
//    resumed queue) cannot deliver the same message twice.
//  * A turn is removed from the FIFO only when the caller commits it after a
//    successful turn. `beginTurn` merely records the in-flight id, so a crash
//    in the middle of a turn leaves the message queued.
//  * A queue restored from disk is `paused`: a restart never resumes work on
//    its own, the user has to ask for it.
//  * Images are kept in full (base64) but bounded per image, per turn and per
//    queue.
import fs from 'node:fs';
import path from 'node:path';
export const EMPTY_TURN_QUEUE = {
    version: 1,
    sessions: {},
    running: {},
    completed: {},
    paused: [],
};
/** Turns one session may hold while its current turn runs. */
export const MAX_QUEUED_TURNS_PER_SESSION = 10;
/** Images one queued turn may carry (the same cap as a live message). */
export const MAX_QUEUED_IMAGES_PER_TURN = 8;
/** Bytes of one decoded image. */
export const MAX_QUEUED_IMAGE_BYTES = 8 * 1024 * 1024;
/** Bytes of the whole queue file. Exceeding it is an error, never a silent drop. */
export const MAX_QUEUE_FILE_BYTES = 32 * 1024 * 1024;
/** How many committed ids per session are remembered for de-duplication. */
export const MAX_COMPLETED_IDS_PER_SESSION = 50;
export function turnQueuePath(stateDir) {
    return path.join(stateDir, 'turn-queue.json');
}
function decodedBytes(image) {
    try {
        return Buffer.byteLength(image.data, 'base64');
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}
function sanitizeImage(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const image = raw;
    if (typeof image.mimeType !== 'string' || !image.mimeType.startsWith('image/'))
        return undefined;
    if (typeof image.data !== 'string' || image.data.length === 0)
        return undefined;
    const value = { mimeType: image.mimeType, data: image.data };
    return decodedBytes(value) <= MAX_QUEUED_IMAGE_BYTES ? value : undefined;
}
function sanitizeTurn(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const turn = raw;
    if (typeof turn.id !== 'string' || turn.id.trim().length === 0)
        return undefined;
    if (typeof turn.message !== 'string' || turn.message.trim().length === 0)
        return undefined;
    const images = Array.isArray(turn.images)
        ? turn.images
            .map(sanitizeImage)
            .filter((image) => image !== undefined)
            .slice(0, MAX_QUEUED_IMAGES_PER_TURN)
        : [];
    return {
        id: turn.id,
        message: turn.message,
        images,
        queuedAt: typeof turn.queuedAt === 'number' && Number.isFinite(turn.queuedAt) ? turn.queuedAt : Date.now(),
    };
}
function idList(raw) {
    if (!Array.isArray(raw))
        return [];
    const ids = raw.filter((id) => typeof id === 'string' && id.trim().length > 0);
    return [...new Set(ids)].slice(-MAX_COMPLETED_IDS_PER_SESSION);
}
function sanitizeState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { ...EMPTY_TURN_QUEUE };
    const parsed = raw;
    if (parsed.version !== 1)
        return { ...EMPTY_TURN_QUEUE };
    const sessions = {};
    if (parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)) {
        for (const [runId, turns] of Object.entries(parsed.sessions)) {
            if (!runId || !Array.isArray(turns))
                continue;
            const kept = turns
                .map(sanitizeTurn)
                .filter((turn) => turn !== undefined)
                .slice(0, MAX_QUEUED_TURNS_PER_SESSION);
            if (kept.length > 0)
                sessions[runId] = kept;
        }
    }
    const completed = {};
    if (parsed.completed && typeof parsed.completed === 'object' && !Array.isArray(parsed.completed)) {
        for (const [runId, ids] of Object.entries(parsed.completed)) {
            const kept = idList(ids);
            if (runId && kept.length > 0)
                completed[runId] = kept;
        }
    }
    // `running` is deliberately not restored: the process that was running it is
    // gone. The id stays in `sessions` (it is only removed on commit), so the
    // message is still there and the session is paused until the user resumes.
    return { version: 1, sessions, running: {}, completed, paused: [] };
}
/**
 * Reads the queue. Every session that still has turns is marked `paused`, so a
 * restarted server never runs queued work before the user asks for it. A
 * missing, unreadable or malformed file yields an empty queue rather than an
 * error: a broken queue must not stop the GUI from starting.
 */
export function loadTurnQueue(file) {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return { ...EMPTY_TURN_QUEUE, sessions: {}, running: {}, completed: {}, paused: [] };
    }
    const state = sanitizeState(raw);
    const paused = Object.keys(state.sessions).sort();
    return { ...state, paused };
}
function serialize(state) {
    return `${JSON.stringify(state, null, 2)}\n`;
}
/** Bytes the given state would occupy on disk. Pure; used before writing. */
export function serializedQueueBytes(state) {
    return Buffer.byteLength(serialize(state), 'utf8');
}
/**
 * Writes the queue atomically. The state is never modified and nothing is
 * dropped: when the serialized form would exceed `MAX_QUEUE_FILE_BYTES` the
 * call throws *before* creating the temporary file, so the queue on disk is
 * exactly what it was and the caller still holds its own copy.
 */
export function saveTurnQueue(file, state) {
    const body = serialize(state);
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > MAX_QUEUE_FILE_BYTES) {
        throw new Error(`the queued turns need ${bytes} bytes, over the ${MAX_QUEUE_FILE_BYTES} byte limit; nothing was saved`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
}
/** True when this id already ran or is currently running for the session. */
export function isTurnSeen(state, runId, id) {
    if (state.running[runId] === id)
        return true;
    return (state.completed[runId] ?? []).includes(id);
}
/**
 * Appends a turn to one session's FIFO. An id that already ran, is running, or
 * is still queued is rejected rather than duplicated, so a retried request
 * cannot deliver the same message twice. The state is never mutated, and a
 * turn that would push the file over the size cap is rejected here instead of
 * being dropped later.
 */
export function enqueueTurn(state, runId, turn) {
    if (!runId)
        return { ok: false, error: 'runId is required' };
    if (!turn.id.trim())
        return { ok: false, error: 'turn id is required' };
    // The live endpoint also requires text: images alone are not a message.
    if (!turn.message.trim())
        return { ok: false, error: 'message is required' };
    if (turn.images.length > MAX_QUEUED_IMAGES_PER_TURN) {
        return { ok: false, error: `at most ${MAX_QUEUED_IMAGES_PER_TURN} images per message` };
    }
    for (const image of turn.images) {
        if (!image.mimeType.startsWith('image/'))
            return { ok: false, error: 'only images can be attached' };
        if (decodedBytes(image) > MAX_QUEUED_IMAGE_BYTES) {
            return { ok: false, error: `each image must be at most ${MAX_QUEUED_IMAGE_BYTES} bytes` };
        }
    }
    const turns = state.sessions[runId] ?? [];
    if (isTurnSeen(state, runId, turn.id) || turns.some((queued) => queued.id === turn.id)) {
        return { ok: false, error: 'this message was already sent' };
    }
    if (turns.length >= MAX_QUEUED_TURNS_PER_SESSION) {
        return { ok: false, error: `at most ${MAX_QUEUED_TURNS_PER_SESSION} queued messages per chat` };
    }
    const next = {
        version: 1,
        sessions: { ...state.sessions, [runId]: [...turns, turn] },
        running: state.running,
        completed: state.completed,
        paused: state.paused,
    };
    if (serializedQueueBytes(next) > MAX_QUEUE_FILE_BYTES) {
        return { ok: false, error: 'the queue is full; wait for the running turn to finish' };
    }
    return { ok: true, state: next };
}
/**
 * Returns the next turn for a session without removing it. A paused session
 * keeps everything: after a restart the user has to resume explicitly.
 */
export function peekNextTurn(state, runId) {
    if (state.paused.includes(runId))
        return undefined;
    if (state.running[runId] !== undefined)
        return undefined;
    return (state.sessions[runId] ?? [])[0];
}
/**
 * Records that `id` is now running. The turn stays in the FIFO, so a crash
 * before `commitTurn` leaves the user's message queued instead of losing it.
 */
export function beginTurn(state, runId, id) {
    if (state.running[runId] === id)
        return state;
    return { version: 1, sessions: state.sessions, running: { ...state.running, [runId]: id }, completed: state.completed, paused: state.paused };
}
/**
 * Removes a turn that finished successfully and remembers its id so a resend
 * is rejected. This is the only place a queued turn leaves the FIFO.
 */
export function commitTurn(state, runId, id) {
    const turns = (state.sessions[runId] ?? []).filter((turn) => turn.id !== id);
    const sessions = { ...state.sessions };
    if (turns.length > 0)
        sessions[runId] = turns;
    else
        delete sessions[runId];
    const running = { ...state.running };
    if (running[runId] === id)
        delete running[runId];
    const completed = {
        ...state.completed,
        [runId]: [...new Set([...(state.completed[runId] ?? []), id])].slice(-MAX_COMPLETED_IDS_PER_SESSION),
    };
    return { version: 1, sessions, running, completed, paused: state.paused.filter((paused) => paused !== runId || turns.length > 0) };
}
/**
 * Clears the in-flight marker after a failure, cancellation or crash-like
 * error. The queued turn is kept: the user decides whether to resend it.
 */
export function releaseTurn(state, runId) {
    if (state.running[runId] === undefined)
        return state;
    const running = { ...state.running };
    delete running[runId];
    return { version: 1, sessions: state.sessions, running, completed: state.completed, paused: state.paused };
}
/** Drops queued turns (one session, or all of them). */
export function clearQueuedTurns(state, runId) {
    if (runId === undefined)
        return { version: 1, sessions: {}, running: {}, completed: {}, paused: [] };
    const sessions = { ...state.sessions };
    delete sessions[runId];
    const running = { ...state.running };
    delete running[runId];
    return { version: 1, sessions, running, completed: state.completed, paused: state.paused.filter((id) => id !== runId) };
}
/** Lets a restored session run its queued turns again (explicit user action). */
export function resumeSession(state, runId) {
    if (!state.paused.includes(runId))
        return state;
    return { version: 1, sessions: state.sessions, running: state.running, completed: state.completed, paused: state.paused.filter((id) => id !== runId) };
}
export function isPaused(state, runId) {
    return state.paused.includes(runId);
}
export function queuedTurnCount(state, runId) {
    return (state.sessions[runId] ?? []).length;
}
