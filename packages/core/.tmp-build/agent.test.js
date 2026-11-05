import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebuildHistory, toolErrorMessage, toolResultMessage } from './agent.js';
let seq = 0;
const ev = (type, payload, runId = 'run-a') => ({
    v: 1,
    seq: ++seq,
    ts: seq,
    sessionId: 's',
    runId,
    type,
    payload,
});
test('rebuildHistory replays what the model saw and honours /undo', () => {
    const events = [
        ev('turn/start', { turn: 1 }),
        ev('user/message', { content: 'first' }),
        ev('assistant/message', { content: '{"tool":"read_file","args":{"path":"a"}}' }),
        ev('tool/result', { name: 'read_file', output: '{"content":"x"}', isError: false }),
        ev('assistant/message', { content: '{"final":"done"}' }),
        ev('user/message', { content: 'other run' }, 'run-b'),
        ev('turn/start', { turn: 2 }),
        ev('user/message', { content: 'second' }),
        ev('assistant/message', { content: '{"tool":"shell","args":{}}' }),
        ev('tool/result', { name: 'shell', output: 'boom', isError: true }),
        ev('turn/undo', { turn: 2 }),
        ev('turn/start', { turn: 2 }),
        ev('user/message', { content: 'second again' }),
    ];
    // Out-of-order input is sorted by seq.
    const history = rebuildHistory([...events].reverse(), 'run-a');
    assert.deepEqual(history, [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: '{"tool":"read_file","args":{"path":"a"}}' },
        { role: 'user', content: toolResultMessage('read_file', '{"content":"x"}') },
        { role: 'assistant', content: '{"final":"done"}' },
        { role: 'user', content: 'second again' },
    ]);
    assert.match(toolErrorMessage('shell', 'boom'), /^TOOL ERROR \(shell\): boom\n/);
});
test('identical consecutive tool calls get a reminder (RepeatToolReminderGuard)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Agent } = await import('./agent.js');
    const { ToolRuntime } = await import('./tools.js');
    const { SessionLog } = await import('./session-log.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-repeat-'));
    try {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
        const call = JSON.stringify({ tool: 'read_file', args: { path: 'a.txt' } });
        const replies = [call, call, call, JSON.stringify({ tool: 'read_file', args: { path: 'a.txt', startLine: 1 } }), '{"final":"ok"}'];
        const seen = [];
        const provider = {
            name: 'scripted',
            complete: async (messages) => {
                seen.push(messages.at(-1).content);
                return { content: replies.shift(), usage: { inputTokens: 0, outputTokens: 0 } };
            },
        };
        const log = new SessionLog(path.join(dir, 'log.jsonl'));
        const tools = new ToolRuntime({}, dir);
        const result = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir }).run('go');
        assert.equal(result.final, 'ok');
        // seen[n] is the result of reply n-1.
        assert.doesNotMatch(seen[1], /\[reminder\]/);
        assert.match(seen[2], /\[reminder\] This is the same call with the same arguments 2 times in a row/);
        assert.match(seen[3], /3 times in a row/);
        assert.doesNotMatch(seen[4], /\[reminder\]/, 'different arguments reset the count');
        assert.equal(log.events().filter((e) => e.type === 'guard/repeat').length, 2);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('native tool calls: parallel reads, a plain-text final, and history that resumes', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Agent, rebuildHistory } = await import('./agent.js');
    const { ToolRuntime } = await import('./tools.js');
    const { SessionLog } = await import('./session-log.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-native-'));
    try {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
        fs.writeFileSync(path.join(dir, 'b.txt'), 'B');
        const requests = [];
        const replies = [
            { content: '', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }, { name: 'read_file', args: { path: 'b.txt' } }] },
            { content: 'Both files read: A and B.' },
        ];
        const provider = {
            name: 'native',
            complete: async (messages, o) => {
                requests.push({ ...(o.tools ? { tools: o.tools } : {}), system: messages[0].content });
                return { ...replies.shift(), usage: { inputTokens: 1, outputTokens: 1 } };
            },
        };
        const log = new SessionLog(path.join(dir, 'log.jsonl'));
        log.setRun('run-n');
        const tools = new ToolRuntime({}, dir);
        const r = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('read both');
        assert.equal(r.final, 'Both files read: A and B.');
        assert.ok(requests[0].tools.some((t) => t.name === 'apply_patch'));
        assert.match(requests[0].system, /Use the provided tools through function calls/);
        assert.doesNotMatch(requests[0].system, /Reply with exactly one JSON object/);
        // One user message holds both results, in call order.
        const results = r.history.find((m) => m.content.startsWith('TOOL RESULT')).content;
        assert.match(results, /^TOOL RESULT \(read_file\):[\s\S]*"content": "A"[\s\S]*TOOL RESULT \(read_file\):[\s\S]*"content": "B"/);
        assert.deepEqual(rebuildHistory(log.events(), 'run-n'), r.history, 'the log rebuilds the same conversation');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('a model that rejects tools falls back to the text protocol; text mode accepts batched calls', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Agent } = await import('./agent.js');
    const { ToolRuntime } = await import('./tools.js');
    const { SessionLog } = await import('./session-log.js');
    const { LlmError } = await import('./llm.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-fallback-'));
    try {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
        let calls = 0;
        const systems = [];
        const provider = {
            name: 'old-model',
            complete: async (messages, o) => {
                calls += 1;
                if (o.tools)
                    throw new LlmError('ollama HTTP 400: {"error":"m does not support tools"}', 400);
                systems.push(messages[0].content);
                const last = messages.at(-1).content;
                const content = last.startsWith('TOOL')
                    ? '{"final":"done"}'
                    : JSON.stringify({ calls: [{ tool: 'read_file', args: { path: 'a.txt' } }, { tool: 'read_file', args: { path: 'missing.txt' } }] });
                return { content, usage: { inputTokens: 0, outputTokens: 0 } };
            },
        };
        const log = new SessionLog(path.join(dir, 'log.jsonl'));
        const r = await new Agent({ provider, tools: new ToolRuntime({}, dir), sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('go');
        assert.equal(r.final, 'done');
        assert.equal(calls, 3, 'one rejected native request, then two text requests');
        assert.match(systems[0], /Reply with exactly one JSON object/);
        const results = r.history.find((m) => m.content.startsWith('TOOL')).content;
        assert.match(results, /TOOL RESULT \(read_file\)[\s\S]*TOOL ERROR \(read_file\)/);
        assert.equal(log.events().filter((e) => e.type === 'native-tools/off').length, 1);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
