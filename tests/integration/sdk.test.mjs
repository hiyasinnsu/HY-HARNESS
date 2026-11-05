// WP-51: the SDK server (`hy serve --sdk`) driven by the TypeScript client, and
// the Python package's example run against the same server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')
const { HarnessClient } = await import(pathToFileURL(path.join(repo, 'packages', 'sdk', 'dist', 'index.js')).href)

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-sdk-it-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# SDK fixture\n\nA repository for the SDK test.\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  return dir
}

const env = (dir) => ({ HY_CONFIG_DIR: path.join(dir, 'config'), LOCALAPPDATA: path.join(dir, 'localappdata') })

test('the SDK client runs a prompt, streams events and cancels', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 180_000, concurrency: false }, async () => {
  const dir = fixture()
  const client = new HarnessClient({
    cli,
    cwd: dir,
    args: ['--mock', '--yes'],
    env: env(dir),
    node: process.execPath,
  })
  try {
    const info = await client.start()
    assert.equal(info.name, 'HY-HARNESS')
    assert.equal(info.protocolVersion, 1)
    assert.equal(info.capabilities.streaming, true)

    const session = await client.createSession()
    assert.match(session, /^sdk-/)

    const events = []
    const statuses = []
    const off = client.onStatus((status) => statuses.push(status))
    const result = await client.prompt(session, 'CALL read_file {"path":"README.md"}', {
      onEvent: (event) => events.push(event),
    })
    off()
    assert.match(result.final, /called:|TOOL RESULT/)
    assert.ok(events.some((event) => event.type === 'tool-start' && event.name === 'read_file'), JSON.stringify(events.map((e) => e.type)))
    assert.ok(events.some((event) => event.type === 'tool'))
    assert.ok(statuses.some((status) => status.busy === true))
    assert.ok(statuses.some((status) => status.busy === false))

    // A resumed session keeps its turns.
    const resumed = await client.resumeSession(session)
    assert.equal(resumed.sessionId, session)
    assert.ok(resumed.turns >= 1)

    // Cancelling a slow command ends the prompt with an error, not a hang.
    const started = client.prompt(session, 'CALL shell {"command":"Start-Sleep -Seconds 20"}')
    await new Promise((resolve) => setTimeout(resolve, 500))
    await client.cancel(session)
    await assert.rejects(started, /cancelled/i)

    await client.closeSession(session)
    // An unknown session is a clear error.
    await assert.rejects(client.prompt('sdk-nope', 'hello'), /unknown session/)
  } finally {
    await client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the Python package runs an example against the SDK server', { timeout: 180_000, concurrency: false }, () => {
  const python = spawnSync('python', ['--version'], { encoding: 'utf8' })
  if (python.status !== 0) {
    console.log('python is not available; skipping the example')
    return
  }
  const dir = fixture()
  try {
    const run = spawnSync(
      'python',
      [path.join(repo, 'python', 'examples', 'run.py'), '--cli', cli, '--cwd', dir, '--mock', '--yes', 'SAY hello from python'],
      { encoding: 'utf8', env: { ...process.env, ...env(dir) }, timeout: 120_000 },
    )
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.match(run.stdout, /server: HY-HARNESS/)
    assert.match(run.stdout, /final: hello from python/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
