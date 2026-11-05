// Phase 4 exit test (design §Phase 4, ADR 0001): the confined-token backend on
// this machine. Fixtures are built by tmpRoot() under os.tmpdir(): a restricted
// token cannot write under %USERPROFILE%, while %TEMP% stays writable. Every
// grant is revoked before the fixture is deleted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipReason, tmpRoot } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const core = await import(new URL('../../packages/core/dist/index.js', import.meta.url).href)
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')
const { ExecRpcClient, resolveServerPath } = core

const skip = process.platform !== 'win32' ? 'Windows only' : false
const approval = { by: 'user', callId: 'it' }

function fixture() {
  const root = tmpRoot()
  const ws = path.join(root, 'ws')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(ws)
  fs.mkdirSync(outside)
  return { root, ws, outside, state: path.join(root, 'state') }
}

async function open(f, extra = {}) {
  return ExecRpcClient.start(resolveServerPath(), {
    protocolVersion: 1,
    workspaceRoot: fs.realpathSync.native(f.ws),
    stateDir: f.state,
    sandbox: 'workspace-write',
    extraWritableRoots: [],
    envPassthrough: [],
    projectTrusted: false,
    protectedPaths: [],
    ...extra,
  })
}

async function run(client, command, extra = {}) {
  return client.exec({ command, mode: 'agent', foregroundWaitMs: 120_000, approval, ...extra })
}

async function cleanup(client, f) {
  try {
    await client.sandboxRevoke()
  } finally {
    await client.stop()
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 3 })
  }
}

function aclMentions(dir, sid) {
  const out = spawnSync('icacls', [dir, '/T', '/C', '/Q'], { encoding: 'utf8' })
  return out.stdout.split(/\r?\n/).filter((l) => l.includes(sid))
}

