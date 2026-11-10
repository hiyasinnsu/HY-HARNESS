/**
 * Recognises a reply that is clearly a tool call the model failed to emit
 * properly. With native function calling such text arrives as plain content,
 * so without this check it would be shown as the final answer.
 *
 * The check stays conservative, because a false positive discards a valid
 * answer: fenced blocks and inline code are ignored (they explain, they do not
 * call), function arguments such as `calls.push({...})` are skipped, and an
 * object that parses as JSON is never broken. A body that starts with `{` and
 * is not one JSON value, though, is a call cut off by the provider, not an
 * answer — native mode used to show it as the final answer and stop mid-task.
 */

import { TOOLS_BY_NAME } from './tool-registry.js'

/** Tail fragments of a chat-template tool block leaking into the text. */
const CLOSING_FRAGMENTS = [
  '</｜',
  '</|',
  'parameter>',
  '<tool_call>',
  '</tool_call',
  '</tool_calls',
  '</arg_value',
  '</function',
  '</invoke>',
  'Begin Patch',
]

/** The same keys, double-quoted only: `{tool: name}` is code, not a call. */
const JSON_TOOL_KEY = /(?:^|[{,\s])"(?:tool|calls|tools)"\s*:|"name"\s*:\s*"[a-zA-Z0-9_]+"[\s\S]*?"(?:arguments|args)"\s*:/

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Fenced blocks are examples: drop them before looking for calls. Only a fence
 * with its closing marker is dropped — a fence that never closes means the reply
 * stopped inside a code block, so its content is still judged. Making the closer
 * optional hid a tool call cut off inside an unclosed fence: with the fence and
 * everything after it removed, the truncated call looked like prose and native
 * mode took the reply as the final answer (verify-agent-budget 7.1).
 */
function stripFences(text: string): string {
  return text.replace(/(?:```|~~~)[\s\S]*?(?:```|~~~)/g, ' ')
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

/** The text stops mid-value: the reply was cut off, it did not end here. */
const TRUNCATED_END = /(?:…|\.\.\.)\s*$/

/**
 * Braces, brackets and strings all closed (escapes inside strings honoured).
 * A body that starts with `{` and is not balanced is a JSON value that was cut
 * off, not an answer.
 */
function isBalancedJson(text: string): boolean {
  const open: string[] = []
  let inString = false
  let escape = false
  for (const c of text) {
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') open.push(c)
    else if (c === '}' || c === ']') {
      if (open.pop() !== (c === '}' ? '{' : '[')) return false
    }
  }
  return !inString && open.length === 0
}

/** True when the text names a tool call but does not parse as JSON. */
function namesToolWithoutJson(text: string): boolean {
  if (isJson(text)) return false
  if (/"(?:tool|calls)"\s*:/.test(text)) return true
  return /"name"\s*:\s*"/.test(text) && /"arguments"\s*:/.test(text)
}

export function looksLikeBrokenToolCall(text: string): boolean {
  const t = stripInlineCode(stripFences(text.trim())).trim()
  if (!t) return false
  if (/^<(?:tool(?:[ _]calls?)?|｜DSML｜\s*(?:calls|invoke))(?=[\s>])/.test(t)) return true
  if (/^<system>\s*Tool ran without output or errors\s*<\/system>$/i.test(t)) return true
  // G-15: a reply that is nothing but an XML tool call is a call, not an answer.
  if (t.startsWith('<') && recoverXmlToolCall(t) !== undefined) return true
  // A template's closing tag mixed with JSON.
  if (t.includes('{') && CLOSING_FRAGMENTS.some((f) => t.includes(f))) return true
  // A body that is JSON-shaped but is not one JSON value is a call cut short
  // (the provider's output limit, a dropped stream), not an answer: native mode
  // accepted it as `final` and the turn stopped mid-task. Covers unbalanced
  // braces/brackets/strings, tool keys that do not parse, and an ellipsis tail.
  // A body that is one whole JSON value, or prose that merely contains `{`,
  // is not affected.
  if (t.startsWith('{') && (TRUNCATED_END.test(t) || !isBalancedJson(t) || namesToolWithoutJson(t))) return true
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
/**
 * True when prose (outside fenced blocks and inline code) holds a complete
 * tool-call object or `{"calls":[…]}` batch. Native mode never runs such text:
 * a call written mid-answer may be an example being explained ("the agent sent
 * `{"tool":"shell",…}`"), and running it would execute a command the model only
 * described. The agent asks once for a real function call instead.
 */
export function embedsCallInProse(text: string): boolean {
  const t = stripInlineCode(stripFences(text.trim())).trim()
  if (!t.includes('{')) return false
  const pairs = closingBraces(t)
  for (let i = t.indexOf('{'); i >= 0; i = t.indexOf('{', i + 1)) {
    if (afterCallToken(t, i)) continue
    const end = pairs.get(i)
    if (end === undefined) continue
    try {
      const value = JSON.parse(t.slice(i, end + 1)) as { calls?: unknown; tools?: unknown }
      if (isCallObject(value)) return true
      for (const list of [value?.calls, value?.tools]) {
        if (Array.isArray(list) && list.length > 0 && list.every(isCallObject)) return true
      }
    } catch {
      // Not JSON: an inner object may still be one.
      continue
    }
    i = end
  }
  return false
}

/** A closing chat-template tag, e.g. `</｜DSML｜ parameter>`, `</tool_call:id>`, or `</invoke>`. */
const TEMPLATE_CUT = /<\/(?:｜|\||tool_calls?(?:[:>])|arg_value(?:[:>])|function(?:[:>])|invoke>|parameter>)/
const TEMPLATE_TAIL = /^(?:\s*<\/(?:｜|\|)?[^<>\n]{0,80}>)+\s*$/

const NON_TOOL_SINGLE_KEYS = new Set(['tool', 'name', 'args', 'arguments', 'calls', 'tools', 'final', 'note', 'error', 'result', 'content'])

function isCallObject(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  if (typeof obj.tool === 'string' || (typeof obj.name === 'string' && ('args' in obj || 'arguments' in obj))) return true
  const keys = Object.keys(obj)
  if (keys.length === 1 && !NON_TOOL_SINGLE_KEYS.has(keys[0]!) && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(keys[0]!)) {
    const inner = obj[keys[0]!]
    return !!inner && typeof inner === 'object' && !Array.isArray(inner)
  }
  return false
}

function parseValidCallJson(repaired: string): string | undefined {
  try {
    const parsed = JSON.parse(repaired) as { calls?: unknown; tools?: unknown; tool?: unknown; name?: unknown; arguments?: unknown; args?: unknown }
    if (typeof parsed?.tool === 'string') return repaired
    if (typeof parsed?.name === 'string' && parsed && ('arguments' in parsed || 'args' in parsed)) {
      return JSON.stringify({ tool: parsed.name, args: parsed.arguments !== undefined ? parsed.arguments : parsed.args })
    }
    for (const list of [parsed?.calls, parsed?.tools]) {
      if (Array.isArray(list) && list.length > 0 && list.every(isCallObject)) return repaired
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Repairs minor structural glitches in a JSON tool call or `{"calls":[...]}`
 * batch:
 * - `"tool":"<name>":{...}` missing `"args"` key (`"tool":"<name>","args":{...}`)
 * - raw newlines/tabs inside string literals
 * - a stray `)` between closing braces (`})}` -> `}}`)
 * - a missing `}` on a call object inside `{"calls":[...]}` right before
 *   `,{"tool":` or `]}` (after its `"args":{...}` closed with `}`)
 * - missing final closing `]` / `}` at the end of the reply (always when cut
 *   short by template tags; for untagged replies, only on a `{"calls":[...]}`
 *   batch that ended cleanly on `}` or `]`).
 */
function repairCallHead(rawHead: string, allowMissingClosers: boolean): string | undefined {
  const head = rawHead.replace(/"tool"\s*:\s*"([a-zA-Z0-9_]+)"\s*:\s*\{/g, '"tool":"$1","args":{')
  if (!JSON_TOOL_KEY.test(head)) return undefined
  const open: Array<'{' | '['> = []
  let out = ''
  let inString = false
  let escape = false
  let lastToken = ''
  for (let i = 0; i < head.length; i++) {
    const c = head[i]!
    if (inString) {
      if (escape) {
        escape = false
        out += c
      } else if (c === '\\') {
        escape = true
        out += c
      } else if (c === '"') {
        inString = false
        lastToken = '"'
        out += c
      } else if (c === '\n') {
        out += '\\n'
      } else if (c === '\r') {
        out += '\\r'
      } else if (c === '\t') {
        out += '\\t'
      } else {
        out += c
      }
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === '{' || c === '[') {
      open.push(c)
      lastToken = c
      out += c
    } else if (c === ')') {
      if (lastToken === '}' && /^\s*[}\]]/.test(head.slice(i + 1))) continue
      return undefined
    } else if (c === ',') {
      if (
        open.length === 3 &&
        open[0] === '{' &&
        open[1] === '[' &&
        open[2] === '{' &&
        lastToken === '}' &&
        /^,\s*\{\s*"tool"\s*:/.test(head.slice(i))
      ) {
        open.pop()
        out += '}'
      }
      lastToken = ','
      out += ','
    } else if (c === '}' || c === ']') {
      if (
        c === ']' &&
        open.length === 3 &&
        open[0] === '{' &&
        open[1] === '[' &&
        open[2] === '{' &&
        lastToken === '}'
      ) {
        open.pop()
        out += '}'
      }
      if (
        c === ']' &&
        open.length === 1 &&
        open[0] === '{' &&
        (lastToken === '"' || lastToken === '}') &&
        /^[\s\]}]*$/.test(head.slice(i))
      ) {
        open.pop()
        out += '}'
        break
      }
      if (open.length === 0) {
        if (/^[\s\]}]*$/.test(head.slice(i))) break
        return undefined
      }
      if (open.pop() !== (c === '}' ? '{' : '[')) return undefined
      lastToken = c
      out += c
    } else {
      if (!/\s/.test(c)) lastToken = c
      out += c
    }
  }
  if (inString) return undefined
  if (open.length > 0) {
    if (!allowMissingClosers) {
      if (!/^\{\s*"(?:calls|tools)"\s*:\s*\[/.test(head)) return undefined
      if (lastToken !== '}' && lastToken !== ']') return undefined
      if (open.length > 2) return undefined
    }
    out += open
      .reverse()
      .map((c) => (c === '{' ? '}' : ']'))
      .join('')
  }
  return parseValidCallJson(out)
}

/**
 * Recovers hybrid JSON/XML tool calls emitted when a model mixes the JSON tool
 * header with `<parameter name="...">...</parameter>` or `<arg_name>...</arg_name>`
 * tags and `</invoke>` / `</｜DSML｜...>`.
 */
function recoverXmlParameterCall(text: string): string | undefined {
  const m = /^\{\s*"tool"\s*:\s*"([^"\\]+)"\s*>\s*([\s\S]*)$/.exec(text)
  if (!m) return undefined
  const tool = m[1]!
  let rest = m[2]!
  const args = new Map<string, unknown>()
  const paramRe = /^<(?:｜DSML｜\s+)?parameter\s+name="([a-zA-Z_][a-zA-Z0-9_]*)"(?:\s+string="(true|false)")?>([\s\S]*?)<\/(?:｜DSML｜\s+)?parameter>\s*/
  const directTagRe = /^<([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/\1>\s*/
  const reservedTags = new Set(['invoke', 'parameter', 'tool_call', 'tool_calls', 'function', 'arg_value'])
  for (;;) {
    const pm = paramRe.exec(rest)
    if (pm) {
      const [, name, string, raw] = pm
      if (args.has(name!)) return undefined
      try {
        args.set(name!, string === 'false' ? JSON.parse(raw!) : raw)
      } catch {
        return undefined
      }
      rest = rest.slice(pm[0].length)
      continue
    }
    const dm = directTagRe.exec(rest)
    if (dm && !reservedTags.has(dm[1]!)) {
      if (args.has(dm[1]!)) return undefined
      args.set(dm[1]!, dm[2]!)
      rest = rest.slice(dm[0].length)
      continue
    }
    break
  }
  if (args.size === 0) return undefined
  if (rest.length > 0 && !TEMPLATE_TAIL.test(rest)) return undefined
  const nested = args.get('args')
  if (args.size === 1 && nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return JSON.stringify({ tool, args: nested })
  }
  return JSON.stringify({ tool, args: Object.fromEntries(args) })
}

// --- XML-only tool calls (G-15) ---------------------------------------------
// Some chat templates never produce the JSON protocol: the model writes
// `<tool_call>…</tool_call>`, `<function=NAME>…</function>`,
// `<invoke name="NAME">…</invoke>` or a bare `<NAME><arg>value</arg></NAME>`.
// The parser below reads tag names and attributes generically instead of
// enumerating dialects, and converts an unambiguous call to the JSON protocol.

/** Known tool names; the bare `<NAME>…</NAME>` form needs one to be safe. */
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...TOOLS_BY_NAME.keys(),
  'write_file',
  'edit_file',
  'read_image',
  'todo_write',
  'present',
])

const XML_TAG_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*/
const XML_ATTR_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/
const XML_ARGUMENT_TAGS = new Set(['parameter', 'argument', 'arg_value'])
const XML_WRAPPER_TAGS = new Set(['tool_call', 'tool_calls', 'function_call'])
const XML_CALL_TAGS = new Set(['function', 'invoke', 'tool'])

interface XmlElement {
  name: string
  attrs: Record<string, string>
  /** `<function=NAME>`: a value written straight after the tag name. */
  bare?: string
  children: XmlNode[]
}

type XmlNode = { text: string } | { element: XmlElement }

interface XmlTag {
  closing: boolean
  name: string
  attrs: Record<string, string>
  bare?: string
  selfClosing: boolean
  end: number
}

/** Reads the value after `=` (quoted or bare); undefined when it is broken. */
function readXmlValue(text: string, at: number): { value: string; end: number } | undefined {
  let i = at
  while (i < text.length && /\s/.test(text[i]!)) i += 1
  const quote = text[i]
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, i + 1)
    return close < 0 ? undefined : { value: text.slice(i + 1, close), end: close + 1 }
  }
  const start = i
  while (i < text.length && !/[\s>]/.test(text[i]!)) i += 1
  return i === start ? undefined : { value: text.slice(start, i), end: i }
}

/**
 * Reads the tag starting at `at` (`text[at] === '<'`). Tag and attribute names
 * keep their case (argument tags are case-sensitive); a template decoration
 * such as `<｜DSML｜ parameter …>` is skipped before the name.
 */
function readXmlTag(text: string, at: number): XmlTag | undefined {
  let i = at + 1
  const closing = text[i] === '/'
  if (closing) i += 1
  const prefix = /^(?:｜[^｜<>]*｜|\|[^|<>]*\|)\s*/.exec(text.slice(i))
  if (prefix) i += prefix[0].length
  const name = XML_TAG_NAME.exec(text.slice(i))
  if (!name) return undefined
  i += name[0].length
  const attrs: Record<string, string> = {}
  let bare: string | undefined
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i += 1
    if (text[i] === '>') return { closing, name: name[0], attrs, ...(bare !== undefined ? { bare } : {}), selfClosing: false, end: i + 1 }
    if (text[i] === '/' && text[i + 1] === '>') return { closing, name: name[0], attrs, ...(bare !== undefined ? { bare } : {}), selfClosing: true, end: i + 2 }
    if (text[i] === '=') {
      const value = readXmlValue(text, i + 1)
      if (!value) return undefined
      bare = value.value
      i = value.end
      continue
    }
    const attr = XML_ATTR_NAME.exec(text.slice(i))
    if (!attr) return undefined
    i += attr[0].length
    while (i < text.length && /\s/.test(text[i]!)) i += 1
    if (text[i] !== '=') {
      attrs[attr[0].toLowerCase()] = ''
      continue
    }
    const value = readXmlValue(text, i + 1)
    if (!value) return undefined
    attrs[attr[0].toLowerCase()] = value.value
    i = value.end
  }
}

