// `pnpm check:version`: every place that reports the harness version must agree
// with the root package.json, or `hy update check` compares against a version
// that was never released and the GUI shows a different number than the API.
//
// Checked: the root package.json, HARNESS_VERSION (packages/core/src/version.ts),
// every packages/*/package.json, and that the MCP / HY Protocol `serverInfo`
// takes HARNESS_VERSION instead of a hard-coded literal.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
const errors = []

const version = readJson(join(root, 'package.json')).version

const source = readFileSync(join(root, 'packages', 'core', 'src', 'version.ts'), 'utf8')
const match = /HARNESS_VERSION = '([^']+)'/.exec(source)
if (!match) errors.push('packages/core/src/version.ts does not declare HARNESS_VERSION')
else if (match[1] !== version) errors.push(`HARNESS_VERSION ${match[1]} does not match package.json ${version}`)

for (const name of readdirSync(join(root, 'packages'))) {
  const file = join(root, 'packages', name, 'package.json')
  if (!existsSync(file)) continue
  const v = readJson(file).version
  if (v !== version) errors.push(`packages/${name}/package.json is ${v}, expected ${version}`)
}

for (const rel of ['packages/hy-cli/src/main.ts', 'packages/hy-cli/src/protocol.ts']) {
  const text = readFileSync(join(root, rel), 'utf8')
  if (/serverInfo:\s*\{[^}]*version:\s*['"]/.test(text)) errors.push(`${rel}: serverInfo.version is a literal; use HARNESS_VERSION`)
}

if (errors.length > 0) {
  for (const error of errors) console.error(error)
  process.exit(1)
}
console.log(`version ${version} is in step (root, packages/*, HARNESS_VERSION, serverInfo)`)
