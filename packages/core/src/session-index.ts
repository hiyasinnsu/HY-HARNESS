import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from './session-log.js'

/**
 * WP-32: full-text search over the session log with SQLite FTS5
 * (`node:sqlite`, no native build step). The JSONL log stays the truth: this is
 * a disposable index that can be deleted and rebuilt at any time.
 *
 * `tokenize='trigram'` is what makes Japanese search work (no word boundaries):
 * a quoted query matches any substring, and `rank` orders by bm25.
 */
export interface IndexHit {
  runId: string
  seq: number
  kind: string
  ts: number
  snippet: string
}

export interface IndexStatus {
  path: string
  files: number
  sessions: number
  events: number
  bytes: number
}

export interface IndexOptions {
  /** Only events of runs that started in this workspace. */
  cwd?: string
  /** The caller's own run id, so it does not search itself. */
  excludeRunId?: string
  limit?: number
}

/** Text of an event, or undefined when it is not worth searching. */
export function searchableText(event: SessionEvent): string | undefined {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const content = (value: unknown): string => (typeof value === 'string' ? value : '')
  switch (event.type) {
    case 'user/message':
    case 'user/steer':
      return content(payload.content) || undefined
    case 'assistant/message': {
      const text = content(payload.content)
      // Tool calls are JSON, not prose; indexing them only adds noise.
      if (!text || /^\s*\{\s*"(?:tool|calls)"/.test(text)) return undefined
      return text
    }
    case 'tool/result':
      return content(payload.output).slice(0, 4_000) || undefined
    default:
      return undefined
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  indexed_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  run_id TEXT PRIMARY KEY,
  cwd TEXT,
  first_ts INTEGER,
  last_ts INTEGER,
  last_seq INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  run_id UNINDEXED,
  seq UNINDEXED,
  kind,
  ts UNINDEXED,
  text,
  tokenize='trigram'
);
`

export class SessionIndex {
  private readonly db: DatabaseSync

  constructor(
    readonly file: string,
    private readonly cwd: string,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    try {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec(SCHEMA)
    } catch (error) {
      // Never leak the handle: a locked file would survive in the state dir.
      try {
        this.db.close()
      } catch {
        // Already gone.
      }
      throw error
    }
  }

  /** Opens (or creates) the index under the state directory. A corrupt file is replaced. */
  static open(stateDir: string, cwd: string): SessionIndex {
    const file = path.join(stateDir, 'index', 'session-fts.db')
    try {
      return new SessionIndex(file, path.resolve(cwd))
    } catch {
      // SQLite could not even open it (not a database): the log is the truth.
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(`${file}${suffix}`, { force: true })
        } catch {
          // Nothing to remove.
        }
      }
      return new SessionIndex(file, path.resolve(cwd))
    }
  }

  /**
   * Indexes what the log gained since the last call. Only complete lines are
   * consumed, so a torn write is picked up next time.
   */
  sync(logFile: string): number {
    let offset = 0
    let sinceSeq = 0
    try {
      const row = this.db.prepare('SELECT offset, indexed_seq FROM files WHERE path = ?').get(logFile) as
        | { offset: number; indexed_seq: number }
        | undefined
      if (row) {
        offset = Number(row.offset)
        sinceSeq = Number(row.indexed_seq)
      }
    } catch {
      // A corrupt index is rebuilt below; the log is the truth.
      this.reset()
    }
    let buffer: Buffer
    try {
      const stat = fs.statSync(logFile)
      if (stat.size <= offset) return 0
      const fd = fs.openSync(logFile, 'r')
      try {
        buffer = Buffer.alloc(stat.size - offset)
        fs.readSync(fd, buffer, 0, buffer.length, offset)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return 0
    }
    const end = buffer.lastIndexOf(0x0a)
    if (end < 0) return 0
    const complete = buffer.subarray(0, end + 1)
    const events: SessionEvent[] = []
    for (const line of complete.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as SessionEvent)
      } catch {
        // Ignore an unparsable line; it cannot be indexed either way.
      }
    }
    if (events.length === 0) {
      this.rememberFile(logFile, offset + complete.length, sinceSeq)
      return 0
    }
    const insert = this.db.prepare('INSERT INTO events_fts (run_id, seq, kind, ts, text) VALUES (?, ?, ?, ?, ?)')
    const session = this.db.prepare(
      `INSERT INTO sessions (run_id, cwd, first_ts, last_ts, last_seq) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         last_ts = excluded.last_ts,
         last_seq = excluded.last_seq`,
    )
    let added = 0
    this.db.exec('BEGIN')
    try {
      for (const event of events) {
        if (event.seq <= sinceSeq || !event.runId) continue
        const text = searchableText(event)
        if (!text) continue
        insert.run(event.runId, event.seq, event.type, event.ts, text)
        session.run(event.runId, this.cwd, event.ts, event.ts, event.seq)
        added += 1
      }
      this.db.prepare(
        `INSERT INTO files (path, offset, indexed_seq) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, indexed_seq = excluded.indexed_seq`,
      ).run(
        logFile,
        offset + complete.length,
        events.reduce((max, event) => Math.max(max, event.seq), sinceSeq),
      )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return added
  }

  /** Drops the index and rebuilds it from the log (also the corruption recovery). */
  rebuild(logFile: string): number {
    this.reset()
    return this.sync(logFile)
  }

  search(query: string, options: IndexOptions = {}): IndexHit[] {
    const text = query.trim()
    if (!text) return []
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100))
    const filters: string[] = []
    const params: Array<string | number> = []
    if (options.excludeRunId) {
      filters.push('e.run_id <> ?')
      params.push(options.excludeRunId)
    }
    if (options.cwd) {
      filters.push('s.cwd = ?')
      params.push(path.resolve(options.cwd))
    }
    const where = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : ''
    // Trigram needs three characters; shorter queries fall back to LIKE so a
    // one-character search still answers instead of silently returning nothing.
    const sql =
      text.length >= 3
        ? `SELECT e.run_id, e.seq, e.kind, e.ts, snippet(events_fts, 4, '', '', '…', 16) AS snippet
           FROM events_fts e JOIN sessions s ON s.run_id = e.run_id
           WHERE events_fts MATCH ?${where}
           ORDER BY rank LIMIT ?`
        : `SELECT e.run_id, e.seq, e.kind, e.ts, substr(e.text, 1, 240) AS snippet
           FROM events_fts e JOIN sessions s ON s.run_id = e.run_id
           WHERE e.text LIKE ?${where}
           ORDER BY e.ts DESC LIMIT ?`
    const binding = text.length >= 3 ? [`"${text.replace(/"/g, '""')}"`, ...params, limit] : [`%${text}%`, ...params, limit]
    try {
      const rows = this.db.prepare(sql).all(...binding) as Array<{
        run_id: string
        seq: number
        kind: string
        ts: number
        snippet: string
      }>
      return rows.map((row) => ({
        runId: String(row.run_id),
        seq: Number(row.seq),
        kind: String(row.kind),
        ts: Number(row.ts),
        snippet: String(row.snippet ?? ''),
      }))
    } catch {
      // A corrupt index is rebuilt from the log and the query retried once.
      this.rebuildFromKnownLogs()
      return []
    }
  }

  status(): IndexStatus {
    const count = (sql: string): number => {
      try {
        const row = this.db.prepare(sql).get() as { n?: number } | undefined
        return Number(row?.n ?? 0)
      } catch {
        return 0
      }
    }
    let bytes = 0
    try {
      bytes = fs.statSync(this.file).size
    } catch {
      bytes = 0
    }
    return {
      path: this.file,
      files: count('SELECT COUNT(*) AS n FROM files'),
      sessions: count('SELECT COUNT(*) AS n FROM sessions'),
      events: count('SELECT COUNT(*) AS n FROM events_fts'),
      bytes,
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }

  private rememberFile(logFile: string, offset: number, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO files (path, offset, indexed_seq) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, indexed_seq = excluded.indexed_seq`,
      )
      .run(logFile, offset, seq)
  }

  private reset(): void {
    this.db.exec('DROP TABLE IF EXISTS events_fts')
    this.db.exec('DROP TABLE IF EXISTS sessions')
    this.db.exec('DROP TABLE IF EXISTS files')
    this.db.exec(SCHEMA)
  }

  /** Re-indexes every log this index has seen (the offsets are kept per file). */
  private rebuildFromKnownLogs(): void {
    let files: string[] = []
    try {
      files = (this.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map((row) => String(row.path))
    } catch {
      files = []
    }
    this.reset()
    for (const file of files) this.sync(file)
  }
}
