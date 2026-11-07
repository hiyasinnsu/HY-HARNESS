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

test('apply takes committed and uncommitted worktree work, and never applies it twice', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const { WorktreeManager } = await import('./worktree.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-wt-apply-'))
  const repo = path.join(tmp, 'repo')
  const state = path.join(tmp, 'state')
  fs.mkdirSync(repo)
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  }
  try {
    git(repo, 'init', '-q')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
    const manager = new WorktreeManager(repo, state)
    const wt = manager.create('feat')
    // The agent commits in the worktree, then leaves one change uncommitted.
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'two\n')
    git(wt.path, 'commit', '-qam', 'agent work')
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'new\n')
    const first = manager.apply('feat')
    assert.equal(first.empty, false)
    assert.deepEqual([...first.applied].sort(), ['a.txt', 'b.txt'])
    // git may write CRLF here (core.autocrlf); the content is what matters.
    const read = (f: string) => fs.readFileSync(path.join(repo, f), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(read('a.txt'), 'two\n', 'committed work arrived')
    assert.equal(read('b.txt'), 'new\n')
    // A second apply brings only what is new since the first.
    assert.equal(manager.apply('feat').empty, true, 'nothing applied twice')
    fs.writeFileSync(path.join(wt.path, 'c.txt'), 'later\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-qm', 'more')
    const second = manager.apply('feat')
    assert.deepEqual(second.applied, ['c.txt'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('CP-16: worktree names are branch-safe', () => {
  assert.equal(sanitizeWorktreeName('Feature X!'), 'feature-x')
  assert.equal(sanitizeWorktreeName('  ../escape  '), 'escape')
  assert.equal(sanitizeWorktreeName('a--b'), 'a-b')
  assert.throws(() => sanitizeWorktreeName('!!!'), /invalid worktree name/)
  assert.equal(worktreesDir('C:/state'), path.join('C:/state', 'worktrees'))
})