/**
 * Recognises a reply that is clearly a tool call the model failed to emit
 * properly. With native function calling such text arrives as plain content,
 * so without this check it would be shown as the final answer.
 *
 * The check stays conservative, because a false positive discards a valid
 * answer: fenced blocks and inline code are ignored (they explain, they do not
 * call), function arguments such as `calls.push({...})` are skipped, and an
 * object that parses as JSON is never broken.
 */

/** Tail fragments of a chat-template tool block leaking into the text. */
const CLOSING_FRAGMENTS = ['</｜', '</|', 'parameter>', '</tool_call>', '</function>', 'Begin Patch']

/** The same keys, double-quoted only: `{tool: name}` is code, not a call. */
const JSON_TOOL_KEY = /(?:^|[{,\s])"(?:tool|calls)"\s*:/

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** Fenced blocks are examples: drop them before looking for calls. */
function stripFences(text: string): string {
  return text.replace(/(?:```|~~~)[\s\S]*?(?:(?:```|~~~)|$)/g, ' ')
}

/** Inline code spans are examples too, so they do not count as calls. */
function stripInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, ' ')
}

/**
 * Maps each `{` to the index of the `}` closing it, in one pass. Braces inside
 * strings are ignored, and a `{` that never closes has no entry. Pairing up
 * front keeps a long unterminated run linear: rescanning from every `{` would
 * make a reply of many `{"` fragments quadratic.
 */
function closingBraces(text: string): Map<number, number> {
  const pairs = new Map<number, number>()
  const open: number[] = []
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') open.push(i)
    else if (c === '}') {
      const start = open.pop()
      if (start !== undefined) pairs.set(start, i)
    }
  }
  return pairs
}

/** True when the `{` at `index` opens a call argument or an assignment. */
function afterCallToken(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const c = text[i]!
    // A newline ends the statement: prose ending in "." must not make the
    // next line's JSON object look like `foo.bar({...})`.
    if (c === ' ' || c === '\t') continue
    return c === '(' || c === '.' || c === '='
  }
  return false
}

/** True when this JSON-looking fragment names a tool but does not parse. */
function brokenFragment(fragment: string): boolean {
  return JSON_TOOL_KEY.test(fragment) && !isJson(fragment)
}

export function looksLikeBrokenToolCall(text: string): boolean {
  const t = stripInlineCode(stripFences(text.trim())).trim()
  if (!t) return false
  // A template's closing tag mixed with JSON.
  if (t.includes('{') && CLOSING_FRAGMENTS.some((f) => t.includes(f))) return true
  // A reply that parses as a whole is an answer, however broken it looks in parts.
  if (isJson(t)) return false
  const pairs = closingBraces(t)
  let sawUnclosed = false
  for (let i = t.indexOf('{'); i >= 0; i = t.indexOf('{', i + 1)) {
    if (afterCallToken(t, i)) continue
    const end = pairs.get(i)
    if (end === undefined) {
      // The rest of the reply is one unterminated fragment, and every later
      // unclosed brace starts inside it: judge it once, not once per brace.
      if (sawUnclosed) continue
      sawUnclosed = true
      if (brokenFragment(t.slice(i))) return true
      continue
    }
    // A complete object that parses is an answer or an example: skip it whole.
    if (brokenFragment(t.slice(i, end + 1))) return true
    i = end
  }
  return false
}