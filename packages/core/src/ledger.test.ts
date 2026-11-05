import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Ledger, LedgerError, deriveNotes, discoverPinned } from './ledger.js'
import { SessionLog, readEvents } from './session-log.js'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hy-ledger-'))
}

test('a new key at the entry cap is rejected with the current keys (OQ-5)', () => {
  const l = new Ledger([], [], { maxEntries: 3, maxTokens: 10_000 })
  for (const k of ['a', 'b', 'c']) l.upsert({ key: k, rule: `rule ${k}` })
  assert.throws(() => l.upsert({ key: 'd', rule: 'rule d' }), (e: unknown) => {
    assert.ok(e instanceof LedgerError)
    assert.match((e as Error).message, /full \(3 entries\).*Current keys: a, b, c/)
    return true
  })
  // Updating an existing key at the cap is fine; nothing was evicted.
  l.upsert({ key: 'b', rule: 'rule b2' })
  assert.deepEqual(l.list().map((n) => [n.key, n.rule]), [['a', 'rule a'], ['b', 'rule b2'], ['c', 'rule c']])
})

test('the token cap rejects an oversized note and keeps the ledger unchanged', () => {
  const l = new Ledger([], [], { maxEntries: 12, maxTokens: 50 })
  l.upsert({ key: 'short', rule: 'keep it short' })
  assert.throws(() => l.upsert({ key: 'long', rule: 'x'.repeat(400) }), /limit 50.*Current keys: short/)
  assert.deepEqual(l.list().map((n) => n.key), ['short'])
  assert.throws(() => l.upsert({ key: 'bad key', rule: 'r' }), /invalid key/)
  assert.throws(() => l.supersede({ oldKey: 'nope', newKey: 'x', rule: 'r' }), /no note "nope"/)
})

