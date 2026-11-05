// Session log format versioning (WP-20).
//
// The log is JSONL and every event is self-describing, so a *newer* log can be
// read best-effort (unknown event types are ignored by consumers). A *shape*
// change is different: it needs an adjacent migration, keyed by the format the
// log declares in its `session/format` header. Legacy logs have no header and
// are format 1.
//
// The migration runs at read time and never rewrites the file. Writing always
// uses the current format, and `SessionLog` writes the header once.

import type { SessionEvent } from './session-log.js'

/** Current on-disk format. Bump when an existing event shape changes. */
export const SESSION_FORMAT_VERSION = 2

/** A pure migration from one format to the next. */
export type SessionFormatMigration = (events: SessionEvent[]) => SessionEvent[]

/**
 * Adjacent migrations, keyed by the format they read.
 *
 * v1 → v2 is additive (`sandbox/mode`, `user/steer`, `agent/*` events), so the
 * conversion is the identity: old events stay valid and new ones are simply
 * unknown to older readers.
 */
const MIGRATIONS: Readonly<Record<number, SessionFormatMigration>> = {
  1: (events) => events,
}

/** The format a log declares, or 1 when it predates the header. */
export function sessionFormatOf(events: readonly SessionEvent[]): number {
  for (const event of events) {
    if (event.type !== 'session/format') continue
    const payload = event.payload as { format?: unknown } | null | undefined
    const format = payload?.format
    if (typeof format === 'number' && Number.isInteger(format) && format > 0) return format
  }
  return 1
}

export interface MigratedLog {
  events: SessionEvent[]
  /** The format the returned events can be read as. */
  format: number
  /** The file was written by a newer version than this one understands. */
  unsupported: boolean
}

/**
 * Applies the adjacent migrations a log needs to reach the current format.
 *
 * A missing migration edge is a programming error, not a user error: the log is
 * returned as-is (best effort) instead of being dropped. A log from the future
 * is returned unchanged with `unsupported: true`.
 */
export function migrateSessionEvents(events: SessionEvent[]): MigratedLog {
  let format = sessionFormatOf(events)
  if (format > SESSION_FORMAT_VERSION) return { events, format, unsupported: true }
  let migrated = events
  while (format < SESSION_FORMAT_VERSION) {
    const step = MIGRATIONS[format]
    if (step === undefined) break
    migrated = step(migrated)
    format += 1
  }
  return { events: migrated, format, unsupported: false }
}

/** True when the events already carry a `session/format` header. */
export function hasFormatHeader(events: readonly SessionEvent[]): boolean {
  return events.some((event) => event.type === 'session/format')
}
