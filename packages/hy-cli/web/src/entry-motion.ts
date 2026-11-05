/**
 * Entrance animation bookkeeping for the transcript.
 *
 * The transcript is rebuilt with `innerHTML` up to once per animation frame
 * while a turn streams. Tool cards, messages and approval cards carry a short
 * `rise` entrance animation that starts at `opacity: 0`, so recreating them on
 * every frame restarted the animation each time and the cards blinked between
 * visible and invisible (thinking lines, which have no animation, stayed put).
 *
 * Only an entry that appears for the first time should animate. Each entry is
 * wrapped in a `display: contents` element, and one already shown is marked
 * `settled`, which turns its entrance animation off in CSS.
 */

/** Identifies an entry across re-renders; ids repeat between runs (`msg-12`). */
export function entryMotionKey(entry: { runId: string; id: string }): string {
  return `${entry.runId}\u0000${entry.id}`
}

/**
 * Returns, for each key, whether it was already shown (and so must not animate
 * again), then records every key as shown.
 */
export function settledFlags(seen: Set<string>, keys: readonly string[]): boolean[] {
  const flags = keys.map((key) => seen.has(key))
  for (const key of keys) seen.add(key)
  return flags
}

/** Wraps one rendered entry so CSS can tell new entries from settled ones. */
export function wrapEntryHtml(html: string, settled: boolean): string {
  return `<div class="entry${settled ? ' settled' : ''}">${html}</div>`
}
