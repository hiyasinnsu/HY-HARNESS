// CP-41 prototype: the entry point of the single-executable `hy.exe`.
//
// Node SEA runs one CommonJS script. The harness (packages/*/dist, its
// runtime node_modules and hy-exec-server.exe) travels as one asset,
// `app.bin` (a JSON index followed by the file bytes, see build-sea.mjs). On
// first run it is unpacked into %LOCALAPPDATA%\hy-harness\sea\<hash>\ and
// later runs reuse it; then the CLI's main.js is imported with this argv.
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const sea = require('node:sea')

function unpack() {
  const bin = Buffer.from(sea.getAsset('app.bin'))
  const indexLength = bin.readUInt32LE(0)
  const index = JSON.parse(bin.subarray(4, 4 + indexLength).toString('utf8'))
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share')
  const root = path.join(base, 'hy-harness', 'sea', index.hash)
  const done = path.join(root, '.complete')
  if (!fs.existsSync(done)) {
    let offset = 4 + indexLength
    for (const entry of index.files) {
      const target = path.join(root, entry.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, bin.subarray(offset, offset + entry.size))
      offset += entry.size
    }
    fs.writeFileSync(done, new Date().toISOString())
  }
  return root
}

const root = unpack()
// The CLI finds the exec server through this (resolveServerPath).
process.env.HY_EXEC_SERVER ??= path.join(root, 'bin', 'hy-exec-server.exe')
// process.argv for the CLI: [node, script, ...args].
process.argv = [process.execPath, path.join(root, 'packages', 'hy-cli', 'dist', 'main.js'), ...process.argv.slice(2)]
import(pathToFileURL(process.argv[1]).href).catch((error) => {
  process.stderr.write(`hy: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
