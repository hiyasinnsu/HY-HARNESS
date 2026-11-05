import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeBrokenToolCall } from './reply-guard.js';
test('a truncated tool call is a broken tool call', () => {
    assert.equal(looksLikeBrokenToolCall('{"tool":"read_file","args":{"path":"a.txt"'), true);
});
test('a leaked chat-template closing tag is a broken tool call', () => {
    assert.equal(looksLikeBrokenToolCall('{"tool":"shell","args":{"command":"ls"}}</｜parameter>'), true);
});
test('a valid final answer is not a broken tool call', () => {
    assert.equal(looksLikeBrokenToolCall('{"final":"done"}'), false);
});
test('ordinary prose is not a broken tool call', () => {
    assert.equal(looksLikeBrokenToolCall('I read both files. The tool output shows A and B, so nothing else is needed.'), false);
});
test('a long code block is not a broken tool call', () => {
    const code = ['```ts', 'export function tool(name: string): string {', '  return `calls ${name}`', '}', '```'].join('\n');
    assert.equal(looksLikeBrokenToolCall(code), false);
});
