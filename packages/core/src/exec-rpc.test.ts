import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ExecRpcClient, resolveServerPath, resolveServerPathInfo } from './exec-rpc.js'
import type { InitializeParams } from './protocol.js'

const init: InitializeParams = {
  protocolVersion: 1,
  workspaceRoot: process.cwd(),
  stateDir: os.tmpdir(),
  sandbox: 'read-only',
}

test('T-2: a missing exec server is a one-line error, not a failed spawn', async () => {
  const missing = path.join(os.tmpdir(), 'hy-no-such-exec-server', 'hy-exec-server.exe')
  assert.deepEqual(resolveServerPathInfo(missing), { path: path.resolve(missing), resolved: false })
  assert.equal(resolveServerPath(missing), path.resolve(missing), 'the old accessor still returns the path')
  await assert.rejects(ExecRpcClient.start(missing, init), (error: Error) => {
    assert.match(error.message, /hy-exec-server not found/)
    assert.match(error.message, /cargo build -p hy-exec-server/)
    assert.match(error.message, /--exec-server <path>/)
    assert.equal(error.message.includes('\n'), false, 'one line')
    return true
  })
})

test('T-2: a server that cannot start reports one line instead of crashing', async () => {
  // Both paths exist, so the pre-check passes. Spawning a directory reports
  // the failure through `child.on('error')`; a file that is not an image is
  // reported synchronously on Windows. Either way the pending `initialize`
  // must reject with the same one-line error and the process must survive.
  await assert.rejects(ExecRpcClient.start(os.tmpdir(), init), /could not start hy-exec-server/)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-bad-exec-'))
  const file = path.join(dir, 'hy-exec-server.exe')
  fs.writeFileSync(file, 'this is not a PE image')
  try {
    await assert.rejects(ExecRpcClient.start(file, init), /could not start hy-exec-server/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** A client whose `request` records the deadline it was given. */
function recordingClient(timeouts: number[]): ExecRpcClient {
  return Object.assign(Object.create(ExecRpcClient.prototype), {
    request: (_method: string, _params: unknown, timeoutMs: number) => {
      timeouts.push(timeoutMs)
      return Promise.resolve({})
    },
  }) as ExecRpcClient
}

test('command RPC outlives the foreground wait while explicit deadlines still win', async () => {
  const timeouts: number[] = []
  const client = recordingClient(timeouts)
  await client.exec({ command: 'build', mode: 'agent' })
  await client.exec({ command: 'build', mode: 'agent', foregroundWaitMs: 180_000 })
  await client.exec({ command: 'build', mode: 'agent', foregroundWaitMs: 180_000 }, undefined, 1_000)
  assert.deepEqual(timeouts, [120_000, 210_000, 1_000])
})

test('the client deadline stays past hardTimeoutMs so the server kills the job first', async () => {
  const timeouts: number[] = []
  const client = recordingClient(timeouts)
  await client.exec({ command: 'build', mode: 'agent', hardTimeoutMs: 2_700_000, foregroundWaitMs: 2_705_000 })
  await client.exec({ command: 'gate', mode: 'gate' })
  await client.exec({ command: 'build', mode: 'agent', hardTimeoutMs: 10_000 })
  assert.deepEqual(timeouts, [
    // The foreground wait plus the margin is already past hardTimeoutMs.
    2_735_000,
    // A gate job without hardTimeoutMs is killed at 600 s by the server.
    630_000,
    // The 120 s floor still applies to short deadlines.
    120_000,
  ])
  const [first] = timeouts
  assert.ok(first !== undefined && first > 2_700_000, 'the client waits past the hard timeout')
})

test('a timed-out request tells the server to cancel it', async () => {
  const written: string[] = []
  const client = Object.assign(Object.create(ExecRpcClient.prototype), {
    nextId: 0,
    pending: new Map(),
    closed: false,
    transport: {
      write: (line: string) => written.push(line),
      end: () => {},
      kill: () => {},
      exited: async () => {},
    },
  }) as ExecRpcClient
  await assert.rejects(client.request('exec/command', { command: 'build' }, 10), /RPC timeout after 10ms/)
  assert.equal(written.length, 2, 'the request, then $/cancelRequest')
  const [requestLine, cancelLine] = written
  assert.ok(requestLine !== undefined && cancelLine !== undefined, 'two messages were written')
  assert.equal((JSON.parse(requestLine) as { id: number; method: string }).method, 'exec/command')
  const cancel = JSON.parse(cancelLine) as { id?: number; jsonrpc: string; method: string; params: unknown }
  assert.equal(cancel.jsonrpc, '2.0')
  assert.equal(cancel.method, '$/cancelRequest')
  assert.deepEqual(cancel.params, { id: 1 })
  assert.equal(cancel.id, undefined, 'a cancel notification has no id')
})
