const SUMMARY_KEYS = ['summary', '要約', '要約文', '思考', 'thought', 'thinking', 'action', 'text', 'content']

function stringsInJson(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (depth >= 3) return []
  if (Array.isArray(value)) return value.flatMap((item) => stringsInJson(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) => stringsInJson(item, depth + 1))
  }
  return []
}

function jsonSummary(text: string): { found: boolean; text: string } | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const object = parsed as Record<string, unknown>
    for (const key of SUMMARY_KEYS) {
      const value = object[key]
      if (typeof value === 'string' && value.trim()) return { found: true, text: value }
    }
  }
  return { found: true, text: stringsInJson(parsed).join(' ') }
}

/**
 * Small local models often wrap the answer in JSON or a "要約:" label. The UI
 * shows this text as one plain paragraph, so unwrap it and drop empty objects.
 */
export function cleanThinkingSummary(raw: string): string {
  let text = raw.trim()
  if (!text) return ''
  text = text.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```$/, '').trim()
  const parsed = jsonSummary(text)
  if (parsed?.found) text = parsed.text
  text = text.replace(/^(?:要約|summary|思考|thinking|thought)\s*[:：]\s*/i, '').trim()
  text = text.replace(/^["'“”「」]+|["'“”「」]+$/g, '').trim()
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > 500 ? `${text.slice(0, 500).trimEnd()}…` : text
}

export function hasJapanese(text: string): boolean {
  return /[\u3040-\u30ff]/.test(text)
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

/**
 * A zero-latency summary shown with the thinking block. It prefers an explicit
 * "要約:" line or a JSON summary, then falls back to the first Japanese
 * sentences. The LLM summary may replace it a moment later.
 */
export function instantThinkingSummary(raw: string): string {
  const text = raw.trim()
  if (!text) return ''

  const explicit = text.match(/(?:^|\n)\s*(?:要約|まとめ|summary)\s*[:：]\s*([^\n]+)/i)
  if (explicit?.[1]) {
    const cleaned = cleanThinkingSummary(explicit[1])
    if (hasJapanese(cleaned)) return truncate(cleaned, 180)
  }

  const parsed = jsonSummary(text)
  if (parsed?.found) {
    const cleaned = cleanThinkingSummary(parsed.text)
    if (hasJapanese(cleaned)) return truncate(cleaned, 180)
  }

  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\{[\s\S]*?\}/g, ' ')
  const sentences = prose
    .split(/(?<=[。！？])|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && hasJapanese(sentence))
  if (sentences.length === 0) return ''
  let summary = ''
  for (const sentence of sentences) {
    if (summary && summary.length + sentence.length > 160) break
    summary += sentence
    if (summary.length >= 30) break
  }
  return truncate(cleanThinkingSummary(summary), 180)
}
