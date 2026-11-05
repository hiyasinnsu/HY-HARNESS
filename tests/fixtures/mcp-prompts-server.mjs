// A stdio MCP server for CP-11 tests: two prompt templates and a tool `ask`
// that asks the client for input with `elicitation/create` before answering.
import readline from 'node:readline'

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const waiting = new Map()
let nextId = 1
let clientCaps = {}

const prompts = [
  { name: 'review', description: 'Review a file', arguments: [{ name: 'file', required: true }] },
  { name: 'hello', description: 'Say hello' },
]

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  // A response to our elicitation request.
  if (msg.method === undefined && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg.result ?? { action: 'cancel' })
    waiting.delete(msg.id)
    return
  }
  if (msg.id === undefined) return
  switch (msg.method) {
    case 'initialize':
      clientCaps = msg.params.capabilities ?? {}
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'prompts', version: '1' } } })
      break
    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ask', description: 'Ask the user for a colour.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } })
      break
    case 'tools/call': {
      if (!clientCaps.elicitation) {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'client cannot elicit' }], isError: true } })
        break
      }
      const reqId = `e${nextId++}`
      waiting.set(reqId, (result) => {
        const text = result.action === 'accept' ? `colour: ${result.content.colour}` : `user ${result.action}d`
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } })
      })
      send({ jsonrpc: '2.0', id: reqId, method: 'elicitation/create', params: { message: 'Which colour?', requestedSchema: { type: 'object', properties: { colour: { type: 'string' } }, required: ['colour'] } } })
      break
    }
    case 'prompts/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { prompts } })
      break
    case 'prompts/get': {
      const { name, arguments: args = {} } = msg.params
      if (name === 'review') {
        send({ jsonrpc: '2.0', id: msg.id, result: { description: 'Review a file', messages: [{ role: 'user', content: { type: 'text', text: `Please review ${args.file}` } }] } })
      } else if (name === 'hello') {
        send({ jsonrpc: '2.0', id: msg.id, result: { messages: [{ role: 'assistant', content: { type: 'text', text: 'Hello!' } }] } })
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown prompt ${name}` } })
      }
      break
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
  }
})
