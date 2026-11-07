// pnpm test:integration — the integration suite, in two groups:
//
//   parallel  files that only touch their own temp workspace, config and
//             state: run concurrently, one child process per file
//   serial    files that change machine-wide state (sandbox ACL grants and
//             revokes, the shared sandbox temp, fixed ports) or measure time
//             (Ollama token count): one process, one file after another, as
//             the whole suite ran before
//
// node scripts/test-integration.mjs [--concurrency N] [file filter...]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(repo, 'tests', 'integration')

// Keep this list explicit: a file belongs here when it grants or revokes ACLs,
// runs confined commands (shared capability SIDs and sandbox temp), binds a
// fixed port, or times something.
const SERIAL = new Set([
  'default-sandbox.test.mjs',
  'daemon.test.mjs',
  'exec-remote.test.mjs',
  'guardian.test.mjs',
  'phone.test.mjs',
  'ptc-appcontainer.test.mjs',
  'sandbox-deny-read.test.mjs',
  'sandbox-mode.test.mjs',
  'tool-overhead.test.mjs',
  'win10-sandbox.test.mjs',
  'write-stdin.test.mjs',
])

const args = process.argv.slice(2)
const ci = args.indexOf('--concurrency')
const concurrency = ci >= 0 ? Number(args[ci + 1]) : Math.max(2, Math.min(6, Math.floor(os.availableParallelism() / 2)))
const filters = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--concurrency')
const all = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort()
const serial = all.filter((f) => SERIAL.has(f))
const parallel = all.filter((f) => !SERIAL.has(f))

const base = ['--test', '--import', './tests/integration/isolate.mjs', '--import', './tests/integration/fresh-build.mjs', '--test-reporter=spec']
function run(label, extra, files) {
  if (files.length === 0) return Promise.resolve(0)
  const started = Date.now()
  console.log(`\n[${label}] ${files.length} file(s)`)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...base, ...extra, ...files.map((f) => path.join('tests', 'integration', f))], {
      cwd: repo,
      stdio: 'inherit',
    })
    child.on('close', (code) => {
      console.log(`[${label}] exit ${code} in ${((Date.now() - started) / 1000).toFixed(0)}s`)
      resolve(code ?? 1)
    })
  })
}

const started = Date.now()
// Each parallel file runs in its own process (isolation=process), so each
// gets its own isolate.mjs config dir and module state.
const parallelCode = await run(`parallel x${concurrency}`, ['--test-isolation=process', `--test-concurrency=${concurrency}`], parallel)
const serialCode = await run('serial', ['--test-isolation=none', '--test-concurrency=1'], serial)
console.log(`\nintegration: ${((Date.now() - started) / 1000).toFixed(0)}s total`)
process.exit(parallelCode || serialCode)
