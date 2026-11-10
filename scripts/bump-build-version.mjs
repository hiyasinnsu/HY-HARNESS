// Every ordinary build gets a new application version before compilation.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bumpVersion, setVersion } from './release-local.mjs'

export function prepareBuildVersion(root, kind = 'patch') {
  const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, '')).version
  const next = bumpVersion(current, kind)
  if (next === current) throw new Error('a build must use a new version')
  setVersion(next, root)
  return next
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareBuildVersion(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.env.HY_BUILD_VERSION_BUMP ?? 'patch')
}
