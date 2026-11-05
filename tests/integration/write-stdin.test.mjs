import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason, tmpRoot } from './capability.mjs'

// CP-09: a job started with `stdinPipe` accepts `job/write` and its output is
// readable while it runs. The program under test is a Node one-liner that
// prints GOT:<line> after reading one line from stdin.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const core = await import(pathToFileURL(path.join(repo, 'packages', 'core', 'dist', 'index.js')).href)

const skip = skipReason('sync')

test('CP-09: stdinPipe jobs accept input and stream output', { skip, timeout: 120_000, concurrency: false }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-stdin-it-'))
  const ws = path.join(base, 'ws')
  fs.mkdirSync(ws)
  fs.writeFileSync(path.join(ws, 'README.md'), '# fixture\n')
  spawnSync('git', ['init', '-q'], { cwd: ws })
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: ws })
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws })
  const client = await core.ExecRpcClient.start(core.resolveServerPath(), {
    protocolVersion: 1,
    workspaceRoot: ws,
    stateDir: path.join(base, 'state'),
    sandbox: 'unconfined',
    extraWritableRoots: [],
    envPassthrough: [],
    projectTrusted: false,
    protectedPaths: [],
    denyRead: [],
    readOnly: [],
  })
  try {
    const code = 'process.stdin.once("data", (d) => { console.log("GOT:" + d.toString().trim()); process.exit(0) })'
    const started = await client.exec({
      command: `node -e '${code}'`,
      mode: 'agent',
      stdinPipe: true,
      foregroundWaitMs: 300,
      hardTimeoutMs: 60_000,
    })
    assert.equal(started.status, 'backgrounded', JSON.stringify(started))
    assert.ok(started.jobId, 'a stdinPipe job is backgrounded so it can be fed')

    const written = await client.jobWrite(started.jobId, 'hello\r\n')
    assert.equal(written.written, 7)

    let output = ''
    for (let i = 0; i < 50 && !output.includes('GOT:hello'); i++) {
      const page = await client.jobOutput(started.jobId, output.length)
      output += page.data
      if (output.includes('GOT:hello')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.match(output, /GOT:hello/, output)
  } finally {
    await client.stop()
    fs.rmSync(base, { recursive: true, force: true })
  }
})

for (const sandbox of ['unconfined', 'workspace-write']) {
  test(`CP-09: a tty job runs in a pseudo console (${sandbox}); input reaches it and escapes are stripped`, { skip, timeout: 120_000, concurrency: false }, async () => {
    const base = fs.mkdtempSync(path.join(tmpRoot(), 'tty-'))
    const ws = path.join(base, 'ws')
    fs.mkdirSync(ws)
    fs.writeFileSync(path.join(ws, 'README.md'), '# fixture\n')
    spawnSync('git', ['init', '-q'], { cwd: ws })
    const client = await core.ExecRpcClient.start(core.resolveServerPath(), {
      protocolVersion: 1,
      workspaceRoot: fs.realpathSync.native(ws),
      stateDir: path.join(base, 'state'),
      sandbox,
      extraWritableRoots: [],
      envPassthrough: [],
      projectTrusted: false,
      protectedPaths: [],
      denyRead: [],
      readOnly: [],
    })
    try {
      const status = await client.sandboxStatus()
      if (sandbox !== 'unconfined' && !status.workspaceWriteAvailable) return
      const code = 'console.log(process.stdout.isTTY ? "IS-TTY" : "NO-TTY"); process.stdin.once("data", (d) => { console.log("GOT:" + d.toString().trim()); process.exit(0) })'
      const started = await client.exec({ command: `node -e '${code}'`, mode: 'agent', tty: true, sandboxMode: sandbox, foregroundWaitMs: 300, hardTimeoutMs: 60_000, approval: { by: 'user', callId: 'it' } })
      assert.equal(started.status, 'backgrounded', JSON.stringify(started))
      let output = ''
      const read = async (needle) => {
        for (let i = 0; i < 100 && !output.includes(needle); i++) {
          const page = await client.jobOutput(started.jobId, output.length)
          output += page.data
          if (!output.includes(needle)) await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      await read('IS-TTY')
      assert.match(output, /IS-TTY/, output)
      await client.jobWrite(started.jobId, 'hello\r')
      await read('GOT:hello')
      assert.match(output, /GOT:hello/, output)
      assert.doesNotMatch(output, /\x1b/, 'no escape sequences reach the model')
      const done = await client.jobWait(started.jobId, 20_000)
      assert.equal(done.state, 'exited', JSON.stringify(done))
    } finally {
      await client.sandboxRevoke().catch(() => undefined)
      await client.stop()
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
    }
  })
}
