// CP-33: transcript search. Acceptance: 1,000 messages within 200 ms.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIndex, entryText, searchIndex, stepHit } from '../dist/transcript-search.js'

test('CP-33: searchable text per entry kind', () => {
  assert.equal(entryText({ id: '1', kind: 'user', text: 'Hello' }), 'Hello')
  assert.match(entryText({ id: '2', kind: 'tool', name: 'shell', args: { command: 'npm test' }, output: '3 passing' }), /shell[\s\S]*npm test[\s\S]*3 passing/)
  assert.equal(entryText({ id: '3', kind: 'plan' }), '')
})

test('CP-33: case-insensitive hits in order, with counts', () => {
  const index = buildIndex([
    { id: 'a', kind: 'user', text: 'Fix the Login bug' },
    { id: 'b', kind: 'assistant', text: 'login works; login tests pass' },
    { id: 'c', kind: 'plan' },
    { id: 'd', kind: 'notice', text: 'nothing here' },
  ])
  assert.deepEqual(searchIndex(index, 'LOGIN'), [
    { id: 'a', count: 1 },
    { id: 'b', count: 2 },
  ])
  assert.deepEqual(searchIndex(index, '   '), [])
})

test('CP-33: next/previous wrap around', () => {
  assert.equal(stepHit(-1, 3, false), 0)
  assert.equal(stepHit(-1, 3, true), 2)
  assert.equal(stepHit(2, 3, false), 0)
  assert.equal(stepHit(0, 3, true), 2)
  assert.equal(stepHit(0, 0, false), -1)
})

test('CP-33: 1,000 messages are indexed and searched within 200 ms', () => {
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu'.split(' ')
  const entries = Array.from({ length: 1000 }, (_, i) => ({
    id: `m${i}`,
    kind: i % 2 ? 'assistant' : 'user',
    text: Array.from({ length: 120 }, (_, j) => words[(i * 7 + j) % words.length]).join(' ') + (i % 97 === 0 ? ' needle' : ''),
  }))
  const started = performance.now()
  const index = buildIndex(entries)
  const hits = searchIndex(index, 'needle')
  const elapsed = performance.now() - started
  assert.equal(hits.length, 11)
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`)
})
