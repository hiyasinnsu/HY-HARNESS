import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pickUpdate, readStagedInfo, type UpdateCandidateView } from './update-pick.js'

const NOW = 1_800_000_000_000
const candidate = (name: string, version: string | undefined, mtime: number, extra: Partial<UpdateCandidateView> = {}): UpdateCandidateView => ({
  file: name,
  staged: true,
  mtime,
  same: false,
  info: version ? { version } : {},
  ...extra,
})

test('a higher version wins over a newer file of a lower version', () => {
  const result = pickUpdate('0.4.1', NOW, [candidate('a', '0.4.2', NOW + 10), candidate('b', '0.5.0', NOW + 5), candidate('c', '0.4.1', NOW + 20)])
  assert.equal(result.ok && result.pick.file, 'b')
})

test('the same version is applied only as a newer staged rebuild', () => {
  assert.equal(pickUpdate('0.4.1', NOW, [candidate('rebuild', '0.4.1', NOW + 1)]).ok, true)
  const older = pickUpdate('0.4.1', NOW, [candidate('old', '0.4.1', NOW - 1)])
  assert.deepEqual(older, { ok: false, reason: 'none' })
  assert.equal(pickUpdate('0.4.1', NOW, [candidate('loose', '0.4.1', NOW + 1, { staged: false })]).ok, false)
})

test('an older version is refused as a downgrade, even when it is the newest file', () => {
  const result = pickUpdate('0.4.1', NOW, [candidate('old', '0.4.0', NOW + 100)])
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.reason, 'downgrade')
  assert.equal(!result.ok && result.newest?.file, 'old')
})

test('an identical build is never applied; unknown versions keep the old rule', () => {
  assert.deepEqual(pickUpdate('0.4.1', NOW, [candidate('same', '0.4.2', NOW + 1, { same: true })]), { ok: false, reason: 'same' })
  assert.equal(pickUpdate('0.4.1', NOW, [candidate('legacy', undefined, NOW - 1)]).ok, true, 'staged without a version')
  assert.equal(pickUpdate('0.4.1', NOW, [candidate('loose', undefined, NOW - 1, { staged: false })]).ok, false)
})

test('the version comes from the sidecar, else from the staged file name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-pick-'))
  try {
    const withSidecar = path.join(dir, 'HY-HARNESS-0.4.2-20261106-0622.exe')
    fs.writeFileSync(withSidecar, 'MZ')
    fs.writeFileSync(`${withSidecar}.json`, JSON.stringify({ version: '0.4.3', commit: 'abc1234', builtAt: '2026-11-06T06:22:00Z', sha256: 'A'.repeat(64) }))
    assert.deepEqual(readStagedInfo(withSidecar), { version: '0.4.3', commit: 'abc1234', builtAt: '2026-11-06T06:22:00Z', sha256: 'a'.repeat(64) })
    const named = path.join(dir, 'HY-HARNESS-0.5.0-beta.1-20261106-0622-2.exe')
    assert.deepEqual(readStagedInfo(named), { version: '0.5.0-beta.1' })
    assert.deepEqual(readStagedInfo(path.join(dir, 'HY-HARNESS-next-20261105212211.exe')), {})
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