function parseXmlNodes(text: string, from: number, until: string | undefined, depth: number): { nodes: XmlNode[]; end: number } | undefined {
  if (depth > 8) return undefined
  const nodes: XmlNode[] = []
  let i = from
  for (;;) {
    const lt = text.indexOf('<', i)
    const stop = lt < 0 ? text.length : lt
    if (stop > i) nodes.push({ text: text.slice(i, stop) })
    if (lt < 0) return until === undefined ? { nodes, end: text.length } : undefined
    if (text.startsWith('<!--', lt)) {
      const commentEnd = text.indexOf('-->', lt + 4)
      if (commentEnd < 0) return undefined
      i = commentEnd + 3
      continue
    }
    const tag = readXmlTag(text, lt)
    if (!tag) return undefined
    if (tag.closing) return until !== undefined && tag.name === until ? { nodes, end: tag.end } : undefined
    if (tag.selfClosing) {
      nodes.push({ element: { name: tag.name, attrs: tag.attrs, ...(tag.bare !== undefined ? { bare: tag.bare } : {}), children: [] } })
      i = tag.end
      continue
    }
    const inner = parseXmlNodes(text, tag.end, tag.name, depth + 1)
    if (!inner) return undefined
    nodes.push({ element: { name: tag.name, attrs: tag.attrs, ...(tag.bare !== undefined ? { bare: tag.bare } : {}), children: inner.nodes } })
    i = inner.end
  }
}

