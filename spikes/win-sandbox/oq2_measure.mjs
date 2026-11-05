// OQ-2 measurement (ADR 0001 §7, design Phase 4 exit): which Node test-runner
// configurations run in `workspace-write` and in `low-integrity`.
//
//   node spikes/win-sandbox/oq2_measure.mjs [--keep]
//
// Builds %USERPROFILE%\hy-oq2-fixture (NTFS, outside AppData), installs Jest
// and Vitest there (unconfined, by this script), runs every configuration
// through the real daemon in three sessions (unconfined baseline,
// workspace-write, low-integrity via a user-policy rule), writes
// results/oq2.json, then revokes the grant and deletes the fixture.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const { ExecRpcClient, resolveServerPath } = await import(new URL('../../packages/core/dist/index.js', import.meta.url).href)

const root = path.join(os.homedir(), 'hy-oq2-fixture')
const ws = path.join(root, 'ws')
const keep = process.argv.includes('--keep')

function setup() {
  if (fs.existsSync(path.join(ws, 'node_modules', 'vitest')) && fs.existsSync(path.join(ws, 'node_modules', 'jest'))) return
  fs.mkdirSync(path.join(ws, 'jest'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'vt'), { recursive: true })
  fs.writeFileSync(
    path.join(ws, 'package.json'),
    JSON.stringify(
      {
        name: 'oq2-fixture',
        version: '1.0.0',
        private: true,
        type: 'commonjs',
        devDependencies: { jest: '30.5.2', vitest: '5.0.5' },
        jest: { testMatch: ['**/jest/*.test.js'] },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(ws, 'sum.js'), 'module.exports = (a, b) => a + b\n')
  fs.writeFileSync(path.join(ws, 'vitest.config.mjs'), "export default { test: { include: ['vt/*.test.mjs'] } }\n")
  // Several files so both runners actually start workers.
  for (let i = 1; i <= 4; i++) {
    fs.writeFileSync(
      path.join(ws, 'jest', `s${i}.test.js`),
      `const sum = require('../sum')\ntest('adds ${i}', () => { expect(sum(${i}, 1)).toBe(${i + 1}) })\n`,
    )
    fs.writeFileSync(
      path.join(ws, 'vt', `s${i}.test.mjs`),
      `import { test, expect } from 'vitest'\nimport sum from '../sum.js'\ntest('adds ${i}', () => { expect(sum(${i}, 1)).toBe(${i + 1}) })\n`,
    )
  }
  console.error('[oq2] npm install (unconfined, from registry.npmjs.org)…')
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: ws, shell: true, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`npm install failed: ${r.stderr}`)
}

const jest = 'node node_modules/jest/bin/jest.js --ci'
const vitest = 'node node_modules/vitest/vitest.mjs run'
const cases = [
  ['jest-workers', `${jest} --maxWorkers=2`],
  ['jest-runInBand', `${jest} --runInBand`],
  ['jest-workerThreads', `${jest} --maxWorkers=2 --workerThreads`],
  ['vitest-forks', `${vitest} --pool=forks`],
  ['vitest-threads', `${vitest} --pool=threads`],
  ['vitest-vmThreads', `${vitest} --pool=vmThreads`],
  ['npx-vitest-threads', 'npx vitest run --pool=threads'],
]

function summarize(name, r) {
  const text = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '')
  const jestTests = text.match(/Tests:\s+(.*)/)?.[1]?.trim()
  const vitestTests = text.match(/Tests\s+(\d+ passed[^\n]*)/)?.[1]?.trim()
  const errLine = text
    .split(/\r?\n/)
    .find((l) => /EPERM|EACCES|Error:|error:|failed to|0xC0000142/i.test(l))
    ?.trim()
  return {
    exitCode: r.exitCode ?? null,
    timedOut: r.timedOut,
    ms: r.durationMs,
    sandbox: r.sandbox,
    tests: jestTests ?? vitestTests ?? null,
    passed: r.exitCode === 0 && !r.timedOut,
    ...(r.exitCode !== 0 ? { firstError: errLine?.slice(0, 300) ?? null, tail: text.trim().slice(-800) } : {}),
  }
}

async function session(label, sandbox, policy) {
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
      let r
      try {
        r = await client.exec({
          command,
          mode: 'agent',
          foregroundWaitMs: 240_000,
          hardTimeoutMs: 180_000,
          approval: { by: 'user', callId: 'oq2' },
        })
      } catch (e) {
        out[name] = { error: e.message }
        console.error(`[oq2] ${label} ${name}: rpc error ${e.message}`)
        continue
      }
      out[name] = summarize(name, r)
      console.error(`[oq2] ${label.padEnd(16)} ${name.padEnd(20)} ${out[name].passed ? 'PASS' : 'FAIL'} exit=${r.exitCode} ${r.durationMs}ms ${out[name].tests ?? ''} ${out[name].firstError ?? ''}`)
    }
  } finally {
    await client.stop()
  }
  return out
}

setup()
const versions = Object.fromEntries(
  ['jest', 'vitest', 'vite', 'esbuild', 'rolldown', 'tinypool', 'jest-worker'].map((p) => {
    try {
      return [p, JSON.parse(fs.readFileSync(path.join(ws, 'node_modules', p, 'package.json'), 'utf8')).version]
    } catch {
      return [p, null]
    }
  }),
)
const policy = path.join(root, 'user-low-integrity.star')
fs.writeFileSync(policy, 'prefix_rule(pattern = [["node", "npx"]], sandbox = "low-integrity", match = ["node x", "npx vitest"])\n')

const results = {
  date: new Date().toISOString(),
  node: process.version,
  os: `${os.type()} ${os.release()}`,
  versions,
  unconfined: await session('unconfined', 'unconfined'),
  'workspace-write': await session('workspace-write', 'workspace-write'),
  'low-integrity': await session('low-integrity', 'workspace-write', policy),
}
fs.mkdirSync(path.join(here, 'results'), { recursive: true })
fs.writeFileSync(path.join(here, 'results', 'oq2.json'), JSON.stringify(results, null, 2))
console.error(`[oq2] wrote ${path.join(here, 'results', 'oq2.json')}`)

if (!keep) {
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
    const r = await client.sandboxRevoke()
    console.error(`[oq2] revoke: restored=${r.restored} stripped=${r.stripped} failed=${r.failed}`)
  } finally {
    await client.stop()
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  console.error(`[oq2] removed ${root}: ${!fs.existsSync(root)}`)
}
void repo
