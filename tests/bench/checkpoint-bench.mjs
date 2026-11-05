// pnpm bench:checkpoint (design Goal 5, Verification Plan): on a
// 10,000-tracked-file repository with <= 200 changed files (local NTFS, Defender
// on), checkpoint create must take < 750 ms and rollback < 500 ms. Create has to
// hash every changed file and write new loose objects, each of which Defender
// scans; rollback writes no objects (target revised 2026-11-03).
//
//   node tests/bench/checkpoint-bench.mjs [--files 10000] [--changed 200] [--iterations 7] [--keep]
//
// Times are the daemon's own `durationMs` (git work only) and the client-side
// round trip. Exits 1 when a median reaches its target.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : def
}
const FILES = arg('files', 10_000)
const CHANGED = arg('changed', 200)
const ITERATIONS = arg('iterations', 7)
const TARGET_MS = { create: 750, rollback: 500 }

const { ExecRpcClient, resolveServerPath } = await import(new URL('../../packages/core/dist/index.js', import.meta.url).href)
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-bench-'))
const state = `${ws}-state`
const fileOf = (i) => path.join(ws, `src${Math.floor(i / 100)}`, `m${i % 100}.ts`)
console.error(`[bench] building ${FILES} tracked files in ${ws}`)
const t0 = Date.now()
for (let i = 0; i < FILES; i++) {
  const f = fileOf(i)
  if (i % 100 === 0) fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, `export const v${i} = ${i}\n// ${'x'.repeat(i % 200)}\n`)
}
git(ws, 'init', '-q')
git(ws, '-c', 'core.autocrlf=false', 'add', '-A')
git(ws, '-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'bench')
console.error(`[bench] fixture ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`)

const server = resolveServerPath()
const client = await ExecRpcClient.start(server, {
  protocolVersion: 1,
  workspaceRoot: fs.realpathSync.native(ws),
  stateDir: state,
  sandbox: 'unconfined',
  extraWritableRoots: [],
  envPassthrough: [],
  projectTrusted: true,
  protectedPaths: [],
})
const results = { create: [], rollback: [], createRoundTrip: [], rollbackRoundTrip: [] }
try {
  const runId = 'run-bench'
  await client.checkpointCreate(runId, 'base')
  for (let it = 0; it <= ITERATIONS; it++) {
    // The same CHANGED files each time (new content every iteration): the
    // target is for <= CHANGED changed files, not a growing set.
    const picks = Array.from({ length: CHANGED }, (_, k) => (k * 37) % FILES)
    for (const i of picks) fs.appendFileSync(fileOf(i), `// edit ${it}\n`)
    let t = performance.now()
    const created = await client.checkpointCreate(runId, `c${it}`)
    const createRt = performance.now() - t
    for (const i of picks) fs.appendFileSync(fileOf(i), `// more ${it}\n`)
    t = performance.now()
    const rolled = await client.checkpointRollback(runId, `c${it}`)
    const rollbackRt = performance.now() - t
    if (rolled.restored.length !== CHANGED) throw new Error(`rollback restored ${rolled.restored.length}, expected ${CHANGED}`)
    if (it === 0) continue // warm-up: first stat of the index
    results.create.push(created.durationMs)
    results.rollback.push(rolled.durationMs)
    results.createRoundTrip.push(createRt)
    results.rollbackRoundTrip.push(rollbackRt)
  }
} finally {
  await client.stop()
  if (!process.argv.includes('--keep')) {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 3 })
    fs.rmSync(state, { recursive: true, force: true })
  }
}

const summary = Object.fromEntries(
  Object.entries(results).map(([k, xs]) => [k, { medianMs: Math.round(median(xs)), maxMs: Math.round(Math.max(...xs)) }]),
)
const report = {
  date: new Date().toISOString(),
  files: FILES,
  changed: CHANGED,
  iterations: ITERATIONS,
  server: path.basename(path.dirname(server)),
  git: git(os.tmpdir(), '--version').trim(),
  targetMs: TARGET_MS,
  ...summary,
}
console.log(JSON.stringify(report, null, 2))
const pass = summary.create.medianMs < TARGET_MS.create && summary.rollback.medianMs < TARGET_MS.rollback
console.error(
  `[bench] ${pass ? 'PASS' : 'FAIL'}: create median ${summary.create.medianMs} ms (target < ${TARGET_MS.create} ms), ` +
    `rollback median ${summary.rollback.medianMs} ms (target < ${TARGET_MS.rollback} ms)`,
)
process.exitCode = pass ? 0 : 1
