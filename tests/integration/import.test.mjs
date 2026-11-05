// CP-31: `hy import` on the command line and through the GUI wizard's API.
// HY_IMPORT_HOME points the importer at a fake home, never the real one.
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
const { startWebServer } = await import(pathToFileURL(path.join(repo, 'packages', 'hy-cli', 'dist', 'web-server.js')).href)

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-import-it-'))
  const ws = path.join(base, 'ws')
  const home = path.join(base, 'home')
  const user = path.join(base, 'user')
  for (const d of [ws, home, user]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# From Claude\n\nRun the tests.\n')
  fs.writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' } } }))
  fs.mkdirSync(path.join(ws, '.claude', 'commands'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.claude', 'commands', 'ship.md'), 'Ship $ARGUMENTS\n')
  spawnSync('git', ['init', '-q'], { cwd: ws })
  const env = { ...process.env, HY_CONFIG_DIR: user, HY_IMPORT_HOME: home, LOCALAPPDATA: path.join(base, 'local') }
  return { base, ws, home, user, env }
}

test('CP-31: hy import shows the plan, writes nothing without --yes, then applies with --yes', { skip: skipReason('sync'), timeout: 120_000, concurrency: false }, () => {
  const f = fixture()
  try {
    const dry = spawnSync(process.execPath, [cli, 'import', 'claude', '--cwd', f.ws, '--mock'], { encoding: 'utf8', env: f.env, input: '', timeout: 60_000 })
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /\[create\] agents: create AGENTS\.md/)
    assert.match(dry.stdout, /\+ # From Claude/)
    assert.match(dry.stdout, /nothing written \(pass --yes to apply\)/)
    assert.equal(fs.existsSync(path.join(f.ws, 'AGENTS.md')), false)

    const json = spawnSync(process.execPath, [cli, 'import', 'claude', '--cwd', f.ws, '--mock', '--json'], { encoding: 'utf8', env: f.env, timeout: 60_000 })
    const plan = JSON.parse(json.stdout)
    assert.deepEqual(plan.items.map((i) => i.kind).sort(), ['agents', 'mcp', 'prompts'])

    const only = spawnSync(process.execPath, [cli, 'import', 'claude', '--cwd', f.ws, '--mock', '--yes', '--only', 'agents'], { encoding: 'utf8', env: f.env, timeout: 60_000 })
    assert.equal(only.status, 0, only.stderr)
    assert.ok(fs.existsSync(path.join(f.ws, 'AGENTS.md')))
    assert.equal(fs.existsSync(path.join(f.ws, '.hy-harness', 'prompts', 'ship.md')), false, '--only limits the kinds')

    const rest = spawnSync(process.execPath, [cli, 'import', 'claude', '--cwd', f.ws, '--mock', '--yes'], { encoding: 'utf8', env: f.env, timeout: 60_000 })
    assert.equal(rest.status, 0, rest.stderr)
    assert.ok(fs.existsSync(path.join(f.ws, '.hy-harness', 'prompts', 'ship.md')))
    const again = spawnSync(process.execPath, [cli, 'import', 'claude', '--cwd', f.ws, '--mock'], { encoding: 'utf8', env: f.env, timeout: 60_000 })
    assert.match(again.stdout, /nothing to write/)
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('CP-31: the GUI wizard API plans with diffs and applies only the ticked kinds', { skip: skipReason('pipe') ?? skipReason('sync'), timeout: 120_000, concurrency: false }, async () => {
  const f = fixture()
  const saved = { HY_CONFIG_DIR: process.env.HY_CONFIG_DIR, HY_IMPORT_HOME: process.env.HY_IMPORT_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA }
  Object.assign(process.env, { HY_CONFIG_DIR: f.user, HY_IMPORT_HOME: f.home, LOCALAPPDATA: path.join(f.base, 'local') })
  let handle
  try {
    handle = await startWebServer({ overrides: { cwd: f.ws, mock: true }, port: 0, open: false, log: () => {} })
    const base = new URL(handle.url).origin
    const headers = { Authorization: `Bearer ${handle.token}`, 'content-type': 'application/json' }
    const bad = await fetch(`${base}/api/import?source=nope`, { headers })
    assert.equal(bad.status, 400)
    const plan = await (await fetch(`${base}/api/import?source=claude`, { headers })).json()
    const agents = plan.items.find((i) => i.kind === 'agents')
    assert.equal(agents.action, 'create')
    assert.match(agents.diff, /\+ # From Claude/)
    const applied = await fetch(`${base}/api/import`, { method: 'POST', headers, body: JSON.stringify({ source: 'claude', kinds: ['mcp'] }) })
    assert.equal(applied.status, 200, await applied.clone().text())
    const result = await applied.json()
    assert.equal(result.written.length, 1)
    assert.ok(fs.existsSync(path.join(f.ws, '.hy-harness', 'config.json')))
    assert.equal(fs.existsSync(path.join(f.ws, 'AGENTS.md')), false, 'unticked kinds are not written')
    const dsh = await (await fetch(`${base}/api/import?source=dsh`, { headers })).json()
    assert.deepEqual(dsh.items, [], 'no DSH sessions in the fake home')
  } finally {
    await handle?.close()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(f.base, { recursive: true, force: true, maxRetries: 3 })
  }
})
