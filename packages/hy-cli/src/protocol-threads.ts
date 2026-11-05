// CP-25: thread/list and thread/read over the session log.
//
// HY-HARNESS keeps one `session.v1.jsonl` per workspace state; a **run** is one
// conversation (GUI chat, `hy run`, …) and appends its turns to that file. The
// protocol therefore exposes threads as runs: threadId is the run id.
//
// (Round 31 first modelled one file per thread; that was wrong for this
// codebase and is corrected here.)

import { readEvents, type SessionEvent } from '../../core/dist/index.js'
import { ERROR, ProtocolRpcError } from './protocol.js'

export interface ThreadSummary {
  threadId: string
  title: string
  updatedAt: number
  /** Assistant-visible turns (user messages) in the run. */
  turns: number
  events: number
}

export interface ThreadView {
  threadId: string
  title: string
  total: number
  items: Array<{ role: 'user' | 'assistant' | 'tool' | 'error'; text: string; ts: number; name?: string }>
}

function eventsOf(file: string): SessionEvent[] {
  try {
    return readEvents(file)
  } catch {
    return []
  }
}

function titleOf(events: readonly SessionEvent[]): string {
  const first = events.find((event) => event.type === 'user/message')
  const text = String((first?.payload as { content?: unknown } | undefined)?.content ?? '').trim()
  return text.split('\n')[0]!.slice(0, 80)
}

/** CP-25: newest first, one entry per run. */
export function listThreads(logFile: string, options: { limit?: number } = {}): ThreadSummary[] {
  const byRun = new Map<string, SessionEvent[]>()
  for (const event of eventsOf(logFile)) {
    if (typeof event.runId !== 'string' || event.runId.length === 0) continue
    const list = byRun.get(event.runId)
    if (list) list.push(event)
    else byRun.set(event.runId, [event])
  }
  const threads: ThreadSummary[] = []
  for (const [threadId, events] of byRun) {
    threads.push({
      threadId,
      title: titleOf(events),
      updatedAt: events.at(-1)!.ts,
      turns: events.filter((event) => event.type === 'user/message').length,
      events: events.length,
    })
  }
  const sorted = threads.sort((a, b) => b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId))
  const limit = options.limit === undefined ? sorted.length : Math.max(0, Math.floor(options.limit))
  return sorted.slice(0, limit)
}

/** CP-25: the readable transcript of one run. */
export function readThread(logFile: string, threadId: string, options: { offset?: number; limit?: number } = {}): ThreadView {
  const events = eventsOf(logFile).filter((event) => event.runId === threadId)
  if (events.length === 0) throw new ProtocolRpcError(ERROR.invalidParams, `unknown thread ${threadId}`)
  const items: ThreadView['items'] = []
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    if (event.type === 'user/message') {
      const text = String(payload.content ?? '').trim()
      if (text) items.push({ role: 'user', text, ts: event.ts })
    } else if (event.type === 'assistant/message') {
      const text = String(payload.content ?? '').trim()
      if (text) items.push({ role: 'assistant', text, ts: event.ts })
    } else if (event.type === 'tool/result' || event.type === 'tool-error') {
      const name = typeof payload.name === 'string' ? payload.name : undefined
      const output = event.type === 'tool-error' ? String(payload.message ?? '') : String(payload.output ?? '')
      items.push({
        role: event.type === 'tool-error' ? 'error' : 'tool',
        text: output.slice(0, 2_000),
        ts: event.ts,
        ...(name ? { name } : {}),
      })
    }
  }
  const start = Math.max(0, options.offset ?? 0)
  const limit = options.limit === undefined ? items.length : Math.max(0, options.limit)
  return { threadId, title: titleOf(events), total: items.length, items: items.slice(start, start + limit) }
}