import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ExecRpcClient } from './exec-rpc.js'

test('command RPC outlives the foreground wait while explicit deadlines still win', async () => {
  const timeouts: number[] = []
  const client = Object.assign(Object.create(ExecRpcClient.prototype), {
    request: (_method: string, _params: unknown, timeoutMs: number) => {
      timeouts.push(timeoutMs)
      return Promise.resolve({})
    },
  }) as ExecRpcClient
  await client.exec({ command: 'build', mode: 'agent' })
  await client.exec({ command: 'build', mode: 'agent', foregroundWaitMs: 180_000 })
  await client.exec({ command: 'build', mode: 'agent', foregroundWaitMs: 180_000 }, undefined, 1_000)
  assert.deepEqual(timeouts, [120_000, 210_000, 1_000])
})
