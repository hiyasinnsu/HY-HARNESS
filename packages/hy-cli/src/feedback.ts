/**
 * WP-61: message feedback (DSH's `dsh-message-feedback`).
 *
 * Feedback is **local only**: a rating lands in `<stateDir>/feedback.jsonl` and
 * nothing is sent anywhere. That is deliberate — the harness has no telemetry
 * endpoint, and users are told the file is the whole story.
 */
import fs from 'node:fs'
import path from 'node:path'

export const FEEDBACK_CATEGORIES = ['accuracy', 'style', 'instruction', 'speed', 'tool_use', 'safety', 'other'] as const
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]
export type FeedbackRating = 'up' | 'down'

export const MAX_FEEDBACK_NOTE = 600

export interface FeedbackEntry {
  at: number
  runId: string
  /** The assistant message the rating belongs to, when the UI knows it. */
  entryId?: string
  rating: FeedbackRating
  category?: FeedbackCategory
  note?: string
  /** The model that produced the message, for later analysis. */
  model?: string
}

export class FeedbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedbackError'
  }
}

export function feedbackFile(stateDir: string): string {
  return path.join(stateDir, 'feedback.jsonl')
}

/** Validates a request body; the rating is the only required field. */
export function validateFeedback(
  body: Record<string, unknown>,
  runId: string,
  extra: { model?: string } = {},
): FeedbackEntry {
  const rating = body.rating
  if (rating !== 'up' && rating !== 'down') throw new FeedbackError('rating must be "up" or "down"')
  const rawCategory = body.category
  if (rawCategory !== undefined && !(FEEDBACK_CATEGORIES as readonly unknown[]).includes(rawCategory)) {
    throw new FeedbackError(`category must be one of ${FEEDBACK_CATEGORIES.join(', ')}`)
  }
  const note = typeof body.note === 'string' ? body.note.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() : ''
  if (note.length > MAX_FEEDBACK_NOTE) throw new FeedbackError(`note must be at most ${MAX_FEEDBACK_NOTE} characters`)
  const entryId = typeof body.entryId === 'string' && body.entryId ? body.entryId : undefined
  return {
    at: Date.now(),
    runId,
    ...(entryId ? { entryId } : {}),
    rating,
    ...(rawCategory !== undefined ? { category: rawCategory as FeedbackCategory } : {}),
    ...(note ? { note } : {}),
    ...(extra.model ? { model: extra.model } : {}),
  }
}

/** Append-only log of ratings; a corrupt line never hides the others. */
export class FeedbackStore {
  constructor(readonly file: string) {}

  append(entry: FeedbackEntry): FeedbackEntry {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8')
    return entry
  }

  list(options: { runId?: string; limit?: number } = {}): FeedbackEntry[] {
    const out: FeedbackEntry[] = []
    let text: string
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch {
      return out
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== 'object') continue
      const entry = parsed as FeedbackEntry
      if (entry.rating !== 'up' && entry.rating !== 'down') continue
      if (options.runId !== undefined && entry.runId !== options.runId) continue
      out.push(entry)
    }
    const limit = Math.max(1, options.limit ?? 200)
    return out.slice(-limit)
  }

  /** Up/down totals for one chat (the GUI shows them on the header). */
  summary(runId: string): { up: number; down: number; last?: FeedbackEntry } {
    const entries = this.list({ runId, limit: Number.MAX_SAFE_INTEGER })
    return {
      up: entries.filter((entry) => entry.rating === 'up').length,
      down: entries.filter((entry) => entry.rating === 'down').length,
      ...(entries.length > 0 ? { last: entries[entries.length - 1]! } : {}),
    }
  }
}
