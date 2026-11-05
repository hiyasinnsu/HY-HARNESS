import { spawn, spawnSync } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-smoke-'))
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-state-'))
fs.writeFileSync(path.join(root, 'hello.txt'), 'hello\n')
spawnSync('git', ['init', '-q'], { cwd: root })

const child = spawn('F:/HY-HARNESS/target/debug/hy-exec-server.exe', [], {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
})
let nextId = 0
const pending = new Map()
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id)
    pending.delete(msg.id)
    resolve(msg)
  } else {
    console.log('SERVER', JSON.stringify(msg))
  }
})
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }
    }, 30000)
  })
}
function check(msg, label) {
  if (msg.error) throw new Error(`${label}: ${JSON.stringify(msg.error)}`)
  console.log(`${label}: OK`)
  return msg.result
}

try {
  console.log('workspace:', root)
  const init = check(await request('initialize', {
    protocolVersion: 1,
    workspaceRoot: root,
    stateDir: state,
    sandbox: 'unconfined',
    envPassthrough: [],
  }), 'initialize')
  console.log(JSON.stringify(init))

  const exec = check(await request('exec/command', {
    command: 'git --version',
    mode: 'agent',
    foregroundWaitMs: 10000,
    approval: { by: 'policy', callId: 'smoke' },
  }), 'exec')
  console.log('exec:', JSON.stringify(exec))

  const patch = `--- /dev/null\n+++ b/created.txt\n@@ -0,0 +1,2 @@\n+created by hy\n+second line\n`
  const applied = check(await request('patch/apply', { patch }), 'patch')
  console.log('patch:', JSON.stringify(applied))
  console.log('file:', JSON.stringify(fs.readFileSync(path.join(root, 'created.txt'), 'utf8')))

  const ckpt = check(await request('checkpoint/create', { runId: 'smoke', label: 'base' }), 'checkpoint')
  console.log('checkpoint:', JSON.stringify(ckpt))
  fs.writeFileSync(path.join(root, 'created.txt'), 'changed\n')
  fs.writeFileSync(path.join(root, 'new.txt'), 'new\n')
  const rb = check(await request('checkpoint/rollback', { runId: 'smoke', label: 'base' }), 'rollback')
  console.log('rollback:', JSON.stringify(rb))
  console.log('restored:', JSON.stringify(fs.readFileSync(path.join(root, 'created.txt'), 'utf8')))
  console.log('new exists:', fs.existsSync(path.join(root, 'new.txt')))

  check(await request('shutdown', {}), 'shutdown')
  child.stdin.end()
  await new Promise((r) => child.once('exit', r))
  console.log('DONE')
} catch (e) {
  console.error('FAILED', e)
  child.kill()
  process.exitCode = 1
}
