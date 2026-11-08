import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MAX_WORKERS,
  MAX_WORKERS_CEILING,
  activeWorkerCount,
  canSpawnWorker,
  loadOrchestrationState,
  markStaleWorkersInterrupted,
  normalizeScope,
  normalizeScopes,
  parseWorkerReport,
  saveOrchestrationState,
  scopesOverlap,
  workerAwaitingReview,
  workerHoldsScope,
  workerNeedsAttention,
  workerOwnsScope,
  workerStatusLabel,
  type OrchestrationRecord,
  type WorkerRecord,
} from './orchestration.js'

test('orchestration scopes are relative and disjoint', () => {
  assert.equal(normalizeScope('./src/'), 'src')
  assert.equal(normalizeScope('packages\\ui'), 'packages/ui')
  assert.equal(normalizeScope('file:project.md'), 'file:project.md')
  assert.equal(normalizeScope('file:./docs/notes.md'), 'file:docs/notes.md')
  assert.throws(() => normalizeScope('.'), /whole workspace/)
  assert.throws(() => normalizeScope('..\\outside'), /invalid segment/)
  assert.throws(() => normalizeScope('C:\\work'), /relative/)
  assert.throws(() => normalizeScope('file:'), /file scope/)
  assert.throws(() => normalizeScope('file:docs/'), /file scope/)
  assert.throws(() => normalizeScope('file:docs/../project.md'), /invalid segment/)
  assert.deepEqual(normalizeScopes(['src', 'src/', 'docs']), ['src', 'docs'])

  assert.equal(scopesOverlap('src', 'src/ui'), true)
  assert.equal(scopesOverlap('src/ui', 'src/api'), false)
  assert.equal(scopesOverlap('packages/ui', 'packages/uix'), false)
  assert.equal(scopesOverlap('file:project.md', 'file:project.md'), true)
  assert.equal(scopesOverlap('file:project.md', 'docs'), false)
  assert.equal(scopesOverlap('file:docs/a.md', 'docs'), true)
  assert.equal(scopesOverlap('file:docs/a.md', 'docs/sub'), false)
  assert.equal(scopesOverlap('file:root-2:docs/a.md', 'root-2:docs'), true)
})

test('worker scope ownership follows the directory or file boundary', () => {
  const worker: WorkerRecord = {
    runId: 'run-worker',
    title: 'UI',
    task: 'change UI',
    scope: ['src/ui'],
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: 1,
  }
  assert.equal(workerOwnsScope(worker, 'src/ui/app.ts'), true)
  assert.equal(workerOwnsScope(worker, 'src/ui'), true)
  assert.equal(workerOwnsScope(worker, 'src/uix/app.ts'), false)
  assert.equal(workerOwnsScope({ ...worker, status: 'done' }, 'src/ui/app.ts'), false)

  const fileWorker = { ...worker, scope: ['file:project.md'] }
  assert.equal(workerOwnsScope(fileWorker, 'project.md'), true)
  assert.equal(workerOwnsScope(fileWorker, 'README.md'), false)
  assert.equal(workerOwnsScope(fileWorker, 'project.md.bak'), false)
})

