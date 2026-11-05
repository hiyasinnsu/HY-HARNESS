import fs from 'node:fs';
import path from 'node:path';
import { roleApiKey } from './config.js';
/** Messages in Ollama's shape: images as a base64 list beside the text. */
function ollamaMessages(messages) {
    return messages.map((m) => (m.images?.length ? { role: m.role, content: m.content, images: m.images.map((i) => i.data) } : { role: m.role, content: m.content }));
}
/** Messages in the OpenAI Chat Completions shape: images as data-URL content parts. */
function openAiMessages(messages) {
    return messages.map((m) => m.images?.length
        ? {
            role: m.role,
            content: [
                { type: 'text', text: m.content },
                ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
            ],
        }
        : { role: m.role, content: m.content });
}
/** The OpenAI / Ollama `tools` request field. */
function toolsField(tools) {
    return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}
function parseArgs(raw) {
    if (typeof raw !== 'string')
        return raw ?? {};
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
export class LlmError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = 'LlmError';
    }
}
const DEFAULT_RETRY = { retries: 3, baseDelayMs: 500, maxDelayMs: 8_000 };
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted)
            return reject(signal.reason);
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
    });
}
/**
 * POSTs and returns the response text, retrying 429 and 5xx (honoring
 * `Retry-After`) and network errors with exponential backoff (design §9).
 * Other HTTP errors fail at once with `LlmError`.
 */
