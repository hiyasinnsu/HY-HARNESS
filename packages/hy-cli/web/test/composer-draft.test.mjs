import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLANK_CHAT_DRAFT_KEY,
  caretAfterRender,
  composerDraftKey,
  hasComposerDraft,
  readComposerDraft,
  shouldRebuildComposer,
  shouldStartSessionOnFocus,
  writeComposerDraft,
} from '../dist/composer-draft.js'

// Runs against the web build (`npx tsc -p packages/hy-cli/tsconfig.web.json`).
// The source is imported from dist because the src tree uses `.js` specifiers
// that Node's type stripping does not rewrite, while this file is plain ESM.
const EMPTY = new Map()

test('a draft survives being written and read back', () => {
  const drafts = writeComposerDraft(EMPTY, 'run-1', 'half a sentence')
  assert.equal(readComposerDraft(drafts, 'run-1'), 'half a sentence')
})

test('each chat keeps its own draft', () => {
  let drafts = writeComposerDraft(EMPTY, 'run-1', 'first chat')
  drafts = writeComposerDraft(drafts, 'run-2', 'second chat')
  assert.equal(readComposerDraft(drafts, 'run-1'), 'first chat')
  assert.equal(readComposerDraft(drafts, 'run-2'), 'second chat')
})

test('writing a draft does not mutate the map it was given', () => {
  const drafts = writeComposerDraft(EMPTY, 'run-1', 'text')
  assert.equal(readComposerDraft(EMPTY, 'run-1'), '')
  assert.equal(readComposerDraft(drafts, 'run-1'), 'text')
})

test('a new chat starts with an empty draft', () => {
  const drafts = writeComposerDraft(EMPTY, 'run-1', 'left behind in the old chat')
  assert.equal(readComposerDraft(drafts, BLANK_CHAT_DRAFT_KEY), '')
  assert.equal(readComposerDraft(drafts, composerDraftKey(undefined)), '')
})

test('a cleared draft is distinguishable from one never written', () => {
  const cleared = writeComposerDraft(EMPTY, 'run-1', '')
  assert.equal(readComposerDraft(cleared, 'run-1'), '')
  assert.equal(hasComposerDraft(cleared, 'run-1'), true)
  assert.equal(hasComposerDraft(cleared, 'run-2'), false)
})

test('the blank chat has its own key so no run id can collide', () => {
  assert.equal(BLANK_CHAT_DRAFT_KEY, '')
  assert.equal(composerDraftKey(undefined), BLANK_CHAT_DRAFT_KEY)
  assert.equal(composerDraftKey('run-1'), 'run-1')
})

test('the composer is not rebuilt while the input has focus', () => {
  assert.equal(shouldRebuildComposer(true), false)
})

test('the composer is rebuilt when the input does not have focus', () => {
  assert.equal(shouldRebuildComposer(false), true)
})

test('focusing an already blank chat does not start another one', () => {
  assert.equal(shouldStartSessionOnFocus({ hasCurrentSession: false, freshChat: true, startingSession: false }), false)
})

test('focusing a chat-less composer starts a chat', () => {
  assert.equal(shouldStartSessionOnFocus({ hasCurrentSession: false, freshChat: false, startingSession: false }), true)
})

test('focusing a chat that is already open starts nothing', () => {
  assert.equal(shouldStartSessionOnFocus({ hasCurrentSession: true, freshChat: false, startingSession: false }), false)
})

test('a start already in flight is not repeated', () => {
  assert.equal(shouldStartSessionOnFocus({ hasCurrentSession: false, freshChat: false, startingSession: true }), false)
})

test('an unchanged text puts the caret back where it was', () => {
  assert.deepEqual(caretAfterRender({ value: 'hello', selectionStart: 2, selectionEnd: 4 }, 'hello'), { start: 2, end: 4 })
})

test('without a snapshot the caret goes to the end', () => {
  assert.deepEqual(caretAfterRender(undefined, 'hello'), { start: 5, end: 5 })
})

test('a changed text sends the caret to the end instead of a stale offset', () => {
  assert.deepEqual(caretAfterRender({ value: 'hello', selectionStart: 2, selectionEnd: 2 }, 'hello world'), { start: 11, end: 11 })
})

test('caret offsets are clamped to the text length', () => {
  assert.deepEqual(caretAfterRender({ value: 'hello', selectionStart: 9, selectionEnd: 12 }, 'hello'), { start: 5, end: 5 })
})