import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR, ProtocolRpcError } from './protocol.js'
import { ApprovalBridge } from './protocol-approvals.js'

test('CP-25: approvals round-trip through the bridge', async () => {
  const sent: Array<{ method: string; params: unknown }> = []
  const bridge = new ApprovalBridge({ send: (method, params) => sent.push({ method, params }) })
  const answer = bridge.ask({ command: 'rm -rf build', sandbox: 'workspace-write', justification: 'clean' })
  assert.equal(bridge.pendingCount(), 1)
  const request = sent[0]!
  assert.equal(request.method, 'approval/request')
  const params = request.params as { id: string; command: string }
  assert.equal(params.command, 'rm -rf build')
  assert.deepEqual(bridge.respond({ id: params.id, approved: true }), { id: params.id, approved: true })
  assert.equal(await answer, true)
  assert.equal(bridge.pendingCount(), 0)
})

test('CP-25: unknown, repeated and malformed responses are rejected', async () => {
  const bridge = new ApprovalBridge({ send: () => undefined })
  assert.throws(
    () => bridge.respond({ id: 'nope', approved: true }),
    (error: unknown) => error instanceof ProtocolRpcError && error.code === ERROR.invalidParams,
  )
  assert.throws(() => bridge.respond({ id: 'x' }), /approved must be a boolean/)
  assert.throws(() => bridge.respond(null), /params must be an object/)
  const answer = bridge.ask({ command: 'x' })
  assert.equal(bridge.respond({ id: 'approval-1', approved: false }).approved, false)
  assert.equal(await answer, false)
  assert.throws(() => bridge.respond({ id: 'approval-1', approved: true }), /unknown approval/)
})

test('CP-25: a timeout is a denial and denyAll releases waiters', async () => {
  const events: string[] = []
  const bridge = new ApprovalBridge({ send: (method) => events.push(method), timeoutMs: 10 })
  assert.equal(await bridge.ask({ command: 'slow' }), false)
  assert.ok(events.includes('approval/expired'))
  const first = bridge.ask({ command: 'a' })
  const second = bridge.ask({ command: 'b' })
  assert.equal(bridge.pendingCount(), 2)
  bridge.denyAll()
  assert.equal(await first, false)
  assert.equal(await second, false)
  assert.equal(bridge.pendingCount(), 0)
})