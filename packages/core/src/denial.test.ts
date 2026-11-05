import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDenial, denialLabel } from './denial.js'

test('CP-06: denial messages are classified by mechanism', () => {
  assert.deepEqual(classifyDenial('command denied by policy'), { kind: 'policy', detail: 'denied by policy' })
  assert.deepEqual(classifyDenial('command requires approval'), { kind: 'approval', detail: 'requires approval' })
  assert.deepEqual(classifyDenial('command not approved: rm -rf (user: too risky)'), {
    kind: 'approval',
    detail: 'not approved',
  })
  assert.equal(classifyDenial('read-only sandbox forbids file writes')?.kind, 'sandbox')
  assert.equal(classifyDenial('failed to write: ACCESS_DENIED')?.kind, 'sandbox')
  assert.equal(classifyDenial('spawn EACCES')?.kind, 'sandbox')
  assert.equal(classifyDenial('edit protectedPaths: package.json')?.kind, 'protected')
  assert.equal(classifyDenial('connect ECONNREFUSED 127.0.0.1:11434')?.kind, 'network')
})

test('CP-06: ordinary errors are not denials', () => {
  for (const message of [
    'ENOENT: no such file or directory',
    'invalid arguments for shell: args.command is required',
    'the file was too large',
    '',
  ]) {
    assert.equal(classifyDenial(message), undefined, message)
  }
  assert.equal(denialLabel({ kind: 'sandbox', detail: 'x' }), 'blocked: sandbox')
})