import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ExecRpcError } from './exec-rpc.js';
import { TOOLS_BY_NAME, TOOLS_BY_SDK, validate } from './tool-registry.js';
import { loadSkill } from './skills.js';
import { hostAllowed, webFetch, webSearch } from './web.js';
/** True when a tool schema itself declares an `args` property (e.g. mcp_call). */
function schemaAllowsArg(schema, key) {
    if (schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, key))
        return true;
    return schema.anyOf?.some((child) => schemaAllowsArg(child, key)) ?? false;
}
/**
 * Some models wrap the argument object twice (`{ args: { command } }`) or send
 * it as a JSON string. Unwrap that shape for tools that do not declare a real
 * `args` field. `mcp_call` is left alone because `args` is meaningful there.
 */
export function normalizeToolArgs(spec, input) {
    let args = { ...input };
    for (let depth = 0; depth < 3; depth += 1) {
        if (args.args === undefined || schemaAllowsArg(spec.input, 'args'))
            break;
        let inner = args.args;
        if (typeof inner === 'string') {
            try {
                inner = JSON.parse(inner);
            }
            catch {
                break;
            }
        }
        if (!inner || typeof inner !== 'object' || Array.isArray(inner))
            break;
        const merged = { ...inner };
        for (const [key, value] of Object.entries(args)) {
            // Keep outer options such as root/cwd/foregroundWaitMs; the inner object
            // carries the actual command/path/patch.
            if (key !== 'args' && value !== undefined)
                merged[key] = value;
        }
        args = merged;
    }
    return args;
}
/**
 * Accepts the absolute cwd models often copy from the workspace banner, but
 * only when it resolves inside the primary workspace. The exec server still
 * receives a workspace-relative path.
 */
export function normalizeShellCwd(workspaceRoot, cwd) {
    const value = cwd.trim();
    if (!value)
        return '.';
    if (!path.isAbsolute(value)) {
        if (value.includes(':')) {
            throw new Error(`cwd must be a path, not a root-qualified path: ${cwd}`);
        }
        return value;
    }
    const root = path.resolve(workspaceRoot);
    const resolved = path.resolve(value);
    const rel = path.relative(root, resolved);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new Error(`cwd must be inside the primary workspace: ${cwd}`);
    }
    return rel === '' ? '.' : rel;
}
/**
 * Windows PowerShell 5.1 serializes stderr as CLIXML when a command fails.
 * Return the human-readable error strings instead of XML noise.
 */
export function cleanPowerShellOutput(text) {
    if (!text.includes('#< CLIXML') && !text.includes('<Objs'))
        return text;
    const errors = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((match) => match[1] ?? '');
    const source = errors.length > 0 ? errors.join('') : text;
    return source
        .replace(/_x000D__x000A_/g, '\n')
        .replace(/_x000D_/g, '\r')
        .replace(/_x000A_/g, '\n')
        .replace(/_x0009_/g, '\t')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/^#< CLIXML\s*/, '')
        .replace(/<\/?Objs[^>]*>/g, '')
        .replace(/<\/?S[^>]*>/g, '')
        .trim();
}
/** `spill://<session>/<call>` → file under the spill directory, or undefined. */
export function spillFile(spillDir, rel) {
    const m = /^spill:\/\/([\w-]+\/[\w.-]+)$/.exec(rel);
    if (!m || !spillDir)
        return undefined;
    return path.join(spillDir, `${m[1]}.txt`);
}
/**
 * An error that ends the run (or the ralph round) instead of being returned to
 * the model as a tool error, e.g. Guardian's three-strike breaker.
 */
