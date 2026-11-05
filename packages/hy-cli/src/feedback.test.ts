import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  FEEDBACK_CATEGORIES,
  FeedbackError,
  FeedbackStore,
  MAX_FEEDBACK_NOTE,
  feedbackFile,
  validateFeedback,
} from './feedback.js'

function tempState(): { stateDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-feedback-'))
  return { stateDir: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('a rating is validated before it reaches the file', () => {
  const entry = validateFeedback({ rating: 'up' }, 'run-1', { model: 'mock:mock' })
  assert.equal(entry.rating, 'up')
  assert.equal(entry.runId, 'run-1')
  assert.equal(entry.model, 'mock:mock')
  assert.equal(typeof entry.at, 'number')
  assert.throws(() => validateFeedback({}, 'run-1'), (error: unknown) => {
    assert.ok(error instanceof FeedbackError)
    assert.match(error.message, /rating must be/)
    return true
  })
  assert.throws(() => validateFeedback({ rating: 'meh' }, 'run-1'), /rating must be/)
  assert.throws(() => validateFeedback({ rating: 'down', category: 'nope' }, 'run-1'), /category must be one of/)
  assert.throws(() => validateFeedback({ rating: 'down', note: 'x'.repeat(MAX_FEEDBACK_NOTE + 1) }, 'run-1'), /at most/)
  for (const category of FEEDBACK_CATEGORIES) {
    assert.equal(validateFeedback({ rating: 'down', category }, 'run-1').category, category)
  }
  // Notes are cleaned and bounded; an empty note is dropped.
  const noted = validateFeedback({ rating: 'down', note: '  too\u0007verbose\n' }, 'run-1')
  assert.equal(noted.note, 'too verbose')
  assert.equal(validateFeedback({ rating: 'up', note: '   ' }, 'run-1').note, undefined)
  assert.equal(validateFeedback({ rating: 'up', entryId: 'msg-3' }, 'run-1').entryId, 'msg-3')
})

test('the store appends, filters and summarises', () => {
  const { stateDir, cleanup } = tempState()
  try {
    const store = new FeedbackStore(feedbackFile(stateDir))
    assert.deepEqual(store.summary('run-1'), { up: 0, down: 0 })
    store.append(validateFeedback({ rating: 'up' }, 'run-1'))
    store.append(validateFeedback({ rating: 'down', category: 'accuracy', note: 'wrong file' }, 'run-1'))
    store.append(validateFeedback({ rating: 'up' }, 'run-2'))
    // A corrupt line is skipped, not fatal.
    fs.appendFileSync(feedbackFile(stateDir), '{not json}\n')
    const listed = store.list()
    assert.equal(listed.length, 3)
    assert.equal(store.list({ runId: 'run-1' }).length, 2)
    assert.equal(store.list({ runId: 'run-1', limit: 1 }).length, 1)
    assert.equal(store.list({ runId: 'run-1', limit: 1 })[0]?.rating, 'down', 'the newest survives the limit')
    const summary = store.summary('run-1')
    assert.equal(summary.up, 1)
    assert.equal(summary.down, 1)
    assert.equal(summary.last?.note, 'wrong file')
    // The file is plain JSON lines, one per rating.
    const lines = fs.readFileSync(feedbackFile(stateDir), 'utf8').trim().split('\n')
    assert.equal(lines.filter((line) => line.startsWith('{')).length, 4)
  } finally {
    cleanup()
  }
})

test('a missing feedback file reads as empty', () => {
  const { stateDir, cleanup } = tempState()
  try {
    const store = new FeedbackStore(path.join(stateDir, 'nested', 'feedback.jsonl'))
    assert.deepEqual(store.list(), [])
    assert.deepEqual(store.summary('run-x'), { up: 0, down: 0 })
  } finally {
    cleanup()
  }
})
