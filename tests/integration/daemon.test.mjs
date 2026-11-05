// CP-27 / CP-29 / CP-30: the resident hy-protocol/1 server and the SDK client.
//
// Acceptance (docs/codex-adoption-plan.md CP-27): the client reconnects after
// the daemon is killed, and two clients working at once do not collide.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')
const sdk = await import(pathToFileURL(path.join(repo, 'packages', 'sdk', 'dist', 'index.js')).href)

const skip = skipReason('pipe') ?? skipReason('sync')

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-daemon-'))
  const ws = path.join(base, 'ws')
  const user = path.join(base, 'user')
  fs.mkdirSync(ws)
  fs.mkdirSync(user)
  fs.writeFileSync(path.join(ws, 'README.md'), '# daemon fixture\n')
  spawnSync('git', ['init', '-q'], { cwd: ws })
  const env = { HY_CONFIG_DIR: user, LOCALAPPDATA: path.join(base, 'local'), HY_SANDBOX: 'unconfined' }
  return { base, ws, launch: { cli, cwd: ws, args: ['--mock'], env } }
}

function stop(f) {
  spawnSync(process.execPath, [cli, 'serve', 'stop', '--mock'], { cwd: f.ws, env: { ...process.env, ...f.launch.env }, encoding: 'utf8' })
}

test('CP-27: two clients share one daemon; turns on different threads run at once, the same thread is refused', { skip, timeout: 180_000, concurrency: false }, async () => {
  const f = fixture()
  let a
  let b
  try {
    a = await sdk.connectDaemon(f.launch)
    b = await sdk.connectDaemon(f.launch)
    const info = await sdk.startDaemon(f.launch)
    assert.ok(info.pid > 0 && info.pipe.length > 0)

    // Different threads, concurrently.
    const [one, two] = await Promise.all([a.turn('SAY from client A'), b.turn('SAY from client B')])
    assert.equal(one.final, 'from client A')
    assert.equal(two.final, 'from client B')
    assert.notEqual(one.threadId, two.threadId)
    const listed = (await b.threads()).map((t) => t.threadId)
    assert.ok(listed.includes(one.threadId) && listed.includes(two.threadId), 'both clients see both threads')

    // The same thread from two clients: the second is refused while the first runs.
    let refusal
    const slow = sdk.ProtocolClient.connect({ kind: 'pipe', path: info.pipe, token: info.token }, {
      onApproval: async () => {
        refusal = await b.turn('SAY intruder', { threadId: one.threadId }).then(() => 'accepted', (error) => error)
        return false
      },
    })
    const c = await slow
    try {
      await c.turn('CALL shell {"command":"npm install"}', { threadId: one.threadId })
    } finally {
      c.close()
    }
    assert.ok(refusal instanceof sdk.ProtocolError, String(refusal))
    assert.equal(refusal.code, -32002)
    assert.match(refusal.message, /busy/)

    // Events carry their thread, so a client can follow several turns.
    const seen = new Set()
    const r = await a.turn('SAY events', { onEvent: (_event, threadId) => seen.add(threadId) })
    assert.deepEqual([...seen], [r.threadId])
  } finally {
    a?.close()
    b?.close()
    stop(f)
    fs.rmSync(f.base, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('CP-27: a killed daemon is restarted and the client reconnects', { skip, timeout: 180_000, concurrency: false }, async () => {
  const f = fixture()
  let client
  try {
    client = await sdk.connectDaemon(f.launch)
    const first = await client.turn('SAY before the crash')
    const before = await sdk.startDaemon(f.launch)
    process.kill(before.pid)
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(before.pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 100))
      } catch {
        break
      }
    }
    // The next call reconnects (starting a new daemon) and the thread is still there.
    const threads = await client.threads()
    assert.ok(threads.some((t) => t.threadId === first.threadId), 'the thread survives in the session log')
    const after = await sdk.startDaemon(f.launch)
    assert.notEqual(after.pid, before.pid, 'a new daemon runs')
    const again = await client.turn('SAY after the crash', { threadId: first.threadId })
    assert.equal(again.final, 'after the crash')
  } finally {
    client?.close()
    stop(f)
    fs.rmSync(f.base, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('CP-27: tokens are required on the pipe and the WebSocket; the WebSocket stays on loopback', { skip, timeout: 180_000, concurrency: false }, async () => {
  const f = fixture()
  try {
    const info = await sdk.startDaemon({ ...f.launch, args: ['--mock', '--ws', '0'] })
    assert.match(info.ws ?? '', /^ws:\/\/127\.0\.0\.1:\d+$/)

    await assert.rejects(sdk.ProtocolClient.connect({ kind: 'pipe', path: info.pipe }), (error) => error.code === -32001)
    await assert.rejects(sdk.ProtocolClient.connect({ kind: 'pipe', path: info.pipe, token: 'wrong' }), (error) => error.code === -32001)

    const ws = await sdk.ProtocolClient.connect({ kind: 'ws', url: info.ws, token: info.token })
    try {
      const config = await ws.configGet()
      assert.equal(config.model.provider, 'mock')
      const r = await ws.turn('SAY over websocket')
      assert.equal(r.final, 'over websocket')
    } finally {
      ws.close()
    }
    await assert.rejects(sdk.ProtocolClient.connect({ kind: 'ws', url: info.ws, token: 'wrong' }))

    const remote = spawnSync(process.execPath, [cli, 'serve', 'start', '--mock', '--ws', '0', '--host', '0.0.0.0'], { cwd: f.ws, env: { ...process.env, ...f.launch.env, LOCALAPPDATA: path.join(f.base, 'local2') }, encoding: 'utf8', timeout: 60_000 })
    assert.notEqual(remote.status, 0)
    assert.match(remote.stderr, /--allow-remote/)
  } finally {
    stop(f)
    fs.rmSync(f.base, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('CP-29: model switch and MCP/plugin reload take effect without a restart', { skip, timeout: 180_000, concurrency: false }, async () => {
  const f = fixture()
  let client
  try {
    client = await sdk.connectDaemon(f.launch)
    const t = await client.turn('SAY hello')
    const switched = await client.setModel('mock-2')
    assert.equal(switched.model.model, 'mock-2')
    assert.ok(switched.threads.includes(t.threadId), 'loaded threads switch too')
    assert.equal((await client.configGet()).model.model, 'mock-2')

    await assert.rejects(client.configSet('approvalPolicy', 'sometimes'), (e) => e.code === -32602)
    const set = await client.configSet('approvalPolicy', 'never')
    assert.equal(set.config.approvalPolicy, 'never')

    // An MCP server added to the user config after the daemon started.
    const server = path.join(repo, 'tests', 'fixtures', 'mcp-echo-server.mjs')
    fs.writeFileSync(path.join(f.launch.env.HY_CONFIG_DIR, 'config.json'), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [server] } } }))
    const reloaded = await client.reloadMcp()
    assert.deepEqual(reloaded.servers, ['echo'])
    assert.ok(reloaded.tools.includes('echo/echo'), reloaded.tools.join(', '))

    const plugins = await client.reloadPlugins()
    assert.ok(Array.isArray(plugins.tools) && Array.isArray(plugins.errors))
  } finally {
    client?.close()
    stop(f)
    fs.rmSync(f.base, { recursive: true, force: true, maxRetries: 3 })
  }
})
