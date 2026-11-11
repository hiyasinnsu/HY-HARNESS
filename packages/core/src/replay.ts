// F1: replay saved sessions through the current agent loop, without a model.
//
// Each agent run in a session log (from `session/snapshot` to `turn/end` or
// `turn/error`) is replayed: a provider returns the replies the model actually
// gave, in order, and the tools return the results that were recorded. The
// decisions the current code makes (run these tools, send this reply back for
// this reason, stop, finish) are compared with the decisions in the log. A
// change to the reply guards, the loop guards or the verification gate shows
// up as a divergence on real history, at no API cost.
//
// Limits, stated in the report rather than hidden:
// - Some rejected replies were never logged (a retry that does not carry the
//   assistant text); the replay stops there (`unreplayable`).
// - Once the current code decides differently, the model's later replies no
//   longer apply; the replay stops at the first divergence.
// - Compaction is not replayed: a run that compacted is replayed up to that
//   point only.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Agent } from './agent.js'
import type { ChatMessage, CompleteOptions, Completion, ToolCall } from './llm.js'
import { SessionLog, type SessionEvent } from './session-log.js'
import { ToolRuntime } from './tools.js'

/** One decision of the agent loop, in a form the log and the replay share. */
export type ReplayDecision = string

interface RunSlice {
  runId: string
  startSeq: number
  events: SessionEvent[]
}

export interface ReplayResult {
  runId: string
  startSeq: number
  status: 'same' | 'diverged' | 'unreplayable'
  logged: ReplayDecision[]
  replayed: ReplayDecision[]
  /** Index into `logged` / `replayed` of the first difference. */
  divergedAt?: number
  note?: string
}

class ReplayExhausted extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplayExhausted'
  }
}

/** The decisions a slice of log events records (also used on the replay's own log). */
export function decisionsOf(events: readonly SessionEvent[]): ReplayDecision[] {
  const out: ReplayDecision[] = []
  let pendingTools: string[] = []
  const flush = () => {
    if (pendingTools.length) out.push(`tools:${pendingTools.join(',')}`)
    pendingTools = []
  }
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>
    switch (e.type) {
      case 'tool/result':
        pendingTools.push(String(p.name ?? '?'))
        break
      case 'turn/retry':
        flush()
        out.push(`retry:${String(p.reason ?? '?')}`)
        break
      case 'turn/nudge':
        flush()
        out.push(`nudge:${String(p.reason ?? '?')}`)
        break
      case 'turn/failure':
        flush()
        out.push(`stop:${String(p.reason ?? '?')}`)
        break
      case 'step/end':
        flush()
        break
      case 'turn/end': {
        flush()
        const status = String(p.status ?? '?')
        // `stop:<reason>` already covers a failure's turn/end.
        if (status !== 'stalled' || !out.at(-1)?.startsWith('stop:')) out.push(`end:${status}`)
        break
      }
      default:
        break
    }
  }
  flush()
  return out
}

/** Splits a session log into agent runs (one `Agent.run` each). */
export function agentRuns(events: readonly SessionEvent[]): RunSlice[] {
  const runs: RunSlice[] = []
  const open = new Map<string, RunSlice>()
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const runId = e.runId ?? ''
    if (e.type === 'session/snapshot') {
      const slice = { runId, startSeq: e.seq, events: [e] }
      open.set(runId, slice)
      runs.push(slice)
      continue
    }
    const slice = open.get(runId)
    if (!slice) continue
    slice.events.push(e)
    if (e.type === 'turn/end' || e.type === 'turn/error') open.delete(runId)
  }
  return runs.filter((run) => run.events.some((e) => e.type === 'turn/end'))
}

function nativeCallsOf(content: string, ids: unknown): ToolCall[] | undefined {
  if (!Array.isArray(ids)) return undefined
  try {
    const parsed = JSON.parse(content) as { tool?: string; args?: unknown; calls?: Array<{ tool?: string; args?: unknown }> }
    const list = Array.isArray(parsed.calls) ? parsed.calls : [parsed]
    if (list.length !== ids.length) return undefined
    return list.map((call, i) => ({ id: String(ids[i]), name: String(call.tool), args: call.args }))
  } catch {
    return undefined
  }
}

