// OQ-2 follow-up measurement (ADR 0001 §4): `esbuild` (CLI + Node API) and
// `npm install` under `workspace-write` and `low-integrity`.
//
//   node spikes/win-sandbox/oq2_esbuild_npm.mjs
//
// Builds %USERPROFILE%\hy-oq2-esbuild (NTFS, outside AppData), installs esbuild
// and packs a local tarball, runs each command in unconfined, workspace-write,
// and low-integrity via hy-exec-server, writes results/oq2-esbuild-npm.json,
// then revokes the grant and deletes the fixture.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { ExecRpcClient, resolveServerPath } = await import(new URL('../../packages/core/dist/index.js', import.meta.url).href)

const root = path.join(os.homedir(), 'hy-oq2-esbuild')
const ws = path.join(root, 'ws')

function setup() {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'local-pkg'), { recursive: true })
  fs.writeFileSync(
    path.join(ws, 'local-pkg', 'package.json'),
    JSON.stringify({ name: 'local-pkg', version: '1.0.0', main: 'index.js' }, null, 2),
  )
  fs.writeFileSync(path.join(ws, 'local-pkg', 'index.js'), 'module.exports = 42\n')

  fs.writeFileSync(
    path.join(ws, 'package.json'),
    JSON.stringify(
      {
        name: 'oq2-esbuild-fixture',
        version: '1.0.0',
        private: true,
        devDependencies: { esbuild: '0.25.0' },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(ws, 'entry.ts'), 'const x: number = 21 * 2; console.log(x)\n')
  fs.writeFileSync(
    path.join(ws, 'build-api.cjs'),
    [
      "const esbuild = require('esbuild')",
      "esbuild.build({ entryPoints: ['entry.ts'], bundle: true, outfile: 'out-api.js' })",
      "  .then(() => { console.log('esbuild-api-ok'); process.exit(0) })",
      "  .catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1) })",
    ].join('\n'),
  )
  console.error('[oq2-esbuild] npm install esbuild (unconfined setup)...')
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: ws,
    shell: true,
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`npm install esbuild failed: ${r.stderr}`)
  const pack = spawnSync('npm', ['pack', './local-pkg', '--loglevel=error'], {
    cwd: ws,
    shell: true,
    encoding: 'utf8',
  })
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`)
}

const cases = [
  ['esbuild-cli', 'node_modules\\.bin\\esbuild.cmd entry.ts --bundle --outfile=out-cli.js'],
  ['esbuild-node-api', 'node build-api.cjs'],
  ['npm-install-default-cache', 'npm install ./local-pkg-1.0.0.tgz --no-audit --no-fund --prefer-offline'],
  ['npm-install-workspace-cache', 'npm install ./local-pkg-1.0.0.tgz --cache .npm-cache --no-audit --no-fund --prefer-offline'],
]

function summarize(r) {
  const text = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '')
  const errLine = text
    .split(/\r?\n/)
    .find((l) => /EPERM|EACCES|ENOENT|Error:|error:|npm error|failed/i.test(l))
    ?.trim()
  return {
    exitCode: r.exitCode ?? null,
    timedOut: r.timedOut,
    ms: r.durationMs,
    sandbox: r.sandbox,
    passed: r.exitCode === 0 && !r.timedOut,
    ...(r.exitCode !== 0 ? { firstError: errLine?.slice(0, 300) ?? null, tail: text.trim().slice(-600) } : {}),
  }
}

async function runSession(label, sandbox, policy) {
  const client = await ExecRpcClient.start(resolveServerPath(), {
    protocolVersion: 1,
    workspaceRoot: fs.realpathSync.native(ws),
    stateDir: path.join(root, 'state'),
    sandbox,
    extraWritableRoots: [],
    envPassthrough: [],
    projectTrusted: false,
    protectedPaths: [],
    ...(policy ? { userPolicyPath: policy } : {}),
  })
  const out = {}
  try {
    const status = await client.sandboxStatus()
    if (sandbox !== 'unconfined' && !status.workspaceWriteAvailable) throw new Error(status.unavailableReason)
    for (const [name, command] of cases) {
      const r = await client.exec({
        command,
        mode: 'agent',
        foregroundWaitMs: 120_000,
        hardTimeoutMs: 120_000,
        approval: { by: 'user', callId: 'oq2-esbuild' },
      })
      const s = summarize(r)
      out[name] = s
      console.error(`[${label}] ${name.padEnd(28)} exit=${String(s.exitCode).padEnd(3)} ${s.ms}ms (${s.sandbox}) ${s.firstError ?? 'OK'}`)
    }
    return { status, results: out }
  } finally {
    await client.stop()
  }
}

setup()
const lowPolicy = path.join(root, 'low.rules')
fs.writeFileSync(
  lowPolicy,
  [
    'prefix_rule(pattern = ["node", "build-api.cjs"], decision = "allow", sandbox = "low-integrity")',
    'prefix_rule(pattern = ["npm", "install"], decision = "allow", sandbox = "low-integrity")',
    'prefix_rule(pattern = ["node_modules\\\\.bin\\\\esbuild.cmd"], decision = "allow", sandbox = "low-integrity")',
  ].join('\n'),
)

let revokeResult
try {
  const unconfined = await runSession('unconfined', 'unconfined')
  const workspaceWrite = await runSession('workspace-write', 'workspace-write')
  const lowIntegrity = await runSession('low-integrity', 'workspace-write', lowPolicy)

  const client = await ExecRpcClient.start(resolveServerPath(), {
    protocolVersion: 1,
    workspaceRoot: fs.realpathSync.native(ws),
    stateDir: path.join(root, 'state'),
    sandbox: 'unconfined',
    extraWritableRoots: [],
    envPassthrough: [],
    projectTrusted: false,
    protectedPaths: [],
  })
  try {
    revokeResult = await client.sandboxRevoke()
  } finally {
    await client.stop()
  }

  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    fixture: ws,
    esbuildVersion: JSON.parse(fs.readFileSync(path.join(ws, 'node_modules', 'esbuild', 'package.json'), 'utf8')).version,
    unconfined: unconfined.results,
    workspaceWrite: workspaceWrite.results,
    lowIntegrity: lowIntegrity.results,
    revoke: revokeResult,
  }
  fs.mkdirSync(path.join(here, 'results'), { recursive: true })
  const outPath = path.join(here, 'results', 'oq2-esbuild-npm.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`wrote ${outPath}`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
