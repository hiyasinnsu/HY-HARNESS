import { cleanThinkingSummary, instantThinkingSummary } from './summary-text.js';
function stripFence(text) {
    const t = text.trim();
    if (t.startsWith('```'))
        return t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
    return t;
}
/** Parses the model's action JSON, including a JSON object embedded in prose. */
export function parseModelAction(text) {
    const t = stripFence(text);
    try {
        const parsed = JSON.parse(t);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
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
function parseCalls(action) {
    if (!action)
        return [];
    if (Array.isArray(action.calls)) {
        return action.calls
            .filter((c) => !!c && typeof c === 'object' && typeof c.tool === 'string')
            .map((c) => ({ tool: c.tool, args: c.args }));
    }
    if (typeof action.tool === 'string')
        return [{ tool: action.tool, args: action.args }];
    return [];
}
function parseResult(output) {
    const t = output.trim();
    if (!t.startsWith('{') && !t.startsWith('['))
        return undefined;
    try {
        return JSON.parse(t);
    }
    catch {
        return undefined;
    }
}
const INTERNAL_USER_PREFIXES = [
    'Your previous reply was not a single valid JSON object',
    'Your final answer does not match the required schema',
    'This run finishes only through claim_complete',
    'Reply with either {"tool"',
];
function isInternalUserMessage(text, previousType) {
    if (previousType === 'turn/retry' || previousType === 'turn/nudge')
        return true;
    return INTERNAL_USER_PREFIXES.some((p) => text.startsWith(p));
}
function stripPlanPrefix(text) {
    return text
        .replace(/^\[session goal: [^\]]*\]\n?/, '')
        .replace(/^\[plan mode: read-only\.[^\]]*\]\n?/, '')
        .replace(/^\[session goal: [^\]]*\]\n?/, '')
        .replace(/^\n+/, '');
}
/**
 * Reconstructs the chat surface from a run's durable session events. This is
 * what the GUI shows after a reload; live updates use the same entry shapes.
 */
