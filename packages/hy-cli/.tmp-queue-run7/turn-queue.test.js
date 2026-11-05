import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EMPTY_TURN_QUEUE, MAX_COMPLETED_IDS_PER_SESSION, MAX_QUEUED_IMAGES_PER_TURN, MAX_QUEUED_TURNS_PER_SESSION, MAX_QUEUE_FILE_BYTES, beginTurn, clearQueuedTurns, commitTurn, enqueueTurn, isPaused, isTurnSeen, isUncertain, loadTurnQueue, peekNextTurn, queuedTurnCount, releaseTurn, resolveUncertain, resumeSession, saveTurnQueue, serializedQueueBytes, } from './turn-queue.js';
function turn(id, message = `message ${id}`, images = []) {
    return { id, message, images, queuedAt: 1 };
}
function enqueueAll(state, runId, ids) {
    let next = state;
    for (const id of ids) {
        const result = enqueueTurn(next, runId, turn(id));
        assert.equal(result.ok, true);
        if (result.ok)
            next = result.state;
    }
    return next;
}
function tmpQueueFile(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, file: path.join(dir, 'turn-queue.json') };
}
test('turns of one session are delivered in the order they were queued', () => {
    let state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1', 't2', 't3']);
    assert.equal(queuedTurnCount(state, 'run-a'), 3);
    assert.equal(peekNextTurn(state, 'run-a')?.id, 't1');
    state = beginTurn(state, 'run-a', 't1');
    // Still queued while it runs: a crash here must not lose the message.
    assert.equal(queuedTurnCount(state, 'run-a'), 3);
    state = commitTurn(state, 'run-a', 't1');
    assert.equal(queuedTurnCount(state, 'run-a'), 2);
    assert.equal(peekNextTurn(state, 'run-a')?.id, 't2');
    state = commitTurn(beginTurn(state, 'run-a', 't2'), 'run-a', 't2');
    assert.equal(peekNextTurn(state, 'run-a')?.id, 't3');
    state = commitTurn(beginTurn(state, 'run-a', 't3'), 'run-a', 't3');
    assert.equal(queuedTurnCount(state, 'run-a'), 0);
    assert.equal(peekNextTurn(state, 'run-a'), undefined);
});
test('a session without queued turns does not borrow another session queue', () => {
    const state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1']);
    assert.equal(peekNextTurn(state, 'run-b'), undefined);
    assert.equal(queuedTurnCount(state, 'run-a'), 1, 'run-a keeps its turn');
});
test('an id is delivered at most once: queued, running and completed ids are rejected', () => {
    let state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1']);
    assert.equal(enqueueTurn(state, 'run-a', turn('t1')).ok, false, 'still queued');
    state = beginTurn(state, 'run-a', 't1');
    assert.equal(enqueueTurn(state, 'run-a', turn('t1')).ok, false, 'currently running');
    state = commitTurn(state, 'run-a', 't1');
    assert.equal(enqueueTurn(state, 'run-a', turn('t1')).ok, false, 'already ran');
    assert.equal(queuedTurnCount(state, 'run-a'), 0);
});
test('de-duplication is bounded by MAX_COMPLETED_IDS_PER_SESSION', () => {
    let state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1']);
    state = commitTurn(beginTurn(state, 'run-a', 't1'), 'run-a', 't1');
    for (let i = 0; i < MAX_COMPLETED_IDS_PER_SESSION; i += 1) {
        const id = `later-${i}`;
        const added = enqueueTurn(state, 'run-a', turn(id));
        assert.equal(added.ok, true);
        if (!added.ok)
            return;
        state = commitTurn(beginTurn(added.state, 'run-a', id), 'run-a', id);
    }
    // The window slid past t1, so the guarantee is explicitly bounded: t1 may
    // now be queued again. Documenting this keeps the promise honest.
    assert.equal(isTurnSeen(state, 'run-a', 't1'), false);
    assert.equal(enqueueTurn(state, 'run-a', turn('t1')).ok, true);
    assert.equal(isTurnSeen(state, 'run-a', `later-${MAX_COMPLETED_IDS_PER_SESSION - 1}`), true);
});
test('commitTurn refuses an id that is not the running turn and keeps every reservation', () => {
    const queued = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1', 't2']);
    const snapshot = JSON.stringify(queued);
    // Never started: nothing may be removed.
    assert.throws(() => commitTurn(queued, 'run-a', 't1'), /not the running turn/);
    assert.equal(JSON.stringify(queued), snapshot, 'the queued state is untouched');
    assert.equal(queuedTurnCount(queued, 'run-a'), 2);
    // A different id while t1 runs: t2 must keep its reservation.
    const running = beginTurn(queued, 'run-a', 't1');
    const runningSnapshot = JSON.stringify(running);
    assert.throws(() => commitTurn(running, 'run-a', 't2'), /not the running turn/);
    assert.throws(() => commitTurn(running, 'run-a', 'nope'), /not the running turn/);
    assert.equal(JSON.stringify(running), runningSnapshot, 'the running state is untouched');
    assert.equal(queuedTurnCount(running, 'run-a'), 2, 'no reservation was dropped');
    assert.equal(running.running['run-a'], 't1');
    // A session with nothing running rejects every id.
    assert.throws(() => commitTurn(EMPTY_TURN_QUEUE, 'run-a', 't1'), /not the running turn/);
    // The real running id still commits normally.
    const committed = commitTurn(running, 'run-a', 't1');
    assert.equal(queuedTurnCount(committed, 'run-a'), 1);
    assert.equal(committed.sessions['run-a']?.[0]?.id, 't2');
    assert.deepEqual(committed.running, {});
});
test('the per-session limit is enforced and rejects instead of dropping work', () => {
    const ids = Array.from({ length: MAX_QUEUED_TURNS_PER_SESSION }, (_, i) => `t${i}`);
    const full = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ids);
    assert.equal(queuedTurnCount(full, 'run-a'), MAX_QUEUED_TURNS_PER_SESSION);
    const overflow = enqueueTurn(full, 'run-a', turn('extra'));
    assert.equal(overflow.ok, false);
    assert.equal(queuedTurnCount(full, 'run-a'), MAX_QUEUED_TURNS_PER_SESSION);
});
test('a queued turn keeps its images, and an over-limit image set is rejected', () => {
    const image = { mimeType: 'image/png', data: Buffer.from('pixels').toString('base64') };
    const result = enqueueTurn(EMPTY_TURN_QUEUE, 'run-a', turn('t1', 'look', [image]));
    assert.equal(result.ok, true);
    if (!result.ok)
        return;
    assert.deepEqual(peekNextTurn(result.state, 'run-a')?.images, [image]);
    const tooMany = Array.from({ length: MAX_QUEUED_IMAGES_PER_TURN + 1 }, () => image);
    assert.equal(enqueueTurn(EMPTY_TURN_QUEUE, 'run-a', turn('t2', 'look', tooMany)).ok, false);
    const notAnImage = enqueueTurn(EMPTY_TURN_QUEUE, 'run-a', turn('t3', 'look', [{ mimeType: 'text/plain', data: 'eA==' }]));
    assert.equal(notAnImage.ok, false);
});
test('images alone are not a message, matching the live turn endpoint', () => {
    const image = { mimeType: 'image/png', data: Buffer.from('pixels').toString('base64') };
    assert.equal(enqueueTurn(EMPTY_TURN_QUEUE, 'run-a', turn('t1', '   ', [image])).ok, false);
});
test('beginTurn only accepts the head id and refuses a second concurrent turn', () => {
    const state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1', 't2']);
    assert.throws(() => beginTurn(state, 'run-a', 't2'), /only the first queued turn/);
    assert.throws(() => beginTurn(state, 'run-b', 't1'), /no queued turn/);
    assert.throws(() => beginTurn(EMPTY_TURN_QUEUE, 'run-a', 't1'), /no queued turn/);
    const running = beginTurn(state, 'run-a', 't1');
    assert.throws(() => beginTurn(running, 'run-a', 't1'), /already running/);
    assert.equal(peekNextTurn(running, 'run-a'), undefined, 'nothing new starts while one runs');
});
test('a queue restored from disk stays paused until the user resumes it', () => {
    const { dir, file } = tmpQueueFile('hy-turn-queue-');
    try {
        saveTurnQueue(file, enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1', 't2']));
        const restored = loadTurnQueue(file);
        assert.equal(queuedTurnCount(restored, 'run-a'), 2, 'nothing is lost by a restart');
        assert.equal(isPaused(restored, 'run-a'), true);
        assert.equal(peekNextTurn(restored, 'run-a'), undefined, 'a restart never runs queued work on its own');
        assert.throws(() => beginTurn(restored, 'run-a', 't1'), /paused/);
        const resumed = resumeSession(restored, 'run-a');
        assert.equal(isPaused(resumed, 'run-a'), false);
        assert.equal(peekNextTurn(resumed, 'run-a')?.id, 't1');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('a turn that was running when the process died becomes uncertain, not runnable', () => {
    const { dir, file } = tmpQueueFile('hy-turn-queue-crash-');
    try {
        let state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1', 't2']);
        state = beginTurn(state, 'run-a', 't1');
        saveTurnQueue(file, state);
        const restored = loadTurnQueue(file);
        assert.equal(queuedTurnCount(restored, 'run-a'), 2, 'the in-flight turn was not removed');
        assert.deepEqual(restored.running, {}, 'a dead process is not still running anything');
        assert.equal(isUncertain(restored, 'run-a', 't1'), true);
        assert.equal(isPaused(restored, 'run-a'), true);
        // Resuming alone is not enough: the uncertain head stays blocked.
        const resumed = resumeSession(restored, 'run-a');
        assert.equal(peekNextTurn(resumed, 'run-a'), undefined, 'an unknown outcome is never resent automatically');
        assert.throws(() => beginTurn(resumed, 'run-a', 't1'), /unknown outcome/);
        assert.equal(enqueueTurn(resumed, 'run-a', turn('t1')).ok, false, 'a resend of the same id is still rejected');
        // Explicit user decision: resend keeps the message and unblocks it.
        const resend = resolveUncertain(resumed, 'run-a', 't1', 'resend');
        assert.equal(isUncertain(resend, 'run-a', 't1'), false);
        assert.equal(peekNextTurn(resend, 'run-a')?.id, 't1');
        // Explicit user decision: discard removes it and remembers the id.
        const discard = resolveUncertain(resumed, 'run-a', 't1', 'discard');
        assert.equal(queuedTurnCount(discard, 'run-a'), 1, 'only the uncertain turn was removed');
        assert.equal(isTurnSeen(discard, 'run-a', 't1'), true, 'a discarded id is not queued again');
        assert.equal(peekNextTurn(discard, 'run-a')?.id, 't2');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('resolveUncertain rejects an id that is not uncertain', () => {
    const state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1']);
    assert.throws(() => resolveUncertain(state, 'run-a', 't1', 'resend'), /not uncertain/);
    assert.throws(() => resolveUncertain(state, 'run-b', 't1', 'discard'), /not uncertain/);
});
test('a failed or cancelled turn pauses the session and keeps the message queued', () => {
    let state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1']);
    state = beginTurn(state, 'run-a', 't1');
    const released = releaseTurn(state, 'run-a');
    assert.equal(queuedTurnCount(released, 'run-a'), 1, 'the message survives a failure');
    assert.deepEqual(released.running, {});
    assert.equal(isPaused(released, 'run-a'), true, 'a failure does not restart on its own');
    assert.equal(peekNextTurn(released, 'run-a'), undefined);
    assert.throws(() => beginTurn(released, 'run-a', 't1'), /paused/);
    // Only an explicit resume runs it again.
    const resumed = resumeSession(released, 'run-a');
    assert.equal(peekNextTurn(resumed, 'run-a')?.id, 't1');
    assert.equal(beginTurn(resumed, 'run-a', 't1').running['run-a'], 't1');
    // Releasing twice is harmless and stays paused.
    const twice = releaseTurn(released, 'run-a');
    assert.equal(isPaused(twice, 'run-a'), true);
    assert.equal(queuedTurnCount(twice, 'run-a'), 1);
});
test('clearing a session keeps the running turn and drops the rest', () => {
    let state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1', 't2', 't3']);
    state = beginTurn(state, 'run-a', 't1');
    const cleared = clearQueuedTurns(state, 'run-a');
    assert.equal(queuedTurnCount(cleared, 'run-a'), 1, 'the running turn is not dropped');
    assert.equal(cleared.sessions['run-a']?.[0]?.id, 't1');
    assert.equal(cleared.running['run-a'], 't1', 'its running marker survives');
    // Committing it afterwards still records the id.
    const committed = commitTurn(cleared, 'run-a', 't1');
    assert.equal(queuedTurnCount(committed, 'run-a'), 0);
    assert.equal(isTurnSeen(committed, 'run-a', 't1'), true);
});
test('clearing an idle session drops everything and unpauses it', () => {
    let state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1', 't2']);
    state = releaseTurn(state, 'run-a');
    assert.equal(isPaused(state, 'run-a'), true);
    const cleared = clearQueuedTurns(state, 'run-a');
    assert.equal(queuedTurnCount(cleared, 'run-a'), 0);
    assert.equal(isPaused(cleared, 'run-a'), false);
});
test('a full clear keeps running turns, uncertain ids and completed history', () => {
    let state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1', 't2']);
    state = enqueueAll(state, 'run-b', ['b1']);
    state = beginTurn(state, 'run-a', 't1');
    state = commitTurn(beginTurn(state, 'run-b', 'b1'), 'run-b', 'b1');
    state = enqueueAll(state, 'run-c', ['c1']);
    const crashed = { ...state, running: {}, uncertain: { 'run-c': ['c1'] }, paused: ['run-c'] };
    const cleared = clearQueuedTurns(crashed);
    assert.deepEqual(cleared.sessions['run-a']?.map((q) => q.id), ['t1']);
    assert.equal(cleared.running['run-a'], 't1');
    assert.equal(cleared.sessions['run-b'], undefined);
    assert.deepEqual(cleared.sessions['run-c']?.map((q) => q.id), ['c1']);
    assert.deepEqual(cleared.uncertain['run-c'], ['c1']);
    assert.deepEqual(cleared.completed['run-b'], ['b1']);
    assert.equal(isTurnSeen(cleared, 'run-b', 'b1'), true);
    assert.equal(isPaused(cleared, 'run-a'), false);
    assert.equal(isPaused(cleared, 'run-c'), true);
    const committed = commitTurn(cleared, 'run-a', 't1');
    assert.equal(queuedTurnCount(committed, 'run-a'), 0);
    assert.equal(isTurnSeen(committed, 'run-a', 't1'), true);
    const discarded = resolveUncertain(committed, 'run-c', 'c1', 'discard');
    assert.equal(queuedTurnCount(discarded, 'run-c'), 0);
    assert.equal(isTurnSeen(discarded, 'run-c', 'c1'), true);
});
test('images survive the disk round trip', () => {
    const { dir, file } = tmpQueueFile('hy-turn-queue-image-');
    try {
        const image = { mimeType: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') };
        const result = enqueueTurn(EMPTY_TURN_QUEUE, 'run-a', turn('t1', 'describe', [image]));
        assert.equal(result.ok, true);
        if (!result.ok)
            return;
        saveTurnQueue(file, result.state);
        assert.deepEqual(loadTurnQueue(file).sessions['run-a']?.[0]?.images, [image]);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('a missing or malformed queue file yields an empty queue instead of throwing', () => {
    const { dir, file } = tmpQueueFile('hy-turn-queue-bad-');
    try {
        const empty = { version: 1, sessions: {}, running: {}, uncertain: {}, completed: {}, paused: [] };
        assert.deepEqual(loadTurnQueue(file), empty);
        fs.writeFileSync(file, '{not json', 'utf8');
        assert.deepEqual(loadTurnQueue(file), empty);
        fs.writeFileSync(file, JSON.stringify({ version: 2, sessions: { 'run-a': [] } }), 'utf8');
        assert.deepEqual(loadTurnQueue(file), empty);
        fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: { 'run-a': [{ id: 't1', message: 'keep me', images: [], queuedAt: 5 }, { id: 7 }] } }), 'utf8');
        const kept = loadTurnQueue(file);
        assert.equal(queuedTurnCount(kept, 'run-a'), 1);
        assert.equal(kept.sessions['run-a']?.[0]?.message, 'keep me');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('clearing one session leaves the others untouched', () => {
    let state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1']);
    state = enqueueAll(state, 'run-b', ['t2']);
    const cleared = clearQueuedTurns(state, 'run-a');
    assert.equal(queuedTurnCount(cleared, 'run-a'), 0);
    assert.equal(queuedTurnCount(cleared, 'run-b'), 1);
});
test('a turn that would overflow the file is rejected and the queue is unchanged', () => {
    const first = enqueueTurn(EMPTY_TURN_QUEUE, 'run-a', turn('big', 'x'.repeat(1024)));
    assert.equal(first.ok, true);
    if (!first.ok)
        return;
    const headroom = MAX_QUEUE_FILE_BYTES - serializedQueueBytes(first.state);
    const filler = 'y'.repeat(headroom + 200);
    const snapshot = JSON.stringify(first.state);
    const second = enqueueTurn(first.state, 'run-a', turn('second', filler));
    assert.equal(second.ok, false);
    assert.equal(JSON.stringify(first.state), snapshot, 'the caller state is untouched');
    assert.equal(queuedTurnCount(first.state, 'run-a'), 1, 'nothing was dropped');
});
test('an oversized save throws and leaves the existing file byte-for-byte intact', () => {
    const { dir, file } = tmpQueueFile('hy-turn-queue-oversize-');
    try {
        saveTurnQueue(file, enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1']));
        const before = fs.readFileSync(file, 'utf8');
        const tooBig = {
            version: 1,
            sessions: { 'run-a': [turn('t1'), turn('huge', 'y'.repeat(MAX_QUEUE_FILE_BYTES + 1024))] },
            running: {},
            uncertain: {},
            completed: {},
            paused: [],
        };
        assert.throws(() => saveTurnQueue(file, tooBig), /over the .* byte limit/);
        assert.equal(fs.readFileSync(file, 'utf8'), before, 'the old queue is unchanged');
        assert.equal(fs.existsSync(`${file}.tmp`), false, 'no partial file was left behind');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('a failed write leaves the previous queue readable', () => {
    const { dir, file } = tmpQueueFile('hy-turn-queue-writefail-');
    try {
        saveTurnQueue(file, enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1']));
        fs.mkdirSync(`${file}.tmp`);
        assert.throws(() => saveTurnQueue(file, enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t2'])));
        assert.deepEqual(loadTurnQueue(file).sessions['run-a']?.map((queued) => queued.id), ['t1']);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
