// Test hook: appends what it received to the file in argv[2]; with --block,
// exits 2 with a reason (a preToolUse block). argv[3+] may carry notify JSON.
import fs from 'node:fs'
const [, , out, ...rest] = process.argv
let stdin = ''
process.stdin.on('data', (d) => (stdin += d))
process.stdin.on('end', () => {
  const block = rest.includes('--block')
  const arg = rest.filter((a) => a !== '--block').join(' ')
  fs.appendFileSync(out, `${JSON.stringify({ stdin: stdin ? JSON.parse(stdin) : null, arg: arg ? JSON.parse(arg) : null })}\n`)
  if (block) {
    process.stderr.write('patches are frozen today')
    process.exit(2)
  }
})
