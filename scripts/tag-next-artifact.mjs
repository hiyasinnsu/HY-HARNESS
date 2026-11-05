import fs from 'node:fs'
import path from 'node:path'

// The portable build is always release/HY-HARNESS.exe (a fixed name, so the
// in-place self-update can replace the running file). A staged build gets a
// timestamp so it is never confused with the running exe and several can wait.
const root = process.cwd()
const dir = path.join(root, 'release', 'next')
const base = path.join(dir, 'HY-HARNESS.exe')
if (!fs.existsSync(dir) || !fs.existsSync(base)) process.exit(0)

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
const target = path.join(dir, `HY-HARNESS-next-${stamp}.exe`)
fs.renameSync(base, target)
console.log(`[package] staged ${target}`)

// Keep the three newest timestamped staged builds; older ones are noise.
const staged = fs
  .readdirSync(dir)
  .filter((name) => /^HY-HARNESS-next-\d+\.exe$/i.test(name))
  .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
for (const old of staged.slice(3)) fs.rmSync(path.join(dir, old.name), { force: true })
