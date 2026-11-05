import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenInError, detectOpenIn, isLocalAddress, openInArgv } from './open-in.js'

test('only programs that exist are offered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-openin-'))
  try {
    const fakeSystem = path.join(dir, 'Windows')
    fs.mkdirSync(path.join(fakeSystem, 'System32', 'WindowsPowerShell', 'v1.0'), { recursive: true })
    fs.writeFileSync(path.join(fakeSystem, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '')
    const targets = detectOpenIn({
      SystemRoot: fakeSystem,
      ProgramFiles: path.join(dir, 'none'),
      'ProgramFiles(x86)': path.join(dir, 'none'),
      LOCALAPPDATA: path.join(dir, 'none'),
    })
    assert.deepEqual(
      targets.map((target) => target.id),
      ['powershell'],
    )
    assert.equal(targets[0]?.kind, 'terminal')
    assert.equal(targets[0]?.label, 'PowerShell')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown target is refused instead of running anything', () => {
  assert.throws(() => openInArgv('definitely-not-installed', process.cwd()), (error: unknown) => {
    assert.ok(error instanceof OpenInError)
    assert.match(error.message, /unknown target/)
    return true
  })
})

test('a terminal target receives a safe set-location command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-openin-argv-'))
  try {
    const fakeSystem = path.join(dir, 'Windows')
    fs.mkdirSync(path.join(fakeSystem, 'System32', 'WindowsPowerShell', 'v1.0'), { recursive: true })
    fs.writeFileSync(path.join(fakeSystem, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '')
    const env = { SystemRoot: fakeSystem, ProgramFiles: path.join(dir, 'none'), 'ProgramFiles(x86)': path.join(dir, 'none'), LOCALAPPDATA: path.join(dir, 'none') }
    const folder = path.join(dir, "it's a folder")
    fs.mkdirSync(folder)
    const argv = openInArgv('powershell', folder, env)
    assert.match(argv.command, /powershell\.exe$/)
    assert.deepEqual(argv.args.slice(0, 2), ['-NoExit', '-Command'])
    // A quote in the path is doubled, not left to break the command.
    assert.match(String(argv.args[2]), /it''s a folder/)
    assert.equal(argv.args.length, 3)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('only this machine may be asked to launch an app', () => {
  assert.equal(isLocalAddress('127.0.0.1'), true)
  assert.equal(isLocalAddress('127.0.0.5'), true)
  assert.equal(isLocalAddress('::1'), true)
  assert.equal(isLocalAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLocalAddress('192.168.1.20'), false)
  assert.equal(isLocalAddress('100.101.102.103'), false)
  assert.equal(isLocalAddress(undefined), false)
})
