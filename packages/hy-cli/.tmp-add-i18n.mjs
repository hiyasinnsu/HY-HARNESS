import fs from 'node:fs'

const file = 'F:/HY-HARNESS/packages/hy-cli/web/src/i18n.ts'
const src = fs.readFileSync(file, 'utf8')
const nl = '\n'
const q = "'"

const blocks = [
  // ja
  [
    '  sessionDeleted: ' + q + '\u30c1\u30e3\u30c3\u30c8\u3092\u524a\u9664\u3057\u307e\u3057\u305f\u3002' + q + ',',
    [
      '  renameChat: ' + q + '\u30c1\u30e3\u30c3\u30c8\u540d\u3092\u5909\u66f4' + q + ',',
      '  renameDesc: ' + q + '\u7a7a\u6b04\u306b\u3059\u308b\u3068\u3001\u6700\u521d\u306e\u30e1\u30c3\u30bb\u30fc\u30b8\u304b\u3089\u4f5c\u3089\u308c\u308b\u81ea\u52d5\u540d\u306b\u623b\u308a\u307e\u3059\u3002' + q + ',',
      '  renamePlaceholder: ' + q + '\u30c1\u30e3\u30c3\u30c8\u540d' + q + ',',
      '  renamed: ' + q + '\u30c1\u30e3\u30c3\u30c8\u540d\u3092\u5909\u66f4\u3057\u307e\u3057\u305f\u3002' + q + ',',
      '  renamedAuto: ' + q + '\u81ea\u52d5\u540d\u306b\u623b\u3057\u307e\u3057\u305f\u3002' + q + ',',
    ],
  ],
  // zh
  [
    '  sessionDeleted: ' + q + '\u804a\u5929\u5df2\u5220\u9664\u3002' + q + ',',
    [
      '  renameChat: ' + q + '\u91cd\u547d\u540d\u804a\u5929' + q + ',',
      '  renameDesc: ' + q + '\u7559\u7a7a\u53ef\u6062\u590d\u6839\u636e\u7b2c\u4e00\u6761\u6d88\u606f\u81ea\u52a8\u751f\u6210\u7684\u540d\u79f0\u3002' + q + ',',
      '  renamePlaceholder: ' + q + '\u804a\u5929\u540d\u79f0' + q + ',',
      '  renamed: ' + q + '\u804a\u5929\u5df2\u91cd\u547d\u540d\u3002' + q + ',',
      '  renamedAuto: ' + q + '\u5df2\u6062\u590d\u81ea\u52a8\u540d\u79f0\u3002' + q + ',',
    ],
  ],
]

let out = src
for (const [anchor, added] of blocks) {
  const hits = out.split(anchor).length - 1
  if (hits !== 1) {
    console.error('aborted: anchor found ' + hits + ' times; nothing written')
    process.exit(2)
  }
  out = out.replace(anchor, () => [anchor, ...added].join(nl))
}

fs.writeFileSync(file, out, 'utf8')
const after = fs.readFileSync(file, 'utf8')
for (const key of ['renameChat', 'renameDesc', 'renamePlaceholder', 'renamed', 'renamedAuto']) {
  console.log(key + ': ' + (after.split(key + ':').length - 1))
}
console.log('lines: ' + after.split(/\r?\n/).length)
