// CP-41 prototype: builds `release/sea/hy.exe`, a single executable of the
// CLI (Node SEA), and prints its size. Usage:
//
//   pnpm build && cargo build --release -p hy-exec-server
//   node scripts/sea/build-sea.mjs [--debug-exec-server]
//
// The asset `app.bin` is a 4-byte index length, a JSON index
// { hash, files: [{ path, size }] } and the file bytes in index order.
// Measured results and the decision are in docs/adr/0003-single-binary.md.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = path.join(repo, 'release', 'sea')
const exeName = process.platform === 'win32' ? 'hy-exec-server.exe' : 'hy-exec-server'
const profile = process.argv.includes('--debug-exec-server') ? 'debug' : 'release'
const execServer = path.join(repo, 'target', profile, exeName)
if (!fs.existsSync(execServer)) {
  console.error(`missing ${execServer}; build it first (cargo build ${profile === 'release' ? '--release ' : ''}-p hy-exec-server)`)
  process.exit(1)
}

/** Every file under `dir` (skipping tests and source maps), as [relative path in the bundle, absolute path]. */
function collect(dir, prefix, skip = (rel) => /\.test\.(js|d\.ts)$|\.map$|tsbuildinfo$/.test(rel)) {
  const files = []
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name)
      const r = path.posix.join(rel, e.name)
      if (e.isDirectory()) walk(a, r)
      else if (e.isFile() && !skip(r)) files.push([path.posix.join(prefix, r), a])
    }
  }
  walk(dir, '')
  return files
}

/** The runtime dependency closure of `names` in the hoisted node_modules. */
function dependencyClosure(names) {
  const seen = new Set()
  const queue = [...names]
  while (queue.length) {
    const name = queue.shift()
    if (seen.has(name)) continue
    const dir = path.join(repo, 'node_modules', name)
    if (!fs.existsSync(dir)) continue
    seen.add(name)
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    queue.push(...Object.keys(pkg.dependencies ?? {}))
  }
  return [...seen]
}

const files = [
  ...collect(path.join(repo, 'packages', 'core', 'dist'), 'packages/core/dist'),
  ...collect(path.join(repo, 'packages', 'seams', 'dist'), 'packages/seams/dist'),
  ...collect(path.join(repo, 'packages', 'hy-cli', 'dist'), 'packages/hy-cli/dist'),
  ...collect(path.join(repo, 'packages', 'hy-cli', 'web'), 'packages/hy-cli/web', (rel) => rel.startsWith('src/') || rel.startsWith('test/')),
  // package.json files carry "type": "module" for the dist folders.
  ...['core', 'seams', 'hy-cli'].map((p) => [`packages/${p}/package.json`, path.join(repo, 'packages', p, 'package.json')]),
  ['package.json', path.join(repo, 'package.json')],
  [`bin/${exeName}`, execServer],
  ...dependencyClosure(['cordis']).flatMap((name) => collect(path.join(repo, 'node_modules', name), `node_modules/${name}`, (rel) => rel.includes('/test/'))),
]

const hash = createHash('sha256')
const entries = files.map(([rel, abs]) => {
  const bytes = fs.readFileSync(abs)
  hash.update(rel).update(bytes)
  return { rel, bytes }
})
const index = Buffer.from(JSON.stringify({ hash: hash.digest('hex').slice(0, 16), files: entries.map((e) => ({ path: e.rel, size: e.bytes.length })) }))
const head = Buffer.alloc(4)
head.writeUInt32LE(index.length, 0)
fs.mkdirSync(out, { recursive: true })
const asset = path.join(out, 'app.bin')
fs.writeFileSync(asset, Buffer.concat([head, index, ...entries.map((e) => e.bytes)]))

const config = path.join(out, 'sea-config.json')
const blob = path.join(out, 'sea-prep.blob')
fs.writeFileSync(
  config,
  JSON.stringify({ main: path.join(repo, 'scripts', 'sea', 'launcher.cjs'), output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, assets: { 'app.bin': asset } }, null, 2),
)
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' })
const exe = path.join(out, process.platform === 'win32' ? 'hy.exe' : 'hy')
fs.copyFileSync(process.execPath, exe)
const postject = path.join(repo, 'node_modules', 'postject', 'dist', 'cli.js')
execFileSync(process.execPath, [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite'], { stdio: 'inherit' })
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`
console.log(JSON.stringify({ exe, exeBytes: fs.statSync(exe).size, exe: mb(fs.statSync(exe).size), asset: mb(fs.statSync(asset).size), files: files.length, node: mb(fs.statSync(process.execPath).size) }, null, 2))
