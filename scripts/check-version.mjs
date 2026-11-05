// `pnpm check:version`: HARNESS_VERSION (packages/core/src/version.ts) must
// match the root package.json, or `hy update check` compares against a version
// that was never released.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The repository's package.json starts with a BOM.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
const source = readFileSync(join(root, 'packages', 'core', 'src', 'version.ts'), 'utf8')
const match = /HARNESS_VERSION = '([^']+)'/.exec(source)
if (!match) {
  console.error('packages/core/src/version.ts does not declare HARNESS_VERSION')
  process.exit(1)
}
if (match[1] !== pkg.version) {
  console.error(`HARNESS_VERSION ${match[1]} does not match package.json ${pkg.version}`)
  process.exit(1)
}
console.log(`version ${pkg.version} is in step`)
