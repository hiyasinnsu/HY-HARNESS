// A durable, per-session FIFO of turns the user sent while a turn was running.
//
// The queue lives next to `ui-state.json` in the state directory and is written
// atomically. Everything here is pure except `loadTurnQueue` / `saveTurnQueue`,
// so the web server can decide *when* to run the next turn (only after the
// previous one completed and `busy` went back to false) while the queue itself
// stays testable without a server.
//
// Safety rules encoded here:
//  * an id can be enqueued only once, so a retried HTTP request cannot deliver
//    the same turn twice;
//  * a queue restored from disk is `paused`: a restart never resumes work on
//    its own, the user has to ask for it;
//  * images are kept in full (base64) but bounded, and the whole file is
//    pruned instead of growing without limit.
import fs from 'node:fs';
import path from 'node:path';
export const EMPTY_TURN_QUEUE = { version: 1, sessions: {}, paused: [] };
/** Turns one session may hold while its current turn runs. */
export const MAX_QUEUED_TURNS_PER_SESSION = 10;
/** Images one queued turn may carry (the same cap as a live message). */
export const MAX_QUEUED_IMAGES_PER_TURN = 8;
/** Bytes of one decoded image. */
export const MAX_QUEUED_IMAGE_BYTES = 8 * 1024 * 1024;
/** Bytes of the whole queue file; older turns are dropped beyond this. */
export const MAX_QUEUE_FILE_BYTES = 32 * 1024 * 1024;
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
    return { version: 1, sessions, paused: [] };
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
        return { ...EMPTY_TURN_QUEUE };
    }
    const state = sanitizeState(raw);
    const paused = Object.keys(state.sessions).sort();
    return { ...state, paused };
}
function totalTurns(state) {
    const all = [];
    for (const [runId, turns] of Object.entries(state.sessions)) {
        for (const turn of turns)
            all.push({ runId, turn });
    }
    return all.sort((a, b) => a.turn.queuedAt - b.turn.queuedAt);
}
function withoutTurn(state, runId, id) {
    const turns = (state.sessions[runId] ?? []).filter((turn) => turn.id !== id);
    const sessions = { ...state.sessions };
    if (turns.length > 0)
        sessions[runId] = turns;
    else
        delete sessions[runId];
    return { version: 1, sessions, paused: state.paused };
}
/**
 * Writes the queue atomically. When the serialized file would exceed
 * `MAX_QUEUE_FILE_BYTES`, the oldest turns are dropped first; a single turn
 * that is too large on its own is an error, so the caller can answer 413
 * instead of silently losing the user's message.
 */
export function saveTurnQueue(file, state) {
    let current = state;
    let body = `${JSON.stringify(current, null, 2)}\n`;
    while (Buffer.byteLength(body, 'utf8') > MAX_QUEUE_FILE_BYTES) {
        const oldest = totalTurns(current)[0];
        if (!oldest)
            break;
        current = withoutTurn(current, oldest.runId, oldest.turn.id);
        body = `${JSON.stringify(current, null, 2)}\n`;
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_QUEUE_FILE_BYTES) {
        throw new Error('the queued turn is too large to persist');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
}
/**
 * Appends a turn to one session's FIFO. An id that is already queued (or that
 * already ran, as tracked by the caller) is rejected rather than duplicated, so
 * a retried request cannot deliver the same message twice.
 */
export function enqueueTurn(state, runId, turn, seen = new Set()) {
    if (!runId)
        return { ok: false, error: 'runId is required' };
    if (!turn.id.trim())
        return { ok: false, error: 'turn id is required' };
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
    if (seen.has(turn.id) || turns.some((queued) => queued.id === turn.id)) {
        return { ok: false, error: 'this message was already sent' };
    }
    if (turns.length >= MAX_QUEUED_TURNS_PER_SESSION) {
        return { ok: false, error: `at most ${MAX_QUEUED_TURNS_PER_SESSION} queued messages per chat` };
    }
    return {
        ok: true,
        state: {
            version: 1,
            sessions: { ...state.sessions, [runId]: [...turns, turn] },
            paused: state.paused,
        },
    };
}
/**
 * Removes and returns the next turn for a session. Paused sessions keep their
 * turns: a restart must wait for the user. The caller runs the turn and then
 * calls this again only after `busy` is false and the outcome was `completed`.
 */
export function takeNextTurn(state, runId) {
    if (state.paused.includes(runId))
        return { state, turn: undefined };
    const turns = state.sessions[runId] ?? [];
    const [turn, ...rest] = turns;
    if (!turn)
        return { state, turn: undefined };
    const sessions = { ...state.sessions };
    if (rest.length > 0)
        sessions[runId] = rest;
    else
        delete sessions[runId];
    return { state: { version: 1, sessions, paused: state.paused }, turn };
}
/** Drops queued turns (one session, or all of them). */
export function clearQueuedTurns(state, runId) {
    if (runId === undefined)
        return { version: 1, sessions: {}, paused: [] };
    const sessions = { ...state.sessions };
    delete sessions[runId];
    return { version: 1, sessions, paused: state.paused.filter((id) => id !== runId) };
}
/** Lets a restored session run its queued turns again (explicit user action). */
export function resumeSession(state, runId) {
    if (!state.paused.includes(runId))
        return state;
    return { version: 1, sessions: state.sessions, paused: state.paused.filter((id) => id !== runId) };
}
export function isPaused(state, runId) {
    return state.paused.includes(runId);
}
export function queuedTurnCount(state, runId) {
    return (state.sessions[runId] ?? []).length;
}
