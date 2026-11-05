import { createHash } from 'node:crypto';
import { LlmError } from './llm.js';
import { buildSystemPrompt, nativeToolDefs } from './prompt.js';
import { AbortRunError } from './tools.js';
import { Ledger, discoverPinned } from './ledger.js';
import { validate } from './tool-registry.js';
import { looksLikeBrokenToolCall } from './reply-guard.js';
/** The model-visible text of a tool result (also used to rebuild history from the log). */
export function toolResultMessage(name, output) {
    return `TOOL RESULT (${name}):\n${output}`;
}
export function toolErrorMessage(name, message) {
    return `TOOL ERROR (${name}): ${message}\nFix the call or choose another approach.`;
}
/**
 * Rebuilds a run's conversation from its session log (`hy resume`): the user
 * messages, the assistant replies and the tool results exactly as the model saw
 * them. A `turn/undo` drops everything since the matching `turn/start`.
 */
export function rebuildHistory(events, runId) {
    const history = [];
    const turnStarts = new Map();
    const relevant = events.filter((e) => e.runId === runId).sort((a, b) => a.seq - b.seq);
    let lastType = '';
    for (const e of relevant) {
        const p = (e.payload ?? {});
        const prevType = lastType;
        lastType = e.type;
        switch (e.type) {
            case 'turn/start':
                turnStarts.set(Number(p.turn), history.length);
                break;
            case 'turn/undo': {
                const at = turnStarts.get(Number(p.turn));
                if (at !== undefined)
                    history.length = at;
                break;
            }
            case 'user/message':
                history.push({ role: 'user', content: String(p.content ?? '') });
                break;
            case 'assistant/message':
                history.push({ role: 'assistant', content: String(p.content ?? '') });
                break;
            case 'tool/result': {
                const name = String(p.name ?? '');
                const output = String(p.output ?? '');
                const text = p.isError === true ? toolErrorMessage(name, output) : toolResultMessage(name, output);
                // Results of one step's several calls share one user message.
                const prev = history.at(-1);
                if (prevType === 'tool/result' && prev?.role === 'user')
                    prev.content = `${prev.content}\n\n${text}`;
                else
                    history.push({ role: 'user', content: text });
                break;
            }
        }
    }
    return history;
}
function stripFence(text) {
    const t = text.trim();
    if (t.startsWith('```')) {
        return t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
    }
    return t;
}
function parseAction(text) {
    const t = stripFence(text);
    try {
        const parsed = JSON.parse(t);
        if (parsed && typeof parsed === 'object')
            return parsed;
    }
    catch {
        // Fall through to the first balanced object.
    }
    const start = t.indexOf('{');
    if (start < 0)
        return undefined;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < t.length; i++) {
        const c = t[i];
        if (inString) {
            if (escape)
                escape = false;
            else if (c === '\\')
                escape = true;
            else if (c === '"')
                inString = false;
            continue;
        }
        if (c === '"')
            inString = true;
        else if (c === '{')
            depth += 1;
        else if (c === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(t.slice(start, i + 1));
                }
                catch {
                    return undefined;
                }
            }
        }
    }
    return undefined;
}
function truncate(text, max = 20_000) {
    if (text.length <= max)
        return text;
    return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars] …`;
}
/** Appended to the result of an identical consecutive tool call. */
export function repeatReminder(times) {
    return `\n[reminder] This is the same call with the same arguments ${times} times in a row; its result will not change. Change your approach, or finish if the work is done.`;
}
export class Agent {
    options;
    maxSteps;
    maxOutputTokens;
    temperature;
    effort;
    constructor(options) {
        this.options = options;
        this.maxSteps = options.maxSteps ?? 20;
        this.maxOutputTokens = options.maxOutputTokens ?? 4_096;
        this.temperature = options.temperature ?? 0;
        this.effort = options.effort;
    }
    /**
     * Runs one user turn. `history` (from a previous result or `rebuildHistory`)
     * continues an earlier conversation: `hy chat` and `hy resume`.
     */
    async run(objective, history = [], images = [], source) {
        const objectiveMode = this.options.objective ?? false;
        const ptc = this.options.ptc ?? false;
        const extras = {
            ...(this.options.skills ? { skills: this.options.skills } : {}),
            ...(this.options.mcpCatalog ? { mcpCatalog: this.options.mcpCatalog } : {}),
            ...(this.options.delegate ? { delegate: true } : {}),
            ...(this.options.roleInstruction ? { roleInstruction: this.options.roleInstruction } : {}),
            ...(this.options.allowTools ? { allowTools: this.options.allowTools } : {}),
            ...(this.options.web ? { web: true } : {}),
            ...(this.options.search ? { search: true } : {}),
            ...(this.options.lsp ? { lsp: true } : {}),
            ...(this.options.finalSchema ? { finalSchema: this.options.finalSchema } : {}),
            // The date once per turn (DSH time context): the model's own sense of "now" is its training cutoff.
            date: new Date().toISOString().slice(0, 10),
            ...(this.options.ask ? { ask: true } : {}),
            ...(this.options.extraTools?.length ? { extraTools: this.options.extraTools } : {}),
            ...(this.options.memory ? { memory: true } : {}),
        };
        // Native function calling when the provider supports it; a model that
        // rejects tools switches the turn to the JSON text protocol.
        let native = this.options.nativeTools === true;
        const prompt = () => buildSystemPrompt(this.options.workspaceRoot, ptc, objectiveMode, { ...extras, native });
        let base = prompt();
        let nudged = false;
        // Set once a broken tool call has been retried (native mode).
        let brokenRetried = false;
        const ledger = this.options.ledger ?? new Ledger(discoverPinned(this.options.workspaceRoot));
        let messages = [
            { role: 'system', content: base },
            ...history,
            { role: 'user', content: objective, ...(images.length > 0 ? { images } : {}) },
        ];
        this.options.sessionLog.append('user/message', {
            content: objective,
            ...(images.length > 0 ? { images: images.length } : {}),
            ...(source ? { source } : {}),
        });
        const usage = { inputTokens: 0, outputTokens: 0 };
        let lastInputTokens = 0;
        // RepeatToolReminderGuard (design §2, DSH repeat-tool-reminder).
        let lastCall = '';
        let repeats = 0;
        for (let step = 1; step <= this.maxSteps; step++) {
            if (this.options.signal?.aborted)
                throw new AbortRunError('turn cancelled');
            this.options.onEvent?.({ type: 'step-start', step, role: 'worker', model: this.options.provider.name });
            if (this.options.context)
                messages = await this.options.context.beforeRequest(messages, lastInputTokens);
            // Constraints and notes are re-projected verbatim into every request,
            // independent of any compaction summary (Goal 3).
            const sections = [ledger.render(), this.options.memory?.render() ?? ''].filter(Boolean).join('\n\n');
            messages[0] = { role: 'system', content: sections ? `${base}\n\n${sections}` : base };
            let completion;
            try {
                completion = await this.options.provider.complete(messages, {
                    maxTokens: this.maxOutputTokens,
                    temperature: this.temperature,
                    ...(this.effort ? { effort: this.effort } : {}),
                    ...(this.options.signal ? { signal: this.options.signal } : {}),
                    ...(native ? { tools: nativeToolDefs(ptc, objectiveMode, extras) } : {}),
                });
            }
            catch (error) {
                if (this.options.signal?.aborted)
                    throw new AbortRunError('turn cancelled');
                if (native && error instanceof LlmError && error.status === 400 && /tool/i.test(error.message)) {
                    native = false;
                    base = prompt();
                    this.options.sessionLog.append('native-tools/off', { reason: error.message.slice(0, 300) });
                    step -= 1;
                    continue;
                }
                throw error;
            }
            lastInputTokens = completion.usage.inputTokens;
            usage.inputTokens += completion.usage.inputTokens;
            usage.outputTokens += completion.usage.outputTokens;
            usage.cacheHitTokens = (usage.cacheHitTokens ?? 0) + (completion.usage.cacheHitTokens ?? 0);
            usage.cacheMissTokens = (usage.cacheMissTokens ?? 0) + (completion.usage.cacheMissTokens ?? 0);
            if (completion.reasoning?.trim()) {
                const thinkingEvent = this.options.sessionLog.append('assistant/thinking', { content: completion.reasoning });
                this.options.onEvent?.({ type: 'thinking', step, content: truncate(completion.reasoning, 8_000), seq: thinkingEvent.seq });
            }
            this.options.sessionLog.append('step/end', {
                stepIndex: step,
                role: 'worker',
                model: this.options.provider.name,
                usage: completion.usage,
                // Detects prompt-template changes between steps (design §1).
                systemSha256: createHash('sha256').update(messages[0].content).digest('hex').slice(0, 16),
            });
            this.options.onEvent?.({ type: 'step-end', step, usage: completion.usage });
            let content = completion.content.trim();
            let action;
            let calls;
            if (completion.toolCalls && completion.toolCalls.length > 0) {
                calls = completion.toolCalls.map((c) => ({ tool: c.name, args: c.args }));
                // History keeps one string per message: the calls in the text protocol's form.
                content = JSON.stringify(calls.length === 1 ? calls[0] : { calls });
            }
            else {
                action = parseAction(content);
                if (action && Array.isArray(action.calls)) {
                    calls = action.calls.filter((c) => !!c && typeof c.tool === 'string');
                }
                else if (action && typeof action.tool === 'string') {
                    calls = [{ tool: action.tool, args: action.args }];
                }
                else if (native && content && (!action || action.final === undefined)) {
                    if (looksLikeBrokenToolCall(content)) {
                        // A tool call the model failed to emit as a function call arrives
                        // as plain content; showing it as the final answer would present a
                        // broken call as the result. Retry once, then stop with a fixed text.
                        messages.push({ role: 'assistant', content });
                        if (brokenRetried) {
                            const final = 'The model produced an invalid tool call. No changes were made.';
                            this.options.sessionLog.append('turn/end', { status: 'completed' });
                            this.options.onEvent?.({ type: 'final', content: final });
                            return { outcome: 'final', final, steps: step, usage, history: messages.slice(1) };
                        }
                        brokenRetried = true;
                        messages.push({
                            role: 'user',
                            content: 'Your reply looked like a broken tool call. Use a real function call for tools, or reply with a short plain-text summary when finished.',
                        });
                        this.options.sessionLog.append('turn/retry', { step, reason: 'broken-tool-call' });
                        this.options.onEvent?.({ type: 'retry', step, content: truncate(content, 2_000) });
                        continue;
                    }
                    // Native mode: a reply without a tool call is the final answer.
                    action = { final: content };
                }
            }
            if (!action && !calls) {
                messages.push({ role: 'assistant', content });
                const retry = 'Your previous reply was not a single valid JSON object. Reply with exactly one JSON object: ' +
                    '{"tool":"read_file","args":{"path":"..."}} or {"final":"..."}';
                messages.push({ role: 'user', content: retry });
                this.options.sessionLog.append('turn/retry', { step, reason: 'invalid-json' });
                this.options.onEvent?.({ type: 'retry', step, content: truncate(content, 2_000) });
                continue;
            }
            this.options.sessionLog.append('assistant/message', { content });
            this.options.onEvent?.({ type: 'assistant', step, content: truncate(content, 4_000) });
            if (!calls && action && this.options.finalSchema && action.final !== undefined && !objectiveMode) {
                // Structured output: the final value must match the schema; a mismatch
                // is returned to the model like a tool error.
                let value = action.final;
                if (typeof value === 'string') {
                    try {
                        value = JSON.parse(value);
                    }
                    catch {
                        // Validated as the string itself below.
                    }
                }
                const problems = validate(this.options.finalSchema, value, 'final');
                messages.push({ role: 'assistant', content });
                if (problems.length > 0) {
                    const retry = `Your final answer does not match the required schema: ${problems.join('; ')}. Reply again with {"final": <JSON matching the schema>}.`;
                    messages.push({ role: 'user', content: retry });
                    this.options.sessionLog.append('user/message', { content: retry });
                    this.options.onEvent?.({ type: 'retry', step, content: retry });
                    continue;
                }
                const final = JSON.stringify(value);
                this.options.sessionLog.append('turn/end', { status: 'completed' });
                this.options.onEvent?.({ type: 'final', content: final });
                return { outcome: 'final', final, steps: step, usage, history: messages.slice(1) };
            }
            if (!calls && action && typeof action.final === 'string') {
                if (objectiveMode) {
                    // A text-only reply is not a claim (OQ-4): one nudge, then a stall.
                    if (nudged) {
                        this.options.sessionLog.append('turn/end', { status: 'stalled' });
                        messages.push({ role: 'assistant', content });
                        return { outcome: 'stalled', final: action.final, steps: step, usage, history: messages.slice(1) };
                    }
                    nudged = true;
                    messages.push({ role: 'assistant', content });
                    messages.push({
                        role: 'user',
                        content: 'This run finishes only through claim_complete. If the objective is done and verified, call ' +
                            '{"tool":"claim_complete","args":{"summary":"..."}}; otherwise keep working with tools.',
                    });
                    this.options.sessionLog.append('turn/nudge', { step, reason: 'final-without-claim' });
                    continue;
                }
                this.options.sessionLog.append('turn/end', { status: 'completed' });
                messages.push({ role: 'assistant', content });
                this.options.onEvent?.({ type: 'final', content: action.final });
                return { outcome: 'final', final: action.final, steps: step, usage, history: messages.slice(1) };
            }
            if (calls && calls.length > 0) {
                const key = JSON.stringify(calls);
                repeats = key === lastCall ? repeats + 1 : 1;
                lastCall = key;
                const reminder = repeats >= 2 ? repeatReminder(repeats) : '';
                if (reminder)
                    this.options.sessionLog.append('guard/repeat', { tool: calls.map((c) => c.tool).join(','), times: repeats });
                messages.push({ role: 'assistant', content });
                const outcomes = await this.executeCalls(step, calls);
                const parts = outcomes.map((o, i) => {
                    const tail = i === outcomes.length - 1 ? reminder : '';
                    const output = o.output + tail;
                    this.options.sessionLog.append('tool/result', {
                        callId: o.callId,
                        name: o.call.tool,
                        output,
                        isError: !o.ok,
                        ...(o.ok && o.spillRef ? { spillRef: o.spillRef } : {}),
                    });
                    if (o.ok)
                        this.options.onEvent?.({ type: 'tool', step, callId: o.callId, name: o.call.tool, args: o.call.args, result: o.result });
                    else
                        this.options.onEvent?.({ type: 'tool-error', step, callId: o.callId, name: o.call.tool, args: o.call.args, message: output });
                    return o.ok ? toolResultMessage(o.call.tool, output) : toolErrorMessage(o.call.tool, output);
                });
                messages.push({ role: 'user', content: parts.join('\n\n') });
                // claim_complete, directly or from a run_code script, ends the session.
                const claim = this.options.tools.takeClaim();
                if (claim !== undefined) {
                    this.options.sessionLog.append('objective/claim', { summary: claim });
                    this.options.sessionLog.append('turn/end', { status: 'completed' });
                    this.options.onEvent?.({ type: 'final', content: claim });
                    return { outcome: 'claimed', final: claim, steps: step, usage, history: messages.slice(1) };
                }
                continue;
            }
            messages.push({ role: 'assistant', content });
            messages.push({
                role: 'user',
                content: 'Reply with either {"tool":"<name>","args":{...}} or {"final":"..."} and nothing else.',
            });
            this.options.sessionLog.append('turn/retry', { step, reason: 'missing-tool-or-final' });
            this.options.onEvent?.({ type: 'retry', step, content: truncate(content, 2_000) });
        }
        throw new Error(`agent did not finish within ${this.maxSteps} steps`);
    }
    /**
     * Runs one step's calls: all at once when every one is read-only, else in
     * order. Errors become tool errors except run-ending ones.
     */
    async executeCalls(step, calls) {
        const one = async (call, i) => {
            const prefix = this.options.callIdPrefix ?? '';
            const callId = calls.length === 1 ? `${prefix}step-${step}` : `${prefix}step-${step}.${i + 1}`;
            if (this.options.signal?.aborted)
                throw new AbortRunError('turn cancelled');
            this.options.onEvent?.({ type: 'tool-start', step, callId, name: call.tool, args: call.args });
            try {
                const result = await this.options.tools.execute(call.tool, call.args);
                const raw = JSON.stringify(result, null, 2);
                const view = this.options.context?.toolOutput(callId, raw) ?? { visible: truncate(raw) };
                return { call, callId, ok: true, result, output: view.visible, ...(view.spillRef ? { spillRef: view.spillRef } : {}) };
            }
            catch (error) {
                // Run-ending errors (e.g. Guardian's breaker) are not the model's to fix.
                if (error instanceof AbortRunError)
                    throw error;
                return { call, callId, ok: false, output: error instanceof Error ? error.message : String(error) };
            }
        };
        const parallel = calls.length > 1 && calls.every((c) => this.options.tools.isReadOnly(c.tool));
        if (parallel)
            return Promise.all(calls.map(one));
        const out = [];
        for (let i = 0; i < calls.length; i++)
            out.push(await one(calls[i], i));
        return out;
    }
}
