/**
 * CP-33: full-text search over the open transcript (F3 / Ctrl+F).
 *
 * The index is the plain text of each entry, lowercased once; a query is a
 * substring scan over those strings, so 1,000 messages search well within the
 * 200 ms budget (web/test/transcript-search.test.mjs measures it).
 *
 * Pure module (no DOM).
 */

/** The parts of a chat entry that carry searchable text. */
export interface SearchableEntry {
  id: string
  kind: string
  text?: string
  name?: string
  output?: string
  args?: unknown
  question?: string
  answer?: string
}

export interface TranscriptIndex {
  ids: string[]
  texts: string[]
}

/** What a reader sees of an entry, as plain text. */
export function entryText(entry: SearchableEntry): string {
  switch (entry.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'notice':
      return entry.text ?? ''
    case 'tool': {
      const args = entry.args === undefined ? '' : typeof entry.args === 'string' ? entry.args : JSON.stringify(entry.args)
      return [entry.name ?? '', args, entry.output ?? ''].join('\n')
    }
    case 'question':
      return [entry.question ?? '', entry.answer ?? ''].join('\n')
    default:
      return ''
  }
}

export function buildIndex(entries: readonly SearchableEntry[]): TranscriptIndex {
  const ids: string[] = []
  const texts: string[] = []
  for (const entry of entries) {
    const text = entryText(entry)
    if (!text) continue
    ids.push(entry.id)
    texts.push(text.toLowerCase())
  }
  return { ids, texts }
}

export interface SearchHit {
  id: string
  /** Matches inside this entry. */
  count: number
}

/** Entries containing `query` (case-insensitive), in transcript order. */
export function searchIndex(index: TranscriptIndex, query: string): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SearchHit[] = []
  for (let i = 0; i < index.texts.length; i++) {
    const text = index.texts[i]!
    let at = text.indexOf(q)
    if (at < 0) continue
    let count = 0
    while (at >= 0) {
      count += 1
      at = text.indexOf(q, at + q.length)
    }
    hits.push({ id: index.ids[i]!, count })
  }
  return hits
}

/** Next (or previous) hit position, wrapping around. */
export function stepHit(current: number, total: number, backwards: boolean): number {
  if (total <= 0) return -1
  if (current < 0) return backwards ? total - 1 : 0
  return (current + (backwards ? total - 1 : 1)) % total
}