export function projectChat(events, runId) {
    const entries = [];
    const turnStartIndex = new Map();
    // Tool results are logged in call order, so a queue is more reliable than
    // deriving call ids from the step counter (the log writes step/end first).
    const pendingCalls = [];
    let previousType = '';
    for (const e of events) {
        if (e.runId !== runId)
            continue;
        const p = (e.payload ?? {});
        const ts = e.ts;
        switch (e.type) {
            case 'turn/start': {
                const turn = Number(p.turn ?? 0);
                pendingCalls.length = 0;
                turnStartIndex.set(turn, entries.length);
                break;
            }
            case 'turn/undo': {
                const turn = Number(p.turn ?? 0);
                pendingCalls.length = 0;
                const at = turnStartIndex.get(turn);
                if (at !== undefined)
                    entries.length = at;
                break;
            }
            case 'user/message': {
                const text = stripPlanPrefix(String(p.content ?? ''));
                if (!text || isInternalUserMessage(text, previousType))
                    break;
                if (p.source === 'orchestrator' || p.source === 'worker' || p.source === 'system') {
                    entries.push({ id: `event-${e.seq}`, kind: 'notice', runId, text, ts });
                    break;
                }
                entries.push({ id: `msg-${e.seq}`, kind: 'user', runId, text, ts, ...(Number(p.images ?? 0) > 0 ? { images: Number(p.images) } : {}) });
                break;
            }
            case 'assistant/thinking': {
                const content = String(p.content ?? '').trim();
                if (content) {
                    const summary = instantThinkingSummary(content);
                    entries.push({
                        id: `think-${e.seq}`,
                        kind: 'thinking',
                        runId,
                        text: content,
                        ts,
                        ...(summary ? { summary, summaryProvisional: true } : {}),
                    });
                }
                break;
            }
            case 'thinking/summary': {
                const seq = Number(p.thinkingSeq);
                const summary = cleanThinkingSummary(String(p.summary ?? ''));
                if (!Number.isFinite(seq) || !summary)
                    break;
                const entry = entries.find((candidate) => candidate.id === `think-${seq}`);
                if (entry?.kind === 'thinking') {
                    entry.summary = summary;
                    entry.summaryProvisional = false;
                }
                break;
            }
            case 'assistant/message': {
                const content = String(p.content ?? '').trim();
                if (!content)
                    break;
                const action = parseModelAction(content);
                const calls = parseCalls(action);
                if (calls.length > 0) {
                    pendingCalls.push(...calls);
                    break;
                }
                if (action && typeof action.final === 'string') {
                    entries.push({ id: `msg-${e.seq}`, kind: 'assistant', runId, text: action.final, ts, final: true });
                    break;
                }
                // Native function calling returns a plain-text final answer.
                if (!action || action.final === undefined) {
                    entries.push({ id: `msg-${e.seq}`, kind: 'assistant', runId, text: content, ts });
                }
                break;
            }
            case 'step/end':
                break;
            case 'tool/result': {
                const callId = String(p.callId ?? `tool-${e.seq}`);
                const name = String(p.name ?? 'tool');
                const output = String(p.output ?? '');
                const isError = p.isError === true;
                const call = pendingCalls.shift();
                const args = call?.args;
                entries.push({
                    id: `tool-${callId}`,
                    kind: 'tool',
                    runId,
                    callId,
                    name: call?.tool ?? name,
                    ...(args !== undefined ? { args } : {}),
                    output,
                    ...(parseResult(output) !== undefined ? { result: parseResult(output) } : {}),
                    isError,
                    ts,
                    status: isError ? 'error' : 'done',
                });
                if (name === 'update_plan' && args && typeof args === 'object') {
                    const plan = args.plan;
                    if (Array.isArray(plan)) {
                        entries.push({ id: `plan-${e.seq}`, kind: 'plan', runId, plan: plan, ts });
                    }
                }
                break;
            }
            case 'objective/claim':
                entries.push({ id: `msg-${e.seq}`, kind: 'assistant', runId, text: String(p.summary ?? ''), ts, final: true });
                break;
            case 'turn/retry':
                entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `retrying (${String(p.reason ?? 'invalid response')})`, ts, level: 'warn' });
                break;
            case 'compaction/manual':
                entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `compacted ${String(p.before ?? '?')} → ${String(p.after ?? '?')} messages`, ts });
                break;
            case 'plan-mode':
                entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: p.on === true ? 'plan mode on' : 'plan mode off', ts });
                break;
            case 'model/switch':
                entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `model: ${String(p.model ?? '')}`, ts });
                break;
            case 'goal/set':
                entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: p.goal ? `goal: ${String(p.goal)}` : 'goal cleared', ts });
                break;
            case 'subagent/start':
                entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `subagent ${String(p.readOnly ? 'read-only' : 'write')}`, ts });
                break;
            case 'round/start':
                pendingCalls.length = 0;
                entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `round ${String(p.round ?? '')} started`, ts });
                break;
            case 'round/end':
                entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `round ${String(p.round ?? '')}: ${String(p.outcome ?? '')}`, ts, level: p.outcome === 'succeeded' ? 'info' : 'warn' });
                break;
            default:
                break;
        }
        previousType = e.type;
    }
    return entries;
}
/** Applies one live `AgentEvent` to a chat transcript (the GUI's incremental path). */
export function applyAgentEvent(entries, runId, event) {
    const ts = Date.now();
    switch (event.type) {
        case 'thinking': {
            const content = String(event.content ?? '').trim();
            if (content) {
                const seq = typeof event.seq === 'number' ? event.seq : undefined;
                const summary = instantThinkingSummary(content);
                entries.push({
                    id: seq !== undefined ? `think-${seq}` : `think-${ts}-${entries.length}`,
                    kind: 'thinking',
                    runId,
                    text: content,
                    ts,
                    ...(summary ? { summary, summaryProvisional: true } : {}),
                });
            }
            break;
        }
        case 'assistant': {
            const content = String(event.content ?? '').trim();
            if (!content)
                break;
            const action = parseModelAction(content);
            if (action && (action.tool !== undefined || Array.isArray(action.calls)))
                break;
            if (action && typeof action.final === 'string')
                break;
            entries.push({ id: `live-${ts}-${entries.length}`, kind: 'assistant', runId, text: content, ts });
            break;
        }
        case 'tool-start': {
            const callId = String(event.callId ?? `live-${entries.length}`);
            entries.push({
                id: `tool-${callId}`,
                kind: 'tool',
                runId,
                callId,
                name: String(event.name ?? 'tool'),
                ...(event.args !== undefined ? { args: event.args } : {}),
                ...(event.step === undefined ? {} : { step: Number(event.step) }),
                ...(typeof event.subagent === 'string' ? { subagent: event.subagent } : {}),
                ts,
                status: 'running',
            });
            break;
        }
        case 'tool': {
            const callId = String(event.callId ?? `live-${entries.length}`);
            const entry = entries.find((e) => e.kind === 'tool' && e.callId === callId);
            const output = JSON.stringify(event.result ?? null, null, 2);
            if (entry) {
                entry.output = output;
                entry.result = event.result;
                entry.status = 'done';
            }
            else {
                entries.push({
                    id: `tool-${callId}`,
                    kind: 'tool',
                    runId,
                    callId,
                    name: String(event.name ?? 'tool'),
                    ...(event.args !== undefined ? { args: event.args } : {}),
                    output,
                    result: event.result,
                    ...(event.step === undefined ? {} : { step: Number(event.step) }),
                    ...(typeof event.subagent === 'string' ? { subagent: event.subagent } : {}),
                    ts,
                    status: 'done',
                });
            }
            break;
        }
        case 'tool-error': {
            const callId = String(event.callId ?? `live-${entries.length}`);
            const message = String(event.message ?? 'tool failed');
            const entry = entries.find((e) => e.kind === 'tool' && e.callId === callId);
            if (entry) {
                entry.output = message;
                entry.isError = true;
                entry.status = 'error';
            }
            else {
                entries.push({
                    id: `tool-${callId}`,
                    kind: 'tool',
                    runId,
                    callId,
                    name: String(event.name ?? 'tool'),
                    ...(event.args !== undefined ? { args: event.args } : {}),
                    output: message,
                    isError: true,
                    ...(event.step === undefined ? {} : { step: Number(event.step) }),
                    ...(typeof event.subagent === 'string' ? { subagent: event.subagent } : {}),
                    ts,
                    status: 'error',
                });
            }
            break;
        }
        case 'final': {
            const text = String(event.content ?? '');
            const last = entries.at(-1);
            if (last?.kind === 'assistant' && last.text === text)
                break;
            entries.push({ id: `final-${ts}-${entries.length}`, kind: 'assistant', runId, text, ts, final: true });
            break;
        }
        case 'retry':
            entries.push({ id: `notice-${ts}-${entries.length}`, kind: 'notice', runId, text: `retrying (${String(event.reason ?? 'invalid response')})`, ts, level: 'warn' });
            break;
        default:
            break;
    }
}
