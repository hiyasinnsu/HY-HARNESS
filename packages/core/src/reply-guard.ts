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
  // A readable first object followed by more calls: running only the first
  // would drop the others silently.
  if (hasCallsAfterFirstObject(t)) return true
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
/** A closing chat-template tag, e.g. `</｜DSML｜ parameter>` or `</tool_call>`. */
const TEMPLATE_TAIL = /^(?:\s*<\/(?:｜|\|)?[^<>\n]{0,80}>)+\s*$/

/**
 * Repairs one known glitch of DeepSeek models: a text tool call written as a
 * complete JSON batch that lacks only its closing brackets, followed by the
 * closing tags of the model's native tool template, e.g.
 * `{"calls":[{...},{...}]</｜DSML｜ parameter></｜DSML｜ invoke>`. The intent is
 * unambiguous, so the call is restored instead of being retried (the model
 * tends to repeat the same glitch, and two in a row ended the turn).
 *
 * Conservative: only when everything after the JSON is template closing tags,
 * the JSON names a tool, the scan ends outside a string with every bracket
 * well nested, and the result parses. Returns the repaired JSON text.
 */
export function recoverTemplateCall(text: string): string | undefined {
  const t = text.trim()
  if (!t.startsWith('{')) return undefined
  const cut = t.search(/<\/(?:｜|\||tool_call>|function>)/)
  if (cut < 0) return undefined
  if (!TEMPLATE_TAIL.test(t.slice(cut))) return undefined
  const head = t.slice(0, cut).trimEnd()
  if (!JSON_TOOL_KEY.test(head)) return undefined
  const open: string[] = []
  let inString = false
  let escape = false
  for (const c of head) {
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') open.push(c)
    else if (c === '}' || c === ']') {
      if (open.pop() !== (c === '}' ? '{' : '[')) return undefined
    }
  }
  if (inString) return undefined
  const repaired = head + open.reverse().map((c) => (c === '{' ? '}' : ']')).join('')
  try {
    const parsed = JSON.parse(repaired) as { calls?: unknown; tools?: unknown; tool?: unknown }
    const named = (c: unknown) => !!c && typeof (c as { tool?: unknown }).tool === 'string'
    if (typeof parsed?.tool === 'string') return repaired
    for (const list of [parsed?.calls, parsed?.tools]) if (Array.isArray(list) && list.length > 0 && list.every(named)) return repaired
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Splits text into its top-level JSON values separated by commas. Returns the
 * values' texts and what follows the last one, or undefined when a bracket
 * does not match. String-aware.
 */
function topLevelValues(text: string): { values: string[]; rest: string } | undefined {
  const values: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  let i = 0
  for (; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      if (escape) escape = false
      else if (c === BACKSLASH) escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      if (depth === 0) return undefined
      inString = true
    } else if (c === '{' || c === '[') {
      if (depth === 0) start = i
      depth += 1
    } else if (c === '}' || c === ']') {
      if (depth === 0) break
      depth -= 1
      if (depth === 0) values.push(text.slice(start, i + 1))
    } else if (depth === 0 && c !== ',' && !/\s/.test(c)) {
      break
    }
  }
  if (inString || depth !== 0) return undefined
  return { values, rest: text.slice(i) }
}

const BACKSLASH = String.fromCharCode(92)

function isCall(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { tool?: unknown }).tool === 'string'
}

/**
 * Repairs a batch written without its `{"calls":[` opener:
 * `{"tool":"a",...},{"tool":"b",...}]}`. Every call is complete and the
 * order is clear, so they all run. Without this only the first object was
 * read and the rest silently dropped: an orchestrator "spawned" four workers
 * that never existed. Returns `{"calls":[...]}` or undefined.
 */
export function recoverUnwrappedBatch(text: string): string | undefined {
  const t = text.trim()
  if (!t.startsWith('{')) return undefined
  const split = topLevelValues(t)
  if (!split || split.values.length < 2) return undefined
  // Only the closers of the missing wrapper may follow.
  if (!/^[\s\]}]*$/.test(split.rest)) return undefined
  const calls: unknown[] = []
  for (const value of split.values) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (!isCall(parsed)) return undefined
      calls.push(parsed)
    } catch {
      return undefined
    }
  }
  return JSON.stringify({ calls })
}

/**
 * True when the reply is not valid JSON as a whole, its first object can be
 * read, and more tool calls follow it. Running only that first object would
 * drop the rest without a word, so such a reply counts as a broken call.
 */
export function hasCallsAfterFirstObject(text: string): boolean {
  const t = text.trim()
  if (isJson(t)) return false
  const start = t.indexOf('{')
  if (start < 0) return false
  const end = closingBraces(t).get(start)
  if (end === undefined) return false
  return JSON_TOOL_KEY.test(t.slice(end + 1))
}
