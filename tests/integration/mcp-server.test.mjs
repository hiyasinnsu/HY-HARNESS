// hy mcp-server: another MCP client drives HY-HARNESS through hy_run, and a
// second call with the returned runId continues the same conversation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')
const { McpManager } = await import(pathToFileURL(path.join(repo, 'packages', 'core', 'dist', 'index.js')).href)

test('hy mcp-server serves hy_run and continues a run by id', { skip: skipReason('pipe') }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-mcpsrv-'))
  const mcp = await McpManager.start({ hy: { command: process.execPath, args: [cli, 'mcp-server', '--mock', '--cwd', ws], trusted: true } })
  try {
    assert.deepEqual(mcp.errors, [])
    assert.deepEqual(mcp.tools.map((t) => t.name), ['hy_run'])
    const first = await mcp.call('hy', 'hy_run', { prompt: 'SAY hello from mcp' })
    assert.equal(first.isError, false)
    assert.equal(first.text, 'hello from mcp')
    const runId = first.structured.runId
    assert.match(runId, /^run-/)
    const second = await mcp.call('hy', 'hy_run', { prompt: 'REPEAT FIRST', runId })
    assert.equal(second.text, 'first: SAY hello from mcp')
    const bad = await mcp.call('hy', 'hy_run', { nope: 1 }).catch((e) => e)
    assert.match(String(bad), /hy_run needs a string prompt/)
  } finally {
    mcp.close()
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 3 })
  }
})

// The MCP handshake must report the harness version, not a literal.
test('hy mcp-server reports the harness version in serverInfo', { skip: skipReason('pipe') }, async () => {
  const { spawn } = await import('node:child_process')
  const { HARNESS_VERSION } = await import(pathToFileURL(path.join(repo, 'packages', 'core', 'dist', 'index.js')).href)
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-mcpver-'))
  const child = spawn(process.execPath, [cli, 'mcp-server', '--mock', '--cwd', ws], { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    const line = await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('no MCP response')), 30_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        const index = buffer.indexOf('\n')
        if (index >= 0) {
          clearTimeout(timer)
          resolve(buffer.slice(0, index))
        }
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n',
      )
    })
    const response = JSON.parse(line)
    assert.equal(response.result.serverInfo.version, HARNESS_VERSION)
    assert.equal(response.result.protocolVersion, '2025-06-18')
  } finally {
    child.kill()
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 3 })
  }
})
