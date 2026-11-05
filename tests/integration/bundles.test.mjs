// WP-42: bundles over the CLI. `minimal` narrows the tool set to three, the
// resolution shows up in `hy config dump`, and `--profile` still applies its
// own bundles.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-bundle-it-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Bundle fixture\n\nA repository for the bundle test.\n', 'utf8')
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  return dir
}

function run(args, dir) {
  return spawnSync(process.execPath, [cli, ...args, '--cwd', dir], {
    encoding: 'utf8',
    env: { ...process.env, HY_CONFIG_DIR: path.join(dir, 'config'), LOCALAPPDATA: path.join(dir, 'localappdata') },
    timeout: 120_000,
  })
}

test('hy config dump shows the resolved bundle and its three tools', { timeout: 60_000, concurrency: false }, () => {
  const dir = fixture()
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    const dump = run(['config', 'dump', '--mock', '--bundle', 'minimal'], dir)
    assert.equal(dump.status, 0, dump.stderr)
    const parsed = JSON.parse(dump.stdout)
    assert.deepEqual(parsed.bundles.names, ['core', 'minimal'])
    assert.deepEqual(parsed.bundles.tools, ['read_file', 'search_glob', 'search_grep'])
    assert.ok(parsed.bundles.prompts[0].includes('read-only'))
    // Without a bundle flag there is no allowlist: the host tool set applies.
    const plain = JSON.parse(run(['config', 'dump', '--mock'], dir).stdout)
    assert.deepEqual(plain.bundles.names, ['core'])
    assert.equal(plain.bundles.tools, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hy run --bundle minimal cannot write and says why', { timeout: 180_000, concurrency: false }, () => {
  const dir = fixture()
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    const result = run(['run', 'Create the demo file', '--mock', '--yes', '--json', '--bundle', 'minimal'], dir)
    assert.equal(result.status, 0, result.stderr.slice(-800))
    // The refusal names the bundle, and no file was created.
    assert.match(result.stdout, /not allowed here \(this session's bundles: core, minimal\)/)
    assert.equal(fs.existsSync(path.join(dir, 'HY_DEMO.md')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
