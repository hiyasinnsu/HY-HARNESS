import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { SESSION_FORMAT_VERSION, hasFormatHeader, migrateSessionEvents } from './session-format.js'

export interface SessionEvent {
  v: 1
  /** Monotonic per log file, across sessions (design §1): ledger ordering uses it. */
  seq: number
  ts: number
  sessionId: string
  /** Set for every event of a run (`hy run` / a `hy ralph` objective). */
  runId?: string
  round?: number
  type: string
  payload: unknown
}

/**
 * Reads a log, ignoring a truncated last line (design §1) and migrating the
 * events of an older format in memory (WP-20). The file itself is never
 * rewritten; writing always uses the current format.
 */
export function readEvents(file: string): SessionEvent[] {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: SessionEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as SessionEvent)
    } catch {
      // A crash mid-write leaves at most one partial line.
    }
  }
  return migrateSessionEvents(out).events
}

/** Last seq per log file, shared by every SessionLog of this process. */
const lastSeq = new Map<string, number>()

const sleepCell = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms)
}

/**
 * Runs `write` while holding `<file>.lock`, so the GUI, the CLI and automation
 * appending to the same log take turns. A lock older than 10 s belongs to a
 * crashed writer and is taken over; after 5 s of waiting the write goes ahead
 * without it rather than losing the event.
 */
function withFileLock<T>(file: string, write: () => T): T {
  const lock = `${file}.lock`
  const deadline = Date.now() + 5_000
  let fd: number | undefined
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') break
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { force: true })
      } catch {
        // Released meanwhile.
      }
      if (Date.now() > deadline) break
      sleepSync(2)
    }
  }
  try {
    return write()
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd)
      fs.rmSync(lock, { force: true })
    }
  }
}

/**
 * The seq of the file's last complete event, and whether the file ends in a
 * partial line (a crash mid-write). Reads only the tail.
 */
function tailState(file: string): { seq: number; partial: boolean } {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return { seq: 0, partial: false }
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size === 0) return { seq: 0, partial: false }
    const length = Math.min(size, 256 * 1024)
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    const text = buffer.toString('utf8')
    const partial = !text.endsWith('\n')
    const lines = text.split('\n')
    if (partial) lines.pop()
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line) continue
      try {
        const seq = (JSON.parse(line) as { seq?: unknown }).seq
        if (typeof seq === 'number') return { seq, partial }
      } catch {
        // The cut first line of the tail window, or a damaged line.
      }
    }
    return { seq: 0, partial }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Appends one event under the file lock. Its seq continues from the larger of
 * this process's counter and the file itself, so events another process
 * wrote are never numbered over (the search index skips seq it has seen). A
 * partial last line left by a crash is ended first, so it stays one bad line
 * instead of swallowing the new event.
 */
function appendEvent(file: string, build: (seq: number) => SessionEvent): SessionEvent {
  return withFileLock(file, () => {
    const tail = tailState(file)
    const seq = Math.max(lastSeq.get(file) ?? 0, tail.seq) + 1
    const event = build(seq)
    fs.appendFileSync(file, `${tail.partial ? '\n' : ''}${JSON.stringify(event)}\n`, 'utf8')
    lastSeq.set(file, seq)
    return event
  })
}

/** Files whose format header this process has already written. */
const formatHeaders = new Set<string>()

export class SessionLog {
  readonly sessionId = randomUUID()
  private runId?: string
  private round: number | undefined
  /** Whether this file already declares its format (WP-20). */
  private hasHeader: boolean

  constructor(readonly file: string) {
    // Continue the file's numbering so seq orders events of all sessions in it.
    const events = readEvents(file)
    this.hasHeader = formatHeaders.has(file) || hasFormatHeader(events)
    if (!lastSeq.has(file)) lastSeq.set(file, events.reduce((max, e) => Math.max(max, e.seq ?? 0), 0))
  }

  /** Tags the following events with a run (and a ralph round). */
  setRun(runId: string, round?: number): void {
    this.runId = runId
    this.round = round
  }

  get currentRunId(): string | undefined {
    return this.runId
  }

  append(type: string, payload: unknown): SessionEvent {
    // Every file starts with its format, exactly once, so a future reader knows
    // which migration to apply without guessing from the first event shape.
    if (!this.hasHeader) {
      this.hasHeader = true
      if (!formatHeaders.has(this.file)) {
        formatHeaders.add(this.file)
        this.writeEvent('session/format', { format: SESSION_FORMAT_VERSION })
      }
    }
    return this.writeEvent(type, payload)
  }

  /** CP-31: an event with its original time (imported histories). */
  appendAt(type: string, payload: unknown, ts: number): SessionEvent {
    if (!this.hasHeader) {
      this.hasHeader = true
      if (!formatHeaders.has(this.file)) {
        formatHeaders.add(this.file)
        this.writeEvent('session/format', { format: SESSION_FORMAT_VERSION })
      }
    }
    return this.writeAt(type, payload, ts)
  }

  private writeEvent(type: string, payload: unknown): SessionEvent {
    return this.writeAt(type, payload, Date.now())
  }

  private writeAt(type: string, payload: unknown, ts: number): SessionEvent {
    return appendEvent(this.file, (seq) => ({
      v: 1,
      seq,
      ts,
      sessionId: this.sessionId,
      ...(this.runId !== undefined ? { runId: this.runId } : {}),
      ...(this.round !== undefined ? { round: this.round } : {}),
      type,
      payload,
    }))
  }

  /**
   * WP-60: appends events that happened elsewhere (a session fork). The history
   * keeps its original timestamps, while `seq` and `sessionId` are fresh so the
   * shared log stays monotonic and each event belongs to this writer.
   */
  importEvents(events: readonly { ts: number; type: string; payload: unknown; runId?: string; round?: number }[]): SessionEvent[] {
    if (!this.hasHeader) {
      this.hasHeader = true
      if (!formatHeaders.has(this.file)) {
        formatHeaders.add(this.file)
        this.writeAt('session/format', { format: SESSION_FORMAT_VERSION }, Date.now())
      }
    }
    const out: SessionEvent[] = []
    for (const event of events) {
      const written = appendEvent(this.file, (seq) => ({
        v: 1,
        seq,
        ts: event.ts,
        sessionId: this.sessionId,
        ...(event.runId !== undefined ? { runId: event.runId } : this.runId !== undefined ? { runId: this.runId } : {}),
        ...(event.round !== undefined ? { round: event.round } : {}),
        type: event.type,
        payload: event.payload,
      }))
      out.push(written)
    }
    return out
  }

  events(): SessionEvent[] {
    return readEvents(this.file)
  }
}
