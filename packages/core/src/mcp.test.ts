import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { McpManager, elicitationContent, quoteForCmd, resolveWindowsCommand, setElicitationHandler, stdioCommand } from './mcp.js'
import { ToolRuntime } from './tools.js'
import { nativeToolDefs } from './prompt.js'

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'mcp-echo-server.mjs')

test('T-5: a Windows .cmd shim is resolved on PATH and started through cmd.exe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-cmd-shim-'))
  try {
    const cmdShim = path.join(dir, 'hy-fake-cmd.cmd')
    const exe = path.join(dir, 'hy-fake-exe.exe')
    fs.writeFileSync(cmdShim, '@echo off\r\n')
    fs.writeFileSync(exe, 'not a real executable')
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    assert.equal(resolveWindowsCommand('hy-fake-cmd', env), cmdShim)
    assert.equal(resolveWindowsCommand('hy-fake-exe', env), exe)
    assert.equal(resolveWindowsCommand('hy-no-such-tool', env), undefined, 'a missing command is not invented')
    // A name that carries a path separator or an extension is used as written.
    assert.equal(resolveWindowsCommand('hy-fake-cmd.cmd', env), undefined)
    assert.equal(resolveWindowsCommand('.\\hy-fake-cmd', env), undefined)

    const shim = stdioCommand('hy-fake-cmd', ['-y', 'pkg name'], 'win32', { ...env, ComSpec: 'C:\\Windows\\System32\\cmd.exe' })
    assert.equal(shim.file, 'C:\\Windows\\System32\\cmd.exe')
    // One command line: the shim and each argument quoted on their own, the
    // whole line wrapped so `cmd /s` strips only the outer quotes.
    assert.deepEqual(shim.args, ['/d', '/s', '/c', `"${quoteForCmd(cmdShim)} -y "pkg name""`])
    assert.equal(shim.args[3]!.includes('pkg name'), true)
    assert.equal(shim.windowsVerbatimArguments, true)
    // The fallback when ComSpec is absent.
    assert.equal(stdioCommand('hy-fake-cmd', [], 'win32', env).file, 'cmd.exe')

    // A real executable, an unresolved name and POSIX keep the plain spawn.
    assert.deepEqual(stdioCommand('hy-fake-exe', ['--flag'], 'win32', env), { file: exe, args: ['--flag'] })
    assert.deepEqual(stdioCommand('hy-no-such-tool', ['x'], 'win32', env), { file: 'hy-no-such-tool', args: ['x'] })
    assert.deepEqual(stdioCommand('npx', ['-y', 'pkg'], 'linux', env), { file: 'npx', args: ['-y', 'pkg'] })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('T-5: cmd.exe arguments are quoted individually', () => {
  assert.equal(quoteForCmd('simple'), 'simple')
  assert.equal(quoteForCmd('two words'), '"two words"')
  assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""')
  assert.equal(quoteForCmd('C:\\dir with space\\'), '"C:\\dir with space\\\\"')
  assert.equal(quoteForCmd(''), '""')
})

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
    const runtime = new ToolRuntime({} as never, process.cwd(), async () => false, false, { mcp })
    const extraTools = runtime.mcpToolSpecs()
    const definitions = nativeToolDefs(false, false, { mcp: true, extraTools, allowTools: new Set(['mcp_call']), activeTools: new Set(['mcp_call']) })
    assert.equal(definitions.length, 3)
    const add = definitions.find((tool) => tool.description.startsWith('echo/add'))!
    const echo = definitions.find((tool) => tool.description.startsWith('echo/echo'))!
    // 5-4: the server's readOnlyHint reaches the tool spec, so a read-only MCP
    // tool runs in parallel inside run_code (`isReadOnly`).
    assert.equal(runtime.isReadOnly(echo.name), true)
    assert.equal(runtime.isReadOnly(add.name), false)
    assert.deepEqual(add.parameters, mcp.find('echo', 'add')!.inputSchema)
    await assert.rejects(runtime.execute(add.name, { a: 1 }), /args.b is required/)
    await assert.rejects(runtime.execute(add.name, { a: 1, b: 2 }), /MCP call not approved/)
    assert.deepEqual(await runtime.execute(echo.name, { text: 'native' }), { text: 'echo: native' })
    runtime.setAllowTools(new Set())
    await assert.rejects(runtime.execute(echo.name, { text: 'blocked' }), /not available while plan mode/)

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

test('5-4: only an explicit readOnlyHint makes an MCP tool read-only; long descriptions are cut', () => {
  const long = 'x'.repeat(1_000)
  const mcp = {
    tools: [
      { server: 'srv', name: 'read', description: 'Reads.', inputSchema: { type: 'object' }, readOnly: true },
      { server: 'srv', name: 'write', description: long, inputSchema: { type: 'object' }, readOnly: false },
      // A server that sends no hint, or sends readOnlyHint: false, keeps the
      // serial path: a false "safe" guess would skip the approval prompt.
      { server: 'srv', name: 'unhinted', description: 'Unknown.', inputSchema: { type: 'object' } },
    ],
  }
  const runtime = new ToolRuntime({} as never, process.cwd(), undefined, false, { mcp: mcp as never })
  const specs = runtime.mcpToolSpecs()
  assert.deepEqual(specs.map((spec) => spec.readOnly), [true, false, false])
  assert.equal(runtime.isReadOnly(specs[0]!.name), true)
  assert.equal(runtime.isReadOnly(specs[1]!.name), false)
  // The description travels in every prompt and native tool definition.
  assert.ok(specs[1]!.description.length <= 400, String(specs[1]!.description.length))
  assert.match(specs[1]!.description, /^srv\/write\. /)
  assert.ok(specs[1]!.description.endsWith('…'))
  assert.equal(specs[0]!.description, 'srv/read. Reads.')
})
