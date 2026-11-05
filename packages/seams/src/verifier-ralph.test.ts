// State-machine paths of verifier-ralph with a stub exec client (the real
// daemon and git paths are in tests/integration/verifier-ralph.test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ExecRpcClient, LlmProvider } from '../../core/dist/index.js'
import { Budget4D } from './budget.js'
import { parseGraderVerdict, renderDigest, runVerifierRalph, type RalphOptions } from './verifier-ralph.js'

const free = { inputPerMTokUsd: 0, outputPerMTokUsd: 0 }

function stubExec(calls: string[], gateExit = 0): ExecRpcClient {
  return {
    checkpointCreate: async (_r: string, label: string) => (calls.push(`create ${label}`), { ref: `refs/hy/${label}`, treeOid: 't', unprotected: [], durationMs: 1 }),
    checkpointRollback: async (_r: string, label: string) => (calls.push(`rollback ${label}`), { restored: [], deleted: [], skipped: [], durationMs: 1 }),
    checkpointDiff: async () => ({ filesChanged: ['src/a.ts'], patch: '+x', stat: ' 1 file', truncated: false }),
    checkpointPrune: async (_r: string, keep: string[]) => (calls.push(`prune keep=${keep.join(',')}`), { deletedRefs: [] }),
    exec: async (p: { command: string }) => (calls.push(`gate ${p.command}`), { exitCode: gateExit, stdout: 'out', stderr: '', timedOut: false, sandbox: 'unconfined', status: 'completed', durationMs: 1, truncated: false }),
  } as unknown as ExecRpcClient
}

function base(calls: string[], extra: Partial<RalphOptions>): RalphOptions {
  return {
    exec: stubExec(calls),
    runId: 'run-t',
    objective: 'obj',
    verifyCmds: ['check'],
    budget: new Budget4D({ maxRounds: 3, maxTotalTokens: 1e6, maxWallClockMs: 60_000 }, { worker: free, grader: free }),
    protectedPaths: [],
    allowProtectedEdits: false,
    pinned: [],
    workerNotes: () => [],
    runRound: async () => ({ outcome: 'claimed', final: 'done' }),
    ...extra,
  }
}

test('a stalled round (no claim) goes to the next round with a digest', async () => {
  const calls: string[] = []
  const prompts: string[] = []
  const outcomes = ['stalled', 'claimed'] as const
  const r = await runVerifierRalph(
    base(calls, {
      runRound: async (round, prompt) => (prompts.push(prompt), { outcome: outcomes[round - 1]!, final: 'x' }),
    }),
  )
  assert.equal(r.outcome, 'succeeded')
  assert.match(prompts[1]!, /Round 1 ended: stalled \(the worker stopped without calling claim_complete\)/)
  assert.deepEqual(calls, ['create base', 'create r1', 'create r2', 'gate check', 'prune keep=base'])
})

test('Ctrl-C aborts the round, rolls it back and ends the run', async () => {
  const calls: string[] = []
  const stop = new AbortController()
  const r = await runVerifierRalph(
    base(calls, {
      signal: stop.signal,
      runRound: (_round, _prompt, signal) =>
        new Promise((_res, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason))
          stop.abort()
        }),
    }),
  )
  assert.equal(r.outcome, 'interrupted')
  assert.deepEqual(calls, ['create base', 'create r1', 'rollback r1'])
})

test('a grader that runs out of budget ends the run as budget-exhausted', async () => {
  const calls: string[] = []
  const budget = new Budget4D({ maxRounds: 3, maxTotalTokens: 10, maxWallClockMs: 60_000 }, { worker: free, grader: free })
  const grader: LlmProvider = budget.meter({ name: 'g', complete: async () => ({ content: '{}', usage: { inputTokens: 0, outputTokens: 0 } }) }, 'grader')
  const r = await runVerifierRalph(base(calls, { budget, grader }))
  assert.equal(r.outcome, 'budget-exhausted')
  assert.match(r.digest!.reason!, /budget exhausted \(tokens\)/)
})

test('a malformed grader verdict fails Gate 2', async () => {
  const calls: string[] = []
  const prompts: string[] = []
  let n = 0
  const grader: LlmProvider = {
    name: 'g',
    complete: async () => ({ content: n++ === 0 ? 'looks good to me' : '{"pass":true,"unmetCriteria":[]}', usage: { inputTokens: 1, outputTokens: 1 } }),
  }
  const r = await runVerifierRalph(base(calls, { grader, runRound: async (_r, p) => (prompts.push(p), { outcome: 'claimed', final: 'x' }) }))
  assert.equal(r.outcome, 'succeeded')
  assert.match(prompts[1]!, /gate2-failed\.\nUnmet criteria:\n- the grader returned a malformed verdict/)
  assert.equal(parseGraderVerdict('[1,2]'), undefined)
  assert.equal(parseGraderVerdict('{"pass":"yes"}'), undefined)
  assert.deepEqual(parseGraderVerdict('```json\n{"pass":true,"unmetCriteria":[],"rollbackRecommended":true}\n```'), {
    pass: true,
    unmetCriteria: [],
    rollbackRecommended: true,
    reasoning: '',
  })
})

test('the failure digest is capped at about 2,000 tokens', () => {
  const huge = 'x'.repeat(50_000)
  const text = renderDigest({
    round: 3,
    outcome: 'gate1-failed',
    failingCommands: Array.from({ length: 20 }, (_, i) => ({ cmd: `npm test -- ${i}`, exitCode: 1, tail: huge })),
    unmetCriteria: ['a'],
    filesChanged: Array.from({ length: 80 }, (_, i) => `f${i}.ts`),
  })
  assert.ok(text.length < 8_000, `${text.length} chars`)
  assert.match(text, /^Round 3 ended: gate1-failed\./)
  assert.match(text, /`npm test -- 19` exited 1/)
  assert.ok(!text.includes('f60.ts'), 'at most 50 file names')
  assert.equal(
    renderDigest({ round: 1, outcome: 'aborted', reason: 'y'.repeat(30_000) }),
    'Round 1 ended: aborted.',
    'falls back to the outcome alone when nothing else fits',
  )
})
