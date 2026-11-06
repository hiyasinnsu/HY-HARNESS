// `pnpm release:local [--bump patch|minor|major|<x.y.z>] [--skip-tests] [--stage|--replace]`
//
// One command for a local desktop release. It used to take several manual
// steps that were easy to get wrong (a version edited in seven files, the Rust
// release build forgotten so hy-secret.exe was missing from the package, and a
// failed package because the running app locks release/HY-HARNESS.exe):
//
//   1. bump the version everywhere `check:version` looks (optional)
//   2. cargo build --release (hy-exec-server.exe, hy-secret.exe)
//   3. pnpm build (also writes build-info.json: version, commit, build time)
//   4. check:version, then the unit tests (unless --skip-tests)
//   5. package: into release/next as HY-HARNESS-<version>-<stamp>.exe while the
//      app is running (it then offers "update ready"), else release/HY-HARNESS.exe
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

function run(label, command) {
  console.log(`\n[release] ${label}\n> ${command}`)
  execSync(command, { cwd: root, stdio: 'inherit' })
}

function readText(file) {
  return fs.readFileSync(path.join(root, file), 'utf8')
}

function currentVersion() {
  return JSON.parse(readText('package.json').replace(/^﻿/, '')).version
}

export function bumpVersion(version, kind) {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(kind)) return kind
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`--bump expects patch, minor, major or x.y.z, got ${kind}`)
}

/** Rewrites the version in place (keeps BOMs, line endings and formatting). */
function setVersion(next) {
  const files = ['package.json', ...fs.readdirSync(path.join(root, 'packages')).map((name) => `packages/${name}/package.json`)].filter((file) =>
    fs.existsSync(path.join(root, file)),
  )
  for (const file of files) {
    const text = readText(file)
    const updated = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`)
    if (updated === text) throw new Error(`no "version" field in ${file}`)
    fs.writeFileSync(path.join(root, file), updated, 'utf8')
  }
  const versionTs = 'packages/core/src/version.ts'
  const source = readText(versionTs)
  const updated = source.replace(/HARNESS_VERSION = '[^']+'/, `HARNESS_VERSION = '${next}'`)
  if (updated === source) throw new Error(`HARNESS_VERSION not found in ${versionTs}`)
  fs.writeFileSync(path.join(root, versionTs), updated, 'utf8')
  console.log(`[release] version ${next} written to ${files.length} package.json files and ${versionTs}`)
}

function appIsRunning() {
  if (process.platform !== 'win32') return false
  try {
    const output = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    return output.split(/\r?\n/).some((line) => /^"HY-HARNESS[^"]*"/i.test(line.trim()))
  } catch {
    return false
  }
}

function newestStaged() {
  const dir = path.join(root, 'release', 'next')
  if (!fs.existsSync(dir)) return undefined
  return fs
    .readdirSync(dir)
    .filter((name) => /^HY-HARNESS-.+\.exe$/i.test(name))
    .map((name) => ({ file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.file
}

async function main() {
  const started = Date.now()
  const bump = option('--bump')
  if (bump) setVersion(bumpVersion(currentVersion(), bump))
  const version = currentVersion()

  run('Rust release build (hy-exec-server.exe, hy-secret.exe)', 'cargo build --release --workspace')
  run('TypeScript build', 'pnpm build')
  run('version check', 'node scripts/check-version.mjs')
  if (!flag('--skip-tests')) run('unit tests', 'pnpm test')

  const stage = flag('--stage') || (!flag('--replace') && appIsRunning())
  if (flag('--replace') && appIsRunning()) {
    throw new Error('HY-HARNESS is running and locks release/HY-HARNESS.exe; close it or drop --replace (the build is then staged).')
  }
  if (stage) {
    run('package (staged; the running app will offer the update)', 'pnpm exec electron-builder --win portable --x64 --config.directories.output=release/next')
    run('name the staged build', 'node scripts/tag-next-artifact.mjs')
  } else {
    run('package', 'pnpm exec electron-builder --win portable --x64')
  }

  const info = JSON.parse(readText('build-info.json'))
  const artifact = stage ? newestStaged() : path.join(root, 'release', 'HY-HARNESS.exe')
  const seconds = Math.round((Date.now() - started) / 1000)
  console.log(`\n[release] done in ${seconds}s: ${version}${info.commit ? ` (${info.commit}${info.dirty ? '+dirty' : ''})` : ''}`)
  console.log(`[release] ${artifact}`)
  console.log(
    stage
      ? '[release] The running app shows "Update ready" in the sidebar (on focus); click it to restart into this build.'
      : '[release] Start release\\HY-HARNESS.exe.',
  )
  if (bump) console.log(`[release] The version changed to ${version}; commit the bumped files.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[release] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
