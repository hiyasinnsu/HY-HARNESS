// CP-30: writes docs/protocol-methods.json from packages/hy-cli/src/protocol-methods.ts.
// `--check` fails when the file is stale (CI / pnpm verify).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(repo, 'docs', 'protocol-methods.json')
const { renderProtocolMethods } = await import(pathToFileURL(path.join(repo, 'packages', 'hy-cli', 'dist', 'protocol-methods.js')).href)
const text = renderProtocolMethods()

if (process.argv.includes('--check')) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : ''
  if (current !== text) {
    console.error('docs/protocol-methods.json is stale; run pnpm gen:protocol-methods')
    process.exit(1)
  }
  console.log('docs/protocol-methods.json is up to date')
} else {
  fs.writeFileSync(out, text, 'utf8')
  console.log(`wrote ${path.relative(repo, out)}`)
}
