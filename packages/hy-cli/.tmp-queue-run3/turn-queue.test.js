import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EMPTY_TURN_QUEUE, MAX_QUEUED_IMAGES_PER_TURN, MAX_QUEUED_TURNS_PER_SESSION, MAX_QUEUE_FILE_BYTES, beginTurn, clearQueuedTurns, commitTurn, enqueueTurn, isPaused, loadTurnQueue, peekNextTurn, queuedTurnCount, releaseTurn, resumeSession, saveTurnQueue, serializedQueueBytes, } from './turn-queue.js';
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
    const result = enqueueTurn(EMPTY_TURN_QUEUE, 'run-a', turn('t1', '   ', [image]));
    assert.equal(result.ok, false);
});
test('a queue restored from disk stays paused until the user resumes it', () => {
    const { dir, file } = tmpQueueFile('hy-turn-queue-');
    try {
        saveTurnQueue(file, enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1', 't2']));
        const restored = loadTurnQueue(file);
        assert.equal(queuedTurnCount(restored, 'run-a'), 2, 'nothing is lost by a restart');
        assert.equal(isPaused(restored, 'run-a'), true);
        assert.equal(peekNextTurn(restored, 'run-a'), undefined, 'a restart never runs queued work on its own');
        const resumed = resumeSession(restored, 'run-a');
        assert.equal(isPaused(resumed, 'run-a'), false);
        assert.equal(peekNextTurn(resumed, 'run-a')?.id, 't1');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('a turn that was running when the process died is still queued after a restart', () => {
    const { dir, file } = tmpQueueFile('hy-turn-queue-crash-');
    try {
        let state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1', 't2']);
        state = beginTurn(state, 'run-a', 't1');
        saveTurnQueue(file, state);
        const restored = loadTurnQueue(file);
        assert.equal(queuedTurnCount(restored, 'run-a'), 2, 'the in-flight turn was not removed');
        assert.equal(isPaused(restored, 'run-a'), true);
        assert.deepEqual(restored.running, {}, 'a dead process is not still "running" anything');
        const resumed = resumeSession(restored, 'run-a');
        assert.equal(peekNextTurn(resumed, 'run-a')?.id, 't1', 'the message can be sent again');
        // The committed id stays remembered, so it cannot be duplicated later.
        const afterCommit = commitTurn(beginTurn(resumed, 'run-a', 't1'), 'run-a', 't1');
        saveTurnQueue(file, afterCommit);
        assert.deepEqual(loadTurnQueue(file).completed['run-a'], ['t1']);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('a failed or cancelled turn keeps its message queued for the user', () => {
    let state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1']);
    state = beginTurn(state, 'run-a', 't1');
    const released = releaseTurn(state, 'run-a');
    assert.equal(queuedTurnCount(released, 'run-a'), 1, 'the message survives a failure');
    assert.deepEqual(released.running, {});
    assert.equal(peekNextTurn(released, 'run-a')?.id, 't1');
    // Releasing twice is harmless.
    assert.deepEqual(releaseTurn(released, 'run-a'), released);
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
        assert.deepEqual(loadTurnQueue(file), { version: 1, sessions: {}, running: {}, completed: {}, paused: [] });
        fs.writeFileSync(file, '{not json', 'utf8');
        assert.deepEqual(loadTurnQueue(file), { version: 1, sessions: {}, running: {}, completed: {}, paused: [] });
        fs.writeFileSync(file, JSON.stringify({ version: 2, sessions: { 'run-a': [] } }), 'utf8');
        assert.deepEqual(loadTurnQueue(file), { version: 1, sessions: {}, running: {}, completed: {}, paused: [] });
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
    assert.deepEqual(clearQueuedTurns(state), { version: 1, sessions: {}, running: {}, completed: {}, paused: [] });
});
test('a turn that would overflow the file is rejected and the queue is unchanged', () => {
    const first = enqueueTurn(EMPTY_TURN_QUEUE, 'run-a', turn('big', 'x'.repeat(1024)));
    assert.equal(first.ok, true);
    if (!first.ok)
        return;
    // Size the second message from the measured headroom so it cannot fit.
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
        // Make the temp path a directory so writeFileSync cannot create the file.
        fs.mkdirSync(`${file}.tmp`);
        assert.throws(() => saveTurnQueue(file, enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t2'])));
        assert.deepEqual(loadTurnQueue(file).sessions['run-a']?.map((queued) => queued.id), ['t1']);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
