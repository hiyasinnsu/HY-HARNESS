import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Agent } from './agent.js'
import { SessionLog } from './session-log.js'
import { ToolRuntime } from './tools.js'
import { TurnProgress, editedFilesOf, verificationNoticeText } from './progress.js'

const ok = (tool: string, args: unknown, output: string, result?: unknown) => ({ call: { tool, args }, ok: true, output, result })
const failed = (tool: string, args: unknown, output: string) => ({ call: { tool, args }, ok: false, output })

test('editedFilesOf reads results, file/path args and diff headers', () => {
  assert.deepEqual(editedFilesOf('apply_patch', {}, { appliedFiles: ['a.ts'], created: ['b.ts'], deleted: [] }), ['a.ts', 'b.ts'])
  assert.deepEqual(editedFilesOf('edit_file', { file: 'c.ts' }), ['c.ts'])
  assert.deepEqual(editedFilesOf('apply_patch', { patch: '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/y\n+++ /dev/null\n' }), ['x.ts'])
})

test('a check after the last edit verifies it; an edit after the check does not', () => {
  const progress = new TurnProgress()
  progress.record(1, [ok('apply_patch', { file: 'a.ts', content: 'x' }, '{}')])
  assert.deepEqual(progress.uncheckedEdits(), ['a.ts'])
  progress.record(2, [ok('shell', { command: 'npm test' }, 'pass', { exitCode: 0 })])
  assert.deepEqual(progress.uncheckedEdits(), [])
  assert.equal(progress.summary().lastCheckPassed, true)
  progress.record(3, [ok('edit_file', { file: 'b.ts' }, '{}')])
  assert.deepEqual(progress.uncheckedEdits().sort(), ['a.ts', 'b.ts'])
  assert.equal(progress.summary().verifiedAfterLastEdit, false)
})

test('a failing check still counts as checked, and the summary says it failed', () => {
  const progress = new TurnProgress()
  progress.record(1, [ok('write_file', { file: 'a.py' }, '{}')])
  progress.record(2, [failed('shell', { command: 'pytest' }, 'exit 1')])
  assert.deepEqual(progress.uncheckedEdits(), [])
  const summary = progress.summary()
  assert.equal(summary.lastCheckPassed, false)
  assert.equal(verificationNoticeText(summary)?.level, 'warn')
  assert.match(verificationNoticeText(summary)!.text, /^Last check failed: pytest/)
})

test('prose-only edits are not held back and get no notice', () => {
  const progress = new TurnProgress()
  progress.record(1, [ok('write_file', { file: 'README.md' }, '{}')])
  assert.deepEqual(progress.uncheckedEdits(), [])
  assert.equal(verificationNoticeText(progress.summary()), undefined)
})

test('a backgrounded shell is not a check until its job is waited on', () => {
  const progress = new TurnProgress()
  progress.record(1, [ok('apply_patch', { file: 'a.ts', content: 'x' }, '{}')])
  progress.record(2, [ok('shell', { command: 'npm test' }, 'bg', { status: 'backgrounded' })])
  assert.deepEqual(progress.uncheckedEdits(), ['a.ts'])
  progress.record(3, [ok('job_wait', { id: 'j1' }, 'done', { exitCode: 0 })])
  assert.deepEqual(progress.uncheckedEdits(), [])
})

test('the stall level rises at N, 2N and 3N steps without progress, and progress resets it', () => {
  const progress = new TurnProgress(2)
  // A new result is progress; the same result again is not.
  assert.equal(progress.record(1, [ok('read_file', { path: 'a' }, 'A')]).level, 0)
  assert.equal(progress.record(2, [ok('read_file', { path: 'a' }, 'A')]).level, 0)
  assert.deepEqual(progress.record(3, [failed('shell', { command: 'x --a' }, 'err 1')]), { steps: 2, level: 1 })
  // Reported once per level.
  assert.equal(progress.record(4, [failed('shell', { command: 'x --b' }, 'err 2')]).level, 0)
  assert.equal(progress.record(5, [failed('shell', { command: 'x --c' }, 'err 3')]).level, 2)
  progress.record(6, [failed('shell', { command: 'x --d' }, 'err 4')])
  assert.equal(progress.record(7, [failed('shell', { command: 'x --e' }, 'err 5')]).level, 3)
  // An edit is progress.
  assert.equal(progress.record(8, [ok('edit_file', { file: 'a.ts' }, '{}')]).steps, 0)
  assert.equal(new TurnProgress(0).record(1, [failed('shell', {}, 'e')]).level, 0, '0 turns the escalation off')
})

