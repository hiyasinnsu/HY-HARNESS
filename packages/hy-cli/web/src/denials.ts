// CP-06: summarize blocked tool calls for the Details panel.

export interface DenialCount {
  /** `policy` / `approval` / `sandbox` / `network` / `protected`. */
  kind: string
  count: number
}

interface EntryLike {
  kind?: string
  denial?: string
}

/** Counts blocked tool cards by mechanism, most frequent first. */
export function sumDenials(entries: readonly EntryLike[]): DenialCount[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.kind !== 'tool' || typeof entry.denial !== 'string' || entry.denial === '') continue
    counts.set(entry.denial, (counts.get(entry.denial) ?? 0) + 1)
  }
  return [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
}