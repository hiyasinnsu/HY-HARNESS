import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chooseStartupWorkspace, usableWorkspace } from './startup.js'

function dir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hy-startup-'))
}

test('an explicit workspace wins over the remembered one', () => {
  const a = dir()
  const b = dir()
  try {
    assert.equal(chooseStartupWorkspace(a, { workspace: b, workspaces: [b] }), path.resolve(a))
  } finally {
    fs.rmSync(a, { recursive: true, force: true })
    fs.rmSync(b, { recursive: true, force: true })
  }
})

test('a valid remembered workspace opens without a folder dialog', () => {
  const remembered = dir()
  const recent = dir()
  try {
    assert.equal(
      chooseStartupWorkspace(undefined, { workspace: remembered, workspaces: [recent, remembered] }),
      path.resolve(remembered),
    )
  } finally {
    fs.rmSync(remembered, { recursive: true, force: true })
    fs.rmSync(recent, { recursive: true, force: true })
  }
})

test('a stale workspace falls back to the newest usable recent entry', () => {
  const valid = dir()
  const missing = path.join(os.tmpdir(), 'hy-startup-does-not-exist')
  try {
    assert.equal(
      chooseStartupWorkspace(undefined, { workspace: missing, workspaces: [missing, valid] }),
      path.resolve(valid),
    )
  } finally {
    fs.rmSync(valid, { recursive: true, force: true })
  }
})

test('an explicit missing workspace stays strict instead of switching folders', () => {
  const valid = dir()
  try {
    assert.equal(chooseStartupWorkspace(path.join(os.tmpdir(), 'hy-missing'), { workspaces: [valid] }), undefined)
  } finally {
    fs.rmSync(valid, { recursive: true, force: true })
  }
})

test('no usable workspace still asks the user', () => {
  assert.equal(chooseStartupWorkspace(undefined, { workspace: 'nope', workspaces: ['also-nope'] }), undefined)
  assert.equal(usableWorkspace('nope'), undefined)
})
