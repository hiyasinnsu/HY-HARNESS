// The tool registry (design §2): one JSON Schema per tool drives argument
// validation at dispatch, the compact signatures in the system prompt, and the
// `declare namespace tools` SDK shown for `run_code` (`jsonSchemaToTs`).
//
// Four wire tools are offered to the model directly. Everything else
// (`tools.search.*`, `tools.jobs.*`) exists only inside `run_code` scripts,
// so it costs prompt tokens only when PTC is on.
const str = (description) => ({ type: 'string', ...(description ? { description } : {}) });
const int = (description) => ({ type: 'integer', minimum: 0, ...(description ? { description } : {}) });
const bool = { type: 'boolean' };
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const arr = (items) => ({ type: 'array', items });
const nullable = (s) => ({ anyOf: [s, { type: 'null' }] });
const jobInfo = {
    ...obj({
        jobId: str(),
        command: str(),
        state: { type: 'string', enum: ['running', 'exited', 'killed'] },
        exitCode: nullable({ type: 'integer' }),
        outputBytes: { type: 'integer' },
    }, ['jobId', 'command', 'state', 'outputBytes']),
    title: 'Job',
};
const jobId = obj({ jobId: str() }, ['jobId']);
const ledgerSummary = {
    ...obj({ entries: { type: 'integer' }, tokens: { type: 'integer' } }, ['entries', 'tokens']),
    title: 'NoteCount',
};
export const TOOL_SPECS = [
    {
        name: 'read_file',
        sdk: 'readFile',
        wire: true,
        readOnly: true,
        description: 'Read a workspace file (read before editing). Added roots use root:path.',
        input: obj({ path: str(), startLine: int(), endLine: int() }, ['path']),
        output: obj({ content: str(), totalLines: { type: 'integer' }, truncated: bool, sha256: str() }, [
            'content',
            'totalLines',
            'truncated',
            'sha256',
        ]),
    },
    {
        name: 'apply_patch',
        sdk: 'applyPatch',
        wire: true,
        readOnly: false,
        description: 'Diff, or file + content. Read existing files first. Added roots need root and whole-file file + content.',
        input: {
            anyOf: [
                obj({ patch: str() }, ['patch']),
                obj({ file: str(), content: str(), root: str() }, ['file', 'content']),
            ],
        },
        output: obj({ appliedFiles: arr(str()), created: arr(str()), deleted: arr(str()), warnings: arr(str()) }, [
            'appliedFiles',
            'created',
            'deleted',
            'warnings',
        ]),
    },
    {
        name: 'shell',
        sdk: 'shell',
        wire: true,
        readOnly: false,
        description: 'Run a command; after foregroundWaitMs it becomes a job. root: workspace root ID (default main). Windows: PowerShell, not grep/head/find.',
        input: obj({ command: str(), root: str(), cwd: str(), foregroundWaitMs: int(), hardTimeoutMs: int() }, ['command']),
        output: obj({
            status: { type: 'string', enum: ['completed', 'backgrounded'] },
            exitCode: nullable({ type: 'integer' }),
            stdout: str(),
            stderr: str(),
            jobId: nullable(str()),
        }, ['status', 'stdout', 'stderr']),
    },
    {
        name: 'run_code',
        wire: true,
        readOnly: false,
        description: 'Async JavaScript body calling the `tools` SDK below; only its return value and logs come back. Use for 2+ chained calls, loops or filtering.',
        input: obj({ code: str(), description: str(), timeoutMs: int(), maxSubCalls: int() }, ['code']),
        output: obj({ status: { type: 'string', enum: ['ok'] }, value: {}, logs: arr(str()), subCalls: { type: 'integer' } }, [
            'status',
            'logs',
            'subCalls',
        ]),
    },
    {
        name: 'search_glob',
        sdk: 'search.glob',
        wire: false,
        readOnly: true,
        description: 'Glob workspace paths (skips .git, node_modules, .hy-harness). root:* searches all roots.',
        input: obj({ pattern: str(), root: str(), maxResults: int() }, ['pattern']),
        output: obj({ files: arr(str()), truncated: bool }, ['files', 'truncated']),
    },
    {
        name: 'search_grep',
        sdk: 'search.grep',
        wire: false,
        readOnly: true,
        description: 'Regex lines; optional glob. root:* searches all roots.',
        input: obj({ pattern: str(), root: str(), glob: str(), ignoreCase: bool, maxResults: int() }, ['pattern']),
        output: obj({
            matches: arr(obj({ path: str(), line: { type: 'integer' }, text: str() }, ['path', 'line', 'text'])),
            truncated: bool,
            filesSearched: { type: 'integer' },
        }, ['matches', 'truncated', 'filesSearched']),
    },
    { name: 'job_status', sdk: 'jobs.status', wire: false, readOnly: true, description: 'State of a background job.', input: jobId, output: jobInfo },
    {
        name: 'job_output',
        sdk: 'jobs.output',
        wire: false,
        readOnly: true,
        description: 'A page of a job\'s output from offset.',
        input: obj({ jobId: str(), offset: int(), maxBytes: int() }, ['jobId']),
        output: obj({ data: str(), nextOffset: { type: 'integer' }, totalBytes: { type: 'integer' }, eof: bool }, [
            'data',
            'nextOffset',
            'totalBytes',
            'eof',
        ]),
    },
    {
        name: 'job_wait',
        sdk: 'jobs.wait',
        wire: false,
        readOnly: true,
        description: 'Wait up to timeoutMs for a job to finish.',
        input: obj({ jobId: str(), timeoutMs: int() }, ['jobId']),
        output: jobInfo,
    },
    { name: 'job_kill', sdk: 'jobs.kill', wire: false, readOnly: false, description: 'Kill a job and its process tree.', input: jobId, output: jobInfo },
    {
        name: 'rationale_upsert',
        sdk: 'rationale.upsert',
        wire: false,
        readOnly: false,
        description: 'Record a note that survives compaction (max 12 / ~1500 tokens; a new key at the cap fails).',
        input: obj({ key: str(), rule: str(), rationale: str() }, ['key', 'rule']),
        output: ledgerSummary,
    },
    {
        name: 'rationale_supersede',
        sdk: 'rationale.supersede',
        wire: false,
        readOnly: false,
        description: 'Replace note oldKey with a new one.',
        input: obj({ oldKey: str(), newKey: str(), rule: str(), rationale: str() }, ['oldKey', 'newKey', 'rule']),
        output: ledgerSummary,
    },
    {
        name: 'claim_complete',
        sdk: 'objective.claimComplete',
        wire: true,
        readOnly: false,
        objectiveOnly: true,
        description: 'The only way to finish: claim the objective is done. Independent gates verify it; a false claim costs a round.',
        input: obj({ summary: str() }, ['summary']),
        output: obj({ accepted: bool }, ['accepted']),
    },
    { name: 'rationale_remove', sdk: 'rationale.remove', wire: false, readOnly: false, description: 'Delete a note.', input: obj({ key: str() }, ['key']), output: ledgerSummary },
    {
        name: 'update_plan',
        // Wire only: a plan inside a run_code script has no use, and the SDK entry
        // would cost prompt tokens on every PTC request.
        wire: true,
        readOnly: true,
        description: 'Track multi-step work: the full list each time, at most one in_progress.',
        input: obj({
            plan: arr(obj({ step: str(), status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, ['step', 'status'])),
        }, ['plan']),
        output: obj({ ok: bool }, ['ok']),
    },
    {
        name: 'skill_load',
        sdk: 'skills.load',
        wire: true,
        readOnly: true,
        requires: 'skills',
        description: 'Instructions of a listed skill, or one of its files.',
        input: obj({ name: str(), file: str() }, ['name']),
        output: obj({ content: str(), files: arr(str()) }, ['content', 'files']),
    },
    {
        name: 'mcp_call',
        sdk: 'mcp.call',
        wire: true,
        readOnly: false,
        requires: 'mcp',
        description: 'Call a listed MCP tool.',
        input: obj({ server: str(), tool: str(), args: { type: 'object' } }, ['server', 'tool']),
        output: obj({ text: str(), structured: {} }, ['text']),
    },
    {
        name: 'delegate',
        sdk: 'agents.run',
        wire: true,
        // Read-only subagents may run in parallel inside run_code; see ToolRuntime.runCode.
        readOnly: false,
        requires: 'delegate',
        description: 'A fresh subagent does a self-contained subtask and returns its answer; readOnly (default true) = reading only.',
        input: obj({ task: str(), readOnly: bool }, ['task']),
        output: obj({ final: str(), steps: { type: 'integer' } }, ['final', 'steps']),
    },
    {
        name: 'web_fetch',
        sdk: 'web.fetch',
        wire: true,
        readOnly: true,
        requires: 'web',
        description: 'Fetch an http(s) URL as text (may need approval).',
        input: obj({ url: str() }, ['url']),
        output: obj({ status: { type: 'integer' }, title: str(), text: str(), truncated: bool }, ['status', 'text', 'truncated']),
    },
    {
        name: 'web_search',
        sdk: 'web.search',
        wire: true,
        readOnly: true,
        requires: 'search',
        description: 'Search the web; returns URLs, titles and snippets (read pages with web_fetch).',
        input: obj({ query: str(), maxResults: int() }, ['query']),
        output: obj({ results: arr(obj({ url: str(), title: str(), snippet: str() }, ['url', 'title', 'snippet'])) }, ['results']),
    },
    {
        name: 'lsp',
        sdk: 'lsp.query',
        wire: true,
        readOnly: true,
        requires: 'lsp',
        description: 'Language server query on a workspace file: definition, references, hover, diagnostics or symbols (1-based line/column).',
        input: obj({
            op: { type: 'string', enum: ['definition', 'references', 'hover', 'diagnostics', 'symbols'] },
            path: str(),
            line: int(),
            column: int(),
        }, ['op', 'path']),
        output: { type: 'object' },
    },
    {
        name: 'memory',
        wire: true,
        readOnly: false,
        requires: 'memory',
        description: 'Save (or forget) a short fact for future sessions in this workspace: build quirks, user preferences.',
        input: obj({ action: { type: 'string', enum: ['save', 'forget'] }, key: str(), text: str() }, ['action', 'key']),
        output: obj({ entries: { type: 'integer' } }, ['entries']),
    },
    {
        name: 'ask_user',
        wire: true,
        readOnly: true,
        requires: 'ask',
        description: 'Ask the user a question and wait for the answer (only when you cannot decide from the repository).',
        input: obj({ question: str() }, ['question']),
        output: obj({ answer: str() }, ['answer']),
    },
];
/** Tools a read-only subagent (and `hy review`) may use. */
export const READ_ONLY_TOOLS = new Set([
    'read_file',
    'search_glob',
    'search_grep',
    'job_status',
    'job_output',
    'job_wait',
    'skill_load',
    'update_plan',
    'run_code',
    'web_fetch',
    'web_search',
    'lsp',
]);
export const TOOLS_BY_NAME = new Map(TOOL_SPECS.map((t) => [t.name, t]));
export const TOOLS_BY_SDK = new Map(TOOL_SPECS.filter((t) => t.sdk !== undefined).map((t) => [t.sdk, t]));
// ---------------------------------------------------------------- validation
function typeOf(v) {
    if (v === null)
        return 'null';
    if (Array.isArray(v))
        return 'array';
    if (typeof v === 'number')
        return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
}
/**
 * Checks `value` against `schema`; returns the problems (empty when valid).
 * Unknown properties are tolerated (small models add them); types, enums,
 * minimums and required properties are not.
 */
export function validate(schema, value, at = 'args') {
    if (schema.anyOf) {
        const results = schema.anyOf.map((s) => validate(s, value, at));
        if (results.some((r) => r.length === 0))
            return [];
        // Report the alternative that came closest.
        return results.reduce((best, r) => (r.length < best.length ? r : best));
    }
    const actual = typeOf(value);
    if (schema.type !== undefined) {
        const ok = schema.type === actual || (schema.type === 'number' && actual === 'integer');
        if (!ok)
            return [`${at} must be ${schema.type}, got ${actual}`];
    }
    if (schema.enum && !schema.enum.includes(value)) {
        return [`${at} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`];
    }
    if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
        return [`${at} must be >= ${schema.minimum}`];
    }
    const errors = [];
    if (schema.type === 'object' && value && typeof value === 'object') {
        const o = value;
        for (const r of schema.required ?? []) {
            if (o[r] === undefined)
                errors.push(`${at}.${r} is required`);
        }
        for (const [k, s] of Object.entries(schema.properties ?? {})) {
            if (o[k] !== undefined)
                errors.push(...validate(s, o[k], `${at}.${k}`));
        }
    }
    if (schema.type === 'array' && Array.isArray(value) && schema.items) {
        value.forEach((v, i) => errors.push(...validate(schema.items, v, `${at}[${i}]`)));
    }
    return errors;
}
// ---------------------------------------------------------------- rendering
/**
 * Renders a schema as a TypeScript type expression. With `named`, schemas that
 * have a `title` are rendered once into `named` and referenced by name.
 */
