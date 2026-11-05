import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHAT_TITLE_LENGTH, normalizeChatTitle } from './web-server.js';
test('a chat title is trimmed and keeps its inner spacing', () => {
    assert.equal(normalizeChatTitle('  Fix the login bug  '), 'Fix the login bug');
    assert.equal(normalizeChatTitle('Fix   the\nlogin\tbug'), 'Fix the login bug');
});
test('an empty or whitespace-only title clears the override', () => {
    assert.equal(normalizeChatTitle(''), null);
    assert.equal(normalizeChatTitle('   '), null);
    assert.equal(normalizeChatTitle('\n\t \r\n'), null);
});
test('a long title is capped instead of rejected', () => {
    const long = 'x'.repeat(MAX_CHAT_TITLE_LENGTH + 50);
    const title = normalizeChatTitle(long);
    assert.equal(title?.length, MAX_CHAT_TITLE_LENGTH);
    assert.equal(title, 'x'.repeat(MAX_CHAT_TITLE_LENGTH));
});
test('whitespace collapsing happens before the cap', () => {
    // 80 "a"s separated by runs of spaces collapse to 159 chars, then cap at 120.
    const padded = Array.from({ length: 80 }, () => 'a').join('    ');
    const title = normalizeChatTitle(padded);
    assert.equal(title?.length, MAX_CHAT_TITLE_LENGTH);
    assert.equal(title?.includes('  '), false, 'no double spaces survive');
});
test('the cap constant is a positive, usable length', () => {
    assert.equal(MAX_CHAT_TITLE_LENGTH, 120);
    assert.equal(normalizeChatTitle('a'.repeat(MAX_CHAT_TITLE_LENGTH))?.length, MAX_CHAT_TITLE_LENGTH);
});
