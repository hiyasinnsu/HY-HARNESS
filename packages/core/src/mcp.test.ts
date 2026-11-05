import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { McpManager, elicitationContent, setElicitationHandler } from './mcp.js'

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'mcp-echo-server.mjs')

test('MCP: tools across pages, calls, errors, approval hints and the catalog', async () => {
  const mcp = await McpManager.start({
    echo: { command: process.execPath, args: [server] },
    broken: { command: process.execPath, args: ['-e', 'process.exit(3)'], timeoutMs: 5_000 },
  })
  try {
    assert.deepEqual(
      mcp.tools.map((t) => `${t.server}/${t.name}`),
      ['echo/add', 'echo/echo', 'echo/fail'],
    )
    assert.equal(mcp.errors.length, 1)
    assert.match(mcp.errors[0]!, /^broken: MCP server broken exited with code 3/)

    assert.deepEqual(await mcp.call('echo', 'echo', { text: 'hi' }), { isError: false, text: 'echo: hi' })
    assert.deepEqual(await mcp.call('echo', 'add', { a: 2, b: 3 }), { isError: false, text: '5', structured: { sum: 5 } })
    assert.equal((await mcp.call('echo', 'fail', {})).isError, true)

    assert.equal(mcp.needsApproval(mcp.find('echo', 'echo')!), false, 'readOnlyHint')
    assert.equal(mcp.needsApproval(mcp.find('echo', 'add')!), true)

    const catalog = mcp.renderCatalog()
    assert.match(catalog, /^MCP tools \(call with mcp_call/)
    assert.match(catalog, /- echo\/add\(args: \{ a: number; b: number \}\): Add two numbers\./)
    assert.match(catalog, /- echo\/fail\(args: object\): Always fails\./)
    assert.throws(() => mcp.call('broken', 'x', {}), /MCP server broken is not running/)
  } finally {
    mcp.close()
  }
})

test('MCP: trusted servers and tool allowlists', async () => {
  const mcp = await McpManager.start({ echo: { command: process.execPath, args: [server], trusted: true, tools: ['add'] } })
  try {
    assert.deepEqual(mcp.tools.map((t) => t.name), ['add'])
    assert.equal(mcp.needsApproval(mcp.tools[0]!), false)
  } finally {
    mcp.close()
  }
})

test('CP-11: HTTP MCP servers expose tools and resources (JSON and SSE replies)', async () => {
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method?: string; params?: { uri?: string } }
      seen.push(message.method ?? 'notification')
      const json = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-1' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      }
      switch (message.method) {
        case 'initialize':
          return json({ protocolVersion: '2025-06-18', capabilities: { resources: {} }, serverInfo: { name: 'fake', version: '1' } })
        case 'tools/list':
          return json({
            tools: [
              {
                name: 'echo',
                description: 'Echo text',
                inputSchema: { type: 'object' },
                annotations: { readOnlyHint: true },
              },
            ],
          })
        case 'tools/call':
          return json({ content: [{ type: 'text', text: String((message.params as { arguments?: { text?: string } }).arguments?.text ?? '') }] })
        case 'resources/list':
          return json({ resources: [{ uri: 'file:///a.txt', name: 'a', description: 'A file', mimeType: 'text/plain' }] })
        case 'resources/read': {
          // SSE reply: one event, then the stream ends.
          res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's-1' })
          res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { contents: [{ uri: message.params?.uri, mimeType: 'text/plain', text: 'hello resource' }] } })}\n\n`)
          return res.end()
        }
        default:
          res.writeHead(202)
          return res.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  const mcp = await McpManager.start({ remote: { url: `http://127.0.0.1:${port}/mcp`, trusted: true } })
  try {
    assert.deepEqual(mcp.errors, [])
    assert.deepEqual(mcp.tools.map((t) => `${t.server}/${t.name}`), ['remote/echo'])
    assert.equal(mcp.tools[0]!.readOnly, true)
    const call = await mcp.call('remote', 'echo', { text: 'hi' })
    assert.equal(call.text, 'hi')
    const listed = await mcp.resources()
    assert.deepEqual(listed.errors, [])
    assert.deepEqual(
      listed.resources.map((r) => `${r.server}/${r.uri}`),
      ['remote/file:///a.txt'],
    )
    const read = await mcp.readResource('remote', 'file:///a.txt')
    assert.equal(read.text, 'hello resource')
    assert.equal(read.mimeType, 'text/plain')
    assert.ok(seen.includes('notifications/initialized'), 'the client sends the initialized notification')
  } finally {
    mcp.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('CP-11: an HTTP MCP failure is reported, not fatal', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('boom')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  try {
    const mcp = await McpManager.start({ broken: { url: `http://127.0.0.1:${port}/mcp` } })
    assert.equal(mcp.errors.length, 1)
    assert.match(mcp.errors[0]!, /^broken: .*HTTP 500/)
    mcp.close()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
const promptsServer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'mcp-prompts-server.mjs')

test('CP-11: MCP prompts are listed and rendered', async () => {
  const mcp = await McpManager.start({ p: { command: process.execPath, args: [promptsServer] } })
  try {
    const listed = await mcp.prompts()
    assert.deepEqual(listed.errors, [])
    assert.deepEqual(listed.prompts.map((p) => [p.server, p.name, p.arguments.map((a) => a.name)]), [
      ['p', 'review', ['file']],
      ['p', 'hello', []],
    ])
    const review = await mcp.getPrompt('p', 'review', { file: 'src/a.ts' })
    assert.deepEqual(review, { description: 'Review a file', messages: [{ role: 'user', text: 'Please review src/a.ts' }] })
    await assert.rejects(mcp.getPrompt('nope', 'x'), /not running/)
  } finally {
    mcp.close()
  }
})

test('CP-11: elicitation goes to the registered handler; without one it is declined', async () => {
  const mcp = await McpManager.start({ p: { command: process.execPath, args: [promptsServer] } })
  try {
    setElicitationHandler(undefined)
    assert.equal((await mcp.call('p', 'ask', {})).text, 'user declined')
    const asked: string[] = []
    setElicitationHandler(async (request) => {
      asked.push(`${request.server}: ${request.message}`)
      return elicitationContent(request.requestedSchema, 'teal')
    })
    assert.equal((await mcp.call('p', 'ask', {})).text, 'colour: teal')
    assert.deepEqual(asked, ['p: Which colour?'])
  } finally {
    setElicitationHandler(undefined)
    mcp.close()
  }
})

test('CP-11: free-text answers become typed elicitation content', () => {
  assert.deepEqual(elicitationContent({ properties: { n: { type: 'number' } } }, ' 42 '), { action: 'accept', content: { n: 42 } })
  assert.deepEqual(elicitationContent({ properties: { ok: { type: 'boolean' } } }, 'yes'), { action: 'accept', content: { ok: true } })
  assert.deepEqual(elicitationContent({ properties: { a: {}, b: {} } }, '{"a":1,"b":"x"}'), { action: 'accept', content: { a: 1, b: 'x' } })
  assert.deepEqual(elicitationContent({ properties: { a: {}, b: {} } }, 'not json'), { action: 'decline' })
  assert.deepEqual(elicitationContent(undefined, '   '), { action: 'decline' })
})
