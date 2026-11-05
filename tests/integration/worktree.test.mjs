import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipReason } from './capability.mjs'

// CP-16: `hy worktree create|list|apply|remove` against a real repository.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')

function run(args, cwd, state) {
  return spawnSync(process.execPath, [cli, 'worktree', ...args, '--cwd', cwd, '--state-dir', state], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HY_CONFIG_DIR: path.join(path.dirname(state), 'user') },
  })
}

const skip = skipReason('sync')

test('CP-16: changes made in a worktree are applied to the main checkout', { skip, timeout: 180_000, concurrency: false }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-worktree-'))
  const ws = path.join(base, 'repo')
  const state = path.join(base, 'state')
  fs.mkdirSync(ws)
  const git = (...args) =>
    spawnSync('git', args, { cwd: ws, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  try {
    git('init', '-q')
    git('config', 'user.name', 'test')
    git('config', 'user.email', 'test@example.com')
    // A global core.autocrlf=true would check FEATURE.md out with CRLF; the
    // test is about moving the change, not line endings.
    git('config', 'core.autocrlf', 'false')
    fs.writeFileSync(path.join(ws, 'README.md'), '# main\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')

    const created = run(['create', 'feature'], ws, state)
    assert.equal(created.status, 0, created.stderr)
    const worktree = created.stdout.trim()
    assert.ok(fs.existsSync(worktree), `worktree exists: ${worktree}`)
    assert.ok(worktree.startsWith(path.join(state, 'worktrees')), 'the worktree lives in the state directory')

    const listed = run(['list'], ws, state)
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /hy\/feature/)

    fs.writeFileSync(path.join(worktree, 'FEATURE.md'), '# feature\n')
    const applied = run(['apply', 'feature'], ws, state)
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(fs.readFileSync(path.join(ws, 'FEATURE.md'), 'utf8'), '# feature\n')

    const removed = run(['remove', 'feature'], ws, state)
    assert.equal(removed.status, 0, removed.stderr)
    assert.equal(fs.existsSync(worktree), false)
    // The branch survives, so the work can still be inspected.
    assert.match(git('branch', '--list', 'hy/feature').stdout, /hy\/feature/)
    // apply recorded the change on the branch, which is why remove needed no --force.
    assert.equal(git('show', 'hy/feature:FEATURE.md').stdout, '# feature\n')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
