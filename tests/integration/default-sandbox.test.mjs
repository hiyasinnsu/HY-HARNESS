import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// CP-01: `workspace-write` is the default. `tests/integration/isolate.mjs` pins
// HY_SANDBOX=unconfined for the other integration tests (they run under %TEMP%,
// where confined mode refuses to start), so this file removes that variable to
// observe the real default.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')

function dump(args, env) {
  const childEnv = { ...process.env }
  delete childEnv.HY_SANDBOX
  const result = spawnSync(process.execPath, [cli, 'config', 'dump', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...childEnv, ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('the sandbox defaults to workspace-write and can be opted out of', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-default-sandbox-'))
  try {
    const ws = path.join(dir, 'ws')
    const user = path.join(dir, 'user')
    fs.mkdirSync(ws)
    fs.mkdirSync(user)

    const fresh = dump(['--cwd', ws], { HY_CONFIG_DIR: user })
    assert.equal(fresh.sandbox, 'workspace-write')
    assert.equal(fresh.sandboxSource, 'default')

    const unsafe = dump(['--cwd', ws, '--unsafe-unconfined'], { HY_CONFIG_DIR: user })
    assert.equal(unsafe.sandbox, 'unconfined')
    assert.equal(unsafe.sandboxSource, 'cli')

    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({ sandbox: { legacyUnconfined: true }, roles: { worker: { provider: 'mock', model: 'mock' } } }),
    )
    const legacy = dump(['--cwd', ws], { HY_CONFIG_DIR: user })
    assert.equal(legacy.sandbox, 'unconfined')
    assert.equal(legacy.sandboxSource, 'default', 'the legacy opt-out is still not an explicit CLI choice')

    const env = dump(['--cwd', ws], { HY_CONFIG_DIR: user, HY_SANDBOX: 'read-only' })
    assert.equal(env.sandbox, 'read-only')
    assert.equal(env.sandboxSource, 'env')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