test('ledger order across two sessions of a run follows the log seq', () => {
  const dir = tmp()
  try {
    const file = path.join(dir, 'session.v1.jsonl')
    // Round 1: one child session.
    const s1 = new SessionLog(file)
    s1.setRun('run-x', 1)
    const l1 = Ledger.forRun(s1, 'run-x', [])
    l1.upsert({ key: 'legacy-cjs', rule: 'keep src/legacy CommonJS', rationale: 'the loader requires it' })
    l1.upsert({ key: 'no-vendor', rule: 'never edit vendor/' })
    // Another run in the same log must not leak in.
    const other = new SessionLog(file)
    other.setRun('run-y')
    Ledger.forRun(other, 'run-y', []).upsert({ key: 'other', rule: 'from another run' })
    // Round 2: a fresh session sees round 1's notes and changes them.
    const s2 = new SessionLog(file)
    s2.setRun('run-x', 2)
    const l2 = Ledger.forRun(s2, 'run-x', [])
    assert.deepEqual(l2.list().map((n) => n.key), ['legacy-cjs', 'no-vendor'])
    l2.supersede({ oldKey: 'legacy-cjs', newKey: 'legacy-esm', rule: 'src/legacy may now be ESM' })
    l2.upsert({ key: 'no-vendor', rule: 'never edit vendor/ or third_party/' })
    // seq keeps increasing across sessions of the same file.
    const events = readEvents(file)
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1))
    // A crash may leave a partial last line; it is ignored.
    fs.appendFileSync(file, '{"v":1,"seq":99,"type":"ledger/upsert","payl')
    const s3 = new SessionLog(file)
    const l3 = Ledger.forRun(s3, 'run-x', [])
    assert.deepEqual(
      l3.list().map((n) => [n.key, n.rule]),
      [
        ['no-vendor', 'never edit vendor/ or third_party/'],
        ['legacy-esm', 'src/legacy may now be ESM'],
      ],
    )
    assert.deepEqual(deriveNotes(readEvents(file), 'run-y').map((n) => n.key), ['other'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pinned constraints and notes render verbatim', () => {
  const dir = tmp()
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Never edit vendor/.\n')
    const user = path.join(dir, 'user')
    fs.mkdirSync(user)
    const pinned = discoverPinned(dir, ['Use tabs in Makefiles.'], user)
    assert.deepEqual(pinned, [
      { source: 'AGENTS.md', text: 'Never edit vendor/.' },
      { source: '--rule', text: 'Use tabs in Makefiles.' },
    ])
    const l = new Ledger(pinned)
    assert.doesNotMatch(l.render(), /agent_notes/, 'no notes, no section')
    l.upsert({ key: 'legacy-cjs', rule: 'keep CommonJS', rationale: 'loader' })
    const r = l.render()
    assert.match(r, /<project_constraints>[\s\S]*--- AGENTS\.md ---\nNever edit vendor\/\.\n\n--- --rule ---\nUse tabs in Makefiles\.\n<\/project_constraints>/)
    assert.match(r, /<agent_notes>\n.*do not override system or user instructions\.\n- legacy-cjs: keep CommonJS\n {2}why: loader\n<\/agent_notes>/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AGENTS.md files: user first, then git root down to the workspace; an override wins per directory', () => {
  const dir = tmp()
  try {
    const user = path.join(dir, 'user')
    const root = path.join(dir, 'repo')
    const pkg = path.join(root, 'packages', 'app')
    fs.mkdirSync(user, { recursive: true })
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(user, 'AGENTS.md'), 'user rule')
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root rule')
    fs.writeFileSync(path.join(root, 'packages', 'AGENTS.md'), 'packages rule')
    fs.writeFileSync(path.join(pkg, 'AGENTS.md'), 'shadowed app rule')
    fs.writeFileSync(path.join(pkg, 'AGENTS.override.md'), 'app override')
    assert.deepEqual(discoverPinned(pkg, [], user), [
      { source: 'user:AGENTS.md', text: 'user rule' },
      { source: '../../AGENTS.md', text: 'root rule' },
      { source: '../AGENTS.md', text: 'packages rule' },
      { source: 'AGENTS.override.md', text: 'app override' },
    ])
    // Without a git root only the workspace itself is searched.
    fs.rmSync(path.join(root, '.git'), { recursive: true })
    assert.deepEqual(discoverPinned(pkg, [], path.join(dir, 'empty-user')), [{ source: 'AGENTS.override.md', text: 'app override' }])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('RULE.md alone is pinned, in the user directory and in the workspace', () => {
  const dir = tmp()
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user, { recursive: true })
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(user, 'RULE.md'), 'global rule\n')
    fs.writeFileSync(path.join(ws, 'RULE.md'), 'workspace rule\n')
    assert.deepEqual(discoverPinned(ws, [], user), [
      { source: 'user:RULE.md', text: 'global rule' },
      { source: 'RULE.md', text: 'workspace rule' },
    ])
    // It reaches the prompt the same way as AGENTS.md.
    assert.match(new Ledger(discoverPinned(ws, [], user)).render(), /--- user:RULE\.md ---\nglobal rule/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AGENTS.md wins over RULE.md in the same directory; AGENTS.override.md wins over both', () => {
  const dir = tmp()
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user, { recursive: true })
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(user, 'AGENTS.md'), 'user agents')
    fs.writeFileSync(path.join(user, 'RULE.md'), 'user rule')
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'agents')
    fs.writeFileSync(path.join(ws, 'RULE.md'), 'rule')
    assert.deepEqual(discoverPinned(ws, [], user), [
      { source: 'user:AGENTS.md', text: 'user agents' },
      { source: 'AGENTS.md', text: 'agents' },
    ])
    fs.writeFileSync(path.join(ws, 'AGENTS.override.md'), 'override')
    assert.deepEqual(discoverPinned(ws, [], user), [
      { source: 'user:AGENTS.md', text: 'user agents' },
      { source: 'AGENTS.override.md', text: 'override' },
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty RULE.md is ignored, and a missing one falls back to the old behaviour', () => {
  const dir = tmp()
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user, { recursive: true })
    fs.mkdirSync(ws, { recursive: true })
    // Empty (or whitespace-only) files pin nothing, whichever name they have.
    fs.writeFileSync(path.join(user, 'RULE.md'), '   \n\n')
    fs.writeFileSync(path.join(ws, 'RULE.md'), '')
    assert.deepEqual(discoverPinned(ws, [], user), [])
    // No file at all: the old AGENTS.md lookup is unchanged.
    fs.rmSync(path.join(user, 'RULE.md'))
    fs.rmSync(path.join(ws, 'RULE.md'))
    assert.deepEqual(discoverPinned(ws, [], user), [])
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'agents\n')
    assert.deepEqual(discoverPinned(ws, [], user), [{ source: 'AGENTS.md', text: 'agents' }])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