test('orchestration state survives a round trip and rejects malformed files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-orchestration-'))
  const file = path.join(dir, 'orchestration.json')
  try {
    const state = {
      version: 1 as const,
      active: {
        id: 'orc-1',
        orchestratorRunId: 'run-orch',
        status: 'active' as const,
        createdAt: 1,
        updatedAt: 2,
        maxWorkers: DEFAULT_MAX_WORKERS,
        workers: [
          {
            runId: 'run-worker',
            title: 'UI',
            task: 'do it',
            scope: ['src'],
            status: 'waiting' as const,
            createdAt: 1,
            updatedAt: 2,
            lastEventAt: 2,
            lastSummary: 'done',
            lastReportStatus: 'blocked' as const,
            blocker: 'missing credentials',
          },
        ],
      },
    }
    saveOrchestrationState(file, state)
    assert.deepEqual(loadOrchestrationState(file), state)
    fs.writeFileSync(file, '{not json', 'utf8')
    assert.deepEqual(loadOrchestrationState(file), { version: 1, active: null })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('five disjoint scopes fit the default limit while an overlap is still rejected', () => {
  assert.equal(DEFAULT_MAX_WORKERS, 5)
  const scopes = ['a', 'b', 'c', 'd', 'e']
  assert.equal(scopes.length, DEFAULT_MAX_WORKERS)
  for (let i = 0; i < scopes.length; i++) {
    for (let j = i + 1; j < scopes.length; j++) {
      assert.equal(scopesOverlap(scopes[i]!, scopes[j]!), false)
    }
  }
  assert.equal(scopesOverlap('e', 'e/nested'), true)
})

test('the default limit allows five live workers and a closed worker frees its slot', () => {
  const worker = (runId: string, status: WorkerRecord['status']): WorkerRecord => ({
    runId,
    title: runId,
    task: 'do it',
    scope: [runId],
    status,
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: 1,
  })
  const record: OrchestrationRecord = {
    id: 'orc-1',
    orchestratorRunId: 'run-orch',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    maxWorkers: DEFAULT_MAX_WORKERS,
    workers: [],
  }
  record.workers = ['a', 'b', 'c', 'd'].map((id) => worker(id, 'running'))
  assert.equal(activeWorkerCount(record), 4)
  assert.equal(canSpawnWorker(record), true)
  record.workers.push(worker('e', 'running'))
  assert.equal(activeWorkerCount(record), 5)
  assert.equal(canSpawnWorker(record), false)
  // A closed worker releases its slot for a new one.
  record.workers[0]!.status = 'done'
  assert.equal(activeWorkerCount(record), 4)
  assert.equal(canSpawnWorker(record), true)
  record.workers.push(worker('f', 'queued'))
  assert.equal(activeWorkerCount(record), 5)
  assert.equal(canSpawnWorker(record), false)
})

test('a stored worker limit is clamped and defaults to five when absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-orchestration-limit-'))
  const file = path.join(dir, 'orchestration.json')
  const write = (maxWorkers?: unknown): void => {
    const active: Record<string, unknown> = {
      id: 'orc-1',
      orchestratorRunId: 'run-orch',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      workers: [],
    }
    if (maxWorkers !== undefined) active.maxWorkers = maxWorkers
    fs.writeFileSync(file, JSON.stringify({ version: 1, active }), 'utf8')
  }
  try {
    write(undefined)
    assert.equal(loadOrchestrationState(file).active?.maxWorkers, DEFAULT_MAX_WORKERS)
    write(5)
    assert.equal(loadOrchestrationState(file).active?.maxWorkers, 5)
    write(99)
    assert.equal(loadOrchestrationState(file).active?.maxWorkers, MAX_WORKERS_CEILING)
    write(0)
    assert.equal(loadOrchestrationState(file).active?.maxWorkers, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('worker reports expose blocked and partial states with a reason', () => {
  assert.deepEqual(parseWorkerReport('did work\nSTATUS: blocked\nBLOCKED_BY: missing credentials'), {
    status: 'blocked',
    reason: 'missing credentials',
  })
  assert.deepEqual(parseWorkerReport('**STATUS:** partial\n**BLOCKED_BY:** tests fail'), {
    status: 'partial',
    reason: 'tests fail',
  })
  assert.deepEqual(parseWorkerReport('STATUS: done'), { status: 'done' })
  assert.equal(parseWorkerReport('no status line'), undefined)
  assert.equal(workerStatusLabel('partial'), 'partially done')
  assert.equal(workerNeedsAttention('blocked'), true)
  assert.equal(workerNeedsAttention('partial'), true)
  assert.equal(workerNeedsAttention('waiting'), false)
  assert.equal(workerNeedsAttention('done'), false)
  assert.equal(workerHoldsScope({ status: 'waiting' } as WorkerRecord), true, 'done work awaiting review still owns its scope')
  assert.equal(workerHoldsScope({ status: 'done' } as WorkerRecord), false)
  assert.equal(workerAwaitingReview({ status: 'waiting' } as WorkerRecord), true)
  assert.equal(workerAwaitingReview({ status: 'running' } as WorkerRecord), false)
})

test('a restart turns a stale running or queued worker into interrupted work', () => {
  const record: OrchestrationRecord = {
    id: 'orc-restart',
    orchestratorRunId: 'run-orch',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    maxWorkers: DEFAULT_MAX_WORKERS,
    workers: [
      {
        runId: 'run-running',
        title: 'running',
        task: 'a',
        scope: ['src'],
        status: 'running',
        createdAt: 1,
        updatedAt: 2,
        lastEventAt: 2,
        lastReportStatus: 'done',
      },
      {
        runId: 'run-queued',
        title: 'queued',
        task: 'b',
        scope: ['docs'],
        status: 'queued',
        createdAt: 1,
        updatedAt: 2,
        lastEventAt: 2,
      },
      {
        runId: 'run-waiting',
        title: 'waiting',
        task: 'c',
        scope: ['tests'],
        status: 'waiting',
        createdAt: 1,
        updatedAt: 2,
        lastEventAt: 2,
        lastReportStatus: 'done',
      },
      {
        runId: 'run-done',
        title: 'done',
        task: 'd',
        scope: ['packages/core'],
        status: 'done',
        createdAt: 1,
        updatedAt: 2,
        lastEventAt: 2,
        closedAt: 2,
      },
    ],
  }
  assert.equal(markStaleWorkersInterrupted(record, 99), true)
  assert.equal(record.workers[0]!.status, 'interrupted')
  assert.match(record.workers[0]!.lastError ?? '', /restarted/)
  assert.equal(record.workers[1]!.status, 'interrupted')
  assert.equal(record.workers[2]!.status, 'waiting', 'a completed report still needs review')
  assert.equal(record.workers[3]!.status, 'done', 'closed work is left alone')
  assert.equal(record.updatedAt, 99)
  assert.equal(markStaleWorkersInterrupted(record, 100), false, 'a second load is a no-op')
})

test('the orchestrator prompt requires honest limitation reporting', () => {
  const prompt = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'orchestrator.md'),
    'utf8',
  )
  assert.match(prompt, /## Capability and honesty/)
  assert.match(prompt, /STATUS: blocked/)
  assert.match(prompt, /Do not explain internal modes, tool restrictions, or permission mechanics/)
  assert.doesNotMatch(prompt, /Never mention tool restrictions/)
})

test('the orchestrator prompt settles how a turn ends, what it can do, and when it asks', () => {
  const prompt = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'orchestrator.md'), 'utf8')
  // How a turn ends: three cases, and never on an announcement of its own work.
  assert.match(prompt, /## How a turn ends/)
  assert.match(prompt, /Never end a turn by announcing work you will do yourself/)
  assert.match(prompt, /When you choose a default, dispatch it in the same turn/)
  // What it can do itself, so it does not plan commands it cannot run.
  assert.match(prompt, /You cannot run commands, builds or tests, and you cannot edit files/)
  assert.doesNotMatch(prompt, /run a small read-only investigation first/)
  // Asking follows the interaction setting; the general rules are read for a delegator.
  assert.match(prompt, /How often you ask follows the interaction setting/)
  assert.match(prompt, /## Reading the general instructions/)
  assert.match(prompt, /several steps may be `in_progress`/)
  assert.doesNotMatch(prompt, /what is running now and what will follow/)
})

test('a session without apply_patch or shell gets the reading half of the roots note', async () => {
  const { workspaceRootCatalog } = await import('./session-app.js')
  const roots = [
    { id: 'main', path: 'F:/a', writable: true },
    { id: 'docs', path: 'F:/b', writable: false },
  ]
  const full = workspaceRootCatalog(roots as never)
  assert.match(full, /apply_patch \/ shell/)
  const reading = workspaceRootCatalog(roots as never, { readOnly: true })
  assert.match(reading, /read_file \/ search_glob \/ search_grep/)
  assert.doesNotMatch(reading, /apply_patch|shell|writable/)
})
