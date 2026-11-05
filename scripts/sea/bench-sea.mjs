// CP-41: startup comparison of the SEA prototype and `node main.js`.
// Prints median wall-clock times (ms) for `--version` and a mock `run`.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const exe = path.join(repo, 'release', 'sea', 'hy.exe')
const main = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')
const runs = Number(process.argv[2] ?? 7)
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-sea-bench-'))
const ws = path.join(base, 'ws')
fs.mkdirSync(ws)
spawnSync('git', ['init', '-q'], { cwd: ws })
const env = { ...process.env, LOCALAPPDATA: path.join(base, 'local'), HY_CONFIG_DIR: path.join(base, 'user'), HY_SANDBOX: 'unconfined' }

const time = (file, args) => {
  const t = process.hrtime.bigint()
  const r = spawnSync(file, args, { env, encoding: 'utf8', cwd: ws })
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  if (r.status !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${r.stderr}`)
  return { ms, out: r.stdout.trim() }
}
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]

try {
  const cold = time(exe, ['--version'])
  const result = {
    seaColdVersionMs: Math.round(cold.ms),
    seaVersionOutput: cold.out,
    seaVersionMs: Math.round(median(Array.from({ length: runs }, () => time(exe, ['--version']).ms))),
    nodeVersionMs: Math.round(median(Array.from({ length: runs }, () => time(process.execPath, [main, '--version']).ms))),
    seaRunMs: Math.round(median(Array.from({ length: 3 }, () => time(exe, ['run', 'SAY hi', '--mock', '--cwd', ws]).ms))),
    nodeRunMs: Math.round(median(Array.from({ length: 3 }, () => time(process.execPath, [main, 'run', 'SAY hi', '--mock', '--cwd', ws]).ms))),
    seaRunOutput: time(exe, ['run', 'SAY from the single binary', '--mock', '--cwd', ws]).out.split('\n').at(-1),
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
}
