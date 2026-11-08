import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const core = await import(pathToFileURL(path.join(repo, 'packages/core/dist/index.js')).href)

for (const explicit of [false, true]) {
  test(`Python output is ${explicit ? 'explicitly configured' : 'UTF-8 by default'} in one-shot and persistent shells`, {
    skip: skipReason('pipe') ?? skipReason('sync'), timeout: 90_000, concurrency: false,
  }, async (t) => {
    if (spawnSync('python', ['--version'], { timeout: 10_000 }).status !== 0) return t.skip('Python is not installed')
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-exec-env-'))
    const ws = path.join(base, 'ws')
    fs.mkdirSync(ws)
    const previous = process.env.PYTHONIOENCODING
    // An ambient setting must not bypass the allowlist; explicit passthrough must win.
    process.env.PYTHONIOENCODING = 'ascii:backslashreplace'
    let client
    try {
      client = await core.ExecRpcClient.start(core.resolveServerPath(), {
        protocolVersion: 1, workspaceRoot: ws, stateDir: path.join(base, 'state'), sandbox: 'unconfined',
        extraWritableRoots: [], envPassthrough: explicit ? ['PYTHONIOENCODING'] : [], projectTrusted: false,
        protectedPaths: [], denyRead: [], readOnly: [],
      })
      const command = 'python -c "import sys; print(sys.stdout.encoding); print(chr(223)+chr(246)+chr(28450))"'
      const expected = explicit ? /ascii\r?\n\\xdf\\xf6\\u6f22/ : /utf-8\r?\nßö漢/i
      const direct = await client.exec({ command, mode: 'agent', foregroundWaitMs: 20_000, approval: { by: 'user', callId: 'utf8-test' } })
      assert.equal(direct.exitCode, 0, JSON.stringify(direct))
      assert.match(direct.stdout, expected)
      const opened = await client.shellOpen({ sandboxMode: 'unconfined' })
      assert.equal(opened.persistent, true, JSON.stringify(opened))
      await client.shellWrite(opened.shellId, command)
      const persistent = await client.shellRead(opened.shellId, 20_000)
      assert.equal(persistent.exitCode, 0, JSON.stringify(persistent))
      assert.match(persistent.data, expected)
    } finally {
      await client?.stop()
      if (previous === undefined) delete process.env.PYTHONIOENCODING
      else process.env.PYTHONIOENCODING = previous
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
}
