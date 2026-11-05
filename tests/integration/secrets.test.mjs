import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipReason } from './capability.mjs'

// CP-08: `hy secret set` stores a DPAPI reference and `config dump
// --show-secrets` resolves it again. Needs `target/debug/hy-secret.exe`
// (cargo build -p hy-sandbox-windows --bin hy-secret).
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')
const secretBin = ['target/release/hy-secret.exe', 'target/debug/hy-secret.exe']
  .map((p) => path.join(repo, p))
  .find((p) => fs.existsSync(p))
const skip = skipReason('sync') ?? (secretBin === undefined ? 'hy-secret.exe has not been built' : undefined)

test('CP-08: hy secret set stores dpapi and config dump resolves it', { skip, timeout: 120_000, concurrency: false }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-secret-it-'))
  const user = path.join(base, 'user')
  const ws = path.join(base, 'ws')
  fs.mkdirSync(user)
  fs.mkdirSync(ws)
  const env = { ...process.env, HY_CONFIG_DIR: user, HY_SECRET_BIN: secretBin }

  try {
    const set = spawnSync(process.execPath, [cli, 'secret', 'set', 'demo'], {
      cwd: repo,
      encoding: 'utf8',
      env,
      input: 'sk-it-123\n',
    })
    assert.equal(set.status, 0, set.stderr)
    assert.match(set.stdout, /stored demo \(dpapi\)/)

    const written = JSON.parse(fs.readFileSync(path.join(user, 'config.json'), 'utf8'))
    assert.match(written.secrets.demo, /^dpapi:/)
    assert.ok(!JSON.stringify(written).includes('sk-it-123'), 'the plaintext never reaches disk')

    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({
        ...written,
        roles: { worker: { provider: 'deepseek', model: 'deepseek-flash', apiKeySecret: 'demo' } },
      }),
    )
    const dump = spawnSync(process.execPath, [cli, 'config', 'dump', '--cwd', ws, '--show-secrets'], {
      cwd: repo,
      encoding: 'utf8',
      env,
    })
    assert.equal(dump.status, 0, dump.stderr)
    const config = JSON.parse(dump.stdout)
    assert.equal(config.role.apiKey, 'sk-it-123')
    assert.equal(config.role.apiKeySecret, undefined, 'the reference is replaced by the plaintext')

    // Without --show-secrets the key is masked.
    const masked = spawnSync(process.execPath, [cli, 'config', 'dump', '--cwd', ws], { cwd: repo, encoding: 'utf8', env })
    assert.equal(masked.status, 0, masked.stderr)
    assert.equal(JSON.parse(masked.stdout).role.apiKey, '***')
    assert.ok(!masked.stdout.includes('sk-it-123'))

    const removed = spawnSync(process.execPath, [cli, 'secret', 'remove', 'demo'], { cwd: repo, encoding: 'utf8', env })
    assert.equal(removed.status, 0, removed.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(user, 'config.json'), 'utf8')).secrets, {})
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
