import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const updater = path.join(repo, 'packages', 'desktop', 'update.mjs')
const updaterPs1 = path.join(repo, 'packages', 'desktop', 'update.ps1')

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

test('self-update PowerShell script swaps the exe and keeps a backup (dry run)', { skip: skipReason('sync') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-update-ps-'))
  try {
    const oldExe = path.join(dir, 'HY-HARNESS-0.1.0-portable.exe')
    const newExe = path.join(dir, 'HY-HARNESS-0.1.0-portable-next.exe')
    const logPath = path.join(dir, 'update.log')
    fs.writeFileSync(oldExe, 'OLD', 'utf8')
    fs.writeFileSync(newExe, 'NEW', 'utf8')
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        updaterPs1,
        '-OldExe',
        oldExe,
        '-NewExe',
        newExe,
        '-ProcessId',
        '999999',
        '-Log',
        logPath,
        '-DryRun',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(fs.readFileSync(oldExe, 'utf8'), 'NEW')
    assert.ok(
      fs.readdirSync(dir).some((name) => name.startsWith('HY-HARNESS-0.1.0-portable.exe.bak-')),
      'the old exe is kept as a backup',
    )
    const log = fs.readFileSync(logPath, 'utf8')
    assert.match(log, /replaced/)
    // WP-53: six progress steps, from the wait to the restart.
    for (const step of [1, 2, 3, 4, 5, 6]) assert.match(log, new RegExp(`progress ${step}/6 `), `step ${step}`)
    assert.match(log, /progress 4\/6 no SHA-256 to verify/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('self-update swaps the old portable exe and keeps a backup (dry run)', { skip: skipReason('sync') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-update-'))
  try {
    const oldExe = path.join(dir, 'HY-HARNESS-0.1.0-portable.exe')
    const newExe = path.join(dir, 'HY-HARNESS-0.1.0-portable.next.exe')
    fs.writeFileSync(oldExe, 'OLD', 'utf8')
    fs.writeFileSync(newExe, 'NEW', 'utf8')
    const result = spawnSync(process.execPath, [updater, oldExe, newExe, '999999', '--dry-run'], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(oldExe, 'utf8'), 'NEW')
    assert.ok(
      fs.readdirSync(dir).some((name) => name.startsWith('HY-HARNESS-0.1.0-portable.exe.bak-')),
      'the old exe is kept as a backup',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// WP-53: the fetcher writes a `.sha256` sidecar and the swap verifies it again.
// A mismatch must roll the backup back instead of starting a broken exe.
test('the swap verifies the expected SHA-256 and refuses a mismatch', { skip: skipReason('sync') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-update-hash-'))
  try {
    const oldExe = path.join(dir, 'HY-HARNESS-0.2.0-portable.exe')
    const newExe = path.join(dir, 'HY-HARNESS-0.3.0-portable.exe')
    const log = path.join(dir, 'update.log')
    fs.writeFileSync(oldExe, 'OLD', 'utf8')
    fs.writeFileSync(newExe, 'NEW', 'utf8')
    const good = sha256('NEW')
    const bad = sha256('something else')

    const ok = spawnSync(
      process.execPath,
      [updater, oldExe, newExe, '999999', '--dry-run', '--expected-sha256', good],
      { encoding: 'utf8', timeout: 30_000 },
    )
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(fs.readFileSync(oldExe, 'utf8'), 'NEW')

    // Re-run with a mismatching hash: the previous swap left a backup behind.
    const newExe2 = path.join(dir, 'HY-HARNESS-0.4.0-portable.exe')
    fs.writeFileSync(newExe2, 'BROKEN', 'utf8')
    const failed = spawnSync(
      process.execPath,
      [updater, oldExe, newExe2, '999999', '--dry-run', '--expected-sha256', bad],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, HY_UPDATE_LOG: log },
      },
    )
    assert.equal(failed.status, 5, failed.stderr)
    assert.equal(fs.readFileSync(oldExe, 'utf8'), 'NEW', 'the backup is restored')
    const text = fs.readFileSync(log, 'utf8')
    assert.match(text, /progress 4\/6 verifying the SHA-256/)
    assert.match(text, /rollback: checksum mismatch/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the PowerShell swap verifies the expected SHA-256 and rolls back', { skip: skipReason('sync') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-update-ps-hash-'))
  try {
    const oldExe = path.join(dir, 'HY-HARNESS-0.2.0-portable.exe')
    const newExe = path.join(dir, 'HY-HARNESS-0.3.0-portable.exe')
    const log = path.join(dir, 'update.log')
    fs.writeFileSync(oldExe, 'OLD', 'utf8')
    fs.writeFileSync(newExe, 'NEW', 'utf8')
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        updaterPs1,
        '-OldExe',
        oldExe,
        '-NewExe',
        newExe,
        '-ProcessId',
        '999999',
        '-Log',
        log,
        '-ExpectedSha256',
        sha256('not what was copied'),
        '-DryRun',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )
    assert.equal(result.status, 5, `${result.stdout}\n${result.stderr}`)
    assert.equal(fs.readFileSync(oldExe, 'utf8'), 'OLD', 'the backup is restored')
    assert.ok(
      fs.readdirSync(dir).some((name) => name.startsWith('HY-HARNESS-0.2.0-portable.exe.bak-')),
      'the swapped-in exe is kept as the backup',
    )
    const text = fs.readFileSync(log, 'utf8')
    assert.match(text, /progress 4\/6 verifying the SHA-256/)
    assert.match(text, /rollback: checksum mismatch/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
