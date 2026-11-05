// Runs outside the HY-HARNESS process tree. The app spawns this with
// ELECTRON_RUN_AS_NODE=1, quits, and this script waits for the old process to
// release the portable exe before swapping in the staged build.
//
// WP-53: the caller may pass `--expected-sha256 <hex>` (read from the `.sha256`
// sidecar written by `hy update fetch`). The copy is verified before the new
// build is started, and a mismatch rolls the backup back.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
let expectedSha256
const positional = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--dry-run') continue
  if (arg === '--expected-sha256') {
    expectedSha256 = args[i + 1]
    i += 1
    continue
  }
  if (arg.startsWith('--expected-sha256=')) {
    expectedSha256 = arg.slice('--expected-sha256='.length)
    continue
  }
  positional.push(arg)
}
const [oldExe, newExe, pidArg] = positional
const pid = Number(pidArg)
const logFile = process.env.HY_UPDATE_LOG
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log(message) {
  const line = `${new Date().toISOString()} ${message}`
  try {
    if (logFile) fs.appendFileSync(logFile, `${line}\n`, 'utf8')
  } catch {}
}

function step(index, message) {
  log(`progress ${index}/6 ${message}`)
}

function alive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

function start(exe) {
  if (dryRun) {
    log(`dry-run: would start ${exe}`)
    return
  }
  spawn(exe, [], {
    cwd: path.dirname(exe),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref()
}

function sha256File(file) {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

async function waitForExit(processId) {
  const deadline = Date.now() + 120_000
  while (alive(processId) && Date.now() < deadline) await sleep(250)
  return !alive(processId)
}

function restore(backup, why) {
  try {
    fs.copyFileSync(backup, oldExe)
    log(`rollback: ${why}; restored the backup`)
  } catch (error) {
    log(`rollback: ${why}; restoring the backup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  start(oldExe)
}

async function main() {
  if (!oldExe || !newExe) {
    log('missing old/new exe argument')
    process.exit(2)
  }
  if (!fs.existsSync(oldExe) || !fs.existsSync(newExe)) {
    log(`missing file old=${oldExe} new=${newExe}`)
    process.exit(2)
  }
  step(1, `waiting for the app to exit (pid ${pid})`)
  await waitForExit(pid)

  step(2, 'moving the old exe aside')
  const backup = `${oldExe}.bak-${Date.now()}.exe`
  let moved = false
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      fs.renameSync(oldExe, backup)
      moved = true
      break
    } catch {
      await sleep(250)
    }
  }
  if (!moved) {
    log('could not lock the old exe for replacement; starting it again')
    start(oldExe)
    process.exit(3)
  }

  step(3, 'copying the staged build into place')
  try {
    fs.copyFileSync(newExe, oldExe)
  } catch (error) {
    log(`replace failed: ${error instanceof Error ? error.message : String(error)}`)
    restore(backup, 'the copy failed')
    process.exit(4)
  }

  if (expectedSha256) {
    step(4, 'verifying the SHA-256 of the new exe')
    const actual = sha256File(oldExe)
    if (actual !== expectedSha256.toLowerCase()) {
      restore(backup, `checksum mismatch: expected ${expectedSha256}, got ${actual}`)
      process.exit(5)
    }
  } else {
    step(4, 'no SHA-256 to verify (the caller did not pass one)')
  }

  step(5, `replaced ${oldExe} with ${newExe}`)
  step(6, 'starting the new build')
  start(oldExe)
  process.exit(0)
}

void main()
