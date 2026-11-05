import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isIgnored, parseGitignore } from './gitignore.js'

const rules = parseGitignore(
  [
    '# comment',
    '',
    '/target/',
    'node_modules/',
    'dist/',
    '*.log',
    '!keep.log',
    '/.refs/',
    'docs/**/draft-*.md',
    'build?/',
    '*.tsbuildinfo',
    'cache[0-9]',
  ].join('\n'),
)

test('anchored, unanchored and directory-only patterns', () => {
  assert.equal(isIgnored(rules, 'target', true), true)
  assert.equal(isIgnored(rules, 'crates/x/target', true), false, '/target/ is anchored to the root')
  assert.equal(isIgnored(rules, 'packages/core/dist', true), true, 'dist/ matches at any depth')
  assert.equal(isIgnored(rules, 'dist', false), false, 'a trailing slash matches directories only')
  assert.equal(isIgnored(rules, '.refs', true), true)
  assert.equal(isIgnored(rules, 'build1', true), true)
  assert.equal(isIgnored(rules, 'cache7', false), true)
  assert.equal(isIgnored(rules, 'cacheX', false), false)
})

test('wildcards, ** and negation; the last matching rule wins', () => {
  assert.equal(isIgnored(rules, 'm2-integration.log', false), true)
  assert.equal(isIgnored(rules, 'logs/a/b.log', false), true)
  assert.equal(isIgnored(rules, 'keep.log', false), false)
  assert.equal(isIgnored(rules, 'docs/draft-x.md', false), true)
  assert.equal(isIgnored(rules, 'docs/a/b/draft-x.md', false), true)
  assert.equal(isIgnored(rules, 'docs/final.md', false), false)
  assert.equal(isIgnored(rules, 'packages/core/tsconfig.tsbuildinfo', false), true)
  assert.equal(isIgnored(rules, 'README.md', false), false)
})

test('a nested .gitignore applies only below its own directory', () => {
  const nested = [...rules, ...parseGitignore('*.tmp\n/local/\n', 'packages/a')]
  assert.equal(isIgnored(nested, 'packages/a/x.tmp', false), true)
  assert.equal(isIgnored(nested, 'packages/a/deep/x.tmp', false), true)
  assert.equal(isIgnored(nested, 'packages/b/x.tmp', false), false)
  assert.equal(isIgnored(nested, 'packages/a/local', true), true)
  assert.equal(isIgnored(nested, 'packages/a/deep/local', true), false)
})
