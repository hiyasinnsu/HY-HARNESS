import fs from 'node:fs'
import path from 'node:path'

for (const pkg of ['core', 'seams']) {
  const src = path.join('packages', pkg, 'src')
  const dst = path.join('packages', pkg, 'dist')
  if (!fs.existsSync(src) || !fs.existsSync(dst)) continue
  for (const file of fs.readdirSync(src)) {
    if (!file.endsWith('.mjs')) continue
    fs.copyFileSync(path.join(src, file), path.join(dst, file))
  }
}

// xterm.js is served as local ESM (the CSP forbids CDNs).
const vendor = path.join('packages', 'hy-cli', 'web', 'vendor')
fs.mkdirSync(vendor, { recursive: true })
for (const [src, dst] of [
  [path.join('node_modules', '@xterm', 'xterm', 'lib', 'xterm.mjs'), path.join(vendor, 'xterm.mjs')],
  [path.join('node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), path.join(vendor, 'xterm.css')],
  [path.join('node_modules', '@xterm', 'xterm', 'LICENSE'), path.join(vendor, 'xterm.LICENSE')],
  [path.join('node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.mjs'), path.join(vendor, 'addon-fit.mjs')],
  [path.join('node_modules', '@xterm', 'addon-fit', 'LICENSE'), path.join(vendor, 'addon-fit.LICENSE')],
]) {
  fs.copyFileSync(src, dst)
}