test('workspace-write confines writes and reports gaps', { skip: skip || (skipReason('pipe') ?? skipReason('sync')) }, async () => {
  const f = fixture()
  fs.writeFileSync(path.join(f.ws, 'README.md'), '# fixture\n')
  fs.writeFileSync(path.join(f.outside, 'victim.txt'), 'original\n')
  fs.writeFileSync(path.join(f.outside, 'hl_src.txt'), 'original\n')
  fs.linkSync(path.join(f.outside, 'hl_src.txt'), path.join(f.ws, 'hl.txt'))
  fs.symlinkSync(f.outside, path.join(f.ws, 'junc'), 'junction')
  process.env.HY_IT_SECRET_TOKEN = 'do-not-leak'
  const client = await open(f)
  delete process.env.HY_IT_SECRET_TOKEN
  try {
    const status = await client.sandboxStatus()
    assert.equal(status.workspaceWriteAvailable, true, status.unavailableReason ?? '')
    assert.equal(status.enforcement, 'partial')
    assert.ok(fs.existsSync(path.join(f.ws, '.git')), 'git init ran before the grant')
    assert.ok(fs.existsSync(path.join(f.ws, '.hy-harness')))
    assert.ok(status.notices.some((n) => n.includes('initialized a git repository')))
    assert.equal(status.grant?.skippedHardLinks, 1)
    assert.ok(status.gaps.some((g) => g.startsWith('named-pipe-grandchildren')))
    assert.ok(status.gaps.some((g) => g.startsWith('reads-not-confined')))
    assert.ok(status.privateTemp && !status.privateTemp.toLowerCase().includes('appdata'))

    const inside = await run(client, 'cmd /d /c echo hi> inside.txt')
    assert.equal(inside.sandbox, 'workspace-write')
    assert.notEqual(inside.exitCode, -1073741502, '0xC0000142')
    assert.ok(fs.existsSync(path.join(f.ws, 'inside.txt')))

    await run(client, `cmd /d /c echo x> "${path.join(f.outside, 'o.txt')}"`)
    assert.ok(!fs.existsSync(path.join(f.outside, 'o.txt')), 'outside write denied')
    await run(client, `cmd /d /c del /q "${path.join(f.outside, 'victim.txt')}"`)
    assert.ok(fs.existsSync(path.join(f.outside, 'victim.txt')), 'outside delete denied')
    await run(client, 'cmd /d /c echo x> junc\\j.txt')
    assert.ok(!fs.existsSync(path.join(f.outside, 'j.txt')), 'junction write denied')
    await run(client, 'cmd /d /c echo evil> hl.txt')
    assert.equal(fs.readFileSync(path.join(f.outside, 'hl_src.txt'), 'utf8'), 'original\n', 'hard link not granted')
    const config = fs.readFileSync(path.join(f.ws, '.git', 'config'), 'utf8')
    await run(client, 'cmd /d /c echo [core]>> .git\\config')
    assert.equal(fs.readFileSync(path.join(f.ws, '.git', 'config'), 'utf8'), config, '.git write denied')
    await run(client, 'cmd /d /c ren .git git2')
    assert.ok(fs.existsSync(path.join(f.ws, '.git')), '.git rename denied')

    const env = await run(client, 'cmd /d /c set')
    assert.ok(!env.stdout.includes('HY_IT_SECRET_TOKEN'), 'secret absent from the child environment')
    assert.match(env.stdout, /TEMP=.*\.hy-harness\\tmp/i)

    // apply_patch writes as the workspace-write token.
    const patched = await client.patch({
      patch: '--- /dev/null\n+++ b/patched.txt\n@@ -0,0 +1 @@\n+from a patch\n',
      dryRun: false,
      enforceProtectedPaths: false,
    })
    assert.deepEqual(patched.created, ['patched.txt'])
    await assert.rejects(
      client.patch({
        patch: '--- a/hl.txt\n+++ b/hl.txt\n@@ -1 +1 @@\n-original\n+evil\n',
        dryRun: false,
        enforceProtectedPaths: false,
      }),
    )
    assert.equal(fs.readFileSync(path.join(f.outside, 'hl_src.txt'), 'utf8'), 'original\n', 'patch cannot write a hard link')
  } finally {
    const sid = (await client.sandboxStatus()).workspaceSid
    await client.sandboxRevoke()
    assert.deepEqual(aclMentions(f.ws, sid), [], 'revoke leaves no ACE naming the workspace SID')
    await client.stop()
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('workspace-write grants roots added after initialize', { skip: skip || skipReason('pipe') }, async () => {
  const f = fixture()
  fs.writeFileSync(path.join(f.outside, 'seed.txt'), 'seed\n')
  const client = await open(f)
  try {
    await assert.rejects(run(client, 'Write-Output ok', { cwd: f.outside }), /escapes/)
    const added = await client.sandboxAddRoot(f.outside)
    const same = (value) => path.resolve(value).toLowerCase() === path.resolve(f.outside).toLowerCase()
    assert.ok(added.roots.some(same))
    const result = await run(client, 'Set-Content -Path out.txt -Value ok; Get-Content out.txt', { cwd: f.outside })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(fs.readFileSync(path.join(f.outside, 'out.txt'), 'utf8').trim(), 'ok')
    const removed = await client.sandboxRemoveRoot(f.outside)
    assert.ok(!removed.roots.some(same))
    await assert.rejects(run(client, 'Write-Output ok', { cwd: f.outside }), /escapes/)
  } finally {
    await cleanup(client, f)
  }
})

test('a .git created after the grant stops harness git calls', { skip: skip || (skipReason('pipe') ?? skipReason('sync')) }, async () => {
  const f = fixture()
  const client = await open(f)
  try {
    assert.equal((await client.sandboxStatus()).workspaceWriteAvailable, true)
    // The user replaces the repository after the grant: the new .git inherits the grant.
    fs.rmSync(path.join(f.ws, '.git'), { recursive: true, force: true, maxRetries: 3 })
    spawnSync('git', ['init', '-q'], { cwd: f.ws })
    await run(client, 'cmd /d /c echo [core]>> .git\\config')
    await assert.rejects(client.checkpointCreate('run-late', 'base'), /writable by the sandbox/)
  } finally {
    await cleanup(client, f)
  }
})

test('low-integrity runs piped Node children that workspace-write cannot', { skip: skip || skipReason('pipe') }, async () => {
  const f = fixture()
  const script =
    "const r=require('child_process').spawnSync(process.execPath,['-e','console.log(42)'],{stdio:'pipe'});" +
    "let w='ok';try{require('fs').writeFileSync(process.argv[2],'x')}catch(e){w=e.code}" +
    "console.log(JSON.stringify({pipe:r.error?r.error.code:String(r.stdout).trim(),outside:w}))"
  fs.writeFileSync(path.join(f.ws, 'li.js'), script)
  fs.writeFileSync(path.join(f.ws, 'ww.js'), script)
  const policy = path.join(f.root, 'user.star')
  fs.writeFileSync(
    policy,
    'prefix_rule(pattern = ["node", "li.js"], sandbox = "low-integrity", match = ["node li.js x"], not_match = ["node ww.js x"])\n',
  )
  const client = await open(f, { userPolicyPath: policy })
  const target = path.join(f.outside, 'li.txt')
  try {
    const li = await run(client, `node li.js "${target}"`)
    assert.equal(li.sandbox, 'low-integrity')
    assert.deepEqual(JSON.parse(li.stdout.trim()), { pipe: '42', outside: 'EPERM' })
    const ww = await run(client, `node ww.js "${target}"`)
    assert.equal(ww.sandbox, 'workspace-write')
    assert.equal(JSON.parse(ww.stdout.trim()).pipe, 'EPERM')
    assert.ok(!fs.existsSync(target))
  } finally {
    await cleanup(client, f)
  }
})

test('hy run --sandbox workspace-write --mock works end to end', { skip: skip || skipReason('sync') }, async () => {
  const f = fixture()
  fs.writeFileSync(path.join(f.ws, 'README.md'), '# Fixture\n\nE2E.\n')
  try {
    const result = spawnSync(
      process.execPath,
      [cli, 'run', 'Create HY_DEMO.md with a short demo note. Read README.md first.', '--cwd', f.ws,
        '--state-dir', f.state, '--mock', '--yes', '--sandbox', 'workspace-write'],
      { cwd: repo, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /sandbox: workspace-write \(enforcement: partial\)/)
    assert.ok(fs.existsSync(path.join(f.ws, 'HY_DEMO.md')))
    const revoke = spawnSync(process.execPath, [cli, 'sandbox', 'revoke', '--cwd', f.ws, '--state-dir', f.state], {
      cwd: repo,
      encoding: 'utf8',
    })
    assert.equal(revoke.status, 0, revoke.stderr)
    assert.equal(JSON.parse(revoke.stdout).failed, 0)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('workspace-write on a volume without ACLs is volume-wide, like Codex', { skip: skip || skipReason('pipe') }, async (t) => {
  const exfat = ['F:\\', 'G:\\'].find((d) => {
    try {
      fs.accessSync(d)
      return true
    } catch {
      return false
    }
  })
  if (!exfat) return t.skip('no non-ACL volume on this machine')
  const dir = fs.mkdtempSync(path.join(exfat, 'hy-it-noacl-'))
  const state = path.join(os.tmpdir(), `hy-it-noacl-${process.pid}`)
  const outside = path.join(exfat, `hy-it-noacl-outside-${process.pid}.txt`)
  // Deliberately outside the fixture root: on a volume without ACLs the grant is
  // volume-wide, so the check below proves %USERPROFILE% is still refused.
  const profile = path.join(os.homedir(), `hy-it-noacl-profile-${process.pid}.txt`)
  try {
    const client = await ExecRpcClient.start(resolveServerPath(), {
      protocolVersion: 1,
      workspaceRoot: dir,
      stateDir: state,
      sandbox: 'workspace-write',
      extraWritableRoots: [],
      envPassthrough: [],
      projectTrusted: false,
      protectedPaths: [],
    })
    try {
      const status = await client.sandboxStatus()
      assert.equal(status.workspaceWriteAvailable, true, status.unavailableReason ?? '')
      assert.equal(status.enforcement, 'partial')
      assert.ok(status.gaps.some((g) => g.startsWith('non-acl-volumes:')))

      const inside = await run(client, 'cmd /d /c echo INSIDE> inside.txt')
      assert.equal(inside.exitCode, 0, inside.stderr)
      assert.equal(fs.readFileSync(path.join(dir, 'inside.txt'), 'utf8').trim(), 'INSIDE')

      const outsideRun = await run(client, `cmd /d /c echo OUTSIDE> "${outside}"`)
      assert.equal(outsideRun.exitCode, 0, outsideRun.stderr)
      assert.equal(fs.readFileSync(outside, 'utf8').trim(), 'OUTSIDE')

      const profileRun = await run(client, `cmd /d /c echo PROFILE> "${profile}"`)
      assert.notEqual(profileRun.exitCode, 0)
      assert.equal(fs.existsSync(profile), false)
    } finally {
      await client.sandboxRevoke()
      await client.stop()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(state, { recursive: true, force: true })
    fs.rmSync(outside, { force: true })
    fs.rmSync(profile, { force: true })
  }
})
