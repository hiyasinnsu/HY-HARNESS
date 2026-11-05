import type { TurnQueueView } from './types.js'
import { apiPath } from './api.gen.js'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  const raw = await response.text()
  let value: unknown
  try {
    value = raw ? JSON.parse(raw) : {}
  } catch {
    value = { error: raw }
  }
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value ? String((value as { error: unknown }).error) : response.statusText
    throw new ApiError(message, response.status)
  }
  return value as T
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

export function put<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: 'PUT', body: JSON.stringify(body) })
}

/** Current queue of turns waiting for `runId`, plus the paused and uncertain state. */
export function fetchTurnQueue(runId: string): Promise<TurnQueueView> {
  return api<TurnQueueView>(`/api/turn-queue?runId=${encodeURIComponent(runId)}`)
}

export interface QueuedTurnInput {
  runId: string
  id: string
  message: string
  images?: Array<{ mimeType: string; data: string }>
}

/** Queues a turn while another one is running; the server replies with the new view. */
export function queueTurn(input: QueuedTurnInput): Promise<TurnQueueView> {
  return post<TurnQueueView>('/api/turn-queue', input)
}

/** Cancels one queued turn, or every queued turn when `id` is omitted. */
export function cancelQueuedTurn(runId: string, id?: string): Promise<TurnQueueView> {
  return post<TurnQueueView>('/api/turn-queue/cancel', { runId, ...(id === undefined ? {} : { id }) })
}

/** Lets a paused queue run again (explicit user action; nothing resumes on its own). */
export function resumeTurnQueue(runId: string): Promise<TurnQueueView> {
  return post<TurnQueueView>('/api/turn-queue/resume', { runId })
}

/** Resends or discards a turn whose outcome is unknown after a crash. */
export function resolveQueuedTurn(runId: string, id: string, decision: 'resend' | 'discard'): Promise<TurnQueueView> {
  return post<TurnQueueView>('/api/turn-queue/resolve', { runId, id, decision })
}

/** Reply to a rename; the title is null when the automatic name was restored. */
export interface SessionTitleResult {
  runId: string
  title: string | null
}

/**
 * Sets a chat's name. An empty title clears the override, so the automatic name
 * taken from the first message shows again. Trimming and validation stay on the
 * server, next to the other surfaces that read the same name.
 */
export function setSessionTitle(runId: string, title: string): Promise<SessionTitleResult> {
  return post<SessionTitleResult>(`/api/sessions/${encodeURIComponent(runId)}/title`, { title })
}

export function sessionEvents(runId: string): EventSource {
  return new EventSource(`/api/sessions/${encodeURIComponent(runId)}/events`)
}

/** WP-60: a model-generated chat name; `source` says who answered. */
export interface GeneratedTitle {
  runId: string
  title: string
  source: 'llm' | 'heuristic'
  reason?: string
  /** What the sidebar will show (a manual name outranks the generated one). */
  effective: string
}

export function generateTitle(runId: string, from: 'first' | 'all' = 'first'): Promise<GeneratedTitle> {
  return post<GeneratedTitle>(`/api/sessions/${encodeURIComponent(runId)}/title/generate`, { from })
}

export function globalEvents(): EventSource {
  return new EventSource('/api/events')
}