/**
 * Converts the top-level elements of a reply to the JSON protocol. Several
 * calls in one reply become one `{"calls":[…]}` batch: a model that emits
 * parallel XML calls had them all refused before, so the reply fell through to
 * a retry. Prose around the elements is not an unambiguous call.
 */
function xmlCallsFromNodes(nodes: readonly XmlNode[]): string | undefined {
  if (nodes.some((n) => 'text' in n && n.text.trim() !== '')) return undefined
  const elements = nodes.filter((n): n is { element: XmlElement } => 'element' in n)
  if (elements.length === 0) return undefined
  const parts: string[] = []
  for (const node of elements) {
    const call = xmlCallFromElement(node.element)
    if (call === undefined) return undefined
    parts.push(call)
  }
  return xmlBatchJson(parts)
}

/** Text content of an element; undefined when it holds child elements. */
function xmlTextOf(el: XmlElement): string | undefined {
  if (el.children.some((n) => 'element' in n)) return undefined
  return el.children.map((n) => ('text' in n ? n.text : '')).join('')
}

/** A value that is a JSON literal on its own: true/false, a number, `{…}` or `[…]`. */
const JSON_LITERAL_VALUE = /^(?:true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[\[{])/

function xmlArgumentValue(el: XmlElement): { value: unknown } | undefined {
  const text = xmlTextOf(el)
  if (text === undefined) return undefined
  // `string="false"` is the chat template's marker for a JSON value, and
  // `string="true"` keeps the text as written.
  if (el.attrs.string === 'false') {
    try {
      return { value: JSON.parse(text) }
    } catch {
      return undefined
    }
  }
  if (el.attrs.string === 'true') return { value: text }
  // Templates disagree about the marker: without it, a value that is exactly a
  // JSON literal is typed the same way, so `startLine` arrives as 12 and
  // `ignoreCase` as true instead of the strings "12" / "true" (a string arg
  // silently failed the tool: `args.ignoreCase === true` stays false). Anything
  // else, including a `{…}` that does not parse (a shell block), stays text.
  const trimmed = text.trim()
  if (JSON_LITERAL_VALUE.test(trimmed)) {
    try {
      return { value: JSON.parse(trimmed) }
    } catch {
      // Not JSON after all: keep the text.
    }
  }
  return { value: text }
}

/** The argument tags of a call; undefined on anything ambiguous or empty. */
function xmlArguments(el: XmlElement): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {}
  for (const node of el.children) {
    if ('text' in node) {
      if (node.text.trim() === '') continue
      return undefined
    }
    const tag = node.element
    const key = XML_ARGUMENT_TAGS.has(tag.name.toLowerCase()) ? (tag.attrs.name ?? tag.attrs.key ?? tag.bare) : tag.name
    // Argument names start with a letter (`startLine`, `file`), so `__proto__`
    // and other odd keys are refused instead of assigned.
    if (!key || !/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(args, key)) return undefined
    const value = xmlArgumentValue(tag)
    if (!value) return undefined
    args[key] = value.value
  }
  return Object.keys(args).length > 0 ? args : undefined
}

function xmlToolName(el: XmlElement): string | undefined {
  const name = el.attrs.name ?? el.attrs.tool ?? el.bare
  return name !== undefined && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) ? name : undefined
}

