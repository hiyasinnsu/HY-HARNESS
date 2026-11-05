// A minimal LSP server for tests (Content-Length framing over stdio). Answers
// definition / references / hover / documentSymbol with fixed results and
// publishes one diagnostic per line containing "TODO".
let buffer = Buffer.alloc(0)
const send = (msg) => {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}
const range = (line, character) => ({ start: { line, character }, end: { line, character: character + 1 } })
const texts = new Map()

function publish(uri) {
  const lines = texts.get(uri).split('\n')
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri,
      diagnostics: lines.flatMap((l, i) => (l.includes('TODO') ? [{ range: range(i, l.indexOf('TODO')), severity: 2, message: 'unfinished work', source: 'fake' }] : [])),
    },
  })
}

function handle(msg) {
  const p = msg.params ?? {}
  switch (msg.method) {
    case 'initialize':
      // Exercise a server→client request during startup.
      send({ jsonrpc: '2.0', id: 'cfg-1', method: 'workspace/configuration', params: { items: [] } })
      return send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { definitionProvider: true } } })
    case 'textDocument/didOpen':
      texts.set(p.textDocument.uri, p.textDocument.text)
      return publish(p.textDocument.uri)
    case 'textDocument/didChange':
      texts.set(p.textDocument.uri, p.contentChanges[0].text)
      return publish(p.textDocument.uri)
    case 'textDocument/definition':
      return send({ jsonrpc: '2.0', id: msg.id, result: [{ targetUri: p.textDocument.uri, targetRange: range(0, 0), targetSelectionRange: range(0, 3) }] })
    case 'textDocument/references':
      return send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: p.textDocument.uri, range: range(0, 3) }, { uri: p.textDocument.uri, range: range(p.position.line, p.position.character) }] })
    case 'textDocument/hover':
      return send({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'markdown', value: 'fn main()' } } })
    case 'textDocument/documentSymbol':
      return send({ jsonrpc: '2.0', id: msg.id, result: [{ name: 'main', kind: 12, range: range(0, 0), children: [{ name: 'inner', kind: 13, range: range(1, 2) }] }] })
    default:
      if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } })
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + length) return
    const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'))
    buffer = buffer.subarray(end + 4 + length)
    handle(msg)
  }
})
