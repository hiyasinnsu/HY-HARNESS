// CP-26: writes docs/api.schema.json from the checked-in API contract.
// `--check` fails when the committed document is stale (CI gate).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outPath = path.join(repo, 'docs', 'api.schema.json')
const modulePath = path.join(repo, 'packages', 'hy-cli', 'dist', 'api-schema.js')

if (!fs.existsSync(modulePath)) {
  process.stderr.write('packages/hy-cli/dist/api-schema.js is missing; run `pnpm build` first\n')
  process.exit(1)
}
const { renderApiSchema } = await import(pathToFileURL(modulePath).href)
const text = renderApiSchema()
const check = process.argv.includes('--check')

if (check) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : ''
  if (current.replace(/\r\n/g, '\n') !== text) {
    process.stderr.write('docs/api.schema.json is stale; run `pnpm gen:api-schema`\n')
    process.exit(1)
  }
  process.stdout.write('docs/api.schema.json is up to date\n')
} else {
  fs.writeFileSync(outPath, text)
  process.stdout.write(`wrote ${outPath}\n`)
}