function xmlCallJson(tool: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args)
  const nested = keys.length === 1 ? args[keys[0]!] : undefined
  if ((keys[0] === 'args' || keys[0] === 'arguments') && nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    return JSON.stringify({ tool, args: nested })
  }
  return JSON.stringify({ tool, args })
}

/**
 * Joins several converted calls into one `{"calls":[…]}` batch. A single call
 * keeps its own form, so nothing changes for the common case.
 */
function xmlBatchJson(parts: readonly string[]): string | undefined {
  if (parts.length === 1) return parts[0]
  const calls: unknown[] = []
  for (const part of parts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(part)
    } catch {
      return undefined
    }
    const batch = (parsed as { calls?: unknown } | null)?.calls
    if (Array.isArray(batch)) calls.push(...batch)
    else calls.push(parsed)
  }
  return calls.length > 1 ? JSON.stringify({ calls }) : parts[0]
}

function xmlCallFromElement(el: XmlElement): string | undefined {
  const tag = el.name.toLowerCase()
  if (XML_WRAPPER_TAGS.has(tag)) {
    // Hermes/Qwen: a JSON call inside the wrapper.
    const json = xmlTextOf(el)?.trim()
    if (json) return json.startsWith('{') ? parseValidCallJson(json) : undefined
    // `<tool_call><function=NAME>…</function></tool_call>`, or several calls in
    // one wrapper: each element is converted and two or more become a batch
    // (refusing them dropped every parallel call and retried the whole reply).
    const inner = el.children.filter((n): n is { element: XmlElement } => 'element' in n)
    const prose = el.children.some((n) => 'text' in n && n.text.trim() !== '')
    if (prose || inner.length === 0) return undefined
    const parts: string[] = []
    for (const node of inner) {
      const call = xmlCallFromElement(node.element)
      if (call === undefined) return undefined
      parts.push(call)
    }
    return xmlBatchJson(parts)
  }
  if (XML_CALL_TAGS.has(tag)) {
    const tool = xmlToolName(el)
    const args = xmlArguments(el)
    return tool !== undefined && args !== undefined ? xmlCallJson(tool, args) : undefined
  }
  if (KNOWN_TOOL_NAMES.has(tag)) {
    const args = xmlArguments(el)
    return args !== undefined ? xmlCallJson(el.name, args) : undefined
  }
  return undefined
}