/** The model replies of a run, one per `step/end`, or the step where the raw text was not logged. */
function repliesOf(slice: RunSlice): { replies: Completion[]; missingAt?: number; native: boolean; compactedAt?: number } {
  const replies: Completion[] = []
  let native = false
  let current: Completion | undefined
  let stepOpen = false
  let missingAt: number | undefined
  let compactedAt: number | undefined
  let usage: Completion['usage'] = { inputTokens: 1, outputTokens: 1 }
  const close = () => {
    if (!stepOpen) return
    if (current) replies.push(current)
    else if (missingAt === undefined) missingAt = replies.length
    current = undefined
    stepOpen = false
  }
  for (const e of slice.events) {
    const p = (e.payload ?? {}) as Record<string, unknown>
    if (e.type === 'step/end') {
      close()
      stepOpen = true
      if (p.replyChannel === 'native') native = true
      usage = (p.usage ?? { inputTokens: 1, outputTokens: 1 }) as Completion['usage']
      continue
    }
    if (!stepOpen || current) continue
    if (e.type === 'assistant/message') {
      const content = String(p.content ?? '')
      const calls = nativeCallsOf(content, p.toolCallIds)
      if (calls) native = true
      current = calls ? { content: '', toolCalls: calls, usage } : { content, usage }
    } else if ((e.type === 'turn/retry' || e.type === 'turn/failure') && typeof p.assistant === 'string') {
      current = { content: p.assistant, usage }
    } else if (e.type === 'compaction/summary' || e.type === 'compaction/result' || e.type === 'context/forced-compaction') {
      if (compactedAt === undefined) compactedAt = replies.length
    }
  }
  close()
  return { replies, ...(missingAt !== undefined ? { missingAt } : {}), native, ...(compactedAt !== undefined ? { compactedAt } : {}) }
}

/** Logged tool outputs, in call order, as what `ToolRuntime.execute` returned or threw. */
function toolResultsOf(slice: RunSlice): Array<{ ok: boolean; value: unknown }> {
  return slice.events.filter((e) => e.type === 'tool/result').map((e) => {
    const p = (e.payload ?? {}) as { output?: unknown; isError?: unknown }
    const output = String(p.output ?? '')
    // Guard reminders are appended after the JSON; the JSON is what the tool returned.
    const end = output.lastIndexOf('}')
    let value: unknown = { output }
    for (const candidate of [output, end >= 0 ? output.slice(0, end + 1) : '']) {
      if (!candidate) continue
      try {
        value = JSON.parse(candidate)
        break
      } catch {
        // Not JSON: keep the text.
      }
    }
    // A failed shell command is a result (exitCode != 0), not a thrown error.
    const isShellFailure = p.isError === true && typeof (value as { exitCode?: unknown })?.exitCode === 'number'
    return p.isError === true && !isShellFailure ? { ok: false, value: output } : { ok: true, value }
  })
}

function objectiveOf(slice: RunSlice): string {
  const message = slice.events.find((e) => e.type === 'user/message')
  const p = (message?.payload ?? {}) as { content?: unknown; sent?: unknown }
  return String(p.sent ?? p.content ?? '')
}

export async function replayRun(slice: RunSlice, options: { agent?: Record<string, unknown> } = {}): Promise<ReplayResult> {
  const logged = decisionsOf(slice.events)
  const { replies, missingAt, native, compactedAt } = repliesOf(slice)
  const results = toolResultsOf(slice)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-replay-'))
  const log = new SessionLog(path.join(dir, 'replay.jsonl'))
  log.setRun(slice.runId)
  let served = 0
  let toolIndex = 0
  const limit = Math.min(missingAt ?? Infinity, compactedAt ?? Infinity)
  const provider = {
    name: 'replay',
    complete: async (_messages: ChatMessage[], _options: CompleteOptions): Promise<Completion> => {
      if (served >= limit || served >= replies.length) {
        throw new ReplayExhausted(served === missingAt ? 'the logged reply at this step was not recorded' : served === compactedAt ? 'the run compacted here' : 'the current code asked for more replies than the model gave')
      }
      return replies[served++]!
    },
  }
  const tools = new ToolRuntime({} as never, dir)
  ;(tools as unknown as { execute: unknown }).execute = async () => {
    const next = results[toolIndex++]
    if (!next) throw new ReplayExhausted('the current code ran more tools than were recorded')
    if (!next.ok) throw new Error(String(next.value))
    return next.value
  }
  let note: string | undefined
  let replayed: ReplayDecision[]
  try {
    try {
      await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir, nativeTools: native, ...options.agent }).run(objectiveOf(slice))
    } catch (error) {
      note = error instanceof Error ? error.message : String(error)
    }
    // Read before the temporary directory (and the log in it) is removed.
    replayed = decisionsOf(log.events())
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  let divergedAt: number | undefined
  for (let i = 0; i < Math.max(logged.length, replayed.length); i += 1) {
    if (logged[i] !== replayed[i]) {
      divergedAt = i
      break
    }
  }
  const stoppedEarly = note !== undefined && (missingAt !== undefined || compactedAt !== undefined) && served >= limit
  const status = divergedAt === undefined ? 'same' : stoppedEarly && divergedAt >= replayed.length ? 'unreplayable' : 'diverged'
  return { runId: slice.runId, startSeq: slice.startSeq, status, logged, replayed, ...(divergedAt !== undefined ? { divergedAt } : {}), ...(note ? { note } : {}) }
}
