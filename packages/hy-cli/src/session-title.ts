/**
 * A user-assigned chat name.
 *
 * The name is only a label: it never replaces the automatic title derived from
 * the first user message, it is stored next to pins and archives in
 * `ui-state.json`, and it is rendered as text (never as HTML) by the GUI.
 */

/** Longest accepted name, in characters after whitespace collapsing. */
export const MAX_SESSION_TITLE_LENGTH = 120

export type SessionTitleResult = { title: string | null } | { error: string }

/**
 * Normalizes a submitted name.
 *
 * `null` (or a blank string) clears the name and lets the automatic title show
 * again. Control characters are collapsed to spaces so a name cannot smuggle
 * newlines or terminal escapes into the sidebar or the window title.
 */
export function normalizeSessionTitle(raw: unknown): SessionTitleResult {
  if (raw === null || raw === undefined) return { title: null }
  if (typeof raw !== 'string') return { error: 'title must be a string' }
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return { title: null }
  if (cleaned.length > MAX_SESSION_TITLE_LENGTH) {
    return { error: `title must be at most ${MAX_SESSION_TITLE_LENGTH} characters` }
  }
  return { title: cleaned }
}

/** WP-60: generated names are shorter than a hand-written one. */
export const MAX_GENERATED_TITLE_CHARS = 60
/** …and capped in bytes too, so a CJK title cannot wrap the sidebar. */
export const MAX_GENERATED_TITLE_BYTES = 120

/**
 * The deterministic fallback: the first meaningful line of the user's request.
 *
 * It is what the sidebar showed before WP-60, kept as the offline path (no
 * provider, a failing provider, or `--mock`) so a title always exists.
 */
export function titleFromFirstMessage(text: string, fallback = 'New chat'): string {
  const stripped = text
    .replace(/^\[[^\]]*\]\s*/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped) return fallback
  // The first sentence, not the whole request: a title is a label. A CJK full
  // stop needs no trailing space, a Latin one does (so "1.2" is not a stop).
  const cjk = /^(.{1,200}?[。！？])/u.exec(stripped)
  const latin = /^(.{1,200}?[.!?])(?=\s|$)/.exec(stripped)
  const sentence =
    (cjk && (!latin || cjk[1]!.length <= latin[1]!.length) ? cjk[1] : latin?.[1]) ?? stripped
  return cleanGeneratedTitle(sentence) || fallback
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Cuts a title at a character *and* byte boundary without splitting a pair. */
function clampTitle(text: string): string {
  let out = ''
  for (const char of text) {
    const next = out + char
    if ([...next].length > MAX_GENERATED_TITLE_CHARS || utf8Bytes(next) > MAX_GENERATED_TITLE_BYTES) break
    out = next
  }
  return out.trim()
}

/**
 * Normalizes a model-proposed name: strips the wrappers models like to add
 * (quotes, backticks, "Title:", a trailing period) and applies the limits.
 */
export function cleanGeneratedTitle(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // A fence wraps the whole answer; drop it before picking the first line.
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  while (lines.length > 0 && /^```/.test(lines[0]!)) lines.shift()
  while (lines.length > 0 && /^```/.test(lines[lines.length - 1]!)) lines.pop()
  // One line only: a title never carries a second paragraph.
  let text = (lines[0] ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  text = text.replace(/^(?:title|タイトル|标题|題名)\s*[:：]\s*/i, '').trim()
  text = text.replace(/^[-*•]\s+/, '').trim()
  // Surrounding quotes/backticks/brackets, possibly nested (`"「…」"`).
  for (let i = 0; i < 3; i++) {
    const before = text
    text = text.replace(/^["'`「『（(]+/, '').replace(/["'`」』）)]+$/, '').trim()
    if (text === before) break
  }
  text = text.replace(/[.。]$/, '').trim()
  if (!text) return ''
  return clampTitle(text)
}

/**
 * The request sent to the model. Instructions are English (they survive small
 * models better) while the answer must be in the user's own language.
 */
export function buildTitleMessages(input: { request: string }): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You name coding sessions. Reply with the title only: no quotes, no markdown, no "Title:" prefix, no period.\n' +
        'Rules:\n' +
        '- At most 6 words in English; at most 24 characters in Japanese or Chinese.\n' +
        "- Use the same language as the user's request.\n" +
        '- Name the concrete task or area, not the tool ("Fix the flaky login test", not "Read files").\n' +
        '- Do not add advice, punctuation wrappers, or a trailing explanation.',
    },
    { role: 'user', content: input.request.slice(0, 4_000) },
  ]
}

