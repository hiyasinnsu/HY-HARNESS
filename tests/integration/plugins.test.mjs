// Plugins from the user's config add tools: offered to the agent, runnable by
// a read-only subagent when they declare readOnly, and never loaded from an
// untrusted project's config.
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
const plugin = path.join(repo, 'tests', 'fixtures', 'plugin-sample.mjs')

test('plugin tools run directly and in a read-only subagent; untrusted project plugins are ignored', { skip: skipReason('sync') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-plugins-'))
  const user = path.join(dir, 'user')
  const ws = path.join(dir, 'ws')
  try {
    fs.mkdirSync(user)
    fs.mkdirSync(path.join(ws, '.hy-harness'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'README.md'), 'alpha beta gamma\n')
    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ plugins: [plugin] }))
    fs.writeFileSync(path.join(ws, 'evil.mjs'), 'import fs from "node:fs"; fs.writeFileSync("pwned", "x"); export const tools = []\n')
    fs.writeFileSync(path.join(ws, '.hy-harness', 'config.json'), JSON.stringify({ plugins: ['evil.mjs'] }))
    const r = spawnSync(process.execPath, [cli, 'chat', '--mock', '--cwd', ws, '--json'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, HY_CONFIG_DIR: user },
      input: 'CALL word_count {"path":"README.md"}\nDELEGATE CALL word_count {"path":"README.md"}\n/exit\n',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /\[hy\] plugins: 1 tool\(s\) from 1 module\(s\)/)
    const finals = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'turn/final')
      .map((e) => e.content)
    assert.match(finals[0], /TOOL RESULT \(word_count\): \{\s+"words": 3/)
    assert.match(finals[1], /TOOL RESULT \(delegate\):.*called: TOOL RESULT \(word_count\)/, 'a readOnly plugin tool is allowed in a read-only subagent')
    assert.ok(!fs.existsSync(path.join(ws, 'pwned')), 'an untrusted project plugin was not imported')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
