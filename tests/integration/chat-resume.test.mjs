// hy chat / hy resume / hy sessions with the mock provider: history carries
// across turns and processes, /undo restores files and drops the turn, and
// --json / --output-last-message give machine-readable output.
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

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-chat-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Chat\n')
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init']]) {
    spawnSync('git', args, { cwd: dir })
  }
  return dir
}

const hy = (args, input) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8', ...(input !== undefined ? { input } : {}) })

test('hy chat keeps history, /undo restores files, hy resume continues the run', { skip: skipReason('sync') }, () => {
  const dir = fixture()
  try {
    const chat = hy(
      ['chat', '--mock', '--cwd', dir, '--json'],
      'SAY hello\nREPEAT FIRST\nCreate the demo file\n/undo\n/status\n/exit\n',
    )
    assert.equal(chat.status, 0, chat.stderr)
    const events = chat.stdout.trim().split('\n').map((l) => JSON.parse(l))
    const finals = events.filter((e) => e.type === 'turn/final').map((e) => e.content)
    assert.deepEqual(finals.slice(0, 2), ['hello', 'first: SAY hello'])
    assert.match(finals[2], /HY_DEMO\.md was created/)
    const undo = events.find((e) => e.type === 'command' && e.command === '/undo')
    assert.match(undo.output, /undid turn 3: restored 0, deleted 1 file/)
    assert.ok(!fs.existsSync(path.join(dir, 'HY_DEMO.md')), '/undo removed the file the turn created')
    const status = events.find((e) => e.type === 'command' && e.command === '/status')
    assert.match(status.output, /turns: 2, messages: 4/)

    const listed = hy(['sessions', '--cwd', dir, '--json'])
    const runs = JSON.parse(listed.stdout)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].turns, 2)
    assert.equal(runs[0].first, 'SAY hello')

    const found = JSON.parse(hy(['sessions', '--cwd', dir, '--json', '--search', 'repeat first']).stdout)
    assert.equal(found.length, 1)
    assert.deepEqual(JSON.parse(hy(['sessions', '--cwd', dir, '--json', '--search', 'no such text']).stdout), [])

    const out = path.join(dir, '.git', 'last.txt')
    const resumed = hy(['resume', '--last', 'REPEAT FIRST', '--mock', '--cwd', dir, '--output-last-message', out])
    assert.equal(resumed.status, 0, resumed.stderr)
    assert.match(resumed.stderr, /resumed run-\w+ after 2 turn\(s\)/)
    assert.equal(fs.readFileSync(out, 'utf8'), 'first: SAY hello\n')

    // hy undo reverts a chat run to before its first turn.
    hy(['chat', '--mock', '--cwd', dir], 'Create the demo file\n/exit\n')
    assert.ok(fs.existsSync(path.join(dir, 'HY_DEMO.md')))
    const newest = JSON.parse(hy(['sessions', '--cwd', dir, '--json']).stdout)[0].runId
    const undone = hy(['undo', newest, '--cwd', dir])
    assert.equal(undone.status, 0, undone.stderr)
    assert.ok(!fs.existsSync(path.join(dir, 'HY_DEMO.md')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hy resume refuses unknown runs', { skip: skipReason('sync') }, () => {
  const dir = fixture()
  try {
    const r = hy(['resume', 'run-nope', 'hi', '--mock', '--cwd', dir])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /unknown run run-nope/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