function scripted(replies: Array<{ content?: string; toolCalls?: Array<{ name: string; args: unknown }> }>) {
  const seen: string[] = []
  return {
    seen,
    provider: {
      name: 'scripted',
      complete: async (messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.at(-1)!.content)
        const next = replies.shift() ?? { content: 'Done.' }
        return { content: next.content ?? '', ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}), usage: { inputTokens: 1, outputTokens: 1 } }
      },
    },
  }
}

async function runAgent(replies: Parameters<typeof scripted>[0], execute: (tool: string, args: unknown) => Promise<unknown>, options: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-progress-'))
  try {
    const { provider, seen } = scripted(replies)
    const tools = new ToolRuntime({} as never, dir)
    ;(tools as unknown as { execute: unknown }).execute = execute
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-p')
    const events: Array<Record<string, unknown>> = []
    const result = await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir, nativeTools: true, onEvent: (e) => events.push(e), ...options }).run('change it')
    return { result, seen, log: log.events(), events }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('A6: a final answer right after an unchecked edit is sent back once; the check then runs and the summary is logged', async () => {
  const { result, seen, log, events } = await runAgent([
    { toolCalls: [{ name: 'apply_patch', args: { file: 'src/a.ts', content: 'export const a = 1\n' } }] },
    { content: 'Done: changed a.ts.' },
    { toolCalls: [{ name: 'shell', args: { command: 'npm test' } }] },
    { content: 'Done: changed a.ts; npm test passed.' },
  ], async (tool) => tool === 'shell' ? { exitCode: 0, stdout: 'ok', stderr: '' } : { appliedFiles: ['src/a.ts'], created: [], deleted: [], warnings: [] })
  assert.equal(result.final, 'Done: changed a.ts; npm test passed.')
  assert.match(seen[2]!, /You changed src\/a\.ts after your last check/)
  assert.deepEqual(log.filter((e) => e.type === 'turn/nudge').map((e) => (e.payload as { reason: string }).reason), ['final-without-verification'])
  const summary = log.find((e) => e.type === 'turn/verification')!.payload as { verifiedAfterLastEdit: boolean; editedFiles: string[] }
  assert.equal(summary.verifiedAfterLastEdit, true)
  assert.deepEqual(summary.editedFiles, ['src/a.ts'])
  const final = events.find((e) => e.type === 'final') as { verification?: { text: string; level: string } }
  assert.deepEqual(final.verification, { text: 'Checked after the last edit: npm test (exit 0)', level: 'info' })
})

test('A6: a second final without a check is accepted and marked unverified; the gate can be turned off', async () => {
  const replies = () => [
    { toolCalls: [{ name: 'apply_patch', args: { file: 'a.ts', content: 'x' } }] },
    { content: 'Done.' },
    { content: 'Done. Not verified: no test runner here.' },
  ]
  const execute = async () => ({ appliedFiles: ['a.ts'], created: [], deleted: [], warnings: [] })
  const gated = await runAgent(replies(), execute)
  assert.equal(gated.result.final, 'Done. Not verified: no test runner here.')
  const final = gated.events.find((e) => e.type === 'final') as { verification?: { text: string; level: string } }
  assert.deepEqual(final.verification, { text: 'Not verified after the last edit: a.ts', level: 'warn' })
  const off = await runAgent(replies(), execute, { verifyGate: false })
  assert.equal(off.result.final, 'Done.')
})

test('A5: varied failing calls get a progress note and then stop the turn', async () => {
  let n = 0
  const replies = Array.from({ length: 10 }, () => ({ toolCalls: [{ name: 'shell', args: { command: `try-${++n}` } }] }))
  let failures = 0
  const { result, seen, log } = await runAgent(replies, async () => ({ exitCode: 1, stdout: '', stderr: `failure ${++failures}` }), { stallSteps: 2 })
  assert.equal(result.outcome, 'stalled')
  assert.match(result.final, /6 consecutive steps made no progress/)
  assert.match(seen[2]!, /\[progress check\] 2 steps in a row produced no successful edit/)
  assert.match(seen[4]!, /\[progress check\] 4 steps in a row produced no progress/)
  assert.deepEqual(log.filter((e) => e.type === 'guard/stall').map((e) => (e.payload as { level: number }).level), [1, 2, 3])
})