export function jsonSchemaToTs(schema, named) {
    if (named && schema.title) {
        if (!named.has(schema.title)) {
            named.set(schema.title, '');
            const { title: _title, ...rest } = schema;
            named.set(schema.title, jsonSchemaToTs(rest, named));
        }
        return schema.title;
    }
    const ts = (s) => jsonSchemaToTs(s, named);
    if (schema.anyOf)
        return schema.anyOf.map(ts).join(' | ');
    if (schema.enum)
        return schema.enum.map((e) => JSON.stringify(e).replace(/"/g, "'")).join(' | ');
    switch (schema.type) {
        case 'string':
            return 'string';
        case 'integer':
        case 'number':
            return 'number';
        case 'boolean':
            return 'boolean';
        case 'null':
            return 'null';
        case 'array': {
            const item = ts(schema.items ?? {});
            return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
        }
        case 'object': {
            if (!schema.properties || Object.keys(schema.properties).length === 0)
                return 'object';
            const required = new Set(schema.required ?? []);
            const fields = Object.entries(schema.properties ?? {}).map(([k, s]) => `${k}${required.has(k) ? '' : '?'}: ${ts(s)}`);
            return `{ ${fields.join('; ')} }`;
        }
        default:
            return 'unknown';
    }
}
/** The `declare namespace tools { … }` block for `run_code` scripts. */
export function renderSdk(specs = TOOL_SPECS, objective = false, features = new Set(), allow) {
    const root = { fns: [], children: new Map() };
    const named = new Map();
    for (const t of specs) {
        if (!t.sdk || t.name === 'run_code' || (t.objectiveOnly && !objective) || (t.requires && !features.has(t.requires)))
            continue;
        if (allow && !allow.has(t.name))
            continue;
        const parts = t.sdk.split('.');
        let node = root;
        for (const p of parts.slice(0, -1)) {
            if (!node.children.has(p))
                node.children.set(p, { fns: [], children: new Map() });
            node = node.children.get(p);
        }
        node.fns.push(`/** ${t.description} */\nfunction ${parts.at(-1)}(args: ${jsonSchemaToTs(t.input, named)}): Promise<${jsonSchemaToTs(t.output, named)}>`);
    }
    const emit = (node, indent) => {
        const lines = [];
        for (const f of node.fns)
            for (const l of f.split('\n'))
                lines.push(indent + l);
        for (const [name, child] of node.children) {
            lines.push(`${indent}namespace ${name} {`, ...emit(child, `${indent}  `), `${indent}}`);
        }
        return lines;
    };
    const types = [...named].map(([name, body]) => `  type ${name} = ${body}`);
    return ['declare namespace tools {', ...types, ...emit(root, '  '), '}'].join('\n');
}
/** The wire tools a session offers. */
export function offeredTools(ptc, specs = TOOL_SPECS, objective = false, features = new Set(), allow) {
    return specs.filter((t) => t.wire &&
        (ptc || t.name !== 'run_code') &&
        (objective || !t.objectiveOnly) &&
        (!t.requires || features.has(t.requires)) &&
        (!allow || allow.has(t.name)));
}
/**
 * A tool's input as native function parameters. Providers require an object
 * at the root, so a root `anyOf` (apply_patch) becomes one object with every
 * alternative's properties optional; dispatch still validates the real schema.
 */
export function nativeParameters(spec) {
    const input = spec.input;
    if (!input.anyOf)
        return input;
    const properties = {};
    for (const alt of input.anyOf)
        Object.assign(properties, alt.properties ?? {});
    return { type: 'object', properties, required: [] };
}
/** The tool section of the system prompt. */
export function renderToolPrompt(ptc, specs = TOOL_SPECS, objective = false, features = new Set(), allow) {
    const wire = offeredTools(ptc, specs, objective, features, allow);
    const lines = ['Tools (call as {"tool":"<name>","args":{...}}):'];
    for (const t of wire) {
        lines.push(`- ${t.name}(args: ${jsonSchemaToTs(t.input)}) → ${jsonSchemaToTs(t.output)}`, `  ${t.description}`);
    }
    if (ptc) {
        lines.push('Inside run_code, use only this SDK (no require, import, fs, process or network):', renderSdk(specs, objective, features, allow));
    }
    return lines.join('\n');
}
