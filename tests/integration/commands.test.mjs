// hy review and the chat commands added for Codex/DSH parity: /review,
// custom prompts, /init, /model, /compact.
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

test('hy review, /review, custom prompts, /init, /model and /compact', { skip: skipReason('sync') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-cmd-'))
  const user = path.join(dir, 'user')
  const ws = path.join(dir, 'ws')
  try {
    fs.mkdirSync(path.join(user, 'prompts'), { recursive: true })
    fs.writeFileSync(path.join(user, 'prompts', 'fix.md'), 'SAY fixing issue $1 ($ARGUMENTS)')
    // A custom prompt cannot shadow a built-in command.
    fs.writeFileSync(path.join(user, 'prompts', 'status.md'), 'SAY shadowed')
    fs.mkdirSync(ws)
    fs.writeFileSync(path.join(ws, 'a.txt'), 'a\n')
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init']]) {
      spawnSync('git', args, { cwd: ws })
    }
    const env = { ...process.env, HY_CONFIG_DIR: user }
    const hy = (args, input) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8', env, ...(input ? { input } : {}) })

    assert.equal(hy(['review', '--mock', '--cwd', ws]).stdout.trim(), 'nothing to review')
    fs.writeFileSync(path.join(ws, 'a.txt'), 'a\nb\nc\n')
    fs.writeFileSync(path.join(ws, 'new.txt'), 'n\n')
    const reviewed = hy(['review', '--mock', '--cwd', ws])
    assert.equal(reviewed.status, 0, reviewed.stderr)
    assert.equal(reviewed.stdout.trim(), 'review: 2 added line(s); no findings')

    const chat = hy(['chat', '--mock', '--cwd', ws, '--json'], '/review\n/fix 42 now\n/status\n/init\n/model other-model\n/compact\n/exit\n')
    assert.equal(chat.status, 0, chat.stderr)
    const events = chat.stdout.trim().split('\n').map((l) => JSON.parse(l))
    const out = (c) => events.find((e) => e.type === 'command' && e.command === c)?.output
    assert.equal(out('/review'), 'review: 2 added line(s); no findings')
    assert.ok(events.some((e) => e.type === 'turn/final' && e.content === 'fixing issue 42 (42 now)'))
    assert.match(out('/status'), /^run: run-/)
    assert.ok(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8').startsWith('# AGENTS'), '/init wrote AGENTS.md')
    assert.equal(out('/model'), 'model: mock/other-model')
    assert.match(out('/compact'), /^compacted: \d+ → \d+ messages$/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ask_user reads the answer from the chat; /plan-mode keeps the agent read-only', { skip: skipReason('sync') }, () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-plan-'))
  try {
    fs.writeFileSync(path.join(ws, 'README.md'), '# Plan\n')
    spawnSync('git', ['init', '-q'], { cwd: ws })
    const input = ['ASK which db?', 'postgres please', '/plan-mode', 'Create the demo file', '/plan-mode off', 'Create the demo file', '/exit', ''].join('\n')
    const chat = spawnSync(process.execPath, [cli, 'chat', '--mock', '--cwd', ws, '--json'], { cwd: repo, encoding: 'utf8', input })
    assert.equal(chat.status, 0, chat.stderr)
    const finals = chat.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'turn/final')
      .map((e) => e.content)
    assert.match(finals[0], /"answer": "postgres please"/)
    assert.equal(finals[1], 'plan: write HY_DEMO.md after approval')
    assert.ok(!fs.existsSync(path.join(ws, 'PLAN_ATTEMPT.md')), 'plan mode refused the write')
    assert.match(finals[2], /HY_DEMO\.md was created/)
    assert.ok(fs.existsSync(path.join(ws, 'HY_DEMO.md')))
    // Without a user to ask (hy run), ask_user is not offered and fails.
    const run = spawnSync(process.execPath, [cli, 'run', 'ASK hi', '--mock', '--cwd', ws], { cwd: repo, encoding: 'utf8' })
    assert.match(run.stdout, /user said:/)
    assert.match(run.stderr, /ask_user: no user is available/)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})
