import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MAX_WORKERS, MAX_WORKERS_CEILING, activeWorkerCount, canSpawnWorker, loadOrchestrationState, normalizeScope, normalizeScopes, saveOrchestrationState, scopesOverlap, workerOwnsScope, } from './orchestration.js';
test('orchestration scopes are relative and disjoint', () => {
    assert.equal(normalizeScope('./src/'), 'src');
    assert.equal(normalizeScope('packages\\ui'), 'packages/ui');
    assert.throws(() => normalizeScope('.'), /whole workspace/);
    assert.throws(() => normalizeScope('..\\outside'), /invalid segment/);
    assert.throws(() => normalizeScope('C:\\work'), /relative/);
    assert.deepEqual(normalizeScopes(['src', 'src/', 'docs']), ['src', 'docs']);
    assert.equal(scopesOverlap('src', 'src/ui'), true);
    assert.equal(scopesOverlap('src/ui', 'src/api'), false);
    assert.equal(scopesOverlap('packages/ui', 'packages/uix'), false);
});
test('worker scope ownership follows the directory boundary', () => {
    const worker = {
        runId: 'run-worker',
        title: 'UI',
        task: 'change UI',
        scope: ['src/ui'],
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        lastEventAt: 1,
    };
    assert.equal(workerOwnsScope(worker, 'src/ui/app.ts'), true);
    assert.equal(workerOwnsScope(worker, 'src/ui'), true);
    assert.equal(workerOwnsScope(worker, 'src/uix/app.ts'), false);
    assert.equal(workerOwnsScope({ ...worker, status: 'done' }, 'src/ui/app.ts'), false);
});
test('orchestration state survives a round trip and rejects malformed files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-orchestration-'));
    const file = path.join(dir, 'orchestration.json');
    try {
        const state = {
            version: 1,
            active: {
                id: 'orc-1',
                orchestratorRunId: 'run-orch',
                status: 'active',
                createdAt: 1,
                updatedAt: 2,
                maxWorkers: DEFAULT_MAX_WORKERS,
                workers: [
                    {
                        runId: 'run-worker',
                        title: 'UI',
                        task: 'do it',
                        scope: ['src'],
                        status: 'waiting',
                        createdAt: 1,
                        updatedAt: 2,
                        lastEventAt: 2,
                        lastSummary: 'done',
                    },
                ],
            },
        };
        saveOrchestrationState(file, state);
        assert.deepEqual(loadOrchestrationState(file), state);
        fs.writeFileSync(file, '{not json', 'utf8');
        assert.deepEqual(loadOrchestrationState(file), { version: 1, active: null });
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('five disjoint scopes fit the default limit while an overlap is still rejected', () => {
    assert.equal(DEFAULT_MAX_WORKERS, 5);
    const scopes = ['a', 'b', 'c', 'd', 'e'];
    assert.equal(scopes.length, DEFAULT_MAX_WORKERS);
    for (let i = 0; i < scopes.length; i++) {
        for (let j = i + 1; j < scopes.length; j++) {
            assert.equal(scopesOverlap(scopes[i], scopes[j]), false);
        }
    }
    assert.equal(scopesOverlap('e', 'e/nested'), true);
});
test('the default limit allows five live workers and a closed worker frees its slot', () => {
    const worker = (runId, status) => ({
        runId,
        title: runId,
        task: 'do it',
        scope: [runId],
        status,
        createdAt: 1,
        updatedAt: 1,
        lastEventAt: 1,
    });
    const record = {
        id: 'orc-1',
        orchestratorRunId: 'run-orch',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
        maxWorkers: DEFAULT_MAX_WORKERS,
        workers: [],
    };
    record.workers = ['a', 'b', 'c', 'd'].map((id) => worker(id, 'running'));
    assert.equal(activeWorkerCount(record), 4);
    assert.equal(canSpawnWorker(record), true);
    record.workers.push(worker('e', 'running'));
    assert.equal(activeWorkerCount(record), 5);
    assert.equal(canSpawnWorker(record), false);
    // A closed worker releases its slot for a new one.
    record.workers[0].status = 'done';
    assert.equal(activeWorkerCount(record), 4);
    assert.equal(canSpawnWorker(record), true);
    record.workers.push(worker('f', 'queued'));
    assert.equal(activeWorkerCount(record), 5);
    assert.equal(canSpawnWorker(record), false);
});
test('a stored worker limit is clamped and defaults to five when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-orchestration-limit-'));
    const file = path.join(dir, 'orchestration.json');
    const write = (maxWorkers) => {
        const active = {
            id: 'orc-1',
            orchestratorRunId: 'run-orch',
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
            workers: [],
        };
        if (maxWorkers !== undefined)
            active.maxWorkers = maxWorkers;
        fs.writeFileSync(file, JSON.stringify({ version: 1, active }), 'utf8');
    };
    try {
        write(undefined);
        assert.equal(loadOrchestrationState(file).active?.maxWorkers, DEFAULT_MAX_WORKERS);
        write(5);
        assert.equal(loadOrchestrationState(file).active?.maxWorkers, 5);
        write(99);
        assert.equal(loadOrchestrationState(file).active?.maxWorkers, MAX_WORKERS_CEILING);
        write(0);
        assert.equal(loadOrchestrationState(file).active?.maxWorkers, 1);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
