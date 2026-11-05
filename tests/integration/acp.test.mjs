// WP-50: the ACP v1 server over stdio, driven by a scripted client: initialize,
// session/new, a prompt that streams a message, a tool call and its update, then
// cancel and close.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-acp-it-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# ACP fixture\n\nA repository for the ACP test.\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  return dir
}

/** A scripted ACP client: NDJSON in, NDJSON out, requests by method name. */
function client(dir) {
  const child = spawn(process.execPath, [cli, 'acp', '--cwd', dir, '--mock', '--yes'], {
    env: { ...process.env, HY_CONFIG_DIR: path.join(dir, 'config'), LOCALAPPDATA: path.join(dir, 'localappdata') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  const notifications = []
  const responses = new Map()
  let nextId = 1
  const waiters = []
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const at = buffer.indexOf('\n')
      if (at < 0) break
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.id !== undefined && message.method === undefined) responses.set(message.id, message)
      else if (message.method) notifications.push(message)
    }
  })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))
  const send = (method, params, id) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params })}\n`)
  const rpc = (method, params) => {
    const id = nextId++
    send(method, params, id)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll)
        reject(new Error(`timeout: ${method}; stderr=${stderr.join('')}`))
      }, 60_000)
      const poll = setInterval(() => {
        const response = responses.get(id)
        if (!response) return
        responses.delete(id)
        clearInterval(poll)
        clearTimeout(timer)
        resolve(response)
      }, 20)
    })
  }
  const notify = (method, params) => send(method, params)
  const close = () =>
    new Promise((resolve) => {
      child.stdin.end()
      child.once('close', () => resolve())
    })
  return { rpc, notify, notifications, close, child, stderr }
}

test('an ACP session streams a turn, a tool call and a cancel', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 180_000, concurrency: false }, async () => {
  const dir = fixture()
  const acp = client(dir)
  try {
    const init = await acp.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
    assert.equal(init.result.protocolVersion, 1)
    assert.equal(init.result.agentInfo.name, 'HY-HARNESS')
    assert.equal(init.result.agentCapabilities.loadSession, true)

    const created = await acp.rpc('session/new', { cwd: dir, mcpServers: [] })
    const sessionId = created.result.sessionId
    assert.match(sessionId, /^acp-/)

    // A prompt with a tool call: the client sees the tool_call and its update,
    // plus the final message.
    const prompt = await acp.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'CALL read_file {"path":"README.md"}' }],
    })
    assert.equal(prompt.result.stopReason, 'end_turn')
    const toolCalls = acp.notifications.filter((n) => n.params?.update?.sessionUpdate === 'tool_call')
    assert.ok(toolCalls.length >= 1, JSON.stringify(acp.notifications))
    assert.equal(toolCalls[0].params.update.title, 'read_file')
    const updates = acp.notifications.filter((n) => n.params?.update?.sessionUpdate === 'tool_call_update')
    assert.ok(updates.some((n) => n.params.update.status === 'completed'), JSON.stringify(updates))
    const chunks = acp.notifications.filter((n) => n.params?.update?.sessionUpdate === 'agent_message_chunk')
    assert.ok(
      chunks.some((n) => /called:|TOOL RESULT/.test(n.params.update.content.text)),
      JSON.stringify(chunks.map((n) => n.params.update.content.text)),
    )

    // load an existing session and prompt again.
    const loaded = await acp.rpc('session/load', { sessionId, cwd: dir, mcpServers: [] })
    assert.deepEqual(loaded.result, {})

    // A slow command, cancelled mid-turn.
    const started = acp.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'CALL shell {"command":"Start-Sleep -Seconds 20"}' }] })
    await new Promise((resolve) => setTimeout(resolve, 300))
    acp.notify('session/cancel', { sessionId })
    const cancelled = await started
    assert.equal(cancelled.result.stopReason, 'cancelled')

    await acp.rpc('session/close', { sessionId })
    // Unknown methods answer with JSON-RPC's method-not-found.
    const unknown = await acp.rpc('session/nope', {})
    assert.equal(unknown.error.code, -32601)
  } finally {
    await acp.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-30: an ACP session is a hy-protocol thread (same host, same log)', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 180_000, concurrency: false }, async () => {
  const dir = fixture()
  const acp = client(dir)
  try {
    await acp.rpc('initialize', { protocolVersion: 1 })
    const { sessionId } = (await acp.rpc('session/new', { cwd: dir, mcpServers: [] })).result
    const done = await acp.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'SAY via ACP' }] })
    assert.equal(done.result.stopReason, 'end_turn')
  } finally {
    await acp.close()
  }
  try {
    // The protocol server over the same workspace lists and reads that session.
    const env = { ...process.env, HY_CONFIG_DIR: path.join(dir, 'config'), LOCALAPPDATA: path.join(dir, 'localappdata') }
    const { spawnSync } = await import('node:child_process')
    const lines = ['initialize', 'thread/list'].map((method, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method, params: {} })).join('\n')
    const r = spawnSync(process.execPath, [cli, 'protocol', 'serve', '--cwd', dir, '--mock'], { env, input: `${lines}\n`, encoding: 'utf8', timeout: 60_000 })
    const listed = r.stdout.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === 2)
    const thread = listed.result.threads.find((t) => t.threadId.startsWith('acp-'))
    assert.ok(thread, r.stdout)
    assert.match(thread.title ?? '', /SAY via ACP/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
