import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
/** Walking a very large workspace for the ACL grant can take minutes. */
const GRANT_TIMEOUT_MS = 30 * 60_000;
export class ExecRpcError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = 'ExecRpcError';
    }
}
export function findRepoRoot(start = process.cwd()) {
    let dir = path.resolve(start);
    for (;;) {
        if (fs.existsSync(path.join(dir, 'Cargo.toml')) && fs.existsSync(path.join(dir, 'packages'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            return path.resolve(start);
        dir = parent;
    }
}
export function resolveServerPath(explicit) {
    if (explicit)
        return path.resolve(explicit);
    if (process.env.HY_EXEC_SERVER)
        return path.resolve(process.env.HY_EXEC_SERVER);
    const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
    for (const candidate of [
        path.join(root, 'target', 'debug', 'hy-exec-server.exe'),
        path.join(root, 'target', 'release', 'hy-exec-server.exe'),
        path.join(root, 'target', 'debug', 'hy-exec-server'),
        path.join(root, 'target', 'release', 'hy-exec-server'),
    ]) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    return 'hy-exec-server';
}
export class ExecRpcClient {
    child;
    nextId = 0;
    pending = new Map();
    /** `ptc/run` request id → its sub-call handler. */
    ptcHandlers = new Map();
    closed = false;
    constructor(child) {
        this.child = child;
        const lines = readline.createInterface({ input: child.stdout });
        lines.on('line', (line) => this.onLine(line));
        child.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf8').trimEnd();
            if (text)
                process.stderr.write(`[exec] ${text}\n`);
        });
        child.on('exit', (code, signal) => {
            this.closed = true;
            const error = new Error(`hy-exec-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
            for (const [id, pending] of this.pending) {
                clearTimeout(pending.timer);
                pending.reject(error);
                this.pending.delete(id);
            }
        });
    }
    static async start(serverPath, initParams) {
        // The daemon copies the worker into an AppContainer-readable runtime
        // directory and runs it with this Node (design §2).
        const params = {
            ptcWorkerPath: fileURLToPath(new URL('./ptc-worker.mjs', import.meta.url)),
            ptcNodePath: process.execPath,
            ...initParams,
        };
        const child = spawn(serverPath, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: process.env,
        });
        const client = new ExecRpcClient(child);
        // A confined session grants the workspace here: one walk of the tree (ADR 0001 S-1).
        await client.request('initialize', params, GRANT_TIMEOUT_MS);
        return client;
    }
    onLine(line) {
        if (!line.trim())
            return;
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            process.stderr.write(`[exec] non-JSON output: ${line.slice(0, 200)}\n`);
            return;
        }
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
            const pending = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(pending.timer);
            if (msg.error) {
                const err = msg.error;
                pending.reject(new ExecRpcError(err.code ?? -32603, err.message ?? 'unknown RPC error', err.data));
            }
            else {
                pending.resolve(msg.result);
            }
            return;
        }
        if (typeof msg.method === 'string' && msg.id !== undefined) {
            void this.onServerRequest(msg.id, msg.method, msg.params);
        }
    }
    /** Server-initiated requests: only `ptc/toolCall` (design §3). */
    async onServerRequest(id, method, params) {
        const reply = (body) => {
            if (!this.closed)
                this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n');
        };
        if (method !== 'ptc/toolCall') {
            reply({ error: { code: -32601, message: `client does not implement ${method}` } });
            return;
        }
        const p = (params ?? {});
        const handler = this.ptcHandlers.get(String(p.runRequestId));
        if (!handler) {
            reply({ error: { code: -32602, message: `no pending ptc/run ${String(p.runRequestId)}` } });
            return;
        }
        try {
            reply({ result: (await handler(String(p.name ?? ''), p.args)) ?? null });
        }
        catch (error) {
            reply({ error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        }
    }
    /**
     * Runs a `run_code` script in the daemon's AppContainer worker; each
     * sub-call comes back through `onToolCall`.
     */
    async ptcRun(params, onToolCall, signal) {
        // `request` takes the next id synchronously, so the handler is registered first.
        const id = String(this.nextId + 1);
        this.ptcHandlers.set(id, onToolCall);
        try {
            return await this.request('ptc/run', params, params.timeoutMs + 60_000, signal);
        }
        finally {
            this.ptcHandlers.delete(id);
        }
    }
    request(method, params, timeoutMs = 120_000, signal) {
        if (this.closed)
            return Promise.reject(new Error('hy-exec-server is closed'));
        if (signal?.aborted) {
            return Promise.reject(new ExecRpcError(-32005, 'request cancelled'));
        }
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                if (!this.pending.has(id))
                    return;
                this.pending.delete(id);
                clearTimeout(timer);
                if (!this.closed) {
                    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }) + '\n');
                }
                reject(new ExecRpcError(-32005, 'request cancelled'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                this.pending.delete(id);
                reject(new Error(`RPC timeout after ${timeoutMs}ms: ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve(value);
                },
                reject: (err) => {
                    signal?.removeEventListener('abort', onAbort);
                    reject(err);
                },
                timer,
            });
            this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }
    exec(params, signal, timeoutMs = 120_000) {
        return this.request('exec/command', params, timeoutMs, signal);
    }
    patch(params) {
        return this.request('patch/apply', params);
    }
    policyEvaluate(command) {
        return this.request('policy/evaluate', { command });
    }
    checkpointCreate(runId, label) {
        return this.request('checkpoint/create', { runId, label });
    }
    checkpointRollback(runId, label) {
        return this.request('checkpoint/rollback', { runId, label });
    }
    checkpointDiff(runId, fromLabel, maxBytes = 64 * 1024) {
        return this.request('checkpoint/diff', { runId, fromLabel, maxBytes });
    }
    checkpointPrune(runId, keep) {
        return this.request('checkpoint/prune', { runId, keep });
    }
    sandboxStatus() {
        return this.request('sandbox/status', {});
    }
    sandboxGrant() {
        return this.request('sandbox/grant', {}, GRANT_TIMEOUT_MS);
    }
    sandboxRevoke() {
        return this.request('sandbox/revoke', {}, GRANT_TIMEOUT_MS);
    }
    sandboxAddRoot(root) {
        return this.request('sandbox/add-root', { root }, GRANT_TIMEOUT_MS);
    }
    sandboxRemoveRoot(root) {
        return this.request('sandbox/remove-root', { root }, GRANT_TIMEOUT_MS);
    }
    jobStatus(jobId) {
        return this.request('job/status', { jobId });
    }
    jobOutput(jobId, offset = 0, maxBytes) {
        return this.request('job/output', { jobId, offset, ...(maxBytes !== undefined ? { maxBytes } : {}) });
    }
    jobWait(jobId, timeoutMs, signal) {
        return this.request('job/wait', { jobId, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, (timeoutMs ?? 0) + 30_000, signal);
    }
    jobKill(jobId) {
        return this.request('job/kill', { jobId });
    }
    async stop() {
        if (this.closed)
            return;
        try {
            await this.request('shutdown', {}, 5_000);
        }
        catch {
            // The process may already be gone.
        }
        this.child.stdin.end();
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.child.kill();
                resolve();
            }, 2_000);
            this.child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}
