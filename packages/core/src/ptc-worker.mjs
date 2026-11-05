import readline from 'node:readline'
import { stripTypeScriptTypes } from 'node:module'

const rl = readline.createInterface({ input: process.stdin })
const pending = new Map()
const logs = []
let subCalls = 0
let nextId = 0
let started = false

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

// `tools.readFile(...)`, `tools.search.grep(...)`: each property access extends
// the dotted SDK path; a call sends it to the host as one toolCall.
function sdk(path) {
  return new Proxy(function () {}, {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined
      return sdk(path ? `${path}.${name}` : name)
    },
    apply(_target, _this, [args]) {
      if (subCalls >= 200) return Promise.reject(new Error('too many tool sub-calls'))
      const id = ++nextId
      subCalls += 1
      send({ type: 'toolCall', id, name: path, args })
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
      })
    },
  })
}
const tools = sdk('')

const consoleProxy = {
  log: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
  error: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
  warn: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
  info: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
}

async function run(code) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  let js = code
  try {
    // Plain JavaScript: avoid the type stripper, which can misparse regexes and
    // template literals in otherwise valid scripts.
    new AsyncFunction('tools', 'console', js)
  } catch {
    try {
      js = stripTypeScriptTypes(code, { mode: 'strip' })
    } catch {
      // Let the original syntax error surface from AsyncFunction below.
    }
  }
  const fn = new AsyncFunction('tools', 'console', js)
  const value = await fn(tools, consoleProxy)
  send({ type: 'complete', value, logs, subCalls })
}

rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (!started && msg.type === 'run') {
    started = true
    run(String(msg.code ?? '')).catch((error) => {
      send({ type: 'error', error: error instanceof Error ? error.message : String(error), logs, subCalls })
    })
    return
  }
  if (msg.type === 'toolResult' && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    p.resolve(msg.result)
    return
  }
  if (msg.type === 'toolError' && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    p.reject(new Error(String(msg.error ?? 'tool failed')))
  }
})
