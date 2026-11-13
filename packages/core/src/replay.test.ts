import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Agent } from './agent.js'
import { SessionLog } from './session-log.js'
import { ToolRuntime } from './tools.js'
import { agentRuns, decisionsOf, replayRun } from './replay.js'

type Reply = { content?: string; toolCalls?: Array<{ id?: string; name: string; args: unknown }> }

/** Records a real agent run with a scripted model, as a session would. */
async function record(replies: Reply[], execute: (tool: string, args: unknown) => Promise<unknown>, options: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-replay-rec-'))
  try {
    const provider = {
      name: 'scripted',
      complete: async () => {
        const next = replies.shift() ?? { content: 'Done.' }
        return { content: next.content ?? '', ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}), usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const tools = new ToolRuntime({} as never, dir)
    ;(tools as unknown as { execute: unknown }).execute = execute
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-r')
    await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir, nativeTools: true, ...options }).run('do the task')
    log.append('turn/start', { turn: 2 })
    return log.events()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const editThenFinish = (): Reply[] => [
  { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] },
  { toolCalls: [{ id: 'c2', name: 'apply_patch', args: { file: 'a.ts', content: 'x' } }] },
  { content: 'Done.' },
  { toolCalls: [{ id: 'c3', name: 'shell', args: { command: 'npm test' } }] },
  { content: 'Done; npm test passed.' },
]
const execute = async (tool: string) =>
  tool === 'shell' ? { exitCode: 0, stdout: 'ok', stderr: '' }
    : tool === 'apply_patch' ? { appliedFiles: ['a.ts'], created: [], deleted: [], warnings: [] }
    : { content: 'old' }

test('F1: a recorded run replays to the same decisions under the same code', async () => {
  const events = await record(editThenFinish(), execute)
  const runs = agentRuns(events)
  assert.equal(runs.length, 1)
  assert.deepEqual(decisionsOf(runs[0]!.events), ['tools:read_file', 'tools:apply_patch', 'nudge:final-without-verification', 'tools:shell', 'end:completed'])
  const result = await replayRun(runs[0]!)
  assert.equal(result.status, 'same', JSON.stringify(result))
})

test('F1: a behaviour change shows as a divergence at the first different decision', async () => {
  const events = await record(editThenFinish(), execute)
  const result = await replayRun(agentRuns(events)[0]!, { agent: { verifyGate: false } })
  assert.equal(result.status, 'diverged')
  assert.equal(result.divergedAt, 2)
  assert.equal(result.replayed[2], 'end:completed')
  assert.equal(result.logged[2], 'nudge:final-without-verification')
})

test('F1: a rejected reply is logged and replayed; a log without it stops as unreplayable', async () => {
  const events = await record([
    { content: '{"tool": "read_file", "args": {"path": ' },
    { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] },
    { content: 'The file says old.' },
  ], execute)
  const run = agentRuns(events)[0]!
  assert.equal(decisionsOf(run.events)[0], 'retry:broken-tool-call')
  assert.equal((await replayRun(run)).status, 'same')
  // An older log, written before rejected replies were recorded.
  const old = { ...run, events: run.events.map((e) => e.type === 'turn/retry' ? { ...e, payload: { ...(e.payload as object), rejected: undefined } } : e) }
  const result = await replayRun(old)
  assert.equal(result.status, 'unreplayable', JSON.stringify(result))
  assert.match(result.note ?? '', /not recorded/)
})

test('B7: text beside native calls is logged and replayed, while history keeps only the calls', async () => {
  const seen: string[] = []
  const events = await record([
    { content: 'Reading the file first.', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] },
    { content: 'It says old.' },
  ], async (tool, args) => (seen.push(JSON.stringify(args)), execute(tool)))
  const message = events.find((e) => e.type === 'assistant/message')!.payload as { content: string; prose?: string }
  assert.equal(message.prose, 'Reading the file first.')
  assert.equal(message.content, '{"tool":"read_file","args":{"path":"a.ts"}}', 'history and the request are unchanged')
  assert.equal((await replayRun(agentRuns(events)[0]!)).status, 'same')
})