test('A14: a shell result flagged for attention is not a passing check', () => {
  const progress = new TurnProgress()
  progress.record(1, [ok('edit_file', { file: 'a.ps1' }, '{}')])
  progress.record(2, [ok('shell', { command: 'Invoke-WebRequest x' }, 'out', { exitCode: 0, attention: 'exit code 0, but …' })])
  assert.equal(progress.summary().lastCheckPassed, false)
})

test('B5: step/end says how much of the previous request was repeated and what changed first', async () => {
  const replies = () => [
    { toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
    { toolCalls: [{ name: 'read_file', args: { path: 'b' } }] },
    { content: 'Done.' },
  ]
  const execute = async (_tool: string, args: unknown) => ({ content: JSON.stringify(args) })
  const plain = await runAgent(replies(), execute)
  const prefixes = plain.log.filter((e) => e.type === 'step/end').map((e) => (e.payload as { prefix?: { keptMessages: number; changed?: string } }).prefix)
  assert.equal(prefixes[0], undefined)
  assert.equal(prefixes[1]!.changed, undefined, 'appending to the conversation keeps the whole prefix')
  assert.ok(prefixes[1]!.keptMessages >= 2)
  // A context manager that rewrites an old entry (pruning) breaks the prefix there.
  let calls = 0
  const pruning = {
    beforeRequest: async (messages: Array<{ role: string; content: string }>) => {
      calls += 1
      return calls === 3 ? messages.map((m, i) => (i === 2 ? { ...m, content: '[pruned]' } : m)) : messages
    },
    toolOutput: (_id: string, raw: string) => ({ visible: raw }),
  }
  const pruned = await runAgent(replies(), execute, { context: pruning })
  const last = pruned.log.filter((e) => e.type === 'step/end').at(-1)!.payload as { prefix: { keptMessages: number; changed?: string } }
  assert.deepEqual(last.prefix, { keptMessages: 2, changed: 'history' })
})

test('B8: a final after a failed check is sent back once; the next final is accepted', async () => {
  const { result, seen, log } = await runAgent([
    { toolCalls: [{ name: 'apply_patch', args: { file: 'a.ts', content: 'x' } }] },
    { toolCalls: [{ name: 'shell', args: { command: 'npm test' } }] },
    { content: 'Done.' },
    { content: 'Done. npm test still fails in b.test.ts, which this change does not touch.' },
  ], async (tool) => tool === 'shell' ? { exitCode: 1, stdout: '', stderr: 'fail' } : { appliedFiles: ['a.ts'], created: [], deleted: [], warnings: [] })
  assert.equal(result.final, 'Done. npm test still fails in b.test.ts, which this change does not touch.')
  assert.match(seen[3]!, /Your last check after the edit failed: npm test \(exit 1\)/)
  assert.deepEqual(log.filter((e) => e.type === 'turn/nudge').map((e) => (e.payload as { reason: string }).reason), ['final-after-failed-check'])
})

test('B8: a failed check on prose-only edits, or before any edit, is not sent back', () => {
  const prose = new TurnProgress()
  prose.record(1, [ok('write_file', { file: 'README.md' }, '{}')])
  prose.record(2, [failed('shell', { command: 'markdownlint' }, 'exit 1')])
  assert.equal(prose.failedCheckAfterEdit(), undefined)
  const noEdit = new TurnProgress()
  noEdit.record(1, [failed('shell', { command: 'npm test' }, 'exit 1')])
  assert.equal(noEdit.failedCheckAfterEdit(), undefined)
  const passed = new TurnProgress()
  passed.record(1, [ok('edit_file', { file: 'a.ts' }, '{}')])
  passed.record(2, [ok('shell', { command: 'npm test' }, 'ok', { exitCode: 0 })])
  assert.equal(passed.failedCheckAfterEdit(), undefined)
})
