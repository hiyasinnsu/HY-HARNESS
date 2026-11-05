// Model Context Protocol client (stdio transport): external tool servers, as
// in Codex (`mcp_tool_call.rs`) and DSH (`packages/mcp`). Each configured
// server is started once per session; its tools are listed in the system
// prompt and called through the `mcp_call` tool.
//
// Servers come only from the user's own configuration (or a trusted project's),
// like `--verify-cmd`: they run unconfined, as the user. Calls go through the
// approval chain unless the server is marked `trusted` or the tool says it is
// read-only (`annotations.readOnlyHint`).
import { spawn } from 'node:child_process';
import { jsonSchemaToTs } from './tool-registry.js';
export const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_CATALOG_TOOLS = 40;
/** One stdio MCP server: newline-delimited JSON-RPC 2.0. */
export class McpClient {
    name;
    child;
    timeoutMs;
    nextId = 1;
    pending = new Map();
    buffer = '';
    stderrTail = '';
    exited;
    constructor(name, child, timeoutMs) {
        this.name = name;
        this.child = child;
        this.timeoutMs = timeoutMs;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this.onData(chunk));
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-2_000);
        });
        child.on('exit', (code) => this.fail(`exited with code ${String(code)}`));
        child.on('error', (error) => this.fail(error.message));
    }
    static async start(name, config) {
        const child = spawn(config.command, config.args ?? [], {
            cwd: config.cwd,
            env: { ...process.env, ...(config.env ?? {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const client = new McpClient(name, child, config.timeoutMs ?? 60_000);
        await client.request('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'hy-harness', version: '0.1.0' },
        });
        client.notify('notifications/initialized');
        return client;
    }
    onData(chunk) {
        this.buffer += chunk;
        let nl;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                continue; // Servers may log to stdout by mistake; skip non-JSON lines.
            }
            if (msg.method !== undefined) {
                // Server requests (sampling, roots, elicitation) are not supported.
                if (msg.id !== undefined)
                    this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported by hy-harness' } });
                continue;
            }
            const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
            if (!p)
                continue;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error)
                p.reject(new Error(`${this.name}: ${msg.error.message} (${msg.error.code})`));
            else
                p.resolve(msg.result);
        }
    }
    fail(reason) {
        if (this.exited)
            return;
        this.exited = reason;
        const tail = this.stderrTail.trim() ? `; stderr: ${this.stderrTail.trim().slice(-500)}` : '';
        for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error(`MCP server ${this.name} ${reason}${tail}`));
            this.pending.delete(id);
        }
    }
    send(msg) {
        this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    }
    notify(method, params) {
        this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
    }
    request(method, params) {
        if (this.exited)
            return Promise.reject(new Error(`MCP server ${this.name} ${this.exited}`));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP server ${this.name}: ${method} timed out after ${this.timeoutMs} ms`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
        });
    }
    async listTools() {
        const tools = [];
        let cursor;
        do {
            const page = (await this.request('tools/list', cursor !== undefined ? { cursor } : {}));
            for (const t of page.tools ?? []) {
                tools.push({
                    server: this.name,
                    name: t.name,
                    description: (t.description ?? '').replace(/\s+/g, ' ').trim(),
                    inputSchema: t.inputSchema ?? { type: 'object' },
                    readOnly: t.annotations?.readOnlyHint === true,
                });
            }
            cursor = page.nextCursor;
        } while (cursor !== undefined && tools.length < 1_000);
        return tools;
    }
    async callTool(name, args) {
        const r = (await this.request('tools/call', { name, arguments: args ?? {} }));
        const text = (r.content ?? [])
            .map((c) => c.type === 'text'
            ? (c.text ?? '')
            : c.type === 'resource'
                ? (c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`)
                : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''} omitted]`)
            .join('\n');
        return { isError: r.isError === true, text, ...(r.structuredContent !== undefined ? { structured: r.structuredContent } : {}) };
    }
    close() {
        this.fail('was closed');
        this.child.stdin.end();
        this.child.kill();
    }
}
/** All configured servers of a session. A server that fails to start is reported, not fatal. */
export class McpManager {
    clients;
    tools;
    configs;
    errors;
    constructor(clients, tools, configs, errors) {
        this.clients = clients;
        this.tools = tools;
        this.configs = configs;
        this.errors = errors;
    }
    static async start(configs) {
        const clients = new Map();
        const tools = [];
        const errors = [];
        await Promise.all(Object.entries(configs).map(async ([name, config]) => {
            try {
                const client = await McpClient.start(name, config);
                clients.set(name, client);
                const allow = config.tools ? new Set(config.tools) : undefined;
                tools.push(...(await client.listTools()).filter((t) => !allow || allow.has(t.name)));
            }
            catch (error) {
                errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }));
        tools.sort((a, b) => (a.server === b.server ? (a.name < b.name ? -1 : 1) : a.server < b.server ? -1 : 1));
        return new McpManager(clients, tools, configs, errors);
    }
    find(server, tool) {
        return this.tools.find((t) => t.server === server && t.name === tool);
    }
    /** Whether a call needs approval: not for trusted servers or read-only tools. */
    needsApproval(tool) {
        return !(this.configs[tool.server]?.trusted === true || tool.readOnly);
    }
    call(server, tool, args) {
        const client = this.clients.get(server);
        if (!client)
            throw new Error(`MCP server ${server} is not running`);
        return client.callTool(tool, args);
    }
    /** The system-prompt section listing the tools. */
    renderCatalog() {
        if (this.tools.length === 0)
            return '';
        const shown = this.tools.slice(0, MAX_CATALOG_TOOLS);
        const lines = ['MCP tools (call with mcp_call {"server","tool","args"}):'];
        for (const t of shown) {
            lines.push(`- ${t.server}/${t.name}(args: ${jsonSchemaToTs(t.inputSchema)})${t.description ? `: ${t.description.slice(0, 160)}` : ''}`);
        }
        if (this.tools.length > shown.length)
            lines.push(`(${this.tools.length - shown.length} more not listed)`);
        return lines.join('\n');
    }
    close() {
        for (const c of this.clients.values())
            c.close();
    }
}
