import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { parseWorktreeList, sanitizeWorktreeName, worktreesDir } from './worktree.js'

test('CP-16: git worktree porcelain output parses', () => {
  const text = [
    'worktree C:/repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree C:/state/worktrees/a',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/hy/a',
    '',
    'worktree C:/state/worktrees/b',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    '',
  ].join('\n')
  assert.deepEqual(parseWorktreeList(text), [
    { path: 'C:/repo', head: '1111111111111111111111111111111111111111', branch: 'main', detached: false, bare: false },
    { path: 'C:/state/worktrees/a', head: '2222222222222222222222222222222222222222', branch: 'hy/a', detached: false, bare: false },
    { path: 'C:/state/worktrees/b', head: '3333333333333333333333333333333333333333', detached: true, bare: false },
  ])
  assert.deepEqual(parseWorktreeList(''), [])
})

test('CP-16: worktree names are branch-safe', () => {
  assert.equal(sanitizeWorktreeName('Feature X!'), 'feature-x')
  assert.equal(sanitizeWorktreeName('  ../escape  '), 'escape')
  assert.equal(sanitizeWorktreeName('a--b'), 'a-b')
  assert.throws(() => sanitizeWorktreeName('!!!'), /invalid worktree name/)
  assert.equal(worktreesDir('C:/state'), path.join('C:/state', 'worktrees'))
})