/**
 * G-15: converts XML-only tool calls to the JSON text protocol
 * (`{"tool":"…","args":{…}}`, or `{"calls":[…]}` when the reply holds several
 * calls). Ambiguous input is refused: prose around the elements, a
 * `string="false"` value that is not valid JSON, a duplicate argument name, or
 * a call with no arguments at all.
 */
export function recoverXmlToolCall(text: string): string | undefined {
  const parsed = parseXmlNodes(text.trim(), 0, undefined, 0)
  return parsed === undefined ? undefined : xmlCallsFromNodes(parsed.nodes)
}

/**
 * Repairs one known glitch of DeepSeek/GLM/Qwen models: a text tool call written
 * as a JSON call or batch that lacks its closing brackets, is wrapped in
 * `<tool_call>...</tool_call>`, or mixes template closing tags
 * (`</｜DSML｜ parameter>`, `</tool_call:id>`, `</invoke>`). The intent is
 * unambiguous, so the call is restored instead of being retried (the model
 * tends to repeat the same glitch, and two in a row ended the turn).
 */
export function recoverTemplateCall(text: string): string | undefined {
  const raw = text.trim()
  // G-15: an XML-only call (the chat template's own tags, no JSON at all).
  const xmlCall = recoverXmlToolCall(raw)
  if (xmlCall !== undefined) return xmlCall
  const openTag = /^<tool_calls?>\s*/.exec(raw)
  const t = openTag ? raw.slice(openTag[0].length).trimStart() : raw
  if (!t.startsWith('{')) return undefined
  const xml = recoverXmlParameterCall(t)
  if (xml !== undefined) return xml
  const cut = t.search(TEMPLATE_CUT)
  if (cut < 0) {
    return openTag ? repairCallHead(t, true) : undefined
  }
  if (!TEMPLATE_TAIL.test(t.slice(cut))) return undefined
  const head = t.slice(0, cut).trimEnd()
  return repairCallHead(head, true)
}

