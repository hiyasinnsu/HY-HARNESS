import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Agent } from './agent.js'
import { ToolRuntime } from './tools.js'
import { SessionLog } from './session-log.js'

const BROKEN = '{"tool":"read_file","args":{"path":"a.txt"'

async function run(replies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-broken-'))
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A')
  const events = []
  const provider = {
    name: 'native',
    complete: async () => ({ ...replies.shift(), usage: { inputTokens: 0, outputTokens: 0 } }),
  }
  const log = new SessionLog(path.join(dir, 'log.jsonl'))
  const r = await new Agent({
    provider,
    tools: new ToolRuntime({}, dir),
    sessionLog: log,
    workspaceRoot: dir,
    nativeTools: true,
    onEvent: (e) => events.push(e),
  }).run('go')
  const out = {
    final: r.final,
    steps: r.steps,
    retries: log.events().filter((e) => e.type === 'turn/retry').map((e) => e.payload),
    retryEvents: events.filter((e) => e.type === 'retry').length,
    userMessages: r.history.filter((m) => m.role === 'user').map((m) => m.content),
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return out
}

console.log('one broken reply then a real final:', JSON.stringify(await run([{ content: BROKEN }, { content: '{"final":"done"}' }]), null, 2))
console.log('two broken replies:', JSON.stringify(await run([{ content: BROKEN }, { content: BROKEN }]), null, 2))
