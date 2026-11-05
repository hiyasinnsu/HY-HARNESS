// CP-36: the composer's Vim mode reducer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INITIAL_VIM, vimKey } from '../dist/vim.js'

function run(text, cursor, keys, state = INITIAL_VIM) {
  let edit = { text, cursor }
  let handled = true
  for (const key of keys) {
    const r = vimKey(state, key, edit)
    state = r.state
    edit = r.edit
    handled = r.handled
  }
  return { ...edit, mode: state.mode, handled }
}

test('CP-36: insert mode passes keys through; Escape enters normal mode', () => {
  assert.equal(vimKey(INITIAL_VIM, 'a', { text: 'x', cursor: 1 }).handled, false)
  assert.deepEqual(run('hello', 5, ['Escape']), { text: 'hello', cursor: 4, mode: 'normal', handled: true })
})

test('CP-36: motions', () => {
  assert.equal(run('hello world', 10, ['Escape', '0']).cursor, 0)
  assert.equal(run('hello world', 0, ['Escape', '$']).cursor, 10)
  assert.equal(run('hello world', 0, ['Escape', 'w']).cursor, 6)
  assert.equal(run('hello world', 10, ['Escape', 'b']).cursor, 6)
  assert.equal(run('ab\ncd', 1, ['Escape', 'l', 'j']).cursor, 4, 'j keeps the column')
  assert.equal(run('ab\ncd', 4, ['Escape', 'k']).cursor, 0)
})

test('CP-36: edits and returning to insert mode', () => {
  assert.deepEqual(run('abc', 0, ['Escape', 'x']), { text: 'bc', cursor: 0, mode: 'normal', handled: true })
  assert.equal(run('one\ntwo\nthree', 5, ['Escape', 'd', 'd']).text, 'one\nthree')
  assert.equal(run('only', 2, ['Escape', 'd', 'd']).text, '')
  assert.equal(run('hello world', 5, ['Escape', 'D']).text, 'hell')
  const appended = run('abc', 0, ['Escape', 'A'])
  assert.deepEqual([appended.cursor, appended.mode], [3, 'insert'])
  assert.deepEqual(run('ab', 1, ['Escape', 'o']), { text: 'ab\n', cursor: 3, mode: 'insert', handled: true })
  assert.equal(run('ab', 1, ['Escape', 'I']).cursor, 0)
})

test('CP-36: Enter and unknown keys in normal mode', () => {
  const enter = run('send me', 3, ['Escape', 'Enter'])
  assert.equal(enter.handled, false, 'Enter still sends')
  assert.equal(run('abc', 1, ['Escape', 'z']).text, 'abc', 'printable keys do not type in normal mode')
})
