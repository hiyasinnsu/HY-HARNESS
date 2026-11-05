/**
 * CP-36: an optional Vim-style mode for the composer.
 *
 * Insert mode is the normal textarea; Escape switches to normal mode, where
 * keys move and edit instead of typing:
 *
 *   h l 0 $ w b j k     move          x X D dd    delete
 *   i a I A o O         back to insert (at the cursor, after it, line start,
 *                       line end, new line below / above)
 *
 * Enter still sends from either mode. The reducer is pure (text + cursor in,
 * text + cursor out) so web/test/vim.test.mjs covers it without a DOM.
 */

export type VimMode = 'insert' | 'normal'

export interface VimState {
  mode: VimMode
  /** A key waiting for its second half (`d` of `dd`). */
  pending: string
}

export interface VimEdit {
  text: string
  cursor: number
}

export interface VimResult {
  state: VimState
  edit: VimEdit
  /** False when the key should reach the textarea as usual. */
  handled: boolean
}

export const INITIAL_VIM: VimState = { mode: 'insert', pending: '' }

const lineStart = (t: string, c: number) => t.lastIndexOf('\n', c - 1) + 1
const lineEnd = (t: string, c: number) => {
  const e = t.indexOf('\n', c)
  return e < 0 ? t.length : e
}
const isWord = (ch: string | undefined) => ch !== undefined && /[\w]/.test(ch)

function wordForward(t: string, c: number): number {
  let i = c
  if (isWord(t[i])) while (i < t.length && isWord(t[i])) i++
  else if (i < t.length && !/\s/.test(t[i]!)) i++
  while (i < t.length && /\s/.test(t[i]!)) i++
  return Math.min(i, t.length)
}

function wordBack(t: string, c: number): number {
  let i = c
  while (i > 0 && /\s/.test(t[i - 1]!)) i--
  if (i > 0 && isWord(t[i - 1])) while (i > 0 && isWord(t[i - 1])) i--
  else if (i > 0) i--
  return i
}

function vertical(t: string, c: number, down: boolean): number {
  const start = lineStart(t, c)
  const col = c - start
  if (down) {
    const end = lineEnd(t, c)
    if (end >= t.length) return c
    const nextStart = end + 1
    return Math.min(nextStart + col, lineEnd(t, nextStart))
  }
  if (start === 0) return c
  const prevStart = lineStart(t, start - 1)
  return Math.min(prevStart + col, start - 1)
}

export function vimKey(state: VimState, key: string, edit: VimEdit): VimResult {
  const { text: t } = edit
  const c = Math.max(0, Math.min(edit.cursor, t.length))
  const normal = (cursor: number, text = t): VimResult => ({ state: { mode: 'normal', pending: '' }, edit: { text, cursor }, handled: true })
  const insert = (cursor: number, text = t): VimResult => ({ state: { mode: 'insert', pending: '' }, edit: { text, cursor }, handled: true })

  if (state.mode === 'insert') {
    if (key === 'Escape') return normal(Math.max(lineStart(t, c), c - 1))
    return { state, edit: { text: t, cursor: c }, handled: false }
  }

  // Normal mode. Enter and modified keys pass through (send, shortcuts).
  if (key === 'Enter' || key.length > 1 && !['Escape', 'Backspace', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
    return { state: { mode: 'normal', pending: '' }, edit: { text: t, cursor: c }, handled: false }
  }
  if (state.pending === 'd') {
    if (key === 'd') {
      const s = lineStart(t, c)
      const e = lineEnd(t, c)
      const text = e < t.length ? t.slice(0, s) + t.slice(e + 1) : t.slice(0, Math.max(0, s - 1)) + t.slice(e)
      return normal(Math.min(s, text.length), text)
    }
    return normal(c)
  }
  switch (key) {
    case 'Escape':
      return normal(c)
    case 'h':
    case 'ArrowLeft':
    case 'Backspace':
      return normal(Math.max(lineStart(t, c), c - 1))
    case 'l':
    case 'ArrowRight':
      return normal(Math.min(Math.max(lineStart(t, c), lineEnd(t, c) - 1), c + 1))
    case 'j':
    case 'ArrowDown':
      return normal(vertical(t, c, true))
    case 'k':
    case 'ArrowUp':
      return normal(vertical(t, c, false))
    case '0':
      return normal(lineStart(t, c))
    case '$':
      return normal(Math.max(lineStart(t, c), lineEnd(t, c) - 1))
    case 'w':
      return normal(wordForward(t, c))
    case 'b':
      return normal(wordBack(t, c))
    case 'x':
      return c < lineEnd(t, c) ? normal(Math.min(c, Math.max(lineStart(t, c), lineEnd(t, c) - 2)), t.slice(0, c) + t.slice(c + 1)) : normal(c)
    case 'X':
      return c > lineStart(t, c) ? normal(c - 1, t.slice(0, c - 1) + t.slice(c)) : normal(c)
    case 'D':
      return normal(Math.max(lineStart(t, c), c - 1), t.slice(0, c) + t.slice(lineEnd(t, c)))
    case 'd':
      return { state: { mode: 'normal', pending: 'd' }, edit: { text: t, cursor: c }, handled: true }
    case 'i':
      return insert(c)
    case 'a':
      return insert(Math.min(lineEnd(t, c), c + 1))
    case 'I':
      return insert(lineStart(t, c))
    case 'A':
      return insert(lineEnd(t, c))
    case 'o': {
      const e = lineEnd(t, c)
      return insert(e + 1, `${t.slice(0, e)}\n${t.slice(e)}`)
    }
    case 'O': {
      const s = lineStart(t, c)
      return insert(s, `${t.slice(0, s)}\n${t.slice(s)}`)
    }
    default:
      // Any other printable key is swallowed in normal mode, as in Vim.
      return normal(c)
  }
}
