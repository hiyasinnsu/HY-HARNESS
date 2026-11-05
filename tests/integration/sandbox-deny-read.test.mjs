import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

// CP-02: `denyRead` must stop the confined token while the user keeps access.
// The fixture lives under the user profile because a workspace inside %TEMP%
// cannot be granted (AppContainer package ACEs, ADR 0001 §5.2).
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const core = await import(pathToFileURL(path.join(repo, 'packages', 'core', 'dist', 'index.js')).href)

function fixture() {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hy-deny-read-it-'))
  const ws = path.join(base, 'ws')
  const secret = path.join(base, 'secret')
  fs.mkdirSync(ws)
  fs.mkdirSync(secret)
  fs.writeFileSync(path.join(secret, 'key.txt'), 'TOP-SECRET')
  fs.writeFileSync(path.join(ws, 'README.md'), '# fixture\n')
  spawnSync('git', ['init', '-q'], { cwd: ws })
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: ws })
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws })
  return { base, ws, secret, state: path.join(base, 'state') }
}

const skip = skipReason('pipe') ?? skipReason('homedir')
// The commands below are pre-approved, as in win10-sandbox.test.mjs: these
// tests check the ACLs, not the approval policy.
const approval = { by: 'user', callId: 'it' }

test('CP-02: denyRead denies the confined token and is restored by revoke', { skip, timeout: 180_000, concurrency: false }, async () => {
  const f = fixture()
  const client = await core.ExecRpcClient.start(core.resolveServerPath(), {
    protocolVersion: 1,
    workspaceRoot: f.ws,
    stateDir: f.state,
    sandbox: 'workspace-write',
    extraWritableRoots: [],
    envPassthrough: [],
    projectTrusted: false,
    protectedPaths: [],
    denyRead: [f.secret],
  })
  try {
    const status = await client.sandboxStatus()
    assert.deepEqual(status.denyRead ?? [], [f.secret], JSON.stringify(status, null, 2))
    assert.deepEqual(status.denyReadFailed ?? [], [])
    assert.deepEqual(status.denyReadMissing ?? [], [])

    const denied = await client.exec({
      command: `type "${path.join(f.secret, 'key.txt')}"`,
      mode: 'agent',
      sandboxMode: 'workspace-write',
      hardTimeoutMs: 30_000,
      approval,
    })
    assert.notEqual(denied.exitCode, 0, 'the confined token must not read the file')
    assert.match(
      `${denied.stdout}\n${denied.stderr}`,
      /access is denied|denied|permission/i,
      `expected a denial, got: ${denied.stdout}\n${denied.stderr}`,
    )

    // The user's own token is unaffected: the deny ACE names the workspace SID.
    assert.equal(fs.readFileSync(path.join(f.secret, 'key.txt'), 'utf8'), 'TOP-SECRET')

    const revoke = await client.sandboxRevoke()
    assert.ok(revoke.restored >= 1, JSON.stringify(revoke))
    assert.equal(fs.readFileSync(path.join(f.secret, 'key.txt'), 'utf8'), 'TOP-SECRET')
    assert.deepEqual((await client.sandboxStatus()).denyRead ?? [], [])
  } finally {
    await client.sandboxRevoke().catch(() => undefined)
    await client.stop()
    fs.rmSync(f.base, { recursive: true, force: true })
  }
})

test('CP-02: a missing denyRead path is reported, not fatal', { skip, timeout: 120_000, concurrency: false }, async () => {
  const f = fixture()
  const missing = path.join(f.base, 'does-not-exist')
  const client = await core.ExecRpcClient.start(core.resolveServerPath(), {
    protocolVersion: 1,
    workspaceRoot: f.ws,
    stateDir: f.state,
    sandbox: 'workspace-write',
    extraWritableRoots: [],
    envPassthrough: [],
    projectTrusted: false,
    protectedPaths: [],
    denyRead: [missing, f.secret],
  })
  try {
    const status = await client.sandboxStatus()
    assert.deepEqual(status.denyReadMissing ?? [], [missing])
    assert.deepEqual(status.denyRead ?? [], [f.secret])
  } finally {
    await client.sandboxRevoke().catch(() => undefined)
    await client.stop()
    fs.rmSync(f.base, { recursive: true, force: true })
  }
})

