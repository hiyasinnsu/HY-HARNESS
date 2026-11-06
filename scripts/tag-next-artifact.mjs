import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// The portable build is always release/HY-HARNESS.exe (a fixed name, so the
// in-place self-update can replace the running file). A staged build is renamed
// to HY-HARNESS-<version>-<YYYYMMDD-HHMM>.exe (local time) so it is never
// confused with the running exe, and two sidecars are written next to it:
//   <exe>.sha256 — the swap verifies the copied file against it
//   <exe>.json   — version / commit / build time; the app picks updates by
//                  version from it and refuses downgrades
const root = process.cwd()
const dir = path.join(root, 'release', 'next')
const base = path.join(dir, 'HY-HARNESS.exe')
if (!fs.existsSync(dir) || !fs.existsSync(base)) process.exit(0)

let info = {}
try {
  info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8').replace(/^﻿/, ''))
} catch {
  // No build-info.json: fall back to package.json for the version.
}
const version =
  info.version ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^﻿/, '')).version

const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
let target = path.join(dir, `HY-HARNESS-${version}-${stamp}.exe`)
for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `HY-HARNESS-${version}-${stamp}-${n}.exe`)
fs.renameSync(base, target)

const sha256 = createHash('sha256').update(fs.readFileSync(target)).digest('hex')
fs.writeFileSync(`${target}.sha256`, `${sha256}\n`, 'utf8')
fs.writeFileSync(`${target}.json`, `${JSON.stringify({ ...info, version, sha256 }, null, 2)}\n`, 'utf8')
console.log(`[package] staged ${target} (${version}${info.commit ? ` ${info.commit}` : ''})`)

// Keep the two newest staged builds (and their sidecars); each is ~180 MB.
const staged = fs
  .readdirSync(dir)
  .filter((name) => /^HY-HARNESS-.+\.exe$/i.test(name))
  .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
for (const old of staged.slice(2)) {
  for (const suffix of ['', '.sha256', '.json']) fs.rmSync(path.join(dir, old.name + suffix), { force: true })
}
