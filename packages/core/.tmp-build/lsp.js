// Language Server Protocol client for the `lsp` tool (DSH `packages/lsp`):
// definitions, references, hover, diagnostics and document symbols from a
// language server the user configured, chosen by file extension:
//
//   "lsp": { "rust": { "command": ["rust-analyzer"], "extensions": [".rs"] } }
//
// One server per configuration, started on first use (inside the workspace)
// and kept for the session. Positions are 1-based lines and columns for the
// model; the protocol's 0-based ones stay inside this module.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
class LspConnection {
    child;
    timeoutMs;
    nextId = 1;
    pending = new Map();
    buffer = Buffer.alloc(0);
    diagnostics = new Map();
    diagnosticWaiters = new Map();
    opened = new Map();
    dead;
    constructor(child, timeoutMs) {
        this.child = child;
        this.timeoutMs = timeoutMs;
        child.stdout.on('data', (chunk) => this.onData(chunk));
        child.on('exit', (code) => this.fail(`exited with code ${String(code)}`));
        child.on('error', (e) => this.fail(e.message));
    }
    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd < 0)
                return;
            const length = Number(/content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
            if (!Number.isFinite(length)) {
                this.buffer = this.buffer.subarray(headerEnd + 4);
                continue;
            }
            if (this.buffer.length < headerEnd + 4 + length)
                return;
            const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
            this.buffer = this.buffer.subarray(headerEnd + 4 + length);
            let msg;
            try {
                msg = JSON.parse(body);
            }
            catch {
                continue;
            }
            if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
                this.diagnostics.set(msg.params.uri, msg.params.diagnostics ?? []);
                for (const w of this.diagnosticWaiters.get(msg.params.uri) ?? [])
                    w();
                this.diagnosticWaiters.delete(msg.params.uri);
                continue;
            }
            if (msg.method !== undefined) {
                // Server requests (workspace/configuration, window/workDoneProgress/create): answer emptily.
                if (msg.id !== undefined)
                    this.write({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'workspace/configuration' ? [] : null });
                continue;
            }
            const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
            if (!p)
                continue;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error)
                p.reject(new Error(`language server: ${msg.error.message}`));
            else
                p.resolve(msg.result);
        }
    }
    fail(reason) {
        if (this.dead)
            return;
        this.dead = reason;
        for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error(`language server ${reason}`));
            this.pending.delete(id);
        }
    }
    write(msg) {
        const body = Buffer.from(JSON.stringify(msg), 'utf8');
        this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
    }
    notify(method, params) {
        this.write({ jsonrpc: '2.0', method, params });
    }
    request(method, params) {
        if (this.dead)
            return Promise.reject(new Error(`language server ${this.dead}`));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`language server: ${method} timed out after ${this.timeoutMs} ms`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }
    /** Opens (or refreshes) a document so the server analyses its current text. */
    sync(uri, languageId, text) {
        const version = (this.opened.get(uri) ?? 0) + 1;
        if (version === 1)
            this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
        else
            this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
        this.opened.set(uri, version);
        this.diagnostics.delete(uri);
    }
    waitDiagnostics(uri, ms) {
        if (this.diagnostics.has(uri))
            return Promise.resolve(this.diagnostics.get(uri));
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                resolve(this.diagnostics.get(uri) ?? []);
            };
            const timer = setTimeout(done, ms);
            const list = this.diagnosticWaiters.get(uri) ?? [];
            list.push(done);
            this.diagnosticWaiters.set(uri, list);
        });
    }
    /** Stops the server and waits for it to exit (its working directory is the workspace). */
    close() {
        this.fail('was closed');
        if (this.child.exitCode !== null)
            return Promise.resolve();
        const exited = new Promise((resolve) => this.child.once('exit', () => resolve()));
        this.child.kill();
        return exited;
    }
}
export class LspManager {
    workspaceRoot;
    servers;
    connections = new Map();
    constructor(workspaceRoot, servers) {
        this.workspaceRoot = workspaceRoot;
        this.servers = servers;
    }
    get configured() {
        return Object.keys(this.servers).length > 0;
    }
    serverFor(file) {
        const ext = path.extname(file).toLowerCase();
        const hit = Object.entries(this.servers).find(([, s]) => s.extensions.map((e) => e.toLowerCase()).includes(ext));
        if (!hit)
            throw new Error(`no language server is configured for ${ext || 'this file'}; configured: ${Object.keys(this.servers).join(', ')}`);
        return hit;
    }
    connect(name, config) {
        let c = this.connections.get(name);
        if (!c) {
            c = (async () => {
                const [exe, ...args] = config.command;
                if (!exe)
                    throw new Error(`lsp server ${name} has an empty command`);
                const child = spawn(exe, args, { cwd: this.workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
                child.stderr.resume();
                const conn = new LspConnection(child, config.timeoutMs ?? 30_000);
                const rootUri = pathToFileURL(this.workspaceRoot).href;
                await conn.request('initialize', {
                    processId: process.pid,
                    rootUri,
                    workspaceFolders: [{ uri: rootUri, name: path.basename(this.workspaceRoot) }],
                    capabilities: {
                        textDocument: {
                            definition: { linkSupport: true },
                            references: {},
                            hover: { contentFormat: ['plaintext', 'markdown'] },
                            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                            publishDiagnostics: {},
                        },
                    },
                });
                conn.notify('initialized', {});
                return conn;
            })();
            this.connections.set(name, c);
            c.catch(() => this.connections.delete(name));
        }
        return c;
    }
    rel(uri) {
        try {
            const p = fileURLToPath(uri);
            const r = path.relative(this.workspaceRoot, p);
            return r.startsWith('..') ? p : r.split(path.sep).join('/');
        }
        catch {
            return uri;
        }
    }
    loc(l) {
        const uri = l.targetUri ?? l.uri ?? '';
        const range = l.targetSelectionRange ?? l.range;
        return { path: this.rel(uri), line: (range?.start.line ?? 0) + 1, column: (range?.start.character ?? 0) + 1 };
    }
    /** `file` is workspace-relative and already checked by the caller; line/column are 1-based. */
    async query(op, file, fullPath, line = 1, column = 1) {
        const [name, config] = this.serverFor(file);
        const conn = await this.connect(name, config);
        const uri = pathToFileURL(fullPath).href;
        conn.sync(uri, config.languageId ?? path.extname(file).slice(1), fs.readFileSync(fullPath, 'utf8'));
        const position = { line: Math.max(0, line - 1), character: Math.max(0, column - 1) };
        const doc = { textDocument: { uri } };
        switch (op) {
            case 'definition': {
                const r = (await conn.request('textDocument/definition', { ...doc, position }));
                return { locations: (Array.isArray(r) ? r : r ? [r] : []).slice(0, 50).map((l) => this.loc(l)) };
            }
            case 'references': {
                const r = (await conn.request('textDocument/references', { ...doc, position, context: { includeDeclaration: true } }));
                return { locations: (r ?? []).slice(0, 200).map((l) => this.loc(l)), total: r?.length ?? 0 };
            }
            case 'hover': {
                const r = (await conn.request('textDocument/hover', { ...doc, position }));
                const c = r?.contents;
                const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x.value ?? '')).join('\n') : (c?.value ?? '');
                return { text: text.slice(0, 8_000) };
            }
            case 'diagnostics': {
                const list = (await conn.waitDiagnostics(uri, config.timeoutMs ?? 10_000));
                const severity = ['', 'error', 'warning', 'information', 'hint'];
                return {
                    diagnostics: list.slice(0, 200).map((d) => ({
                        line: d.range.start.line + 1,
                        column: d.range.start.character + 1,
                        severity: severity[d.severity ?? 1] ?? 'error',
                        message: d.message,
                        ...(d.source ? { source: d.source } : {}),
                    })),
                };
            }
            case 'symbols': {
                const r = (await conn.request('textDocument/documentSymbol', doc));
                const out = [];
                const walk = (items, prefix) => {
                    for (const s of items ?? []) {
                        if (out.length >= 300)
                            return;
                        out.push({ name: prefix + s.name, kind: s.kind, line: ((s.range ?? s.location?.range)?.start.line ?? 0) + 1 });
                        walk(s.children, `${prefix}${s.name}.`);
                    }
                };
                walk(r, '');
                return { symbols: out };
            }
        }
    }
    async close() {
        for (const c of this.connections.values()) {
            try {
                await (await c).close();
            }
            catch {
                // A server that failed to start has nothing to close.
            }
        }
    }
}
