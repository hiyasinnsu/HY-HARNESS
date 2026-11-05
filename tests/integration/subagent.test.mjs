// delegate: a subagent answers a subtask; a read-only subagent cannot write;
// subagent runs are not listed as their own sessions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')

test('delegate runs a subagent; read-only subagents cannot write', { skip: skipReason('sync') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-sub-'))
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Sub\n')
    spawnSync('git', ['init', '-q'], { cwd: dir })
    const r = spawnSync(
      process.execPath,
      [cli, 'chat', '--mock', '--cwd', dir, '--json'],
      { cwd: repo, encoding: 'utf8', input: 'DELEGATE SAY child done\nDELEGATE Create the demo file\n/exit\n' },
    )
    assert.equal(r.status, 0, r.stderr)
    const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l))
    const finals = events.filter((e) => e.type === 'turn/final').map((e) => e.content)
    assert.match(finals[0], /"final": "child done"/)
    // The refused write comes back to the subagent, which reports instead of writing.
    assert.match(finals[1], /TOOL RESULT \(delegate\):.*"final": "plan: write HY_DEMO\.md after approval"/)
    const refused = events.filter((e) => e.type === 'tool-error' && e.subagent)
    assert.ok(refused.length > 0 && refused.every((e) => /apply_patch is not allowed in this read-only session/.test(e.message)))
    assert.ok(!fs.existsSync(path.join(dir, 'HY_DEMO.md')), 'the read-only subagent wrote nothing')
    const runs = JSON.parse(spawnSync(process.execPath, [cli, 'sessions', '--cwd', dir, '--json'], { encoding: 'utf8' }).stdout)
    assert.equal(runs.length, 1, 'subagent runs belong to the parent')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
