// CP-40: writes winget and Scoop manifests for a release under release/manifests/.
//
//   node scripts/gen-package-manifests.mjs --version 0.5.0 --url https://…/HY-HARNESS.exe --sha256 <hex>
//   node scripts/gen-package-manifests.mjs --version 0.5.0 --url https://… --file release/HY-HARNESS.exe
//
// With --file the SHA-256 is computed from the built exe (the same value the
// signed feed entry from `hy update sign` carries).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { scoopManifest, wingetManifests } = await import(pathToFileURL(path.join(repo, 'packages', 'hy-cli', 'dist', 'package-manifests.js')).href)

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const version = arg('version')
const url = arg('url')
const file = arg('file')
const sha256 = arg('sha256') ?? (file ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : undefined)
if (!version || !url || !sha256) {
  console.error('usage: gen-package-manifests.mjs --version <semver> --url <https url> (--sha256 <hex> | --file <exe>) [--notes <url>]')
  process.exit(2)
}
const release = { version, url, sha256, ...(arg('notes') ? { notesUrl: arg('notes') } : {}) }
const out = path.join(repo, 'release', 'manifests', version)
fs.mkdirSync(path.join(out, 'winget'), { recursive: true })
fs.mkdirSync(path.join(out, 'scoop'), { recursive: true })
fs.writeFileSync(path.join(out, 'scoop', 'hy-harness.json'), `${JSON.stringify(scoopManifest(release), null, 2)}\n`)
for (const [name, text] of Object.entries(wingetManifests(release))) fs.writeFileSync(path.join(out, 'winget', name), text)
console.log(`wrote ${path.relative(repo, out)}`)
