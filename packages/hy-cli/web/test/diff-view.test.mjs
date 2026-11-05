// CP-33: the diff viewer's parser and markup.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commentKey, commentsToPrompt, parseUnifiedDiff, renderDiffFiles } from '../dist/diff-view.js'

const DIFF = [
  ' src/a.ts | 3 ++-',
  ' NEW.md   | 2 ++',
  ' 2 files changed, 4 insertions(+), 1 deletion(-)',
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ function f() {',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = <b>4</b>',
  ' ',
  'diff --git a/NEW.md b/NEW.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/NEW.md',
  '@@ -0,0 +1,2 @@',
  '+# New',
  '+untracked at the start',
  '\\ No newline at end of file',
  '',
].join('\n')

const labels = { added: 'new', deleted: 'deleted', renamed: 'renamed', binary: 'binary', comment: 'Comment', save: 'Save', cancel: 'Cancel' }

test('CP-33: files, statuses, counts and line numbers', () => {
  const files = parseUnifiedDiff(DIFF)
  assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions]), [
    ['src/a.ts', 'modified', 2, 1],
    ['NEW.md', 'added', 2, 0],
  ])
  const lines = files[0].hunks[0].lines
  assert.deepEqual(lines.map((l) => [l.kind, l.oldNo ?? null, l.newNo ?? null]), [
    ['ctx', 10, 10],
    ['del', 11, null],
    ['add', null, 11],
    ['add', null, 12],
    ['ctx', 12, 13],
  ])
  assert.equal(files[1].hunks[0].lines.at(-1).kind, 'note')
})

test('CP-33: deleted and renamed files', () => {
  const files = parseUnifiedDiff([
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/x.ts b/y.ts',
    'similarity index 90%',
    'rename from x.ts',
    'rename to y.ts',
  ].join('\n'))
  assert.deepEqual(files.map((f) => [f.path, f.status, f.oldPath ?? null]), [
    ['old.txt', 'deleted', null],
    ['y.ts', 'renamed', 'x.ts'],
  ])
})

test('CP-33: folding, escaping and the comment box', () => {
  const files = parseUnifiedDiff(DIFF)
  const comments = new Map([[commentKey({ path: 'src/a.ts', side: 'new', line: 11 }), { path: 'src/a.ts', side: 'new', line: 11, text: 'why 3?' }]])
  const html = renderDiffFiles(files, { collapsed: new Set(['NEW.md']), comments, labels })
  assert.match(html, /data-diff-file="src\/a\.ts"/)
  assert.match(html, /&lt;b&gt;4&lt;\/b&gt;/, 'line text is escaped')
  assert.doesNotMatch(html, /# New/, 'a folded file has no body')
  assert.match(html, /class="dl-comment"[^>]*>why 3\?</)
  assert.match(html, /diff-badge-added/)
  const editing = renderDiffFiles(files, { collapsed: new Set(), comments: new Map(), editing: { path: 'src/a.ts', side: 'old', line: 11 }, labels })
  assert.equal((editing.match(/id="diff-comment-input"/g) ?? []).length, 1)
})

test('CP-33: comments become one review message', () => {
  assert.equal(commentsToPrompt([]), '')
  const prompt = commentsToPrompt([
    { path: 'b.ts', side: 'new', line: 3, text: ' rename this ' },
    { path: 'a.ts', side: 'old', line: 9, text: 'keep this line' },
    { path: 'a.ts', side: 'new', line: 2, text: '   ' },
  ])
  assert.equal(prompt, 'Review comments on the current diff. Address each one, then summarise what you changed:\n- a.ts:9 (removed line): keep this line\n- b.ts:3: rename this')
})
