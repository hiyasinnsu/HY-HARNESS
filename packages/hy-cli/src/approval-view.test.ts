import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { alwaysRule, approvalKey, describeApproval, rememberAlways, splitCommand } from './approval-view.js'

test('CP-34: command splitting keeps quoted paths together', () => {
  assert.deepEqual(splitCommand('git commit -m "two words" C:\\a b'), ['git', 'commit', '-m', 'two words', 'C:\\a', 'b'])
  assert.deepEqual(splitCommand("echo '' x"), ['echo', '', 'x'])
})

test('CP-34: paths, hosts and the sandbox effect are read from the request', () => {
  const d = describeApproval(
    { command: 'curl -o out\\page.html https://example.com/a > log.txt', sandbox: 'workspace-write', cwd: 'C:\\ws\\sub' },
    'C:\\ws',
  )
  assert.equal(d.cwd, 'C:\\ws\\sub')
  assert.match(d.effect, /inside the workspace/)
  assert.deepEqual(d.paths, ['out\\page.html', 'log.txt'])
  assert.deepEqual(d.network, ['example.com'])
  assert.equal(d.persistable, true)

  const npm = describeApproval({ command: 'cmd /c npm install left-pad', sandbox: 'unconfined' }, 'C:\\ws')
  assert.equal(npm.cwd, 'C:\\ws', 'the workspace when the request has no cwd')
  assert.deepEqual(npm.network, ['registry.npmjs.org'])
  assert.match(npm.effect, /UNCONFINED/)
  assert.equal(npm.persistable, false)

  assert.deepEqual(describeApproval({ command: 'git push origin main', sandbox: 'read-only' }, 'C:\\ws').network, ['the git remote'])
  assert.deepEqual(describeApproval({ command: 'npm test', sandbox: 'workspace-write' }, 'C:\\ws').network, [])
})

test('CP-34: session keys ignore spacing but not the sandbox', () => {
  assert.equal(approvalKey({ command: 'npm  test ', sandbox: 'workspace-write' }), approvalKey({ command: 'npm test', sandbox: 'workspace-write' }))
  assert.notEqual(approvalKey({ command: 'npm test', sandbox: 'workspace-write' }), approvalKey({ command: 'npm test', sandbox: 'unconfined' }))
})

test('CP-34: "always" writes a checked allow rule, never for user-only sandboxes', () => {
  const when = new Date('2026-11-05T00:00:00Z')
  assert.equal(
    alwaysRule({ command: 'npm run "build all"', sandbox: 'workspace-write' }, when),
    '# Approved "always" from the HY-HARNESS GUI on 2026-11-05.\nprefix_rule(pattern = ["npm", "run", "build all"], decision = "allow", sandbox = "workspace-write", justification = "approved always by the user", match = ["npm run \\"build all\\""])\n',
  )
  assert.throws(() => alwaysRule({ command: 'rm -rf x', sandbox: 'unconfined' }), /cannot be remembered/)
  assert.throws(() => alwaysRule({ command: 'x', sandbox: 'low-integrity' }), /cannot be remembered/)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-always-'))
  try {
    const file = path.join(dir, 'nested', 'policy.star')
    rememberAlways(file, { command: 'npm test', sandbox: 'workspace-write' }, when)
    rememberAlways(file, { command: 'cargo test', sandbox: 'read-only' }, when)
    const text = fs.readFileSync(file, 'utf8')
    assert.equal((text.match(/prefix_rule\(/g) ?? []).length, 2)
    assert.match(text, /pattern = \["cargo", "test"\]/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
