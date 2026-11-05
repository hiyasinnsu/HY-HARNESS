import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EMPTY_TURN_QUEUE, MAX_QUEUED_IMAGES_PER_TURN, MAX_QUEUED_TURNS_PER_SESSION, clearQueuedTurns, enqueueTurn, isPaused, loadTurnQueue, queuedTurnCount, resumeSession, saveTurnQueue, takeNextTurn, } from './turn-queue.js';
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
test('turns of one session are delivered in the order they were queued', () => {
    let state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1', 't2', 't3']);
    assert.equal(queuedTurnCount(state, 'run-a'), 3);
    const first = takeNextTurn(state, 'run-a');
    assert.equal(first.turn?.id, 't1');
    state = first.state;
    const second = takeNextTurn(state, 'run-a');
    assert.equal(second.turn?.id, 't2');
    state = second.state;
    const third = takeNextTurn(state, 'run-a');
    assert.equal(third.turn?.id, 't3');
    state = third.state;
    assert.equal(queuedTurnCount(state, 'run-a'), 0);
    assert.equal(takeNextTurn(state, 'run-a').turn, undefined);
});
test('a session without queued turns does not borrow another session queue', () => {
    const state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1']);
    const other = takeNextTurn(state, 'run-b');
    assert.equal(other.turn, undefined);
    assert.equal(queuedTurnCount(other.state, 'run-a'), 1, 'run-a keeps its turn');
});
test('the same id cannot be queued twice, so a retried request is not delivered twice', () => {
    const state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1']);
    const again = enqueueTurn(state, 'run-a', turn('t1'));
    assert.equal(again.ok, false);
    const alreadyRan = enqueueTurn(EMPTY_TURN_QUEUE, 'run-a', turn('t9'), new Set(['t9']));
    assert.equal(alreadyRan.ok, false);
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
    const taken = takeNextTurn(result.state, 'run-a');
    assert.deepEqual(taken.turn?.images, [image]);
    const tooMany = Array.from({ length: MAX_QUEUED_IMAGES_PER_TURN + 1 }, () => image);
    assert.equal(enqueueTurn(EMPTY_TURN_QUEUE, 'run-a', turn('t2', 'look', tooMany)).ok, false);
    const notAnImage = enqueueTurn(EMPTY_TURN_QUEUE, 'run-a', turn('t3', 'look', [{ mimeType: 'text/plain', data: 'eA==' }]));
    assert.equal(notAnImage.ok, false);
});
test('a queue restored from disk stays paused until the user resumes it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-turn-queue-'));
    const file = path.join(dir, 'turn-queue.json');
    try {
        const state = enqueueAll(EMPTY_TURN_QUEUE, 'run-a', ['t1', 't2']);
        saveTurnQueue(file, state);
        const restored = loadTurnQueue(file);
        assert.equal(queuedTurnCount(restored, 'run-a'), 2, 'nothing is lost by a restart');
        assert.equal(isPaused(restored, 'run-a'), true);
        const blocked = takeNextTurn(restored, 'run-a');
        assert.equal(blocked.turn, undefined, 'a restart never runs queued work on its own');
        assert.equal(queuedTurnCount(blocked.state, 'run-a'), 2);
        const resumed = resumeSession(restored, 'run-a');
        assert.equal(isPaused(resumed, 'run-a'), false);
        const next = takeNextTurn(resumed, 'run-a');
        assert.equal(next.turn?.id, 't1');
        assert.equal(queuedTurnCount(next.state, 'run-a'), 1);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('images survive the disk round trip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-turn-queue-image-'));
    const file = path.join(dir, 'turn-queue.json');
    try {
        const image = { mimeType: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') };
        const result = enqueueTurn(EMPTY_TURN_QUEUE, 'run-a', turn('t1', 'describe', [image]));
        assert.equal(result.ok, true);
        if (!result.ok)
            return;
        saveTurnQueue(file, result.state);
        const restored = loadTurnQueue(file);
        assert.deepEqual(restored.sessions['run-a']?.[0]?.images, [image]);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('a missing or malformed queue file yields an empty queue instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-turn-queue-bad-'));
    const file = path.join(dir, 'turn-queue.json');
    try {
        assert.deepEqual(loadTurnQueue(file), { version: 1, sessions: {}, paused: [] });
        fs.writeFileSync(file, '{not json', 'utf8');
        assert.deepEqual(loadTurnQueue(file), { version: 1, sessions: {}, paused: [] });
        fs.writeFileSync(file, JSON.stringify({ version: 2, sessions: { 'run-a': [] } }), 'utf8');
        assert.deepEqual(loadTurnQueue(file), { version: 1, sessions: {}, paused: [] });
        // Malformed turns are dropped, valid ones are kept.
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
    assert.deepEqual(clearQueuedTurns(state), { version: 1, sessions: {}, paused: [] });
});
