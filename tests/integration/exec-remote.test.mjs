// CP-28: the exec server as a separate process over WebSocket.
//
// Acceptance (docs/codex-adoption-plan.md): a client connects to an exec
// server in another process and runs a command; without the token it is
// refused; a non-loopback address needs --allow-remote.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const core = await import(pathToFileURL(path.join(repo, 'packages', 'core', 'dist', 'index.js')).href)
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')
const skip = skipReason('pipe') ?? skipReason('sync')

function startServer(args) {
  const child = spawn(core.resolveServerPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const url = new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      const line = out.split('\n').find((l) => l.includes('listening'))
      if (line) resolve(JSON.parse(line).listening)
    })
    child.once('exit', (code) => reject(new Error(`exec server exited ${code}`)))
  })
  return { child, url }
}

function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-exec-remote-'))
  const ws = path.join(base, 'ws')
  fs.mkdirSync(ws)
  fs.writeFileSync(path.join(ws, 'README.md'), '# remote\n')
  spawnSync('git', ['init', '-q'], { cwd: ws })
  return { base, ws }
}

const init = (f) => ({
  protocolVersion: 1,
  workspaceRoot: f.ws,
  stateDir: path.join(f.base, 'state'),
  sandbox: 'unconfined',
  extraWritableRoots: [],
  envPassthrough: [],
  projectTrusted: false,
  protectedPaths: [],
})

test('CP-28: a remote exec server runs commands for a client with the token, and refuses one without', { skip, timeout: 120_000, concurrency: false }, async () => {
  const f = workspace()
  const server = startServer(['--listen', 'ws://127.0.0.1:0', '--token', 'sekrit'])
  try {
    const url = await server.url
    assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+$/)
    await assert.rejects(core.ExecRpcClient.connect(url, 'wrong', init(f)), /could not connect/)
    const client = await core.ExecRpcClient.connect(url, 'sekrit', init(f))
    try {
      const r = await client.exec({ command: 'echo remote-ok', mode: 'agent', sandboxMode: 'unconfined', approval: { by: 'user', callId: 'it' } })
      assert.equal(r.exitCode, 0, `${r.stdout}${r.stderr}`)
      assert.match(r.stdout, /remote-ok/)
    } finally {
      await client.stop()
    }
    // The server serves one client and exits when it leaves.
    await new Promise((resolve) => (server.child.exitCode !== null ? resolve() : server.child.once('exit', resolve)))
  } finally {
    server.child.kill()
    fs.rmSync(f.base, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('CP-28: listening needs a token, and anything but loopback needs --allow-remote', { skip, timeout: 60_000, concurrency: false }, () => {
  const noToken = spawnSync(core.resolveServerPath(), ['--listen', 'ws://127.0.0.1:0'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, HY_EXEC_TOKEN: '' } })
  assert.notEqual(noToken.status, 0)
  assert.match(noToken.stderr, /needs a token/)
  const remote = spawnSync(core.resolveServerPath(), ['--listen', 'ws://0.0.0.0:0', '--token', 't'], { encoding: 'utf8', timeout: 20_000 })
  assert.notEqual(remote.status, 0)
  assert.match(remote.stderr, /--allow-remote/)
})

test('CP-28: hy run uses the remote exec server named by HY_EXEC_URL', { skip, timeout: 120_000, concurrency: false }, async () => {
  const f = workspace()
  const server = startServer(['--listen', 'ws://127.0.0.1:0', '--token', 'run-token'])
  try {
    const url = await server.url
    const run = spawnSync(process.execPath, [cli, 'run', 'SAY through the remote server', '--cwd', f.ws, '--mock', '--state-dir', path.join(f.base, 'state')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HY_EXEC_URL: url, HY_EXEC_TOKEN: 'run-token', HY_SANDBOX: 'unconfined', HY_CONFIG_DIR: path.join(f.base, 'user') },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /through the remote server/)
  } finally {
    server.child.kill()
    fs.rmSync(f.base, { recursive: true, force: true, maxRetries: 3 })
  }
})
