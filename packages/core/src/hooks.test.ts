import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hooks, describeHooks, type HookOutcome, type HookRunner, type HookSpec } from './hooks.js'

/** A runner that answers from a queue and records what it was asked. */
function fakeRunner(replies: Array<Partial<HookOutcome>>): { run: HookRunner; calls: Array<{ stdin: string; command: readonly string[] }> } {
  const calls: Array<{ stdin: string; command: readonly string[] }> = []
  const run: HookRunner = async (command, stdin) => {
    calls.push({ stdin, command })
    const reply = replies.shift() ?? {}
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...reply }
  }
  return { run, calls }
}

const hook = (name: string): HookSpec => ({ command: ['hook', name] })

test('CP-19: userPromptSubmit can block (exit 2) or add context (stdout)', async () => {
  const blocked = fakeRunner([{ code: 2, stderr: 'no secrets allowed' }])
  const hooks = new Hooks({ userPromptSubmit: [hook('a')] }, undefined, undefined, blocked.run)
  assert.deepEqual(await hooks.userPromptSubmit({ objective: 'go' }), { block: 'no secrets allowed' })
  assert.deepEqual(JSON.parse(blocked.calls[0]!.stdin), { event: 'userPromptSubmit', objective: 'go' })

  const contextual = fakeRunner([
    { code: 0, stdout: 'project uses pnpm\n' },
    { code: 0, stdout: 'tests: node --test\n' },
  ])
  const hooks2 = new Hooks({ userPromptSubmit: [hook('a'), hook('b')] }, undefined, undefined, contextual.run)
  assert.deepEqual(await hooks2.userPromptSubmit({ objective: 'go' }), { context: 'project uses pnpm\ntests: node --test' })
})

test('CP-19: permissionRequest blocks with the hook stderr', async () => {
  const { run } = fakeRunner([{ code: 2, stderr: 'git push is not allowed' }])
  const hooks = new Hooks({ permissionRequest: [hook('deny')] }, undefined, undefined, run)
  assert.equal(await hooks.permissionRequest({ command: 'git push', sandbox: 'workspace-write' }), 'git push is not allowed')
  const { run: allow } = fakeRunner([{ code: 0 }])
  assert.equal(await new Hooks({ permissionRequest: [hook('ok')] }, undefined, undefined, allow).permissionRequest({ command: 'x' }), undefined)
})

test('CP-19: lifecycle hooks receive their event payloads', async () => {
  const { run, calls } = fakeRunner([{ code: 0 }, { code: 0 }])
  const hooks = new Hooks({ sessionStart: [hook('start')], modelRequest: [hook('model')] }, undefined, undefined, run)
  await hooks.sessionStart({ runId: 'run-1', workspace: 'C:/ws' })
  await hooks.modelRequest({ step: 2, model: 'ollama:qwen' })
  assert.deepEqual(JSON.parse(calls[0]!.stdin), { event: 'sessionStart', runId: 'run-1', workspace: 'C:/ws' })
  assert.deepEqual(JSON.parse(calls[1]!.stdin), { event: 'modelRequest', step: 2, model: 'ollama:qwen' })
})

test('CP-19: preToolUse still honours the tools filter and exit 2', async () => {
  const { run, calls } = fakeRunner([{ code: 2, stderr: 'blocked shell' }])
  const hooks = new Hooks({ preToolUse: [{ command: ['hook'], tools: ['shell'] }] }, undefined, undefined, run)
  assert.equal(await hooks.preToolUse('read_file', {}), undefined)
  assert.equal(calls.length, 0, 'the hook is not run for other tools')
  assert.equal(await hooks.preToolUse('shell', { command: 'rm -rf /' }), 'blocked shell')
})

test('CP-19: empty reflects the new events', () => {
  assert.equal(new Hooks({}).empty, true)
  assert.equal(new Hooks({ sessionStart: [hook('a')] }).empty, false)
  assert.equal(new Hooks({}, ['notify']).empty, false)
})

test('CP-19: stop and interrupt hooks receive the turn and reason', async () => {
  const { run, calls } = fakeRunner([{ code: 0 }, { code: 0 }])
  const hooks = new Hooks({ stop: [hook('s')], interrupt: [hook('i')] }, undefined, undefined, run)
  await hooks.stop({ runId: 'run-1', turn: 2 })
  await hooks.interrupt({ runId: 'run-1', turn: 3, reason: 'boom' })
  assert.deepEqual(JSON.parse(calls[0]!.stdin), { event: 'stop', runId: 'run-1', turn: 2 })
  assert.deepEqual(JSON.parse(calls[1]!.stdin), { event: 'interrupt', runId: 'run-1', turn: 3, reason: 'boom' })
  assert.equal(new Hooks({ stop: [hook('s')] }).empty, false)
})

test('CP-19: sessionEnd receives the run and turn count', async () => {
  const { run, calls } = fakeRunner([{ code: 0 }])
  const hooks = new Hooks({ sessionEnd: [hook('end')] }, undefined, undefined, run)
  await hooks.sessionEnd({ runId: 'run-1', turns: 3 })
  assert.deepEqual(JSON.parse(calls[0]!.stdin), { event: 'sessionEnd', runId: 'run-1', turns: 3 })
})

test('CP-19: subagent lifecycle hooks carry the agent and task', async () => {
  const { run, calls } = fakeRunner([{ code: 0 }, { code: 0 }])
  const hooks = new Hooks({ subagentStart: [hook('start')], subagentStop: [hook('stop')] }, undefined, undefined, run)
  await hooks.subagentStart({ runId: 'run-1', agentId: 'agent-1', task: 'review', readOnly: true })
  await hooks.subagentStop({ runId: 'run-1', agentId: 'agent-1', status: 'done' })
  assert.deepEqual(JSON.parse(calls[0]!.stdin), {
    event: 'subagentStart',
    runId: 'run-1',
    agentId: 'agent-1',
    task: 'review',
    readOnly: true,
  })
  assert.deepEqual(JSON.parse(calls[1]!.stdin), {
    event: 'subagentStop',
    runId: 'run-1',
    agentId: 'agent-1',
    status: 'done',
  })
})
test('CP-32: describeHooks flattens the configuration for /hooks', () => {
  assert.deepEqual(describeHooks(undefined), [])
  assert.deepEqual(
    describeHooks({
      sessionStart: [{ command: ['node', 'start.mjs'] }],
      preToolUse: [{ command: ['guard'], tools: ['shell'], timeoutMs: 2_000 }, { command: ['log'] }],
      stop: [],
    }),
    [
      { event: 'sessionStart', command: ['node', 'start.mjs'] },
      { event: 'preToolUse', command: ['guard'], tools: ['shell'], timeoutMs: 2_000 },
      { event: 'preToolUse', command: ['log'] },
    ],
  )
})
