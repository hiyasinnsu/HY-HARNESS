#!/usr/bin/env node
// Minimal MCP server for vercel-labs/agent-desktop (Apache-2.0).
// Each tool call invokes the native CLI and returns its JSON envelope. The
// harness treats every call as requiring user approval; this wrapper is not a
// security boundary.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const defaultBin = path.join(repoRoot, 'node_modules', 'agent-desktop', 'bin', 'agent-desktop')
const bin = process.env.AGENT_DESKTOP_BIN ?? defaultBin
const session = process.env.AGENT_DESKTOP_SESSION ?? 'hy-harness'

const tools = [
  {
    name: 'desktop_list_apps',
    description: 'List running desktop applications (accessibility apps). Output can contain private desktop information.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'desktop_list_windows',
    description: 'List visible windows, optionally filtered by application name.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: [] },
  },
  {
    name: 'desktop_snapshot',
    description: 'Capture an application accessibility tree with @ref IDs. Use the refs with desktop_click/type/set_value. Prefer interactive-only output.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Application name from desktop_list_apps.' },
        interactiveOnly: { type: 'boolean', description: 'Only interactive elements (default true).' },
        compact: { type: 'boolean', description: 'Collapse unnamed single-child nodes.' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 30 },
        includeBounds: { type: 'boolean' },
      },
      required: ['app'],
    },
  },
  {
    name: 'desktop_click',
    description: 'Click an element by a ref from desktop_snapshot.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  },
  {
    name: 'desktop_type',
    description: 'Insert text into an element by a ref from desktop_snapshot.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'] },
  },
  {
    name: 'desktop_set_value',
    description: 'Set an element value directly by a ref from desktop_snapshot.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, value: { type: 'string' } }, required: ['ref', 'value'] },
  },
  {
    name: 'desktop_press',
    description: 'Send a key combination (for example return, escape, ctrl+c) to an app.',
    inputSchema: { type: 'object', properties: { combo: { type: 'string' }, app: { type: 'string' } }, required: ['combo'] },
  },
  {
    name: 'desktop_scroll',
    description: 'Scroll an element by a ref.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', minimum: 1 } },
      required: ['ref'],
    },
  },
  {
    name: 'desktop_focus_window',
    description: 'Bring an application window to the foreground.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
  },
]

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function runAgent(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(bin)) {
      reject(new Error(`agent-desktop is not installed at ${bin}; install agent-desktop (Apache-2.0) first`))
      return
    }
    const child = spawn(process.execPath, [bin, ...args, '--session', session], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`agent-desktop timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = stdout.trim()
      if (!text) {
        reject(new Error(`agent-desktop exited ${code}: ${stderr.trim().slice(0, 1000)}`))
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error(`agent-desktop returned non-JSON output: ${text.slice(0, 1000)}`))
      }
    })
  })
}

function requireRef(value) {
  if (typeof value !== 'string' || !/^@[^:]+:e\d+$/.test(value)) throw new Error('ref must look like @<snapshot_id>:eN from desktop_snapshot')
  return value
}

async function callTool(name, args) {
  const a = args && typeof args === 'object' ? args : {}
  switch (name) {
    case 'desktop_list_apps':
      return runAgent(['list-apps'])
    case 'desktop_list_windows':
      return runAgent(['list-windows', ...(typeof a.app === 'string' && a.app ? ['--app', a.app] : [])])
    case 'desktop_snapshot': {
      if (typeof a.app !== 'string' || !a.app) throw new Error('app is required')
      const opts = ['snapshot', '--app', a.app]
      if (a.interactiveOnly !== false) opts.push('--interactive-only')
      if (a.compact === true) opts.push('--compact')
      if (Number.isInteger(a.maxDepth)) opts.push('--max-depth', String(a.maxDepth))
      if (a.includeBounds === true) opts.push('--include-bounds')
      return runAgent(opts)
    }
    case 'desktop_click':
      return runAgent(['click', requireRef(a.ref)])
    case 'desktop_type':
      return runAgent(['type', requireRef(a.ref), String(a.text ?? '')])
    case 'desktop_set_value':
      return runAgent(['set-value', requireRef(a.ref), String(a.value ?? '')])
    case 'desktop_press':
      return runAgent(['press', String(a.combo ?? ''), ...(typeof a.app === 'string' && a.app ? ['--app', a.app] : [])])
    case 'desktop_scroll': {
      const direction = ['up', 'down', 'left', 'right'].includes(a.direction) ? a.direction : 'down'
      const amount = Number.isInteger(a.amount) ? String(a.amount) : '1'
      return runAgent(['scroll', requireRef(a.ref), '--direction', direction, '--amount', amount])
    }
    case 'desktop_focus_window':
      return runAgent(['focus-window', '--app', String(a.app ?? '')])
    default:
      throw new Error(`unknown tool ${name}`)
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  if (message.id === undefined) return
  const id = message.id
  const method = message.method
  if (method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: String(message.params?.protocolVersion ?? '2025-06-18'),
        capabilities: { tools: {} },
        serverInfo: { name: 'hy-agent-desktop', version: '0.1.0' },
      },
    })
    return
  }
  if (method === 'ping') {
    write({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools } })
    return
  }
  if (method === 'tools/call') {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    void callTool(name, args)
      .then((envelope) => {
        const text = JSON.stringify(envelope, null, 2)
        write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: envelope?.ok === false } })
      })
      .catch((error) => {
        write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true } })
      })
    return
  }
  write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(method)}` } })
})
