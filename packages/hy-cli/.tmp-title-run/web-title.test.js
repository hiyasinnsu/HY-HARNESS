import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SESSION_TITLE_LENGTH, normalizeSessionTitle } from './session-title.js';
test('a chat title is trimmed and keeps its inner spacing', () => {
    assert.deepEqual(normalizeSessionTitle('  Fix the login bug  '), { title: 'Fix the login bug' });
    assert.deepEqual(normalizeSessionTitle('Fix   the login\tbug'), { title: 'Fix the login bug' });
});
test('control characters become spaces instead of reaching the sidebar', () => {
    assert.deepEqual(normalizeSessionTitle('Fix\u0007the\nlogin bug'), { title: 'Fix the login bug' });
    assert.deepEqual(normalizeSessionTitle('a\u001b[31mb'), { title: 'a [31mb' });
});
test('an empty, blank or missing title clears the override', () => {
    assert.deepEqual(normalizeSessionTitle(''), { title: null });
    assert.deepEqual(normalizeSessionTitle('   '), { title: null });
    assert.deepEqual(normalizeSessionTitle('\n\t \r\n'), { title: null });
    assert.deepEqual(normalizeSessionTitle(null), { title: null });
    assert.deepEqual(normalizeSessionTitle(undefined), { title: null });
});
test('a non-string title is rejected instead of coerced', () => {
    const result = normalizeSessionTitle(42);
    assert.equal('error' in result, true);
    assert.equal('error' in normalizeSessionTitle({ title: 'x' }), true);
});
test('an over-long title is rejected, not silently truncated', () => {
    const result = normalizeSessionTitle('x'.repeat(MAX_SESSION_TITLE_LENGTH + 1));
    assert.equal('error' in result, true);
    assert.deepEqual(normalizeSessionTitle('x'.repeat(MAX_SESSION_TITLE_LENGTH)), {
        title: 'x'.repeat(MAX_SESSION_TITLE_LENGTH),
    });
});
test('whitespace collapsing happens before the length check', () => {
    // 80 "a"s joined by four spaces collapse to 159 chars, which is over the cap.
    const padded = Array.from({ length: 80 }, () => 'a').join('    ');
    assert.equal('error' in normalizeSessionTitle(padded), true);
    const tight = Array.from({ length: MAX_SESSION_TITLE_LENGTH }, () => 'a').join(' ');
    assert.equal('error' in normalizeSessionTitle(tight), true, 'spaces count toward the cap');
});
