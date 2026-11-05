import { execFileSync } from 'node:child_process'

// The portable target writes release/HY-HARNESS.exe. A running portable app
// keeps that file open, and electron-builder then waits forever on "output file
// is locked for writing". Fail fast with an actionable message instead of
// leaving the build hanging.
if (process.platform !== 'win32') process.exit(0)

let output = ''
try {
  output = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
} catch {
  // If tasklist is unavailable, do not block packaging.
  process.exit(0)
}

const running = output
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /^"HY-HARNESS[^"]*"/i.test(line))

if (running.length > 0) {
  console.error('[package] HY-HARNESS is running. Close it before packaging.')
  console.error('[package] A running portable exe locks release/HY-HARNESS.exe,')
  console.error('[package] and electron-builder will wait on "output file is locked for writing".')
  process.exit(1)
}