export async function postWithRetry(label, url, init, retry = DEFAULT_RETRY) {
    for (let attempt = 0;; attempt++) {
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: init.headers,
                body: init.body,
                ...(init.signal !== undefined ? { signal: init.signal } : {}),
            });
        }
        catch (error) {
            if (init.signal?.aborted || attempt >= retry.retries)
                throw error;
            await sleep(Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt), init.signal);
            continue;
        }
        const text = await response.text();
        if (response.ok)
            return text;
        const retriable = response.status === 429 || response.status >= 500;
        if (!retriable || attempt >= retry.retries) {
            throw new LlmError(`${label} HTTP ${response.status}: ${text.slice(0, 800)}`, response.status, text);
        }
        const after = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(after) && after > 0 ? after * 1_000 : retry.baseDelayMs * 2 ** attempt;
        await sleep(Math.min(retry.maxDelayMs, delay), init.signal);
    }
}
export class OllamaProvider {
    role;
    retry;
    name;
    baseUrl;
    constructor(role, retry = DEFAULT_RETRY) {
        this.role = role;
        this.retry = retry;
        this.name = `ollama:${role.model}`;
        this.baseUrl = (role.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    }
    async complete(messages, options) {
        const text = await postWithRetry('ollama', `${this.baseUrl}/api/chat`, {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.role.model,
                messages: ollamaMessages(messages),
                stream: false,
                think: false,
                // Constrained JSON and native tool calls exclude each other.
                ...(options.tools ? { tools: toolsField(options.tools) } : options.json === false ? {} : { format: 'json' }),
                options: {
                    temperature: options.temperature,
                    num_predict: options.maxTokens,
                },
            }),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
        }, this.retry);
        const body = JSON.parse(text);
        const calls = (body.message?.tool_calls ?? []).filter((c) => c.function?.name);
        return {
            content: body.message?.content ?? '',
            usage: {
                inputTokens: body.prompt_eval_count ?? 0,
                outputTokens: body.eval_count ?? 0,
            },
            ...(calls.length > 0 ? { toolCalls: calls.map((c) => ({ name: c.function.name, args: parseArgs(c.function.arguments) })) } : {}),
        };
    }
}
/** OpenAI's reasoning and GPT-5/6+ chat models require `max_completion_tokens`. */
function openAiTokenField(provider, model) {
    if (provider !== 'openai-compatible' && provider !== 'opencode')
        return 'max_tokens';
    const normalized = model.toLowerCase();
    return /(^|[\/:._-])(o[1-9]|gpt-(?:5|6|7|8|9))(?=$|[.\-_:])/.test(normalized)
        ? 'max_completion_tokens'
        : 'max_tokens';
}
/** A 400 saying the chosen token-limit parameter is not supported by this model. */
function alternateTokenField(field, error) {
    if (!(error instanceof LlmError) || error.status !== 400)
        return undefined;
    const body = (error.body ?? error.message).toLowerCase();
    if (!body.includes('unsupported') && !body.includes('not supported') && !body.includes('unknown'))
        return undefined;
    if (field === 'max_tokens' && body.includes('max_completion_tokens'))
        return 'max_completion_tokens';
    if (field === 'max_completion_tokens' && body.includes('max_tokens'))
        return 'max_tokens';
    return undefined;
}
/** gpt-6.1-terra rejects reasoning_effort together with function tools. */
function reasoningEffortConflict(error) {
    if (!(error instanceof LlmError) || error.status !== 400)
        return false;
    const body = (error.body ?? error.message).toLowerCase();
    return body.includes('reasoning_effort') && body.includes('function tools');
}
export class OpenAiProvider {
    role;
    retry;
    sessionId;
    name;
    baseUrl;
    apiKey;
    /** Set for models known to reject effort + tools, or after the first 400. */
    omitEffortWithTools;
    constructor(role, retry = DEFAULT_RETRY, sessionId) {
        this.role = role;
        this.retry = retry;
        this.sessionId = sessionId;
        this.name = `${role.provider}:${role.model}`;
        this.baseUrl = (role.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
        this.omitEffortWithTools = /gpt-6\.1-terra/i.test(role.model);
        const key = roleApiKey(role);
        if (!key) {
            throw new LlmError(`missing API key: set ${role.apiKeyEnv ?? (role.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : role.provider === 'opencode' ? 'OPENCODE_API_KEY' : 'OPENAI_API_KEY')}`);
        }
        this.apiKey = key;
    }
    async complete(messages, options) {
        const opencodeSession = this.sessionId && (this.role.provider === 'opencode' || isOpenCodeHost(this.baseUrl))
            ? `ses_${this.sessionId.replace(/^ses_/, '').replace(/[^a-zA-Z0-9_-]/g, '_')}`
            : undefined;
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            ...(opencodeSession ? { 'x-opencode-session': opencodeSession, 'User-Agent': 'HY-HARNESS/0.1.0' } : {}),
        };
        const payload = (tokenField, withTemperature, omitEffort = this.omitEffortWithTools) => JSON.stringify({
            model: this.role.model,
            messages: openAiMessages(messages),
            [tokenField]: options.maxTokens,
            ...(withTemperature ? { temperature: options.temperature } : {}),
            ...(options.effort && !(options.tools && omitEffort) ? { reasoning_effort: options.effort } : {}),
            ...(options.tools ? { tools: toolsField(options.tools) } : options.json === false ? {} : { response_format: { type: 'json_object' } }),
        });
        const tokenField = openAiTokenField(this.role.provider, this.role.model);
        // OpenAI's newest reasoning models only accept the default temperature.
        const withTemperature = tokenField === 'max_tokens';
        let text;
        try {
            text = await postWithRetry(this.role.provider, `${this.baseUrl}/chat/completions`, { headers, body: payload(tokenField, withTemperature), ...(options.signal !== undefined ? { signal: options.signal } : {}) }, this.retry);
        }
        catch (error) {
            const alternate = alternateTokenField(tokenField, error);
            const omitEffort = reasoningEffortConflict(error);
            if (!alternate && !omitEffort)
                throw error;
            if (omitEffort)
                this.omitEffortWithTools = true;
            const nextField = alternate ?? tokenField;
            text = await postWithRetry(this.role.provider, `${this.baseUrl}/chat/completions`, {
                headers,
                body: payload(nextField, nextField === 'max_tokens', omitEffort || this.omitEffortWithTools),
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
            }, this.retry);
        }
        const body = JSON.parse(text);
        const message = body.choices?.[0]?.message;
        const calls = (message?.tool_calls ?? []).filter((c) => c.function?.name);
        const inputTokens = body.usage?.prompt_tokens ?? 0;
        const hasCache = body.usage?.prompt_cache_hit_tokens !== undefined ||
            body.usage?.prompt_cache_miss_tokens !== undefined ||
            body.usage?.prompt_tokens_details?.cached_tokens !== undefined;
        const cacheHitTokens = body.usage?.prompt_cache_hit_tokens ?? body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        const cacheMissTokens = body.usage?.prompt_cache_miss_tokens ?? Math.max(0, inputTokens - cacheHitTokens);
        const reasoning = message?.reasoning_content?.trim()
            ? message.reasoning_content
            : message?.reasoning?.trim()
                ? message.reasoning
                : undefined;
        return {
            content: message?.content ?? '',
            usage: {
                inputTokens,
                outputTokens: body.usage?.completion_tokens ?? 0,
                ...(hasCache ? { cacheHitTokens, cacheMissTokens } : {}),
            },
            ...(reasoning ? { reasoning } : {}),
            ...(calls.length > 0 ? { toolCalls: calls.map((c) => ({ name: c.function.name, args: parseArgs(c.function.arguments) })) } : {}),
        };
    }
}
export function isOpenCodeHost(baseUrl) {
    try {
        const host = new URL(baseUrl).hostname.toLowerCase();
        return host === 'opencode.ai' || host.endsWith('.opencode.ai');
    }
    catch {
        return false;
    }
}
/** The latest user message that is not a tool result. */
function lastPrompt(messages) {
    return [...messages].reverse().find((m) => m.role === 'user' && !m.content.startsWith('TOOL '))?.content ?? '';
}
/** Removes the harness's `[session goal: …]` / `[plan mode: …]` / root catalog context. */
function stripContext(text) {
    return text
        .replace(/^\[workspace roots\]\n[\s\S]*?\n\n/, '')
        .replace(/^(?:\[[^\]]*\]\n\n)+/, '');
}
/**
 * Deterministic provider used by the offline E2E test and `--mock`.
 * It demonstrates the full tool path without a model server.
 */