/**
 * Repairs a tool call or `{"calls":[...]}` batch that is not valid JSON only
 * because of a missing `}` on a call entry before `,{"tool":` / `]}`, a
 * missing outer `]}` on `{"calls":[...]}`, a `"tool":"name":{...}` colon join,
 * raw newlines inside a string, or a stray `)` / `]}` at the end.
 */
export function recoverMalformedCall(text: string): string | undefined {
  const t = text.trim()
  if (!t.startsWith('{') || isJson(t)) return undefined
  return repairCallHead(t, false)
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

/**
 * Repairs a batch written without its `{"calls":[` opener:
 * `{"tool":"a",...},{"tool":"b",...}]}`. Every call is complete and the
 * order is clear, so they all run. Without this only the first object was
 * read and the rest silently dropped: an orchestrator "spawned" four workers
 * that never existed. Returns `{"calls":[...]}` or undefined.
 */
export function recoverUnwrappedBatch(text: string): string | undefined {
  let t = text.trim()
  if (!t.startsWith('{')) return undefined
  const cut = t.search(TEMPLATE_CUT)
  if (cut > 0) {
    if (!TEMPLATE_TAIL.test(t.slice(cut))) return undefined
    t = t.slice(0, cut).trimEnd()
  }
  const split = topLevelValues(t)
  if (!split || split.values.length < 2) return undefined
  // Only the closers of the missing wrapper may follow.
  if (!/^[\s\]}]*$/.test(split.rest)) return undefined
  const calls: unknown[] = []
  for (const value of split.values) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (!isCallObject(parsed)) return undefined
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

