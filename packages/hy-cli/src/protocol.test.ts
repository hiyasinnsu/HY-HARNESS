import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ERROR,
  PROTOCOL_VERSION,
  ProtocolRpcError,
  ProtocolServer,
  initializeHandler,
  parseRequest,
} from './protocol.js'

function server(): ProtocolServer {
  const notes: Array<{ method: string; params: unknown }> = []
  const logs: string[] = []
  const s = new ProtocolServer({
    methods: {
      initialize: initializeHandler({ threads: true, turns: false }),
      'thread/list': { request: () => ({ threads: [{ id: 'thread-1', title: 'hi' }] }) },
      'turn/start': {
        request: (params) => {
          if (params === null || typeof params !== 'object' || typeof (params as { threadId?: unknown }).threadId !== 'string') {
            throw new ProtocolRpcError(ERROR.invalidParams, 'threadId is required')
          }
          return { turnId: 'turn-1' }
        },
      },
      'session/log': { notification: (params) => notes.push({ method: 'session/log', params }) },
      'session/boom': {
        notification: () => {
          throw new Error('bad notification')
        },
      },
    },
    notify: (method, params) => notes.push({ method, params }),
    log: (line) => logs.push(line),
  })
  ;(s as unknown as { notes: typeof notes }).notes = notes
  ;(s as unknown as { logs: typeof logs }).logs = logs
  return s
}

test('CP-25: initialize negotiates the protocol version and capabilities', async () => {
  const s = server()
  const result = await s.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } }))
  const response = JSON.parse(result.response!) as { id: number; result: { protocolVersion: string; capabilities: { threads: boolean } } }
  assert.equal(response.id, 1)
  assert.equal(response.result.protocolVersion, PROTOCOL_VERSION)
  assert.equal(response.result.capabilities.threads, true)
  assert.equal(s.isInitialized(), true)
})

test('CP-25: thread and turn methods answer, bad params are invalidParams', async () => {
  const s = server()
  const listed = await s.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/list' }))
  assert.deepEqual(JSON.parse(listed.response!), { jsonrpc: '2.0', id: 2, result: { threads: [{ id: 'thread-1', title: 'hi' }] } })
  const bad = await s.handle(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: {} }))
  const error = JSON.parse(bad.response!) as { error: { code: number; message: string } }
  assert.equal(error.error.code, ERROR.invalidParams)
  assert.match(error.error.message, /threadId/)
})

test('CP-25: framing errors use the JSON-RPC codes and null ids', async () => {
  const s = server()
  const parse = await s.handle('{not json')
  assert.deepEqual(JSON.parse(parse.response!), { jsonrpc: '2.0', id: null, error: { code: ERROR.parse, message: 'parse error' } })
  assert.deepEqual(parseRequest('[]').error, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: ERROR.invalidRequest, message: 'a request must be an object' } }))
  const missing = await s.handle(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'nope' }))
  assert.equal((JSON.parse(missing.response!) as { error: { code: number } }).error.code, ERROR.methodNotFound)
})

test('CP-25: notifications get no response and their failures are logged', async () => {
  const s = server()
  const notes = (s as unknown as { notes: Array<{ method: string; params: unknown }> }).notes
  const logs = (s as unknown as { logs: string[] }).logs
  assert.deepEqual(await s.handle(JSON.stringify({ jsonrpc: '2.0', method: 'session/log', params: { line: 'x' } })), { handled: true })
  assert.deepEqual(notes, [{ method: 'session/log', params: { line: 'x' } }])
  await s.handle(JSON.stringify({ jsonrpc: '2.0', method: 'session/boom' }))
  assert.match(logs.at(-1)!, /session\/boom failed: bad notification/)
  assert.deepEqual(await s.handle(JSON.stringify({ jsonrpc: '2.0', method: 'nope' })), { handled: false })
})