export class MockProvider {
    workspaceRoot;
    name = 'mock:scripted';
    step = 0;
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
    }
    async complete(messages) {
        this.step += 1;
        const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        const prompt = stripContext(last);
        let content;
        // Multi-turn probes for `hy chat` / `hy resume` tests: `SAY <text>` answers
        // with the text; `REPEAT FIRST` answers with the conversation's first
        // user message, which proves the history was carried over.
        if (prompt.startsWith('SAY ')) {
            content = JSON.stringify({ final: prompt.slice(4) });
        }
        else if (prompt.startsWith('BLOCK ')) {
            const reason = prompt.slice(6).split('\n')[0]?.trim() || 'blocked by the worker';
            content = JSON.stringify({ final: `STATUS: blocked\nBLOCKED_BY: ${reason}` });
        }
        else if (prompt.startsWith('PARTIAL ')) {
            const reason = prompt.slice(8).split('\n')[0]?.trim() || 'partially done';
            content = JSON.stringify({ final: `STATUS: partial\nBLOCKED_BY: ${reason}` });
        }
        else if (prompt === 'REPEAT FIRST') {
            content = JSON.stringify({ final: `first: ${messages[1]?.content ?? ''}` });
        }
        else if (prompt.startsWith('Review the changes')) {
            // hy review: proves the diff reached the reviewer.
            const added = prompt.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
            content = JSON.stringify({ final: `review: ${added} added line(s); no findings` });
        }
        else if (prompt.startsWith('Create an AGENTS.md')) {
            content = JSON.stringify({ tool: 'apply_patch', args: { file: 'AGENTS.md', content: '# AGENTS\n\nBuild: none.\n' } });
        }
        else if (prompt.startsWith('CALL ')) {
            // `CALL <tool> <json args>`: one call of any tool (plugins, lsp, …).
            // Orchestration tests append assignment context after the JSON, so parse
            // the first complete object rather than the whole remainder.
            const [, tool, ...rest] = prompt.split(' ');
            const raw = rest.join(' ') || '{}';
            const start = raw.indexOf('{');
            const end = raw.lastIndexOf('}');
            content = JSON.stringify({ tool, args: JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw) });
        }
        else if (/^TOOL (RESULT|ERROR) \(/.test(last) && stripContext(lastPrompt(messages)).startsWith('CALL ')) {
            content = JSON.stringify({ final: `called: ${last.split('\n').join(' ').slice(0, 400)}` });
        }
        else if (prompt.startsWith('ASK ')) {
            content = JSON.stringify({ tool: 'ask_user', args: { question: prompt.slice(4) } });
        }
        else if (last.startsWith('TOOL RESULT (ask_user)') || last.startsWith('TOOL ERROR (ask_user)')) {
            content = JSON.stringify({ final: `user said: ${last.split('\n').slice(1).join(' ').trim()}` });
        }
        else if (last.includes('[plan mode: read-only.') && prompt === 'Create the demo file') {
            // In plan mode the mock still tries to write, to prove the tool is refused.
            content = JSON.stringify({ tool: 'apply_patch', args: { file: 'PLAN_ATTEMPT.md', content: 'x\n' } });
        }
        else if (last.startsWith('TOOL ERROR (apply_patch)') && last.includes('not allowed')) {
            content = JSON.stringify({ final: 'plan: write HY_DEMO.md after approval' });
        }
        else if (prompt.startsWith('JSON ')) {
            // Structured output probe: the rest is the final value as raw JSON.
            content = `{"final": ${prompt.slice(5)}}`;
        }
        else if (prompt.startsWith('Your final answer does not match')) {
            content = '{"final": {"ok": true}}';
        }
        else if (prompt.startsWith('FETCH ')) {
            content = JSON.stringify({ tool: 'web_fetch', args: { url: prompt.slice(6) } });
        }
        else if (last.startsWith('TOOL RESULT (web_fetch)') || last.startsWith('TOOL ERROR (web_fetch)')) {
            content = JSON.stringify({ final: `web said: ${last.split('\n').slice(0, 8).join(' ')}` });
        }
        else if (prompt.startsWith('DELEGATE ')) {
            content = JSON.stringify({ tool: 'delegate', args: { task: prompt.slice(9) } });
        }
        else if (last.startsWith('TOOL RESULT (orchestrator_') || last.startsWith('TOOL ERROR (orchestrator_')) {
            content = JSON.stringify({ final: `orchestrator tool finished: ${last.split('\n').slice(0, 6).join(' ').slice(0, 600)}` });
        }
        else if (prompt.startsWith('[worker report]') || prompt.startsWith('[worker approval request]') || prompt.startsWith('[worker heartbeat]')) {
            content = JSON.stringify({ final: 'orchestrator reviewed the worker event' });
        }
        else if (last.startsWith('TOOL RESULT (delegate)') || last.startsWith('TOOL ERROR (delegate)')) {
            content = JSON.stringify({ final: `delegate said: ${last.split('\n').slice(0, 4).join(' ')}` });
        }
        else if (prompt.startsWith('MCP ')) {
            // `MCP <server> <tool> <json args>` → one mcp_call.
            const [, server, tool, ...rest] = prompt.split(' ');
            content = JSON.stringify({ tool: 'mcp_call', args: { server, tool, args: JSON.parse(rest.join(' ') || '{}') } });
        }
        else if (last.startsWith('TOOL RESULT (mcp_call)') || last.startsWith('TOOL ERROR (mcp_call)')) {
            content = JSON.stringify({ final: `mcp said: ${last.split('\n').slice(0, 6).join(' ')}` });
        }
        else if (last.includes('TOOL RESULT (read_file)')) {
            content = JSON.stringify({
                tool: 'apply_patch',
                args: {
                    patch: '--- /dev/null\n' +
                        '+++ b/HY_DEMO.md\n' +
                        '@@ -0,0 +1,3 @@\n' +
                        '+# HY-HARNESS demo\n' +
                        '+\n' +
                        '+Created by the mock provider.\n',
                },
            });
        }
        else if (last.includes('TOOL RESULT (apply_patch)')) {
            content = JSON.stringify({ tool: 'shell', args: { command: 'git status --short' } });
        }
        else if (last.includes('TOOL RESULT (shell)')) {
            // In a hy ralph session the only way to finish is claim_complete (OQ-4).
            const objective = messages[0]?.content.includes('claim_complete(') ?? false;
            content = objective
                ? JSON.stringify({ tool: 'claim_complete', args: { summary: 'Demo complete: HY_DEMO.md was created.' } })
                : JSON.stringify({ final: 'Demo complete: HY_DEMO.md was created.' });
        }
        else {
            const candidate = ['README.md', 'package.json', 'Cargo.toml'].find((p) => fs.existsSync(path.join(this.workspaceRoot, p)));
            content = JSON.stringify({
                tool: 'read_file',
                args: { path: candidate ?? 'README.md' },
            });
        }
        return {
            content,
            usage: { inputTokens: 0, outputTokens: 0 },
        };
    }
}
/** Deterministic compactor for `--mock` runs. */
export class MockCompactorProvider {
    name = 'mock:compactor';
    async complete() {
        return { content: '- (mock summary of earlier steps)', usage: { inputTokens: 0, outputTokens: 0 } };
    }
}
export class MockGraderProvider {
    name = 'mock:grader';
    async complete() {
        return {
            content: JSON.stringify({ pass: true, reasoning: 'mock grader accepted the claim', rollbackRecommended: false }),
            usage: { inputTokens: 0, outputTokens: 0 },
        };
    }
}
/** Deterministic guardian for `--mock` runs: approves with a low risk score. */
export class MockGuardianProvider {
    name = 'mock:guardian';
    async complete() {
        return {
            content: JSON.stringify({ decision: 'approve', riskScore: 10, reason: 'mock guardian approved the command' }),
            usage: { inputTokens: 0, outputTokens: 0 },
        };
    }
}
/**
 * Gemini through the Interactions API (`POST /v1beta/interactions`,
 * verification/sources/gemini_thinking.txt and gemini_tokens.txt).
 *
 * Each request is a single-turn interaction: the system prompt goes in
 * `system_instruction` and the conversation is flattened into `input` with
 * role labels. Stateless multi-turn use would require resending every
 * `thought` block exactly as received, and the agent rewrites its history on
 * compaction; a single turn has no earlier model turns to carry. Usage counts
 * thinking as output, because thinking is billed as output.
 */
