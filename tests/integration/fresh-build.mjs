// Loaded with `node --test --import` (pnpm test:integration).
//
// The suite drives two artifacts that are built separately from the tests:
//   * the Rust execution daemon (`target/debug` or `target/release`, or
//     HY_EXEC_SERVER), and
//   * the compiled TypeScript (`packages/*/dist`).
//
// Neither `pnpm test:integration` nor `cargo test` rebuilds them. Running the
// suite after an edit therefore exercised the *previous* build and reported a
// false green — a jobs.rs paging fix was once verified against a daemon built
// hours before it. Refuse to run against artifacts older than their sources.
//
// `HY_ALLOW_STALE_BUILD=1` skips the check when an old build is intentional.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const iso = (ms) => new Date(ms).toISOString()
const skip = process.env.HY_ALLOW_STALE_BUILD === '1'

/** Newest mtime of a file that satisfies `accept`, under the given roots. */
function newestFile(roots, accept) {
  let newest
  const visit = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'target') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (!accept(entry.name)) continue
      let mtime
      try {
        mtime = fs.statSync(full).mtimeMs
      } catch {
        continue
      }
      if (!newest || mtime > newest.mtime) newest = { file: full, mtime }
    }
  }
  for (const root of roots) visit(root)
  return newest
}

function resolveDaemon() {
  if (process.env.HY_EXEC_SERVER) return { file: path.resolve(process.env.HY_EXEC_SERVER), explicit: true }
  for (const candidate of [
    ['target', 'debug', 'hy-exec-server.exe'],
    ['target', 'release', 'hy-exec-server.exe'],
    ['target', 'debug', 'hy-exec-server'],
    ['target', 'release', 'hy-exec-server'],
  ]) {
    const file = path.join(repo, ...candidate)
    if (fs.existsSync(file)) return { file, explicit: false }
  }
  return undefined
}

function checkDaemon() {
  const daemon = resolveDaemon()
  if (!daemon) {
    throw new Error(
      'the Rust execution daemon was not found. Build it before the integration tests:\n  cargo build -p hy-exec-server',
    )
  }
  if (daemon.explicit || skip) return
  const candidates = [newestFile([path.join(repo, 'crates')], (name) => name.endsWith('.rs') || name === 'Cargo.toml')]
  const rootCargo = path.join(repo, 'Cargo.toml')
  if (fs.existsSync(rootCargo)) candidates.push({ file: rootCargo, mtime: fs.statSync(rootCargo).mtimeMs })
  const newest = candidates.filter(Boolean).sort((a, b) => b.mtime - a.mtime)[0]
  if (!newest) return
  const built = fs.statSync(daemon.file).mtimeMs
  // A rebuild in the same second can leave the source marginally newer.
  if (newest.mtime <= built + 1_000) return
  throw new Error(
    'the Rust execution daemon is older than the Rust sources:\n' +
      `  daemon:        ${path.relative(repo, daemon.file)} (built ${iso(built)})\n` +
      `  newer source:  ${path.relative(repo, newest.file)} (${iso(newest.mtime)})\n` +
      'The integration tests would exercise the old daemon. Run `cargo build -p hy-exec-server` first,\n' +
      'or set HY_ALLOW_STALE_BUILD=1 if testing an older build on purpose.',
  )
}

function checkTypeScript() {
  if (skip) return
  const packages = ['core', 'seams', 'hy-cli', 'desktop'].map((name) => path.join(repo, 'packages', name))
  const sources = newestFile(
    packages.map((dir) => path.join(dir, 'src')).concat(packages.map((dir) => path.join(dir, 'web', 'src'))),
    (name) => name.endsWith('.ts'),
  )
  const built = newestFile(
    packages.map((dir) => path.join(dir, 'dist')).concat(packages.map((dir) => path.join(dir, 'web', 'dist'))),
    (name) => name.endsWith('.js') || name.endsWith('.css') || name.endsWith('.html'),
  )
  if (!sources) return
  if (!built) {
    throw new Error('the TypeScript build is missing. Run `pnpm build` before the integration tests.')
  }
  if (sources.mtime <= built.mtime + 1_000) return
  throw new Error(
    'the TypeScript build is older than its sources:\n' +
      `  newest source: ${path.relative(repo, sources.file)} (${iso(sources.mtime)})\n` +
      `  newest build:  ${path.relative(repo, built.file)} (${iso(built.mtime)})\n` +
      'The integration tests would exercise the old JavaScript. Run `pnpm build` first,\n' +
      'or set HY_ALLOW_STALE_BUILD=1 if testing an older build on purpose.',
  )
}

checkDaemon()
checkTypeScript()
