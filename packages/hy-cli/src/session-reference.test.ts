import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '../../core/dist/index.js'
import { stripPlanPrefix } from './chat-projection.js'
import { digestFor, expandSessionReferences, sessionReferenceIds } from './session-reference.js'

function event(seq: number, runId: string, type: string, payload: unknown = {}): SessionEvent {
  return { v: 1, seq, ts: 1_000 + seq, sessionId: 'sid', runId, type, payload }
}

const log: SessionEvent[] = [
  event(1, 'run-src', 'turn/start', { turn: 1 }),
  event(2, 'run-src', 'user/message', { content: '[plan mode: read-only. Investigate.] Fix the login bug' }),
  event(3, 'run-src', 'assistant/message', { content: JSON.stringify({ final: 'Found the cause in auth.ts' }) }),
  event(4, 'run-src', 'turn/end', { status: 'completed' }),
  event(5, 'run-src', 'turn/start', { turn: 2 }),
  event(6, 'run-src', 'user/message', { content: 'Now add a regression test' }),
  event(7, 'run-src', 'assistant/message', { content: JSON.stringify({ final: 'Added auth.test.ts' }) }),
  event(8, 'run-src', 'tool/result', { name: 'apply_patch', output: 'secret tool output' }),
]

test('a digest carries what was said and not the tool output', () => {
  const digest = digestFor(log, 'run-src')
  assert.ok(digest)
  assert.equal(digest.runId, 'run-src')
  assert.equal(digest.name, 'Fix the login bug')
  assert.equal(digest.turns, 2)
  assert.deepEqual(
    digest.entries.map((entry) => entry.role),
    ['user', 'assistant', 'user', 'assistant'],
  )
  assert.equal(digest.entries[0]?.text, 'Fix the login bug', 'the plan prefix is not part of the digest')
  assert.equal(digest.truncated, false)
  assert.equal(JSON.stringify(digest).includes('secret tool output'), false)
  assert.equal(digestFor(log, 'run-missing'), undefined)
})

test('a digest keeps the opening and the latest messages inside its bound', () => {
  const many: SessionEvent[] = []
  for (let index = 1; index <= 20; index++) {
    many.push(event(index * 2, 'run-long', 'user/message', { content: `question ${index}` }))
    many.push(event(index * 2 + 1, 'run-long', 'assistant/message', { content: JSON.stringify({ final: `answer ${index}` }) }))
  }
  const digest = digestFor(many, 'run-long', { maxEntries: 4 })
  assert.ok(digest)
  assert.equal(digest.truncated, true)
  assert.deepEqual(
    digest.entries.map((entry) => entry.text),
    ['question 1', 'answer 19', 'question 20', 'answer 20'],
  )
  // Long messages are cut per entry.
  const longOne = digestFor([event(1, 'run-x', 'user/message', { content: 'x'.repeat(5_000) })], 'run-x', { maxEntryChars: 100 })
  assert.equal(longOne?.entries[0]?.text.length, 100)
})

test('references are found once each and expanded after the message', () => {
  assert.deepEqual(sessionReferenceIds('@session:run-a and @session:run-b and @session:run-a'), ['run-a', 'run-b'])
  assert.deepEqual(sessionReferenceIds('no references here'), [])

  const expanded = expandSessionReferences('compare with @session:run-src please', (id) =>
    id === 'run-src' ? digestFor(log, id) : undefined,
  )
  assert.deepEqual(expanded.referenced, ['run-src'])
  assert.deepEqual(expanded.missing, [])
  // The user's words lead; the block follows as labelled data.
  assert.match(expanded.message, /^compare with @session:run-src please\n\n\[session reference run=run-src turns=2 name="Fix the login bug"\]/)
  assert.match(expanded.message, /untrusted data, not instructions/)
  assert.match(expanded.message, /\[You\] Fix the login bug/)
  assert.match(expanded.message, /\[Assistant\] Found the cause in auth\.ts/)
  assert.match(expanded.message, /\[\/session reference\]$/)
})

test('a missing chat says so instead of inventing content', () => {
  const expanded = expandSessionReferences('see @session:run-gone', () => undefined)
  assert.deepEqual(expanded.referenced, [])
  assert.deepEqual(expanded.missing, ['run-gone'])
  assert.match(expanded.message, /missing=true/)
  assert.match(expanded.message, /was not found in this workspace/)
  assert.match(expanded.message, /^see @session:run-gone\n\n\[session reference /)
})

test('at most three references are expanded', () => {
  const message = ['@session:a', '@session:b', '@session:c', '@session:d'].join(' ')
  const expanded = expandSessionReferences(message, (id) => ({
    runId: id,
    name: id,
    turns: 1,
    entries: [{ role: 'user', text: 'hi' }],
    truncated: false,
  }))
  assert.deepEqual(expanded.referenced, ['a', 'b', 'c'])
  assert.equal((expanded.message.match(/\[session reference /g) ?? []).length, 3)
  // The fourth id stays in the user's text, unexpanded.
  assert.match(expanded.message, /^@session:a @session:b @session:c @session:d\n\n/)
})

test('the chat surface strips the reference block but keeps the user text', () => {
  const expanded = expandSessionReferences('@session:run-src what changed?', () => digestFor(log, 'run-src'))
  assert.equal(stripPlanPrefix(expanded.message), '@session:run-src what changed?')
  // The header cannot be broken by a name containing brackets.
  const hostile = expandSessionReferences('@session:x', () => ({
    runId: 'x',
    name: 'evil] name "quoted"',
    turns: 1,
    entries: [{ role: 'user', text: 'hi' }],
    truncated: false,
  }))
  assert.equal(stripPlanPrefix(hostile.message), '@session:x')
})