export class GeminiProvider {
    role;
    retry;
    name;
    baseUrl;
    apiKey;
    constructor(role, retry = DEFAULT_RETRY) {
        this.role = role;
        this.retry = retry;
        this.name = `gemini:${role.model}`;
        this.baseUrl = (role.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
        const key = roleApiKey(role);
        if (!key)
            throw new LlmError(`missing API key: set ${role.apiKeyEnv ?? 'GEMINI_API_KEY'}`);
        this.apiKey = key;
    }
    async complete(messages, options) {
        if (messages.some((m) => m.images?.length))
            throw new LlmError('the Gemini adapter does not send images yet; use an Ollama or OpenAI-compatible vision model');
        const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
        const turns = messages.filter((m) => m.role !== 'system');
        const input = turns.length === 1
            ? turns[0].content
            : turns.map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${m.content}`).join('\n\n') + '\n\nASSISTANT:';
        const text = await postWithRetry('gemini', `${this.baseUrl}/interactions`, {
            // The key goes in a header, never in the URL.
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
            body: JSON.stringify({
                model: this.role.model,
                input,
                ...(system ? { system_instruction: system } : {}),
                // Caps thinking and output together.
                generation_config: { max_output_tokens: options.maxTokens },
            }),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
        }, this.retry);
        const body = JSON.parse(text);
        const content = (body.steps ?? [])
            .filter((s) => s.type === 'model_output')
            .flatMap((s) => s.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('');
        return {
            content,
            usage: {
                inputTokens: body.usage?.total_input_tokens ?? 0,
                outputTokens: (body.usage?.total_output_tokens ?? 0) + (body.usage?.total_thought_tokens ?? 0),
            },
        };
    }
}
/**
 * Defers provider construction until the role is actually used. The compactor
 * is only needed once context overflows, so a missing key for that role must
 * not block ordinary chat turns.
 */
export class LazyProvider {
    factory;
    provider;
    constructor(factory) {
        this.factory = factory;
    }
    get name() {
        return this.provider?.name ?? 'lazy';
    }
    async complete(messages, options) {
        this.provider ??= this.factory();
        return this.provider.complete(messages, options);
    }
}
export function createProvider(role, workspaceRoot, sessionId) {
    switch (role.provider) {
        case 'mock':
            return new MockProvider(workspaceRoot);
        case 'ollama':
            return new OllamaProvider(role);
        case 'deepseek':
        case 'openai-compatible':
        case 'opencode':
            return new OpenAiProvider(role, undefined, sessionId);
        case 'gemini':
            return new GeminiProvider(role);
    }
}