test('CP-02: denyRead refuses the workspace and its ancestors', { skip, timeout: 120_000, concurrency: false }, async () => {
  const f = fixture()
  // Denying an ancestor would leave the agent unable to read anything. The
  // guard compares canonical paths, so it must see through `\\?\` spellings.
  const client = await core.ExecRpcClient.start(core.resolveServerPath(), {
    protocolVersion: 1,
    workspaceRoot: f.ws,
    stateDir: f.state,
    sandbox: 'workspace-write',
    extraWritableRoots: [],
    envPassthrough: [],
    projectTrusted: false,
    protectedPaths: [],
    denyRead: [f.base, f.ws],
  })
  try {
    const status = await client.sandboxStatus()
    assert.deepEqual(status.denyRead ?? [], [], JSON.stringify(status, null, 2))
    assert.equal((status.denyReadFailed ?? []).length, 2, JSON.stringify(status, null, 2))
    for (const failed of status.denyReadFailed) assert.match(failed, /workspace or an ancestor/)
    // Nothing was changed on disk, so the user and the agent still read the workspace.
    const read = await client.exec({
      command: `type "${path.join(f.ws, 'README.md')}"`,
      mode: 'agent',
      sandboxMode: 'workspace-write',
      hardTimeoutMs: 30_000,
      approval,
    })
    assert.equal(read.exitCode, 0, `${read.stdout}${read.stderr}`)
  } finally {
    await client.sandboxRevoke().catch(() => undefined)
    await client.stop()
    fs.rmSync(f.base, { recursive: true, force: true })
  }
})

async function start(f, extra) {
  return core.ExecRpcClient.start(core.resolveServerPath(), {
    protocolVersion: 1,
    workspaceRoot: f.ws,
    stateDir: f.state,
    sandbox: 'workspace-write',
    extraWritableRoots: [],
    envPassthrough: [],
    projectTrusted: false,
    protectedPaths: [],
    ...extra,
  })
}

test('CP-02:readOnly carve-outs stay readable but not writable', { skip, timeout: 180_000, concurrency: false }, async () => {
  const f = fixture()
  const vendor = path.join(f.ws, 'vendor')
  fs.mkdirSync(vendor)
  fs.writeFileSync(path.join(vendor, 'keep.txt'), 'keep')
  const client = await start(f, { readOnly: [vendor] })
  try {
    const status = await client.sandboxStatus()
    assert.deepEqual(status.readOnly ?? [], [vendor], JSON.stringify(status, null, 2))
    const read = await client.exec({
      command: `type "${path.join(vendor, 'keep.txt')}"`,
      mode: 'agent',
      sandboxMode: 'workspace-write',
      hardTimeoutMs: 30_000,
      approval,
    })
    assert.equal(read.exitCode, 0, `${read.stdout}${read.stderr}`)
    const write = await client.exec({
      command: `echo changed > "${path.join(vendor, 'keep.txt')}"`,
      mode: 'agent',
      sandboxMode: 'workspace-write',
      hardTimeoutMs: 30_000,
      approval,
    })
    assert.notEqual(write.exitCode, 0, 'a carve-out must not be writable by the confined token')
    // The user's own token still writes there.
    fs.writeFileSync(path.join(vendor, 'by-user.txt'), 'ok')
    // The workspace outside the carve-out stays writable.
    const allowed = await client.exec({
      command: `echo ok > "${path.join(f.ws, 'outside.txt')}"`,
      mode: 'agent',
      sandboxMode: 'workspace-write',
      hardTimeoutMs: 30_000,
      approval,
    })
    assert.equal(allowed.exitCode, 0, `${allowed.stdout}${allowed.stderr}`)
  } finally {
    await client.sandboxRevoke().catch(() => undefined)
    await client.stop()
    fs.rmSync(f.base, { recursive: true, force: true })
  }
})

test('CP-02: a readOnly path outside the workspace is reported, not enforced', { skip, timeout: 120_000, concurrency: false }, async () => {
  const f = fixture()
  const outside = path.join(f.base, 'outside')
  fs.mkdirSync(outside)
  const client = await start(f, { readOnly: [outside] })
  try {
    const status = await client.sandboxStatus()
    assert.deepEqual(status.readOnly ?? [], [])
    assert.equal((status.readOnlyFailed ?? []).length, 1, JSON.stringify(status, null, 2))
    assert.match(status.readOnlyFailed[0], /subdirectory of the workspace/)
  } finally {
    await client.sandboxRevoke().catch(() => undefined)
    await client.stop()
    fs.rmSync(f.base, { recursive: true, force: true })
  }
})