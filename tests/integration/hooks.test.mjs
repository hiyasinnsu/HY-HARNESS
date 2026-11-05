// User hooks: preToolUse can block a call (exit 2, stderr is the reason),
// postToolUse sees results and errors, turnEnd and notify run after a turn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')
const hook = path.join(repo, 'tests', 'fixtures', 'hook.mjs')

test('hooks block, observe and notify', { skip: skipReason('sync') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-hooks-'))
  const userDir = path.join(dir, 'user')
  const ws = path.join(dir, 'ws')
  const seen = path.join(dir, 'seen.jsonl')
  try {
    fs.mkdirSync(userDir)
    fs.mkdirSync(ws)
    fs.writeFileSync(path.join(ws, 'README.md'), '# Hooks\n')
    spawnSync('git', ['init', '-q'], { cwd: ws })
    const cmd = (...extra) => [process.execPath, hook, seen, ...extra]
    fs.writeFileSync(
      path.join(userDir, 'config.json'),
      JSON.stringify({
        hooks: {
          preToolUse: [{ command: cmd('--block'), tools: ['apply_patch'] }],
          postToolUse: [{ command: cmd(), tools: ['read_file', 'apply_patch'] }],
          turnEnd: [{ command: cmd() }],
        },
        notify: cmd(),
      }),
    )
    const read = spawnSync(
      process.execPath,
      [cli, 'run', 'CALL read_file {"path":"README.md"}', '--mock', '--cwd', ws, '--json'],
      { cwd: repo, encoding: 'utf8', env: { ...process.env, HY_CONFIG_DIR: userDir } },
    )
    assert.equal(read.status, 0, read.stderr)
    const blockedRun = spawnSync(
      process.execPath,
      [cli, 'run', 'CALL apply_patch {"file":"HY_DEMO.md","content":"x\\n"}', '--mock', '--cwd', ws, '--json'],
      { cwd: repo, encoding: 'utf8', env: { ...process.env, HY_CONFIG_DIR: userDir } },
    )
    assert.equal(blockedRun.status, 0, blockedRun.stderr)
    const events = blockedRun.stdout.trim().split('\n').map((l) => JSON.parse(l))
    const blocked = events.find((e) => e.type === 'tool-error' && e.name === 'apply_patch')
    assert.match(blocked.message, /apply_patch blocked by a preToolUse hook: patches are frozen today/)
    assert.ok(!fs.existsSync(path.join(ws, 'HY_DEMO.md')))
    const lines = fs.readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const pre = lines.filter((l) => l.stdin?.event === 'preToolUse')
    const post = lines.filter((l) => l.stdin?.event === 'postToolUse')
    assert.ok(pre.length >= 1 && pre.every((l) => l.stdin.tool === 'apply_patch'), 'the tools filter applies')
    assert.ok(post.some((l) => l.stdin.tool === 'read_file' && l.stdin.result?.content === '# Hooks'))
    assert.ok(!post.some((l) => l.stdin.tool === 'apply_patch'), 'a blocked call never ran, so no postToolUse')

    const ok = spawnSync(process.execPath, [cli, 'run', 'SAY done', '--mock', '--cwd', ws], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, HY_CONFIG_DIR: userDir },
    })
    assert.equal(ok.status, 0, ok.stderr)
    const after = fs.readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(after.some((l) => l.stdin?.event === 'turnEnd' && l.stdin.final === 'done' && l.stdin.turn === 1))
    assert.ok(after.some((l) => l.arg?.type === 'agent-turn-complete' && l.arg.final === 'done'), 'notify gets the JSON as its last argument')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
