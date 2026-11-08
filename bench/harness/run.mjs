// Harness benchmark: the same tasks, one after another in one session, on
// HY-HARNESS and DeepSeek Harness, with the same model and effort.
//
//   node bench/harness/run.mjs [--suite tb2-financial|stats] [--runs 10] [--harness hy,dsh] [--parallel 2] [--out bench/results]
//
// Each run gets a fresh workspace from the suite, gives its tasks in order,
// then runs the suite's hidden checks and reads tokens, cache hits, tool calls
// and timing from the harness's own session log. Results append to
// <out>/<stamp>/runs.jsonl; `report.mjs` turns them into means and 95% CIs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readDshSession, readHySession } from './logs.mjs'
import { runRounds } from './schedule.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const MODEL = 'deepseek-v4.1-flash'
const EFFORT = 'max'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const runs = Number(arg('runs', '10'))
const harnesses = String(arg('harness', 'hy,dsh')).split(',')
const parallel = Number(arg('parallel', '2'))
if (!Number.isInteger(runs) || runs < 0 || !Number.isInteger(parallel) || parallel < 1 || new Set(harnesses).size !== harnesses.length) throw new Error('runs, parallel, or harness list is invalid')
const benchRoot = path.resolve(arg('workdir', 'F:/hy-bench/harness'))
const stamp = arg('stamp', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stamp)) throw new Error('stamp must be a simple name')
const outDir = path.resolve(arg('out', path.join(repo, 'bench', 'results')), stamp)
if (fs.existsSync(path.join(outDir, 'meta.json')) || fs.existsSync(path.join(outDir, 'runs.jsonl'))) throw new Error(`benchmark results already exist: ${outDir}`)
fs.mkdirSync(outDir, { recursive: true })
const SUITES = { 'tb2-financial': './suites/tb2-financial.mjs', 'tb2-async-windows': './suites/async-cancel.mjs', 'security-holdout': './suites/security-holdout.mjs', stats: './suites/stats.mjs' }
const suiteId = String(arg('suite', 'tb2-financial'))
if (!(suiteId in SUITES)) throw new Error(`unknown suite ${suiteId}; one of ${Object.keys(SUITES).join(', ')}`)
const suite = (await import(SUITES[suiteId])).createSuite({ cacheRoot: path.join(path.dirname(benchRoot), 'cache') })
const TASKS = suite.tasks

const DSH_EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
const DSH_CLI = path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
const DSH_PATCH = path.join(here, 'dsh.patch.yml')
const HY_MAIN = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')
const EXEC_SERVER = path.join(repo, 'target', 'release', 'hy-exec-server.exe')

// exFAT records no owner, so git needs safe.directory; scoped to the child.
const childEnv = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' }

