// Harness benchmark: the same tasks, one after another in one session, on
// HY-HARNESS and DeepSeek Harness, with the same model and effort.
//
//   node bench/harness/run.mjs --runs 5 [--harness hy,dsh] [--parallel 2] [--out bench/results]
//
// Each run gets a fresh copy of the fixture project, gives the tasks in order,
// then runs the hidden checks and reads tokens, cache hits, tool calls and
// timing from the harness's own session log. Results append to
// <out>/<stamp>/runs.jsonl; `report.mjs` turns them into means and 95% CIs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeFixture } from './fixture.mjs'
import { TASKS, checkWorkspace } from './tasks.mjs'
import { readDshSession, readHySession } from './logs.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const MODEL = 'deepseek-v4.1-flash'
const EFFORT = 'max'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const runs = Number(arg('runs', '3'))
const harnesses = String(arg('harness', 'hy,dsh')).split(',')
const parallel = Number(arg('parallel', '2'))
const benchRoot = path.resolve(arg('workdir', 'F:/hy-bench/harness'))
const stamp = arg('stamp', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
const outDir = path.resolve(arg('out', path.join(repo, 'bench', 'results')), stamp)
fs.mkdirSync(outDir, { recursive: true })

const DSH_EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
const DSH_CLI = path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
const DSH_PATCH = path.join(here, 'dsh.patch.yml')
const HY_MAIN = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')
const EXEC_SERVER = path.join(repo, 'target', 'release', 'hy-exec-server.exe')

// exFAT records no owner, so git needs safe.directory; scoped to the child.
const childEnv = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' }

function exec(cmd, args, options) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...options, env: options.env ?? childEnv, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 3_600_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function prepare(harness, n) {
  const ws = path.join(benchRoot, `${stamp}-${harness}-${n}`)
  fs.rmSync(ws, { recursive: true, force: true })
  fs.mkdirSync(ws, { recursive: true })
  writeFixture(ws)
  await exec('git', ['init', '-q'], { cwd: ws })
  await exec('git', ['-c', 'core.autocrlf=false', 'add', '-A'], { cwd: ws })
  await exec('git', ['-c', 'user.email=bench@local', '-c', 'user.name=bench', 'commit', '-qm', 'fixture'], { cwd: ws })
  return ws
}

async function runHy(ws, n) {
  const state = `${ws}.state`
  fs.rmSync(state, { recursive: true, force: true })
  const input = `${TASKS.map((t) => t.prompt).join('\n')}\n/exit\n`
  const started = Date.now()
  const r = await exec(process.execPath, [HY_MAIN, 'chat', '--cwd', ws, '--state-dir', state, '--json', '--full-auto', '--exec-server', EXEC_SERVER], {
    cwd: ws,
    input,
  })
  const wallMs = Date.now() - started
  fs.writeFileSync(path.join(outDir, `hy-${n}.stdout.jsonl`), r.stdout)
  fs.writeFileSync(path.join(outDir, `hy-${n}.stderr.log`), r.stderr)
  return { exit: r.code, wallMs, log: readHySession(state) }
}

async function runDsh(ws, n) {
  let sessionId
  const started = Date.now()
  const exits = []
  let stdoutAll = ''
  let stderrAll = ''
  for (const task of TASKS) {
    const args = ['--expose-internals', DSH_CLI, '--profile', 'headless', '--patch', DSH_PATCH, '--json', ...(sessionId ? ['--session-id', sessionId] : []), task.prompt]
    const r = await exec(DSH_EXE, args, { cwd: ws, env: { ...childEnv, ELECTRON_RUN_AS_NODE: '1' } })
    exits.push(r.code)
    stdoutAll += r.stdout
    stderrAll += r.stderr
    if (!sessionId) {
      for (const line of r.stdout.split('\n')) {
        try {
          const event = JSON.parse(line)
          if (event.type === 'session' && typeof event.id === 'string') sessionId = event.id
          else if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId
        } catch {
          // not JSON
        }
        if (sessionId) break
      }
      if (!sessionId) break
    }
  }
  const wallMs = Date.now() - started
  fs.writeFileSync(path.join(outDir, `dsh-${n}.stdout.jsonl`), stdoutAll)
  fs.writeFileSync(path.join(outDir, `dsh-${n}.stderr.log`), stderrAll)
  return { exit: exits.every((c) => c === 0) ? 0 : exits.find((c) => c !== 0), wallMs, sessionId, log: sessionId ? readDshSession(sessionId) : undefined }
}

async function one(harness, n) {
  const ws = await prepare(harness, n)
  const originalFormatTest = fs.readFileSync(path.join(ws, 'test/format.test.js'), 'utf8')
  const r = harness === 'hy' ? await runHy(ws, n) : await runDsh(ws, n)
  const checks = await checkWorkspace(ws, originalFormatTest)
  const record = { harness, n, stamp, model: MODEL, effort: EFFORT, ws, exit: r.exit, wallMs: r.wallMs, ...(r.sessionId ? { sessionId: r.sessionId } : {}), checks, ...(r.log ?? { logMissing: true }) }
  fs.appendFileSync(path.join(outDir, 'runs.jsonl'), `${JSON.stringify(record)}\n`)
  const passed = Object.values(checks).filter(Boolean).length
  console.log(`${harness} #${n}: exit ${r.exit}, ${(r.wallMs / 1000).toFixed(0)}s, checks ${passed}/${Object.keys(checks).length}, input ${r.log?.input ?? '?'}, hit ${r.log?.hitRate ?? '?'}%, tools ${r.log?.toolCalls ?? '?'}`)
  return record
}

// Interleave: run i of every harness is queued before run i+1, so both see the
// same provider conditions over time.
const queue = []
for (let n = 1; n <= runs; n++) for (const h of harnesses) queue.push([h, n])
fs.writeFileSync(path.join(outDir, 'meta.json'), `${JSON.stringify({ stamp, model: MODEL, effort: EFFORT, runs, harnesses, tasks: TASKS, host: os.hostname(), started: new Date().toISOString() }, null, 2)}\n`)
const workers = Array.from({ length: Math.max(1, parallel) }, async () => {
  for (let item = queue.shift(); item; item = queue.shift()) await one(item[0], item[1])
})
await Promise.all(workers)
console.log(`results: ${outDir}`)
