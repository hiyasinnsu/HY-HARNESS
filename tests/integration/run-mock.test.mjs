import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')

test('hy run --mock creates a file through read_file and apply_patch', { skip: skipReason('sync') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-e2e-'))
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture\n\nE2E.\n')
    spawnSync('git', ['init', '-q'], { cwd: dir })
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    const result = spawnSync(
      process.execPath,
      [cli, 'run', 'Create HY_DEMO.md with a short demo note. Read README.md first.', '--cwd', dir, '--mock', '--yes'],
      { cwd: repo, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const created = fs.readFileSync(path.join(dir, 'HY_DEMO.md'), 'utf8')
    assert.match(created, /HY-HARNESS demo/)
    assert.match(created, /mock provider/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hy policy-test classifies read-only git commands as allow', { skip: skipReason('sync') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-policy-'))
  try {
    const result = spawnSync(
      process.execPath,
      [cli, 'policy-test', 'git status', '--cwd', dir],
      { cwd: repo, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /"decision": "allow"/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hy ralph --mock succeeds and hy undo reverts the run', { skip: skipReason('sync') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-ralph-'))
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Ralph\n\nfixture\n')
    spawnSync('git', ['init', '-q'], { cwd: dir })
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    spawnSync('git', ['add', '-A'], { cwd: dir })
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: dir })
    const ralph = spawnSync(
      process.execPath,
      [
        cli,
        'ralph',
        'Create HY_DEMO.md with a short demo note.',
        '--verify-cmd',
        'git status --short',
        '--cwd',
        dir,
        '--mock',
        '--yes',
        '--max-rounds',
        '1',
        '--unattended-ok',
      ],
      { cwd: repo, encoding: 'utf8' },
    )
    assert.equal(ralph.status, 0, ralph.stderr)
    assert.ok(fs.existsSync(path.join(dir, 'HY_DEMO.md')))
    const run = /ralph (run-[a-z0-9]+)/.exec(ralph.stderr)?.[1]
    assert.ok(run, ralph.stderr)
    const undo = spawnSync(process.execPath, [cli, 'undo', run, '--cwd', dir], {
      cwd: repo,
      encoding: 'utf8',
    })
    assert.equal(undo.status, 0, undo.stderr)
    assert.ok(!fs.existsSync(path.join(dir, 'HY_DEMO.md')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('run_code executes a script and bridges tool calls', { skip: skipReason('pipe') }, async () => {
  const { ExecRpcClient, ToolRuntime, ensureStateDirs, resolveServerPath } = await import(
    pathToFileURL(path.join(repo, 'packages', 'core', 'dist', 'index.js')).href
  )
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-ptc-'))
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-ptc-state-'))
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# PTC\n\nhello\n')
    ensureStateDirs(state)
    const client = await ExecRpcClient.start(resolveServerPath(), {
      protocolVersion: 1,
      workspaceRoot: dir,
      stateDir: state,
      sandbox: 'unconfined',
      extraWritableRoots: [],
      envPassthrough: [],
      projectTrusted: false,
      protectedPaths: [],
    })
    try {
      const tools = new ToolRuntime(client, dir)
      const result = await tools.execute('run_code', {
        code: `
          const read = await tools.readFile({ path: 'README.md' })
          const patch = await tools.applyPatch({ file: 'PTC.md', content: '# PTC result\\n' })
          return { lines: read.totalLines, created: patch.created }
        `,
        description: 'read and create',
      })
      assert.equal(result.status, 'ok')
      const value = result.value
      assert.deepEqual(value.created, ['PTC.md'])
      assert.match(fs.readFileSync(path.join(dir, 'PTC.md'), 'utf8'), /PTC result/)
    } finally {
      await client.stop()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(state, { recursive: true, force: true })
  }
})