// --- Announce-then-stop -----------------------------------------------------
// A reply without a tool call ends the turn. When its last sentence announces
// what the agent will do next ("ここを確認します。", "I'll add the test now."),
// nothing was done and the user is left waiting. Seen in the session logs both
// in plain chats and orchestrators; only goal mode used to catch it.

/** The last sentence of a reply (markdown list markers and emphasis removed). */
export function lastSentence(text: string): string {
  const lines = text.trim().split(/\n+/).map((line) => line.trim()).filter(Boolean)
  const lastLine = (lines.at(-1) ?? '').replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\*\*/g, '')
  const sentences = lastLine.split(/(?<=[。！？!?])\s*|(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean)
  return sentences.at(-1) ?? ''
}

/** Actions the agent does with tools (a noun + する / します). */
const ACTION_NOUNS = '確認|調査|実行|追加|修正|作成|実装|検証|測定|対応|着手|開始|再起動|再実行|再試行|送信|適用|取得|実施|更新|削除|変更|分割|整理|起動|生成|記録|反映|移行|固定'
/** Doing verbs in their stem (polite) and plain forms. */
const VERB_STEMS = '進め|始め|取りかかり|取り掛かり|読み|調べ|書き|直し|やり直し|送り直し|用意し|積み|試し|行い|回し|走らせ|作り|入れ'
const VERB_PLAIN = '進める|始める|取りかかる|読む|調べる|書く|直す|やり直す|送り直す|用意する|積む|試す|行う|回す|走らせる|作る|入れる'

