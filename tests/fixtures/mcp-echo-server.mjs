// A minimal stdio MCP server for tests: tools `echo` (read-only), `add`, and
// `fail` (returns isError). Newline-delimited JSON-RPC 2.0.
import readline from 'node:readline'

const tools = [
  {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object' } },
]

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
process.stdout.write('this line is not JSON and must be ignored\n')

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id === undefined) return // notifications
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } })
      break
    case 'tools/list':
      // Two pages, to exercise the cursor.
      if (msg.params?.cursor === 'p2') send({ jsonrpc: '2.0', id: msg.id, result: { tools: tools.slice(2) } })
      else send({ jsonrpc: '2.0', id: msg.id, result: { tools: tools.slice(0, 2), nextCursor: 'p2' } })
      break
    case 'tools/call': {
      const { name, arguments: args } = msg.params
      const text =
        name === 'echo' ? `echo: ${args.text}` : name === 'add' ? String(args.a + args.b) : 'it failed on purpose'
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text }],
          isError: name === 'fail',
          ...(name === 'add' ? { structuredContent: { sum: args.a + args.b } } : {}),
        },
      })
      break
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
  }
})