export class AbortRunError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AbortRunError';
    }
}
function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function normalizeRel(root, full) {
    return path.relative(root, full).split(path.sep).join('/');
}
function resolveInside(root, rel) {
    if (!rel || path.isAbsolute(rel) || rel.includes(':')) {
        throw new Error(`path must be relative to the workspace: ${rel}`);
    }
    const full = path.resolve(root, rel);
    const real = fs.realpathSync.native(full);
    const rootReal = fs.realpathSync.native(root);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new Error(`path escapes the workspace: ${rel}`);
    }
    return real;
}
/** Directories `tools.search.*` never enters. */
const SEARCH_SKIP = new Set(['.git', 'node_modules', '.hy-harness']);
const GREP_MAX_FILE_BYTES = 1024 * 1024;
/** Glob → RegExp for workspace-relative `/` paths: `**`, `*`, `?`, `{a,b}`. */
export function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                // `**/` matches zero or more directories; a trailing `**` matches anything.
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                }
                else {
                    re += '.*';
                    i += 1;
                }
            }
            else {
                re += '[^/]*';
            }
        }
        else if (c === '?')
            re += '[^/]';
        else if (c === '{') {
            const end = glob.indexOf('}', i);
            if (end < 0)
                re += '\\{';
            else {
                re += `(?:${glob
                    .slice(i + 1, end)
                    .split(',')
                    .map((alt) => globToRegExp(alt).source.slice(1, -1))
                    .join('|')})`;
                i = end;
            }
        }
        else
            re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c;
    }
    return new RegExp(`^${re}$`, 'i');
}
/** Many readers or one writer, in arrival order for writers. */
export class AsyncRwLock {
    readers = 0;
    writer = false;
    queue = [];
    async read(fn) {
        await this.acquire(false);
        try {
            return await fn();
        }
        finally {
            this.readers -= 1;
            this.drain();
        }
    }
    async write(fn) {
        await this.acquire(true);
        try {
            return await fn();
        }
        finally {
            this.writer = false;
            this.drain();
        }
    }
    acquire(write) {
        if (this.queue.length === 0 && !this.writer && (!write || this.readers === 0)) {
            if (write)
                this.writer = true;
            else
                this.readers += 1;
            return Promise.resolve();
        }
        return new Promise((wake) => this.queue.push({ write, wake }));
    }
    drain() {
        while (this.queue.length > 0 && !this.writer) {
            const next = this.queue[0];
            if (next.write) {
                if (this.readers > 0)
                    return;
                this.queue.shift();
                this.writer = true;
                next.wake();
                return;
            }
            this.queue.shift();
            this.readers += 1;
            next.wake();
        }
    }
}
export class ToolRuntime {
    exec;
    workspaceRoot;
    approve;
    enforceProtectedPaths;
    options;
    readHashes = new Map();
    subCallLock = new AsyncRwLock();
    claim;
    plan = [];
    /** Plan mode's read-only set, over `options.allowTools`. */
    allowOverride;
    /** Per-turn cancellation, set by the conversation before each turn. */
    activeSignal;
    roots;
    constructor(exec, workspaceRoot, approve, enforceProtectedPaths = false, options = {}) {
        this.exec = exec;
        this.workspaceRoot = workspaceRoot;
        this.approve = approve;
        this.enforceProtectedPaths = enforceProtectedPaths;
        this.options = options;
        this.roots = options.roots?.length
            ? [...options.roots]
            : [{ id: 'main', path: workspaceRoot, label: path.basename(workspaceRoot), writable: true }];
    }
    root(ref) {
        if (!ref)
            return this.roots[0];
        const match = this.roots.find((root) => root.id.toLowerCase() === ref.toLowerCase());
        if (!match)
            throw new Error(`unknown workspace root: ${ref}`);
        return match;
    }
    /** `main:src/a.ts` selects a root; a bare path always uses the primary root. */
    splitRoot(input) {
        if (path.isAbsolute(input)) {
            const normalized = path.resolve(input);
            const match = this.roots.find((root) => {
                const base = path.resolve(root.path);
                return normalized === base || normalized.startsWith(base + path.sep);
            });
            if (!match)
                throw new Error(`absolute path is outside every configured root: ${input}`);
            return { root: match, rel: path.relative(match.path, normalized).split(path.sep).join('/') };
        }
        const colon = input.indexOf(':');
        if (colon > 0) {
            const id = input.slice(0, colon);
            const match = this.roots.find((root) => root.id.toLowerCase() === id.toLowerCase());
            if (match)
                return { root: match, rel: input.slice(colon + 1) };
        }
        return { root: this.roots[0], rel: input };
    }
    resolveRootPath(input, allowMissing = false) {
        const { root, rel } = this.splitRoot(input);
        const clean = rel.replace(/\\/g, '/').replace(/^\.\/+/, '');
        if (!clean || path.posix.isAbsolute(clean) || clean.split('/').includes('..')) {
            throw new Error(`path must be relative to ${root.id}: ${input}`);
        }
        const full = path.resolve(root.path, clean);
        const rootReal = fs.realpathSync.native(root.path);
        const existing = fs.existsSync(full);
        if (existing) {
            const real = fs.realpathSync.native(full);
            if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
                throw new Error(`path escapes ${root.id}: ${input}`);
            }
            return { root, rel: normalizeRel(rootReal, real), full: real };
        }
        if (!allowMissing)
            throw new Error(`path does not exist in ${root.id}: ${input}`);
        // Check the nearest existing ancestor so a junction cannot redirect a new file.
        let ancestor = path.dirname(full);
        while (ancestor !== rootReal && ancestor !== path.dirname(ancestor)) {
            if (fs.existsSync(ancestor)) {
                const real = fs.realpathSync.native(ancestor);
                if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
                    throw new Error(`path escapes ${root.id}: ${input}`);
                }
                break;
            }
            ancestor = path.dirname(ancestor);
        }
        return { root, rel: normalizeRel(rootReal, full), full };
    }
    qualified(root, rel) {
        return root.id === 'main' ? rel : `${root.id}:${rel}`;
    }
    /**
     * Dispatches one call after checking it against the registry's JSON Schema
     * (design §2). SDK-only tools (`search_*`, `job_*`) exist only inside
     * `run_code` (`viaSdk`).
     */
    /** Sets (or clears) the cancellation signal for the current turn. */
    setSignal(signal) {
        this.activeSignal = signal;
    }
    get signal() {
        return this.activeSignal ?? this.options.signal;
    }
    async execute(name, args, viaSdk = false) {
        if (this.signal?.aborted)
            throw new AbortRunError('round aborted');
        const run = async () => {
            try {
                return await this.dispatch(name, args, viaSdk);
            }
            catch (error) {
                if (this.signal?.aborted)
                    throw new AbortRunError('round aborted');
                throw error;
            }
        };
        const hooks = this.options.hooks;
        if (!hooks)
            return run();
        const blocked = await hooks.preToolUse(name, args);
        if (blocked !== undefined)
            throw new Error(`${name} blocked by a preToolUse hook: ${blocked}`);
        try {
            const result = await run();
            await hooks.postToolUse(name, args, { result });
            return result;
        }
        catch (error) {
            await hooks.postToolUse(name, args, { error: error instanceof Error ? error.message : String(error) });
            throw error;
        }
    }
    /** A built-in or plugin tool's spec. */
    spec(name) {
        return TOOLS_BY_NAME.get(name) ?? this.options.plugins?.get(name)?.spec;
    }
    isReadOnly(name) {
        return this.spec(name)?.readOnly === true;
    }
    async dispatch(name, args, viaSdk) {
        const spec = this.spec(name);
        if (!spec)
            throw new Error(`unknown tool: ${name}`);
        if (spec.objectiveOnly && !this.options.objective)
            throw new Error(`${name} is only available in hy ralph sessions`);
        if (!spec.wire && !viaSdk)
            throw new Error(`${name} is only available inside run_code as tools.${spec.sdk}`);
        if (spec.requires === 'skills' && !this.options.skills?.length)
            throw new Error(`${name}: this session has no skills`);
        if (spec.requires === 'mcp' && !this.options.mcp?.tools.length)
            throw new Error(`${name}: this session has no MCP tools`);
        if (spec.requires === 'ask' && !this.options.askUser)
            throw new Error(`${name}: no user is available (not an interactive session)`);
        if (spec.requires === 'memory' && !this.options.memory)
            throw new Error(`${name}: workspace memory is off (--memory or memory.enabled)`);
        if (spec.requires === 'lsp' && !this.options.lsp?.configured)
            throw new Error(`${name}: no language server is configured (lsp in the user config)`);
        if (spec.requires === 'search' && !this.options.web?.searchUrl)
            throw new Error(`${name}: no search endpoint (web.searchUrl) is configured`);
        if (spec.requires === 'web' && !this.options.web)
            throw new Error(`${name}: web access is off (hy --web or web.enabled)`);
        if (spec.requires === 'delegate' && !this.options.delegate)
            throw new Error(`${name} is not available here (subagents cannot delegate)`);
        const allow = this.allowOverride ?? this.options.allowTools;
        if (allow && !allow.has(name))
            throw new Error(`${name} is not allowed in this read-only session`);
        const a = normalizeToolArgs(spec, (args ?? {}));
        // Accepted alias, kept out of the schema to save prompt tokens.
        if (name === 'apply_patch' && a.file === undefined && typeof a.path === 'string')
            a.file = a.path;
        const problems = validate(spec.input, a);
        if (problems.length > 0) {
            const hint = name === 'shell' && problems.some((problem) => problem.includes('command'))
                ? ' (expected {"tool":"shell","args":{"command":"..."}}; do not nest args)'
                : '';
            throw new Error(`invalid arguments for ${name}: ${problems.join('; ')}${hint}`);
        }
        const plugin = this.options.plugins?.get(name);
        if (plugin) {
            const value = await plugin.run(a, { workspaceRoot: this.workspaceRoot });
            return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { value };
        }
        switch (name) {
            case 'read_file':
                return this.readFile(a);
            case 'apply_patch':
                return this.applyPatch(a);
            case 'shell':
                return this.shell(a);
            case 'run_code':
                return this.runCode(a);
            case 'search_glob':
                return this.searchGlob(a);
            case 'search_grep':
                return this.searchGrep(a);
            case 'job_status':
                return { ...(await this.exec.jobStatus(String(a.jobId))) };
            case 'job_output':
                return {
                    ...(await this.exec.jobOutput(String(a.jobId), a.offset === undefined ? 0 : Number(a.offset), a.maxBytes === undefined ? undefined : Number(a.maxBytes))),
                };
            case 'job_wait':
                return {
                    ...(await this.exec.jobWait(String(a.jobId), a.timeoutMs === undefined ? undefined : Number(a.timeoutMs), this.signal)),
                };
            case 'job_kill':
                return { ...(await this.exec.jobKill(String(a.jobId))) };
            case 'claim_complete':
                this.claim = String(a.summary);
                return { accepted: true, note: 'The claim ends this round; independent gates will now verify it.' };
            case 'rationale_upsert':
                return this.ledger().upsert(a);
            case 'rationale_supersede':
                return this.ledger().supersede(a);
            case 'rationale_remove':
                return this.ledger().remove(a);
            case 'update_plan': {
                const plan = a.plan;
                if (plan.filter((s) => s.status === 'in_progress').length > 1)
                    throw new Error('at most one step may be in_progress');
                this.plan = plan.map((s) => ({ step: s.step, status: s.status }));
                return { ok: true, remaining: plan.filter((s) => s.status !== 'completed').length };
            }
            case 'delegate': {
                const r = await this.options.delegate(String(a.task), a.readOnly !== false);
                return { final: r.final, steps: r.steps };
            }
            case 'ask_user':
                return { answer: await this.options.askUser(String(a.question)) };
            case 'memory':
                if (a.action === 'forget')
                    return this.options.memory.forget(String(a.key));
                if (typeof a.text !== 'string')
                    throw new Error('memory save needs text');
                return this.options.memory.save(String(a.key), a.text);
            case 'lsp': {
                const rel = String(a.path);
                const full = resolveInside(this.workspaceRoot, rel);
                return this.options.lsp.query(a.op, normalizeRel(this.workspaceRoot, full), full, a.line === undefined ? undefined : Number(a.line), a.column === undefined ? undefined : Number(a.column));
            }
            case 'web_search':
                return webSearch(String(a.query), this.options.web, a.maxResults === undefined ? undefined : Number(a.maxResults));
            case 'web_fetch':
                return this.webFetch(String(a.url));
            case 'mcp_call':
                return this.mcpCall(String(a.server), String(a.tool), a.args ?? {});
            case 'skill_load':
                return loadSkill(this.options.skills ?? [], String(a.name), a.file === undefined ? undefined : String(a.file));
            default:
                throw new Error(`unknown tool: ${name}`);
        }
    }
    /** Restricts the tools (plan mode) or lifts the restriction (undefined). */
    setAllowTools(allow) {
        this.allowOverride = allow;
    }
    /** The latest `update_plan` list. */
    currentPlan() {
        return this.plan;
    }
    /** The claim made since the last call, if any (read once by the agent). */
    takeClaim() {
        const c = this.claim;
        this.claim = undefined;
        return c;
    }
    ledger() {
        if (!this.options.ledger)
            throw new Error('the rationale ledger is not available in this session');
        return this.options.ledger;
    }
    /** Workspace files (relative, `/`-separated) in stable order; no links followed. */
    *walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
        for (const e of entries) {
            if (e.isSymbolicLink())
                continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!SEARCH_SKIP.has(e.name))
                    yield* this.walk(full);
            }
            else if (e.isFile()) {
                yield path.relative(dir, full).split(path.sep).join('/');
            }
        }
    }
    searchGlob(args) {
        const re = globToRegExp(String(args.pattern));
        const max = Number(args.maxResults ?? 200);
        const selected = args.root === '*' ? this.roots : [this.root(typeof args.root === 'string' ? args.root : undefined)];
        const files = [];
        for (const root of selected) {
            for (const rel of this.walk(root.path)) {
                if (!re.test(rel))
                    continue;
                if (files.length >= max)
                    return { files, truncated: true };
                files.push(this.qualified(root, rel));
            }
        }
        return { files, truncated: false };
    }
    searchGrep(args) {
        let re;
        try {
            re = new RegExp(String(args.pattern), args.ignoreCase === true ? 'i' : '');
        }
        catch (error) {
            throw new Error(`invalid regex: ${error instanceof Error ? error.message : String(error)}`);
        }
        const only = typeof args.glob === 'string' ? globToRegExp(args.glob) : undefined;
        const max = Number(args.maxResults ?? 100);
        const selected = args.root === '*' ? this.roots : [this.root(typeof args.root === 'string' ? args.root : undefined)];
        const matches = [];
        let filesSearched = 0;
        for (const root of selected) {
            for (const rel of this.walk(root.path)) {
                if (only && !only.test(rel))
                    continue;
                const full = path.join(root.path, rel);
                let bytes;
                try {
                    if (fs.statSync(full).size > GREP_MAX_FILE_BYTES)
                        continue;
                    bytes = fs.readFileSync(full);
                }
                catch {
                    continue;
                }
                if (bytes.subarray(0, 8192).includes(0))
                    continue;
                filesSearched += 1;
                const lines = bytes.toString('utf8').split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (!re.test(lines[i]))
                        continue;
                    if (matches.length >= max)
                        return { matches, truncated: true, filesSearched };
                    matches.push({ path: this.qualified(root, rel), line: i + 1, text: lines[i].slice(0, 300) });
                }
            }
        }
        return { matches, truncated: false, filesSearched };
    }
    readFile(args) {
        const rawInput = String(args.path ?? '');
        const rootArg = typeof args.root === 'string' ? args.root.trim() : '';
        const alreadyQualified = this.roots.some((root) => rawInput.startsWith(`${root.id}:`));
        const input = rawInput.startsWith('spill://')
            ? rawInput
            : rootArg && !alreadyQualified
                ? `${rootArg}:${rawInput}`
                : rawInput;
        // Spilled tool output (design §8): readable, never editable.
        const spilled = spillFile(this.options.spillDir, input);
        if (input.startsWith('spill://') && !spilled)
            throw new Error(`unknown spill reference: ${input}`);
        let resolved;
        try {
            resolved = spilled ? undefined : this.resolveRootPath(input);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(message.includes('does not exist') ? `${message} (use search_glob/search_grep to locate it)` : message);
        }
        const full = spilled ?? resolved.full;
        const stat = fs.statSync(full);
        if (!stat.isFile())
            throw new Error(`not a file: ${input}`);
        const bytes = fs.readFileSync(full);
        const text = bytes.toString('utf8');
        if (text.includes('\0'))
            throw new Error(`binary file: ${input}`);
        const allLines = text.split(/\r?\n/);
        if (text.endsWith('\n'))
            allLines.pop();
        const totalLines = allLines.length;
        const start = Math.max(1, Number(args.startLine ?? 1));
        const end = Math.min(totalLines, Number(args.endLine ?? totalLines));
        const selected = allLines.slice(start - 1, Math.max(start - 1, end));
        let content = selected.join('\n');
        let truncated = false;
        if (selected.length > 400) {
            content = selected.slice(0, 400).join('\n');
            truncated = true;
        }
        if (content.length > 50_000) {
            content = content.slice(0, 50_000);
            truncated = true;
        }
        const hash = sha256(bytes);
        const normalized = spilled ? input : this.qualified(resolved.root, resolved.rel);
        if (!spilled)
            this.readHashes.set(normalized, hash);
        return {
            path: normalized,
            content,
            totalLines,
            truncated,
            sha256: hash,
            ...(truncated ? { note: 'content truncated; use startLine/endLine to read more' } : {}),
        };
    }
    /** Checks a repository-relative path against the worker's scope. */
    assertWriteScope(rel, rootId = 'main') {
        const scopes = this.options.writeScope;
        if (!scopes || scopes.length === 0)
            return;
        const value = rel.replace(/\\/g, '/').replace(/^\.\/+/, '');
        if (path.posix.isAbsolute(value) || /^[a-zA-Z]:/.test(value) || value.split('/').includes('..')) {
            throw new Error(`worker write outside its scope: ${rel}`);
        }
        const qualified = rootId === 'main' ? value : `${rootId}:${value}`;
        if (!scopes.some((scope) => qualified === scope ||
            qualified.startsWith(`${scope.replace(/\\/g, '/').replace(/\/+$/, '')}/`) ||
            (rootId === 'main' && (value === scope || value.startsWith(`${scope.replace(/\\/g, '/').replace(/\/+$/, '')}/`))))) {
            throw new Error(`worker write outside its scope: ${qualified} (allowed: ${scopes.join(', ')})`);
        }
    }
    /**
     * Extra roots are written directly as the user. They are outside the
     * primary git checkpoint/sandbox, so only whole-file writes are allowed and
     * the caller must have opted the root in as writable.
     */
    writeExtraFile(root, relInput, content) {
        if (root.writable !== true)
            throw new Error(`workspace root ${root.id} is read-only; enable writes for it first`);
        const rel = relInput.replace(/\\/g, '/').replace(/^\.\/+/, '');
        this.assertWriteScope(rel, root.id);
        const resolved = this.resolveRootPath(`${root.id}:${rel}`, true);
        const qualified = `${root.id}:${resolved.rel}`;
        const existed = fs.existsSync(resolved.full);
        if (existed) {
            const expected = this.readHashes.get(qualified);
            if (!expected)
                throw new Error(`read_file is required before editing ${qualified}`);
            const current = sha256(fs.readFileSync(resolved.full));
            if (current !== expected)
                throw new Error(`file changed since read_file: ${qualified} (read the file again)`);
        }
        fs.mkdirSync(path.dirname(resolved.full), { recursive: true });
        const temp = `${resolved.full}.hy-tmp-${process.pid}`;
        fs.writeFileSync(temp, content, 'utf8');
        fs.renameSync(temp, resolved.full);
        const hash = sha256(Buffer.from(content));
        this.readHashes.set(qualified, hash);
        return {
            appliedFiles: [qualified],
            created: existed ? [] : [qualified],
            deleted: [],
            hashes: { [qualified]: hash },
            warnings: [
                `writes to ${root.id} are outside the primary workspace sandbox and git checkpoints; /undo does not restore them`,
            ],
        };
    }
    async applyPatch(args) {
        const rootArg = typeof args.root === 'string' ? args.root.trim() : undefined;
        const root = rootArg ? this.root(rootArg) : undefined;
        if (root && root.id !== 'main') {
            if (typeof args.patch === 'string' && args.patch.trim()) {
                throw new Error(`unified diffs are only supported in the primary root; use file + content for ${root.id}`);
            }
            const file = typeof args.file === 'string' ? args.file : typeof args.path === 'string' ? args.path : undefined;
            const content = typeof args.content === 'string' ? args.content : undefined;
            if (!file || content === undefined)
                throw new Error(`writing ${root.id} needs file + content`);
            const rel = file.startsWith(`${root.id}:`) ? file.slice(root.id.length + 1) : file;
            return this.writeExtraFile(root, rel, content);
        }
        let patch = typeof args.patch === 'string' ? args.patch.trim() : '';
        if (!patch.includes('@@') && !patch.startsWith('---')) {
            const file = typeof args.file === 'string' ? args.file : typeof args.path === 'string' ? args.path : undefined;
            const content = typeof args.content === 'string' ? args.content : undefined;
            if (file && content !== undefined) {
                patch = wholeFilePatch(this.workspaceRoot, file, content);
            }
        }
        if (!patch)
            throw new Error('patch is empty');
        for (const rel of patchPaths(patch)) {
            this.assertWriteScope(rel);
            const full = path.resolve(this.workspaceRoot, rel);
            if (!fs.existsSync(full))
                continue;
            const expected = this.readHashes.get(rel);
            if (!expected) {
                throw new Error(`read_file is required before editing ${rel}`);
            }
            const current = sha256(fs.readFileSync(full));
            if (current !== expected) {
                throw new Error(`file changed since read_file: ${rel} (read the file again)`);
            }
        }
        const result = await this.exec.patch({
            patch,
            dryRun: false,
            enforceProtectedPaths: this.enforceProtectedPaths,
        });
        this.rememberHashes(result);
        return { ...result };
    }
    rememberHashes(result) {
        for (const [rel, hash] of Object.entries(result.hashes)) {
            if (typeof hash === 'string')
                this.readHashes.set(rel.split(path.sep).join('/'), hash);
        }
        for (const rel of result.deleted) {
            this.readHashes.delete(rel.split(path.sep).join('/'));
        }
    }
    async shell(args) {
        const command = String(args.command ?? '');
        if (!command.trim())
            throw new Error('command is empty');
        this.options.shellGuard?.(command);
        // The exec server accepts cwd under the primary workspace or under a
        // configured extra writable root. Added roots are only usable when the
        // user explicitly enabled writes for them.
        const shellRoot = typeof args.root === 'string' ? this.root(args.root) : undefined;
        if (shellRoot && shellRoot.id !== 'main' && shellRoot.writable !== true) {
            throw new Error(`shell cannot run in the read-only root "${shellRoot.id}"; enable writes for it first`);
        }
        let requestedCwd;
        if (shellRoot && shellRoot.id !== 'main') {
            const base = path.resolve(shellRoot.path);
            const rawCwd = args.cwd === undefined ? '.' : String(args.cwd);
            if (!path.isAbsolute(rawCwd) && rawCwd.includes(':')) {
                throw new Error(`cwd must be a path relative to root "${shellRoot.id}": ${rawCwd}`);
            }
            const resolved = path.resolve(base, rawCwd);
            const rel = path.relative(base, resolved);
            if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
                throw new Error(`cwd must be inside the added root "${shellRoot.id}": ${rawCwd}`);
            }
            requestedCwd = resolved;
        }
        else {
            requestedCwd = args.cwd === undefined ? undefined : normalizeShellCwd(this.workspaceRoot, String(args.cwd));
        }
        const requestedWait = args.foregroundWaitMs !== undefined ? Number(args.foregroundWaitMs) : undefined;
        const minWait = this.options.minForegroundWaitMs;
        const foregroundWaitMs = requestedWait !== undefined && minWait !== undefined
            ? Math.max(requestedWait, minWait)
            : requestedWait ?? minWait;
        const base = {
            command,
            mode: 'agent',
            ...(this.options.runId !== undefined ? { runId: this.options.runId } : {}),
            ...(requestedCwd !== undefined ? { cwd: requestedCwd } : {}),
            ...(foregroundWaitMs !== undefined ? { foregroundWaitMs } : {}),
            ...(args.hardTimeoutMs !== undefined ? { hardTimeoutMs: Number(args.hardTimeoutMs) } : {}),
        };
        const release = this.options.shellLock ? await this.options.shellLock.acquire() : undefined;
        try {
            let result;
            try {
                result = await this.exec.exec(base, this.signal, this.options.shellTimeoutMs);
            }
            catch (error) {
                if (!(error instanceof ExecRpcError) || error.code !== -32001)
                    throw error;
                const data = (error.data ?? {});
                if (data.decision !== 'prompt' || !this.approve)
                    throw error;
                const answer = await this.approve({
                    command,
                    ...(data.justification ? { justification: data.justification } : {}),
                    ...(data.matchedRule ? { matchedRule: data.matchedRule } : {}),
                    ...(data.sandbox ? { sandbox: data.sandbox } : {}),
                    ...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
                });
                const decision = typeof answer === 'boolean' ? { approved: answer, by: 'user' } : answer;
                if (!decision.approved) {
                    throw new Error(`command not approved: ${command}${decision.reason ? ` (${decision.by}: ${decision.reason})` : ''}`);
                }
                result = await this.exec.exec({
                    ...base,
                    approval: { by: decision.by, callId: `tool-${Date.now()}` },
                }, this.signal, this.options.shellTimeoutMs);
            }
            if (this.options.noBackgroundShell && result.status === 'backgrounded') {
                if (result.jobId)
                    await this.exec.jobKill(result.jobId).catch(() => undefined);
                throw new Error('worker shell commands must finish in the foreground; run a shorter command or ask the orchestrator to split the task');
            }
            return {
                ...result,
                ...(typeof result.stderr === 'string' ? { stderr: cleanPowerShellOutput(result.stderr) } : {}),
            };
        }
        finally {
            release?.();
        }
    }
    async webFetch(rawUrl) {
        const web = this.options.web;
        let url;
        try {
            url = new URL(rawUrl);
        }
        catch {
            throw new Error(`invalid URL: ${rawUrl}`);
        }
        if (!hostAllowed(url, web.allowDomains)) {
            // The request leaves the sandbox's control, so Guardian never approves it.
            const answer = this.approve
                ? await this.approve({ command: `web_fetch ${url.href}`, justification: 'network request', sandbox: 'unconfined' })
                : false;
            const decision = typeof answer === 'boolean' ? { approved: answer, by: 'user' } : answer;
            if (!decision.approved)
                throw new Error(`web_fetch not approved: ${url.href}`);
        }
        return { ...(await webFetch(url.href, web)) };
    }
    async mcpCall(server, tool, args) {
        const mcp = this.options.mcp;
        const spec = mcp.find(server, tool);
        if (!spec)
            throw new Error(`unknown MCP tool ${server}/${tool}; use one from the MCP tools list`);
        if (mcp.needsApproval(spec)) {
            // MCP servers run unconfined as the user, so Guardian never approves them.
            const command = `mcp ${server}/${tool} ${JSON.stringify(args).slice(0, 500)}`;
            const answer = this.approve ? await this.approve({ command, justification: 'MCP tool call', sandbox: 'unconfined' }) : false;
            const decision = typeof answer === 'boolean' ? { approved: answer, by: 'user' } : answer;
            if (!decision.approved)
                throw new Error(`MCP call not approved: ${server}/${tool}${decision.reason ? ` (${decision.by}: ${decision.reason})` : ''}`);
        }
        const r = await mcp.call(server, tool, args);
        if (r.isError)
            throw new Error(`${server}/${tool} failed: ${r.text}`);
        return { text: r.text, ...(r.structured !== undefined ? { structured: r.structured } : {}) };
    }
    async runCode(args) {
        const code = String(args.code ?? '');
        if (!code.trim())
            throw new Error('code is empty');
        const timeoutMs = Number(args.timeoutMs ?? 120_000);
        const maxSubCalls = Number(args.maxSubCalls ?? 200);
        // A run-ending error inside a sub-call (Guardian's breaker) must end the
        // run, not just reject one promise inside the script.
        let abort;
        const result = await this.exec.ptcRun({ jsCode: code, timeoutMs, maxSubCalls }, async (sdkPath, subArgs) => {
            const spec = TOOLS_BY_SDK.get(sdkPath) ?? (sdkPath.startsWith('plugins.') ? this.options.plugins?.get(sdkPath.slice(8))?.spec : undefined);
            if (sdkPath === 'runCode' || spec?.name === 'run_code')
                throw new Error('run_code cannot nest');
            if (!spec)
                throw new Error(`tools.${sdkPath} does not exist`);
            // Reads in parallel, everything else one at a time (design §2). A
            // read-only subagent only reads, so it may run beside other reads.
            const parallel = spec.readOnly || (spec.name === 'delegate' && subArgs?.readOnly !== false);
            try {
                return parallel
                    ? await this.subCallLock.read(() => this.execute(spec.name, subArgs, true))
                    : await this.subCallLock.write(() => this.execute(spec.name, subArgs, true));
            }
            catch (error) {
                if (error instanceof AbortRunError)
                    abort = error;
                throw error;
            }
        }, this.signal);
        if (abort)
            throw abort;
        if (result.status !== 'ok')
            throw new Error(result.error ?? 'run_code failed');
        return { status: 'ok', value: result.value, logs: result.logs, subCalls: result.subCalls };
    }
}
function wholeFilePatch(root, file, content) {
    const rel = file.split(path.sep).join('/');
    const full = path.resolve(root, rel);
    const oldText = fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '') : undefined;
    const oldLines = oldText === undefined ? [] : oldText.split(/\r?\n/);
    if (oldText !== undefined && oldText.endsWith('\n'))
        oldLines.pop();
    const newLines = content.split(/\r?\n/);
    if (content.endsWith('\n'))
        newLines.pop();
    const oldHeader = oldText === undefined ? '/dev/null' : `a/${rel}`;
    const newHeader = `b/${rel}`;
    const oldStart = oldLines.length === 0 ? 0 : 1;
    const lines = [
        `--- ${oldHeader}`,
        `+++ ${newHeader}`,
        `@@ -${oldStart},${oldLines.length} +1,${newLines.length} @@`,
        ...oldLines.map((l) => `-${l}`),
        ...newLines.map((l) => `+${l}`),
    ];
    if (!content.endsWith('\n') && newLines.length > 0)
        lines.push('\\ No newline at end of file');
    return `${lines.join('\n')}\n`;
}
function patchPaths(patch) {
    const out = new Set();
    for (const line of patch.split('\n')) {
        const m = /^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/.exec(line);
        if (!m)
            continue;
        const raw = m[1].split('\t')[0].trim().replace(/^"|"$/g, '');
        if (raw === '/dev/null')
            continue;
        out.add(raw.split(path.sep).join('/'));
    }
    return [...out];
}