/** The agent itself is about to act: future or progressive forms of a doing verb. */
const ANNOUNCE_JA = new RegExp(
  [
    // 確認します / 追加していきます / 進めます / 送り直します
    `(?:(?:${ACTION_NOUNS})し|${VERB_STEMS})(?:ます|ていきます|てみます)`,
    // 確認を進めています / 確認を実行しています (work claimed as in progress)
    '(?:進めて|実行して|作業して|調査して|確認して|対応して|修正して|実装して)います',
    // plain style: 確認する / 次を積む / 送り直す
    `(?:(?:${ACTION_NOUNS})する|${VERB_PLAIN})`,
  ]
    .map((p) => `(?:${p})[。．.！!]?$`)
    .join('|'),
  'u',
)
const ANNOUNCE_EN = /^(?:(?:ok(?:ay)?|now|next|then|first|so)[,:]?\s+)*(?:i'll|i will|i'm going to|i am going to|let me|i'll now|i will now)\b/i

/**
 * Endings that legitimately hand the turn back: questions, offers, conditions
 * on the user or on other work, waiting, conclusions and deferrals. Not
 * 〜なければ ("unless you object, I'll start"): that one stalls a turn.
 */
const HANDS_BACK = new RegExp(
  [
    '[？?]\\s*$',
    'ますか|しましょうか|でしょうか|よろしいですか|いかがですか|どうしますか|教えてください|ご確認ください|ご指示',
    '必要なら|必要であれば|ご希望なら|ご希望があれば|よろしければ|もしよければ',
    '(?<!(?:な|無)け)れば|たら|なら[、,ば]|[るたいだ]なら|場合は|場合には|際は|てから|でから|完了後|後に|以降',
    '次第|届いたら|そろったら|揃ったら|終わったら|完了したら|報告を待|返事を待|承認を待|待ってから|を待って|待ちます|待つ[。]?$',
    'と判断する|と判断します|ことにする|ことにします|とします|別途|後で|あとで|今後',
    "\\b(?:if you|if needed|would you|do you|shall i|once|when (?:the|it|they)|after (?:the|it|they)|waiting for|wait for|later)\\b",
  ].join('|'),
  'iu',
)

/**
 * True when a reply that has no tool call ends by announcing the agent's own
 * next action, so the turn would stop before doing it. Questions to the user,
 * offers and waiting on a worker or the user are not announcements.
 */
export function announcesNextStep(text: string): boolean {
  const last = lastSentence(text)
  if (!last || HANDS_BACK.test(last)) return false
  return ANNOUNCE_JA.test(last) || ANNOUNCE_EN.test(last)
}
