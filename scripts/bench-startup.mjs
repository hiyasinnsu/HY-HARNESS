// WP-01: a small, deterministic baseline for startup, one mock turn and the
// tool-schema size. Run before and after an adoption WP to detect regressions
// (target: startup within ±10% of docs/bench-baseline.md).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')
const core = await import(pathToFileURL(path.join(repo, 'packages', 'core', 'dist', 'index.js')).href)

const runs = Number(process.env.HY_BENCH_RUNS ?? 3)
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-bench-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Bench fixture\n', 'utf8')
  const git = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' })
  if (git.status !== 0) throw new Error(`git init: ${git.stderr}`)
  return dir
}

function envFor(dir) {
  const configDir = path.join(dir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  return {
    ...process.env,
    HY_CONFIG_DIR: configDir,
    LOCALAPPDATA: path.join(dir, 'localappdata'),
    ELECTRON_RUN_AS_NODE: undefined,
  }
}

/** Spawns `hy web` and resolves when it prints its URL line. */
function measureWebStartup(dir) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint()
    const child = spawn(process.execPath, [cli, 'web', '--cwd', dir, '--mock', '--port', '0', '--no-open'], {
      cwd: dir,
      env: envFor(dir),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      if (value instanceof Error) reject(value)
      else resolve(Number(process.hrtime.bigint() - started) / 1e6)
    }
    const timer = setTimeout(() => finish(new Error(`hy web did not start:\n${output.slice(-2000)}`)), 60_000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
      if (/https?:\/\/[^\s]+\?token=/.test(output)) finish()
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (error) => finish(error))
    child.on('exit', (code) => finish(new Error(`hy web exited early (${code}):\n${output.slice(-2000)}`)))
  })
}

function measureMockRun(dir) {
  const started = process.hrtime.bigint()
  const result = spawnSync(process.execPath, [cli, 'run', 'Create BENCH.md', '--cwd', dir, '--mock', '--yes'], {
    cwd: dir,
    env: envFor(dir),
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (result.error) throw new Error(`hy run did not finish: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`hy run failed (${result.status}):\n${result.stderr}`)
  return Number(process.hrtime.bigint() - started) / 1e6
}

const webStartupMs = []
const mockRunMs = []
for (let i = 0; i < runs; i++) {
  // A fresh fixture per run: the mock demo creates HY_DEMO.md, and a second run
  // in the same workspace would take the read-before-edit error path.
  const dir = fixture()
  try {
    webStartupMs.push(await measureWebStartup(dir))
    mockRunMs.push(measureMockRun(dir))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const toolSchemaChars = JSON.stringify(core.TOOL_SPECS.filter((spec) => spec.wire !== false)).length
console.log(
  JSON.stringify(
    {
      webStartupMs: Math.round(median(webStartupMs)),
      webStartupSamples: webStartupMs.map((value) => Math.round(value)),
      mockRunMs: Math.round(median(mockRunMs)),
      mockRunSamples: mockRunMs.map((value) => Math.round(value)),
      toolSchemaChars,
      wireTools: core.TOOL_SPECS.filter((spec) => spec.wire !== false).length,
      node: process.version,
      platform: process.platform,
    },
    null,
    2,
  ),
)
