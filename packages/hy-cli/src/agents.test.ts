import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '../../core/dist/index.js'
import { MAX_RUNNING_AGENTS, SubagentRegistry, isAgentOf, type SubagentHost, type SubagentRunner } from './agents.js'

let seq = 0
const ev = (type: string, payload: unknown, runId = 'run-a'): SessionEvent => ({
  v: 1,
  seq: ++seq,
  ts: seq,
  sessionId: 's',
  runId,
  type,
  payload,
})

interface FakeRunner extends SubagentRunner {
  steered: string[]
  aborted: number
  disposed: number
  release: () => void
}

function fakeHost(): { host: SubagentHost; events: Array<{ type: string; payload: Record<string, unknown> }>; changes: string[]; runners: FakeRunner[] } {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  const changes: string[] = []
  const runners: FakeRunner[] = []
  const host: SubagentHost = {
    create(): SubagentRunner {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const runner: FakeRunner = {
        steered: [],
        aborted: 0,
        disposed: 0,
        release,
        run: async (message: string) => {
          await gate
          // A real aborted turn rejects; the registry must keep the state honest.
          if (runner.aborted > 0) throw new Error('turn cancelled')
          return `answer to ${message}`
        },
        steer(message: string) {
          runner.steered.push(message)
          return { queued: runner.steered.length }
        },
        abort() {
          runner.aborted += 1
          release()
        },
        dispose() {
          runner.disposed += 1
          release()
        },
      }
      runners.push(runner)
      return runner
    },
    log(type, payload) {
      events.push({ type, payload })
    },
    changed(view, event) {
      changes.push(`${event}:${view.status}`)
    },
  }
  return { host, events, changes, runners }
}

test('agent ids are <parent>.subN and nothing else', () => {
  assert.equal(isAgentOf('run-a', 'run-a.sub1'), true)
  assert.equal(isAgentOf('run-a', 'run-a.sub12'), true)
  assert.equal(isAgentOf('run-a', 'run-a.sub1.sub2'), false)
  assert.equal(isAgentOf('run-a', 'run-b.sub1'), false)
  assert.equal(isAgentOf('run-a', 'run-a.sub'), false)
})

test('a background agent runs, is steered, and can be interrupted', async () => {
  const { host, events, changes, runners } = fakeHost()
  const registry = new SubagentRegistry(host, 'run-a')
  const view = registry.spawn('review the diff', true, { background: true, start: 'review the diff' })
  assert.equal(view.agentId, 'run-a.sub1')
  assert.equal(view.status, 'running')
  assert.equal(view.background, true)
  assert.equal(events[0]?.type, 'agent/spawn')
  assert.equal(registry.running(), 1)

  // A message while running steers the turn instead of starting a second one.
  const steered = registry.send('run-a.sub1', 'focus on the tests')
  assert.equal(steered.status, 'running')
  assert.equal(steered.turns, 1, 'steering does not start a new turn')
  assert.deepEqual(runners[0]?.steered, ['focus on the tests'])
  assert.equal(events.at(-1)?.payload.steering, true)

  const interrupted = registry.interrupt('run-a.sub1')
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(runners[0]?.aborted, 1)
  assert.equal(events.at(-1)?.type, 'agent/interrupt')
  // The aborted turn settles as an interruption, not as a clean finish.
  await registry.wait('run-a.sub1').catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(registry.get('run-a.sub1')?.status, 'interrupted')
  assert.equal(events.at(-1)?.payload.interrupted, true)
  assert.ok(changes.includes('running:running'))
})

test('a finished agent takes a follow-up message and keeps its turn count', async () => {
  const { host, runners } = fakeHost()
  const registry = new SubagentRegistry(host, 'run-a')
  registry.spawn('first task', true, { background: true, start: 'first task' })
  runners[0]?.release()
  await registry.wait('run-a.sub1')
  assert.equal(registry.get('run-a.sub1')?.status, 'idle')
  assert.equal(registry.get('run-a.sub1')?.final, 'answer to first task')

  const next = registry.send('run-a.sub1', 'second task')
  assert.equal(next.turns, 2)
  assert.equal(next.status, 'running')
  await registry.wait('run-a.sub1')
  assert.equal(registry.get('run-a.sub1')?.final, 'answer to second task')
})

test('the running limit and the closed state are enforced', () => {
  const { host } = fakeHost()
  const registry = new SubagentRegistry(host, 'run-a')
  for (let i = 0; i < MAX_RUNNING_AGENTS; i += 1) registry.spawn(`task ${i}`, true, { start: `task ${i}` })
  assert.throws(() => registry.spawn('one too many', true, { start: 'one too many' }), /too many subagents/)
  const closed = registry.close('run-a.sub1')
  assert.equal(closed.status, 'closed')
  assert.throws(() => registry.send('run-a.sub1', 'again'), /closed/)
  assert.throws(() => registry.send('run-a.sub99', 'x'), /unknown subagent/)
  assert.equal(registry.running(), MAX_RUNNING_AGENTS - 1)
})

test('closing a running agent keeps it closed after its aborted turn ends, live and on replay', async () => {
  const { host, events } = fakeHost()
  const registry = new SubagentRegistry(host, 'run-a')
  registry.spawn('task', true, { background: true, start: 'task' })
  registry.close('run-a.sub1')
  await registry.wait('run-a.sub1').catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(registry.get('run-a.sub1')?.status, 'closed')
  assert.throws(() => registry.send('run-a.sub1', 'again'), /closed/)
  // The aborted turn's agent/end comes after agent/close in the log.
  assert.deepEqual(events.map((e) => e.type).slice(-2), ['agent/close', 'agent/end'])
  const replayed = SubagentRegistry.replay(events.map((e) => ev(e.type, e.payload)), 'run-a')
  assert.equal(replayed[0]?.status, 'closed')
})

test('a restart normalises a running agent to interrupted', () => {
  const events = [
    ev('agent/spawn', { agentId: 'run-a.sub1', task: 'slow', readOnly: true, background: true }),
    ev('agent/message', { agentId: 'run-a.sub1', message: 'slow' }),
    ev('agent/spawn', { agentId: 'run-a.sub2', task: 'done', readOnly: true }),
    ev('agent/message', { agentId: 'run-a.sub2', message: 'done', final: 'ok' }),
    ev('agent/close', { agentId: 'run-a.sub2' }),
    // Another run's agents are not ours.
    ev('agent/spawn', { agentId: 'run-b.sub1', task: 'other', readOnly: true }, 'run-b'),
  ]
  const replayed = SubagentRegistry.replay(events, 'run-a')
  assert.deepEqual(
    replayed.map((v) => [v.agentId, v.status, v.task, v.turns]),
    [
      ['run-a.sub1', 'interrupted', 'slow', 1],
      ['run-a.sub2', 'closed', 'done', 1],
    ],
  )
  // Restored agents are listed and messaged; the id counter continues after them.
  const { host } = fakeHost()
  const registry = new SubagentRegistry(host, 'run-a')
  registry.restore(replayed)
  assert.equal(registry.list().length, 2)
  assert.equal(registry.get('run-a.sub1')?.status, 'interrupted')
  assert.equal(registry.spawn('next', true).agentId, 'run-a.sub3')
})
