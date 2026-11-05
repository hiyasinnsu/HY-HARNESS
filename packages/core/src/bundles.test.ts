import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUNDLES, resolveBundles } from './bundles.js'

test('core is always included, once, and adds no tool restriction', () => {
  const none = resolveBundles([])
  assert.deepEqual(none.names, ['core'])
  // `core` means "whatever the host's configuration offers": no allowlist.
  assert.equal(none.tools, undefined)
  // Repeating a name does not duplicate it.
  assert.deepEqual(resolveBundles(['minimal', 'minimal']).names, ['core', 'minimal'])
})

test('minimal narrows the tool set to three reading tools', () => {
  const minimal = resolveBundles(['minimal'])
  assert.deepEqual([...minimal.tools!].sort(), ['read_file', 'search_glob', 'search_grep'])
  assert.equal(minimal.prompts.length, 1)
  assert.match(minimal.prompts[0]!, /read-only/)
})

test('bundles only ever take tools away', () => {
  // audit lists web tools minimal does not have; the intersection keeps the
  // reading tools only, so combining bundles can never add a tool.
  const combined = resolveBundles(['minimal', 'audit'])
  assert.deepEqual([...combined.tools!].sort(), ['read_file', 'search_glob', 'search_grep'])
  assert.equal(combined.tools!.has('web_fetch'), false)
  // worker narrows to the core tool set (the default host set stays as it is).
  const worker = resolveBundles(['worker'])
  assert.ok(worker.tools!.has('apply_patch'))
  assert.equal(worker.tools!.has('run_code'), false)
})

test('an unknown bundle is an error instead of a silent widening', () => {
  assert.throws(() => resolveBundles(['nope']), /unknown bundle nope; available: /)
})

test('prompts, panels and role defaults are merged in order', () => {
  const resolved = resolveBundles(['ptc', 'worker'])
  assert.deepEqual(resolved.names, ['core', 'ptc', 'worker'])
  assert.equal(resolved.prompts.length, 1)
  assert.match(resolved.prompts[0]!, /run_code/)
  assert.ok(resolved.panels.includes('trace'))
  assert.deepEqual(resolved.commands, ['/help', '/model', '/plan'])
  assert.deepEqual(resolved.roleDefaults, {})
})

test('custom bundles can be layered on the built-ins', () => {
  const resolved = resolveBundles(['custom'], {
    custom: { name: 'custom', description: 'test bundle', allowTools: ['read_file'], prompt: 'Custom instruction.', roleDefaults: { maxOutputTokens: 1_234 } },
  })
  assert.deepEqual([...resolved.tools!], ['read_file'])
  assert.equal(resolved.roleDefaults.maxOutputTokens, 1_234)
  assert.ok(resolved.prompts.includes('Custom instruction.'))
})

test('the built-in bundles are well formed', () => {
  for (const bundle of Object.values(BUNDLES)) {
    assert.equal(bundle.name.length > 0, true)
    assert.ok(bundle.description.length > 0)
    for (const tool of bundle.allowTools ?? []) assert.ok(tool.length > 0)
  }
})
