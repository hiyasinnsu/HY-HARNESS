import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

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
