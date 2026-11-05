// Generates docs/config.schema.json from packages/core/dist/config-schema.js.
// `--check` fails when the committed file differs from a fresh generation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'docs', 'config.schema.json')
const modulePath = join(root, 'packages', 'core', 'dist', 'config-schema.js')

if (!existsSync(modulePath)) {
  console.error('packages/core/dist/config-schema.js is missing: run `pnpm build` first')
  process.exit(2)
}
const { userConfigJsonSchema } = await import(pathToFileURL(modulePath).href)
const text = `${JSON.stringify(userConfigJsonSchema, null, 2)}\n`
const check = process.argv.includes('--check')

if (check) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : ''
  if (current !== text) {
    console.error('docs/config.schema.json is stale; run `node scripts/gen-config-schema.mjs`')
    process.exit(1)
  }
  console.log('docs/config.schema.json is up to date')
} else {
  writeFileSync(out, text)
  console.log(`wrote ${out}`)
}