function exec(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, env: options.env ?? childEnv, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 3_600_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function prepare(harness, n) {
  const ws = path.join(benchRoot, `${stamp}-${harness}-${n}`)
  fs.mkdirSync(ws, { recursive: false })
  const prepared = await suite.prepare(ws)
  for (const args of [['init', '-q'], ['-c', 'core.autocrlf=false', 'add', '-A'], ['-c', 'user.email=bench@local', '-c', 'user.name=bench', 'commit', '--allow-empty', '-qm', 'fixture']]) {
    const result = await exec('git', args, { cwd: ws })
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return { ws, prepared }
}

/**
 * A fresh HY user-config directory for the benchmark: the user's config.json
 * minus the parts that would make the comparison unfair or leak in state
 * from other projects — MCP servers (`mcpServers`, the `automation` presets)
 * and added workspace roots. RULE.md and skills are not copied, so the
 * user's global rules are ignored too. The model role, plugins, sandbox and
 * the rest stay as the user runs HY.
 */
function benchHyConfigDir(variant, extra = {}) {
  const dir = path.join(benchRoot, `${stamp}-${variant}-config`)
  fs.mkdirSync(dir, { recursive: false })
  const userDir = process.env.HY_CONFIG_DIR ?? path.join(process.env.APPDATA, 'hy-harness')
  const userFile = path.join(userDir, 'config.json')
  const user = fs.existsSync(userFile) ? JSON.parse(fs.readFileSync(userFile, 'utf8')) : {}
  for (const key of ['mcpServers', 'automation', 'workspaceRoots', 'workspaceRootsByWorkspace']) delete user[key]
  const config = { ...user, ...extra }
  const worker = config.roles?.worker
  if (runs > 0 && (worker?.provider !== 'opencode' || worker?.model !== MODEL || worker?.effort !== EFFORT)) {
    throw new Error(`benchmark worker must use opencode/${MODEL} with effort ${EFFORT}`)
  }
  // The exec daemon filters its environment; keep the fixture's exFAT Git trust in agent commands too.
  config.sandbox = { ...config.sandbox, envPassthrough: [...new Set([...(config.sandbox?.envPassthrough ?? []), 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'])] }
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
  return dir
}

// HY variants: `hy` is HY as configured; every other variant changes one
// setting, so comparing it with `hy` measures exactly that change.
const HY_VARIANTS = {
  hy: {},
  'hy-fast': {},
  'hy-thorough': {},
  'hy-full': { reasoningHistory: 'full' },
  'hy-none': { reasoningHistory: 'none' },
  'hy-legacy': { promptVariant: 'legacy' },
  'hy-lean2': { promptVariant: 'lean2' },
  'hy-lean3': { promptVariant: 'lean3' },
  'hy-lean4': { promptVariant: 'lean4' },
}
if (harnesses.some((h) => h !== 'dsh' && !Object.hasOwn(HY_VARIANTS, h))) throw new Error('unknown harness')
fs.mkdirSync(benchRoot, { recursive: true })
const hyConfigDirs = Object.fromEntries(harnesses.filter((h) => h in HY_VARIANTS).map((h) => [h, benchHyConfigDir(h, HY_VARIANTS[h])]))

async function runHy(ws, n, variant) {
  const state = `${ws}.state`
  if (fs.existsSync(state) || fs.existsSync(`${ws}.grader`)) throw new Error(`benchmark state or grader already exists: ${ws}`)
  const started = Date.now()
  const common = ['--cwd', ws, '--state-dir', state, '--json', '--full-auto', '--exec-server', EXEC_SERVER, ...(variant === 'hy-fast' || variant === 'hy-thorough' ? ['--work-mode', variant.slice(3)] : [])]
  const options = { cwd: ws, env: { ...childEnv, HY_CONFIG_DIR: hyConfigDirs[variant] }, timeoutMs: suite.agentTimeoutMs }
  // `hy chat` reads one prompt per stdin line; a single (multi-line) task goes
  // through `hy run` as an argument, the way DSH receives it.
  const r =
    TASKS.length === 1
      ? await exec(process.execPath, [HY_MAIN, 'run', ...common, TASKS[0].prompt], options)
      : await exec(process.execPath, [HY_MAIN, 'chat', ...common], { ...options, input: `${TASKS.map((t) => t.prompt).join('\n')}\n/exit\n` })
  const wallMs = Date.now() - started
  fs.writeFileSync(path.join(outDir, `${variant}-${n}.stdout.jsonl`), r.stdout)
  fs.writeFileSync(path.join(outDir, `${variant}-${n}.stderr.log`), r.stderr)
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
    const r = await exec(DSH_EXE, args, { cwd: ws, env: { ...childEnv, ELECTRON_RUN_AS_NODE: '1' }, timeoutMs: suite.agentTimeoutMs })
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
  let stage = 'setup'
  const ws = path.join(benchRoot, `${stamp}-${harness}-${n}`)
  try {
    const { prepared } = await prepare(harness, n)
    if (fs.existsSync(`${ws}.grader`)) throw new Error(`benchmark grader already exists: ${ws}.grader`)
    stage = 'run'
    const r = harness in HY_VARIANTS ? await runHy(ws, n, harness) : await runDsh(ws, n)
    stage = 'grading'
    const checks = await suite.check(ws, prepared)
    // A run the provider never served (every turn failed with an HTTP error such
    // as "server is overloaded") measures the provider, not the harness: it is
    // recorded and listed, and report.mjs leaves it out of the statistics.
    const stderr = fs.readFileSync(path.join(outDir, `${harness in HY_VARIANTS ? harness : 'dsh'}-${n}.stderr.log`), 'utf8')
    const providerErrors = (stderr.match(/turn failed: \S+ HTTP (429|5\d\d)|dsh: (RATE_LIMIT|SERVER|TRANSPORT|OVERLOADED)/g) ?? []).length
    const providerFailure = providerErrors > 0 && (r.log?.turns ?? 0) < TASKS.length
    const record = {
      harness,
      n,
      stamp,
      suite: suite.id,
      model: MODEL,
      effort: EFFORT,
      ws,
      exit: r.exit,
      wallMs: r.wallMs,
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      checks,
      ...(r.log ?? { logMissing: true }),
      ...(providerErrors > 0 ? { providerErrors } : {}),
      ...(providerFailure ? { providerFailure: true } : {}),
    }
    fs.appendFileSync(path.join(outDir, 'runs.jsonl'), `${JSON.stringify(record)}\n`)
    const graded = Object.entries(checks).filter(([k]) => k !== 'reward')
    const passed = graded.filter(([, v]) => v).length
    console.log(`${harness} #${n}: exit ${r.exit}, ${(r.wallMs / 1000).toFixed(0)}s, checks ${passed}/${graded.length}${checks.reward && r.exit === 0 ? ' (solved)' : ''}, input ${r.log?.input ?? '?'}, hit ${r.log?.hitRate ?? '?'}%, tools ${r.log?.toolCalls ?? '?'}`)
    return record
  } catch (error) {
    const failure = { harness, n, stamp, suite: suite.id, model: MODEL, effort: EFFORT, ws, exit: null, checks: {}, logMissing: true, failureStage: stage, failure: String(error?.message ?? error) }
    fs.appendFileSync(path.join(outDir, 'runs.jsonl'), `${JSON.stringify(failure)}\n`)
    console.error(`${harness} #${n}: ${stage} failed: ${failure.failure}`)
    return failure
  }
}

// Complete each round before starting the next; rotate order to spread starts.
fs.writeFileSync(path.join(outDir, 'meta.json'), `${JSON.stringify({ stamp, suite: suite.id, suiteDescription: suite.description, ...(suite.source ? { source: suite.source } : {}), model: MODEL, effort: EFFORT, runs, harnesses, tasks: TASKS, host: os.hostname(), started: new Date().toISOString() }, null, 2)}\n`)
await runRounds(harnesses, runs, parallel, one)
console.log(`results: ${outDir}`)
