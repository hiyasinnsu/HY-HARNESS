// Environment capability probe for the integration suite. The workspace-write
// sandbox runs child processes with a restricted token whose restricting SIDs
// (WRITE_RESTRICTED) are what deny the access: `spawn` with stdio 'pipe' and
// every `spawnSync` fail with EPERM, and nothing under os.homedir() can be
// created. The integrity level is not the cause - low-integrity sessions do
// create pipes and run Jest/Vitest (spikes/win-sandbox/results/oq2.json). Tests
// that need any of that pass `{ skip: skipReason(kind) }` so node:test reports
// SKIP instead of a failure.
//
// The three checks run once, when this module is first evaluated, and the
// result is cached in `capabilities`. Importing this file therefore starts two
// short-lived child processes (one per spawn flavour, because a restricted
// token fails each of them for a different API path) and touches the user
// profile once; it has no other side effects.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROBE_TIMEOUT_MS = 10_000

// Async spawn, like the tests that need pipes: a denied pipe surfaces as an
// 'error' event (EPERM), not as a throw.
function spawnPipeWorks() {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, ['-e', '0'], { stdio: 'pipe' })
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, PROBE_TIMEOUT_MS)
    const finish = (ok) => {
      clearTimeout(timer)
      resolve(ok)
    }
    child.on('error', () => finish(false))
    child.on('exit', (code) => finish(code === 0))
  })
}

function spawnSyncWorks() {
  try {
    const result = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS })
    return !result.error && result.status === 0
  } catch {
    return false
  }
}

// The probe directory is removed again in the same call, so nothing is left
// behind under the user profile.
function homedirWritable() {
  let dir
  try {
    dir = fs.mkdtempSync(path.join(os.homedir(), 'hy-probe-'))
  } catch {
    return false
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // A leftover probe directory does not change the capability result.
  }
  return true
}

// Whether a workspace-write sandbox can confine a workspace under os.tmpdir().
// On machines where a directory above %TEMP% (normally %LOCALAPPDATA%) carries
// an AppContainer package ACE, the confined token cannot open it and the exec
// server reports the sandbox unavailable (ADR 0001 §5.2). The probe asks the
// exec server itself, so it matches what the tests will see. Any failure to
// probe (no build, no daemon) keeps the old behaviour: use %TEMP%.
async function confinedTempWorks() {
  if (process.platform !== 'win32') return true
  let core
  try {
    core = await import(new URL('../../packages/core/dist/index.js', import.meta.url).href)
  } catch {
    return true
  }
  let base
  let client
  try {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-probe-'))
    const ws = path.join(base, 'ws')
    fs.mkdirSync(ws)
    client = await core.ExecRpcClient.start(core.resolveServerPath(), {
      protocolVersion: 1,
      workspaceRoot: fs.realpathSync.native(ws),
      stateDir: path.join(base, 'state'),
      sandbox: 'workspace-write',
      extraWritableRoots: [],
      envPassthrough: [],
      projectTrusted: false,
      protectedPaths: [],
    })
    const status = await client.sandboxStatus()
    return !status.unavailableReason
  } catch {
    return true
  } finally {
    try {
      await client?.sandboxRevoke()
    } catch {
      // Nothing was granted when the sandbox is unavailable.
    }
    try {
      await client?.stop()
    } catch {
      // The daemon may already be gone.
    }
    if (base) fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  }
}

export const capabilities = {
  canSpawnPipe: await spawnPipeWorks(),
  canSpawnSync: spawnSyncWorks(),
  canWriteHomedir: homedirWritable(),
}
capabilities.canConfineTemp = capabilities.canSpawnPipe ? await confinedTempWorks() : true

const FLAGS = { pipe: 'canSpawnPipe', sync: 'canSpawnSync', homedir: 'canWriteHomedir' }

// Printed by the test reporter, so the reason is Japanese for the operator.
const REASONS = {
  pipe: 'workspace-write の制限 SID（WRITE_RESTRICTED）により pipe 付き子プロセスを起動できない（EPERM）。low-integrity では動作する',
  sync: 'spawnSync は内部で pipe を作るため、同じ制限 SID で拒否される（EPERM）',
  homedir: 'workspace-write ではユーザープロファイル配下に書き込めない（EPERM）。TEMP は専用ディレクトリに差し替えられている',
}

// undefined when the capability is available (the test runs), otherwise the
// reason node:test prints as `# SKIP <reason>`.
export function skipReason(kind) {
  const flag = FLAGS[kind]
  if (!flag) throw new Error(`unknown capability kind: ${kind}`)
  return capabilities[flag] ? undefined : REASONS[kind]
}

// Fixture root for one test, normally under os.tmpdir(): the workspace-write
// sandbox cannot write to os.homedir() and redirects TEMP to a private
// directory, so os.tmpdir() is the stable base. When the exec server cannot
// confine a workspace under %TEMP% on this machine (`canConfineTemp`, AppContainer
// ACE above it) and the profile is writable, the profile is used instead, as
// `sandbox-deny-read.test.mjs` does. The caller removes the returned directory.
export function tmpRoot() {
  const base = !capabilities.canConfineTemp && capabilities.canWriteHomedir ? os.homedir() : os.tmpdir()
  return fs.mkdtempSync(path.join(base, 'hy-it-'))
}