// Orchestration state for the A+ mode (one workspace, path scopes).
//
// The orchestrator and every worker are ordinary sessions. This module keeps
// only the hierarchy and the safety rules that sit above them: one active
// orchestrator, non-overlapping worker scopes, worker status and the last
// report. The web server owns the side effects (turns, approvals, SSE).
import fs from 'node:fs';
import path from 'node:path';
/** Workers that may run at once by default; the host also caps stored values. */
export const DEFAULT_MAX_WORKERS = 5;
/** Upper bound for a persisted maxWorkers value (guards a hand-edited state file). */
export const MAX_WORKERS_CEILING = 6;
export const EMPTY_ORCHESTRATION = { version: 1, active: null };
export function loadOrchestrationState(file) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return { version: 1, active: null };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { version: 1, active: null };
    const raw = parsed;
    if (raw.version !== 1 || !raw.active || typeof raw.active !== 'object' || Array.isArray(raw.active)) {
        return { version: 1, active: null };
    }
    const a = raw.active;
    if (typeof a.id !== 'string' ||
        typeof a.orchestratorRunId !== 'string' ||
        (a.status !== 'active' && a.status !== 'stopped') ||
        !Array.isArray(a.workers)) {
        return { version: 1, active: null };
    }
    const workers = a.workers
        .filter((w) => !!w && typeof w === 'object' && !Array.isArray(w))
        .map((w) => sanitizeWorker(w))
        .filter((w) => w !== undefined);
    return {
        version: 1,
        active: {
            id: a.id,
            orchestratorRunId: a.orchestratorRunId,
            status: a.status,
            createdAt: typeof a.createdAt === 'number' ? a.createdAt : Date.now(),
            updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : Date.now(),
            maxWorkers: typeof a.maxWorkers === 'number' ? Math.max(1, Math.min(MAX_WORKERS_CEILING, Math.floor(a.maxWorkers))) : DEFAULT_MAX_WORKERS,
            workers,
        },
    };
}
function sanitizeWorker(raw) {
    if (typeof raw.runId !== 'string' ||
        typeof raw.title !== 'string' ||
        typeof raw.task !== 'string' ||
        !Array.isArray(raw.scope)) {
        return undefined;
    }
    const status = raw.status;
    const allowed = ['queued', 'running', 'waiting', 'blocked', 'failed', 'stopped', 'interrupted', 'done'];
    return {
        runId: raw.runId,
        title: raw.title,
        task: raw.task,
        scope: raw.scope.filter((s) => typeof s === 'string' && s.trim().length > 0),
        status: typeof status === 'string' && allowed.includes(status) ? status : 'interrupted',
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
        lastEventAt: typeof raw.lastEventAt === 'number' ? raw.lastEventAt : Date.now(),
        ...(typeof raw.lastHeartbeatAt === 'number' ? { lastHeartbeatAt: raw.lastHeartbeatAt } : {}),
        ...(typeof raw.lastSummary === 'string' ? { lastSummary: raw.lastSummary } : {}),
        ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError } : {}),
        ...(typeof raw.closedAt === 'number' ? { closedAt: raw.closedAt } : {}),
    };
}
export function saveOrchestrationState(file, state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
}
/** Normalizes a repository-relative scope, rejecting escapes and broad roots. */
export function normalizeScope(raw) {
    const value = raw.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!value || value === '.' || value === '**' || value === '/') {
        throw new Error('scope must name a directory below the workspace, not the whole workspace');
    }
    if (path.posix.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
        throw new Error(`scope must be relative to the workspace: ${raw}`);
    }
    const parts = value.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..')) {
        throw new Error(`scope contains an invalid segment: ${raw}`);
    }
    return parts.join('/');
}
export function normalizeScopes(raw) {
    const scopes = [...new Set(raw.map(normalizeScope))];
    if (scopes.length === 0)
        throw new Error('at least one scope is required');
    return scopes;
}
/** True when two directory scopes overlap (equal, parent or child). */
export function scopesOverlap(a, b) {
    const x = a.replace(/\/+$/, '');
    const y = b.replace(/\/+$/, '');
    return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
export function workerOwnsScope(worker, rel) {
    if (worker.status === 'done')
        return false;
    const value = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    return worker.scope.some((scope) => value === scope || value.startsWith(`${scope}/`));
}
/** Workers that still reserve their scope. Stopped workers stay reserved until closed. */
export function scopeOwners(record) {
    return record.workers.filter((worker) => worker.status !== 'done');
}
export function activeWorkerCount(record) {
    return record.workers.filter((worker) => worker.status !== 'done').length;
}
/** True when a new worker may start; a closed worker releases its slot. */
export function canSpawnWorker(record) {
    return activeWorkerCount(record) < record.maxWorkers;
}
export function workerStatusLabel(status) {
    switch (status) {
        case 'queued':
            return 'queued';
        case 'running':
            return 'running';
        case 'waiting':
            return 'waiting for review';
        case 'blocked':
            return 'needs approval';
        case 'failed':
            return 'failed';
        case 'stopped':
            return 'stopped';
        case 'interrupted':
            return 'interrupted by restart';
        case 'done':
            return 'done';
    }
}
