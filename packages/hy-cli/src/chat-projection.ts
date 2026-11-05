import type { AgentEvent, SessionEvent } from '../../core/dist/index.js'
import { cleanThinkingSummary, instantThinkingSummary } from './summary-text.js'

export interface ChatToolEntry {
  id: string
  kind: 'tool'
  runId: string
  callId: string
  name: string
  args?: unknown
  output?: string
  result?: unknown
  isError?: boolean
  /** CP-06: why the call was blocked (`policy`/`approval`/`sandbox`/…). */
  denial?: string
  step?: number
  subagent?: string
  ts: number
  status: 'running' | 'done' | 'error'
}

export interface ChatPlanStep {
  step: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** One file the model showed with `present` (WP-23). */
export interface DeliverableFile {
  path: string
  size: number
  lines: number
  description?: string
}

export type ChatEntry =
  | { id: string; kind: 'user'; runId: string; text: string; ts: number; images?: number; steering?: boolean; turn?: number }
  | { id: string; kind: 'assistant'; runId: string; text: string; ts: number; final?: boolean }
  | { id: string; kind: 'thinking'; runId: string; text: string; ts: number; summary?: string; summaryProvisional?: boolean }
  | ChatToolEntry
  | { id: string; kind: 'plan'; runId: string; plan: ChatPlanStep[]; ts: number }
  | { id: string; kind: 'deliverables'; runId: string; files: DeliverableFile[]; ts: number }
  | { id: string; kind: 'notice'; runId: string; text: string; ts: number; level?: 'info' | 'warn' | 'error' }
  | { id: string; kind: 'approval'; runId: string; requestId: string; request: unknown; ts: number; decision?: 'approved' | 'denied'; details?: unknown; reason?: string; scope?: 'once' | 'session' | 'always' }
  | { id: string; kind: 'question'; runId: string; requestId: string; question: string; ts: number; answer?: string }

interface Action {
  tool?: string
  args?: unknown
  calls?: unknown[]
  final?: unknown
}

function stripFence(text: string): string {
  const t = text.trim()
  if (t.startsWith('```')) return t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim()
  return t
}

/** The plan of an `update_plan` / `todo_write` call, in the card's shape. */
function planStepsOf(args: { plan?: unknown; todos?: unknown }): ChatPlanStep[] | undefined {
  const raw = Array.isArray(args.plan) ? args.plan : Array.isArray(args.todos) ? args.todos : undefined
  if (!raw) return undefined
  const plan: ChatPlanStep[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const step = String(record.step ?? record.content ?? '').trim()
    if (!step) continue
    plan.push({ step, status: record.status === 'in_progress' || record.status === 'completed' ? record.status : 'pending' })
  }
  return plan.length > 0 ? plan : undefined
}

/** `deliverable/presented` payload → card entries. */
function deliverableFilesOf(raw: unknown): DeliverableFile[] {
  if (!Array.isArray(raw)) return []
  const files: DeliverableFile[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const path = String(record.path ?? '').trim()
    if (!path) continue
    files.push({
      path,
      size: Number(record.size ?? 0),
      lines: Number(record.lines ?? 0),
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
    })
  }
  return files
}

/** Parses the model's action JSON, including a JSON object embedded in prose. */
export function parseModelAction(text: string): Action | undefined {
  const t = stripFence(text)
  try {
    const parsed = JSON.parse(t) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Action
  } catch {
    // Fall through to the first balanced object.
  }
  const start = t.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < t.length; i++) {
    const c = t[i]!
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1)) as Action
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

function parseCalls(action: Action | undefined): Array<{ tool: string; args?: unknown }> {
  if (!action) return []
  if (Array.isArray(action.calls)) {
    return action.calls
      .filter((c): c is { tool: string; args?: unknown } => !!c && typeof c === 'object' && typeof (c as { tool?: unknown }).tool === 'string')
      .map((c) => ({ tool: c.tool, args: c.args }))
  }
  if (typeof action.tool === 'string') return [{ tool: action.tool, args: action.args }]
  return []
}

function parseResult(output: string): unknown {
  const t = output.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined
  try {
    return JSON.parse(t) as unknown
  } catch {
    return undefined
  }
}

const INTERNAL_USER_PREFIXES = [
  'Your previous reply was not a single valid JSON object',
  'Your final answer does not match the required schema',
  'This run finishes only through claim_complete',
  'Reply with either {"tool"',
]

function isInternalUserMessage(text: string, previousType: string): boolean {
  if (previousType === 'turn/retry' || previousType === 'turn/nudge') return true
  return INTERNAL_USER_PREFIXES.some((p) => text.startsWith(p))
}

/** Lines that can only belong to the `[workspace roots]` catalog. */
const WORKSPACE_ROOT_LINE =
  /^(?:- [^\n]*|Use "rootId:[^\n]*|For shell, cwd[^\n]*|Extra-root shell[^\n]*|Only the primary root[^\n]*)$/

/**
 * Drops the `[workspace roots]` catalog older turns prefixed to the user
 * message: the header, its `- <id>: <path> (mode)` rows and the usage notes.
 * Text without the header is returned unchanged. The catalog is joined to the
 * user text by a blank line, so that boundary wins; the known line shapes are
 * only a fallback for a log written without one.
 */
function stripWorkspaceRoots(text: string): string {
  const header = '[workspace roots]'
  if (!text.startsWith(header)) return text
  const rest = text.slice(header.length)
  if (!rest.trim()) return ''
  if (!rest.startsWith('\n')) return text
  const body = rest.slice(1)
  const boundary = body.indexOf('\n\n')
  if (boundary >= 0) return body.slice(boundary + 2)
  const lines = body.split('\n')
  let index = 0
  while (index < lines.length && WORKSPACE_ROOT_LINE.test(lines[index] ?? '')) index += 1
  return lines.slice(index).join('\n')
}

/**
 * Removes the context the harness prefixes to a user turn (`[session goal: …]`,
 * `[plan mode: …]`, the root catalog) from what the chat surface shows. A turn
 * may carry several of them, so the stripping repeats until it is stable.
 */
export function stripPlanPrefix(text: string): string {
  let out = text
  for (;;) {
    const before = out
    out = stripWorkspaceRoots(
      out
        .replace(/^\[session goal: [^\]]*\]\n?/, '')
        .replace(/^\[plan mode: read-only\.[^\]]*\]\n?/, '')
        // WP-60: `@session:` context blocks are for the model, not the chat.
        .replace(/\n*\[session reference [^\]]*\]\n[\s\S]*?\[\/session reference\]\n*/g, '')
        // CP-21: `@skill:` blocks and the not-installed note are context too.
        .replace(/\n*<skill name="[^"]*">\n[\s\S]*?\n<\/skill>/g, '')
        .replace(/\n*\[not installed skills: [^\]]*\]/g, '')
        .replace(/^\n+/, ''),
    )
    if (out === before) break
  }
  return out
}

/**
 * Reconstructs the chat surface from a run's durable session events. This is
 * what the GUI shows after a reload; live updates use the same entry shapes.
 */
export function projectChat(events: readonly SessionEvent[], runId: string): ChatEntry[] {
  const entries: ChatEntry[] = []
  const turnStartIndex = new Map<number, number>()
  // Tool results are logged in call order, so a queue is more reliable than
  // deriving call ids from the step counter (the log writes step/end first).
  const pendingCalls: Array<{ tool: string; args?: unknown }> = []
  // CP-06: a denial is logged just before its tool/result, so remember it by
  // call id until the result creates the card.
  const denials = new Map<string, string>()
  let previousType = ''
  // CP-33: the turn a user message opened, so the GUI can rewind to it.
  let currentTurn = 0
  let taggedTurn = 0

  for (const e of events) {
    if (e.runId !== runId) continue
    const p = (e.payload ?? {}) as Record<string, unknown>
    const ts = e.ts
    switch (e.type) {
      case 'turn/start': {
        const turn = Number(p.turn ?? 0)
        pendingCalls.length = 0
        turnStartIndex.set(turn, entries.length)
        currentTurn = turn
        break
      }
      case 'turn/undo': {
        const turn = Number(p.turn ?? 0)
        pendingCalls.length = 0
        const at = turnStartIndex.get(turn)
        if (at !== undefined) entries.length = at
        currentTurn = turn - 1
        taggedTurn = Math.min(taggedTurn, currentTurn)
        break
      }
      case 'user/message': {
        const text = stripPlanPrefix(String(p.content ?? ''))
        if (!text || isInternalUserMessage(text, previousType)) break
        if (p.source === 'orchestrator' || p.source === 'worker' || p.source === 'system') {
          entries.push({ id: `event-${e.seq}`, kind: 'notice', runId, text, ts })
          break
        }
        const opens = currentTurn > taggedTurn
        if (opens) taggedTurn = currentTurn
        entries.push({ id: `msg-${e.seq}`, kind: 'user', runId, text, ts, ...(Number(p.images ?? 0) > 0 ? { images: Number(p.images) } : {}), ...(opens ? { turn: currentTurn } : {}) })
        break
      }
      // WP-21: a steering message keeps the user's text verbatim and is marked
      // so the transcript can show it as an interjection rather than a new turn.
      case 'user/steer': {
        const text = String(p.content ?? '')
        if (!text) break
        entries.push({
          id: `msg-${e.seq}`,
          kind: 'user',
          runId,
          text,
          ts,
          steering: true,
          ...(Number(p.images ?? 0) > 0 ? { images: Number(p.images) } : {}),
        })
        break
      }
      case 'assistant/thinking': {
        const content = String(p.content ?? '').trim()
        if (content) {
          const summary = instantThinkingSummary(content)
          entries.push({
            id: `think-${e.seq}`,
            kind: 'thinking',
            runId,
            text: content,
            ts,
            ...(summary ? { summary, summaryProvisional: true } : {}),
          })
        }
        break
      }
      case 'thinking/summary': {
        const seq = Number(p.thinkingSeq)
        const summary = cleanThinkingSummary(String(p.summary ?? ''))
        if (!Number.isFinite(seq) || !summary) break
        const entry = entries.find((candidate) => candidate.id === `think-${seq}`)
        if (entry?.kind === 'thinking') {
          entry.summary = summary
          entry.summaryProvisional = false
        }
        break
      }
      case 'assistant/message': {
        const content = String(p.content ?? '').trim()
        if (!content) break
        const action = parseModelAction(content)
        const calls = parseCalls(action)
        if (calls.length > 0) {
          pendingCalls.push(...calls)
          break
        }
        if (action && typeof action.final === 'string') {
          entries.push({ id: `msg-${e.seq}`, kind: 'assistant', runId, text: action.final, ts, final: true })
          break
        }
        // Native function calling returns a plain-text final answer.
        if (!action || action.final === undefined) {
          entries.push({ id: `msg-${e.seq}`, kind: 'assistant', runId, text: content, ts })
        }
        break
      }
      case 'step/end':
        break
      case 'sandbox/denial': {
        const callId = String(p.callId ?? '')
        if (callId && typeof p.kind === 'string') denials.set(callId, p.kind)
        break
      }
      case 'tool/result': {
        const callId = String(p.callId ?? `tool-${e.seq}`)
        const name = String(p.name ?? 'tool')
        const output = String(p.output ?? '')
        const isError = p.isError === true
        const denial = denials.get(callId)
        const call = pendingCalls.shift()
        const args = call?.args
        entries.push({
          id: `tool-${callId}`,
          kind: 'tool',
          runId,
          callId,
          name: call?.tool ?? name,
          ...(args !== undefined ? { args } : {}),
          output,
          ...(parseResult(output) !== undefined ? { result: parseResult(output) } : {}),
          isError,
          ...(isError && denial ? { denial } : {}),
          ts,
          status: isError ? 'error' : 'done',
        })
        if ((name === 'update_plan' || name === 'todo_write') && args && typeof args === 'object') {
          const plan = planStepsOf(args as { plan?: unknown; todos?: unknown })
          if (plan) entries.push({ id: `plan-${e.seq}`, kind: 'plan', runId, plan, ts })
        }
        break
      }
      // WP-23: the model showed finished files; the card is derived from the
      // dedicated log event so a reload keeps it.
      case 'deliverable/presented': {
        const files = deliverableFilesOf(p.files)
        if (files.length > 0) entries.push({ id: `deliverables-${e.seq}`, kind: 'deliverables', runId, files, ts })
        break
      }
      case 'objective/claim':
        entries.push({ id: `msg-${e.seq}`, kind: 'assistant', runId, text: String(p.summary ?? ''), ts, final: true })
        break
      case 'turn/retry':
        entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `retrying (${String(p.reason ?? 'invalid response')})`, ts, level: 'warn' })
        break
      case 'compaction/manual':
        entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `compacted ${String(p.before ?? '?')} → ${String(p.after ?? '?')} messages`, ts })
        break
      case 'plan-mode':
        entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: p.on === true ? 'plan mode on' : 'plan mode off', ts })
        break
      case 'model/switch':
        entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `model: ${String(p.model ?? '')}`, ts })
        break
      case 'goal/set':
        entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: p.goal ? `goal: ${String(p.goal)}` : 'goal cleared', ts })
        break
      case 'goal/change': {
        const goal = p.goal as
          | { objective?: unknown; phase?: unknown; roundsStarted?: unknown; maxGoalRounds?: unknown; blockerReason?: unknown }
          | null
          | undefined
        if (!goal || typeof goal !== 'object' || typeof goal.objective !== 'string') {
          entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: 'goal cleared', ts })
          break
        }
        const detail = `${String(goal.phase ?? '')} ${Number(goal.roundsStarted ?? 0)}/${Number(goal.maxGoalRounds ?? 0)}`
        const blocker = typeof goal.blockerReason === 'string' ? `: ${goal.blockerReason}` : ''
        entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `goal: ${goal.objective} (${detail})${blocker}`, ts })
        break
      }
      case 'subagent/start':
        entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `subagent ${String(p.readOnly ? 'read-only' : 'write')}`, ts })
        break
      case 'round/start':
        pendingCalls.length = 0
        entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `round ${String(p.round ?? '')} started`, ts })
        break
      case 'round/end':
        entries.push({ id: `notice-${e.seq}`, kind: 'notice', runId, text: `round ${String(p.round ?? '')}: ${String(p.outcome ?? '')}`, ts, level: p.outcome === 'succeeded' ? 'info' : 'warn' })
        break
      default:
        break
    }
    previousType = e.type
  }
  return entries
}

/** Applies one live `AgentEvent` to a chat transcript (the GUI's incremental path). */
export function applyAgentEvent(entries: ChatEntry[], runId: string, event: AgentEvent): void {
  const ts = Date.now()
  switch (event.type) {
    case 'thinking': {
      const content = String(event.content ?? '').trim()
      if (content) {
        const seq = typeof event.seq === 'number' ? event.seq : undefined
        const summary = instantThinkingSummary(content)
        entries.push({
          id: seq !== undefined ? `think-${seq}` : `think-${ts}-${entries.length}`,
          kind: 'thinking',
          runId,
          text: content,
          ts,
          ...(summary ? { summary, summaryProvisional: true } : {}),
        })
      }
      break
    }
    case 'assistant-delta': {
      const content = String(event.content ?? '')
      if (!content) break
      const id = `draft-${runId}`
      const draft = entries.find((entry): entry is Extract<ChatEntry, { kind: 'assistant' }> => entry.id === id && entry.kind === 'assistant')
      if (draft) draft.text += content
      else entries.push({ id, kind: 'assistant', runId, text: content, ts })
      break
    }
    case 'assistant': {
      // CP-18: the streamed draft is replaced by the durable message.
      const draftIndex = entries.findIndex((entry) => entry.id === `draft-${runId}` && entry.kind === 'assistant')
      if (draftIndex >= 0) entries.splice(draftIndex, 1)
      const content = String(event.content ?? '').trim()
      if (!content) break
      const action = parseModelAction(content)
      if (action && (action.tool !== undefined || Array.isArray(action.calls))) break
      if (action && typeof action.final === 'string') break
      // A truncated native/text tool call must not surface as an assistant
      // message; the structured tool-start event owns the card.
      if (/^\{\s*"(?:tool|calls)"\s*:/.test(content)) break
      entries.push({ id: `live-${ts}-${entries.length}`, kind: 'assistant', runId, text: content, ts })
      break
    }
    case 'tool-start': {
      const callId = String(event.callId ?? `live-${entries.length}`)
      entries.push({
        id: `tool-${callId}`,
        kind: 'tool',
        runId,
        callId,
        name: String(event.name ?? 'tool'),
        ...(event.args !== undefined ? { args: event.args } : {}),
        ...(event.step === undefined ? {} : { step: Number(event.step) }),
        ...(typeof event.subagent === 'string' ? { subagent: event.subagent } : {}),
        ts,
        status: 'running',
      })
      break
    }
    case 'tool': {
      const callId = String(event.callId ?? `live-${entries.length}`)
      const entry = entries.find((e): e is ChatToolEntry => e.kind === 'tool' && e.callId === callId)
      const output = JSON.stringify(event.result ?? null, null, 2)
      if (entry) {
        entry.output = output
        entry.result = event.result
        entry.status = 'done'
      } else {
        entries.push({
          id: `tool-${callId}`,
          kind: 'tool',
          runId,
          callId,
          name: String(event.name ?? 'tool'),
          ...(event.args !== undefined ? { args: event.args } : {}),
          output,
          result: event.result,
          ...(event.step === undefined ? {} : { step: Number(event.step) }),
          ...(typeof event.subagent === 'string' ? { subagent: event.subagent } : {}),
          ts,
          status: 'done',
        })
      }
      // WP-23: the todo card and the artifact card appear live, not only after a
      // reload. `projectChat` derives the same entries from the log.
      const name = String(event.name ?? '')
      if (name === 'todo_write' || name === 'update_plan') {
        const args = (event.args ?? {}) as { plan?: unknown; todos?: unknown }
        const plan = planStepsOf(args)
        if (plan) {
          const at = entries.findIndex((e) => e.kind === 'plan')
          const card = { id: `plan-${ts}-${entries.length}`, kind: 'plan' as const, runId, plan, ts }
          if (at >= 0) entries[at] = card
          else entries.push(card)
        }
      }
      if (name === 'present') {
        const result = (event.result ?? {}) as { presented?: unknown }
        const files = deliverableFilesOf(result.presented)
        if (files.length > 0) entries.push({ id: `deliverables-${ts}-${entries.length}`, kind: 'deliverables', runId, files, ts })
      }
      break
    }
    case 'tool-error': {
      const callId = String(event.callId ?? `live-${entries.length}`)
      const message = String(event.message ?? 'tool failed')
      const denial =
        event.denial !== null && typeof event.denial === 'object' && typeof (event.denial as { kind?: unknown }).kind === 'string'
          ? String((event.denial as { kind: unknown }).kind)
          : undefined
      const entry = entries.find((e): e is ChatToolEntry => e.kind === 'tool' && e.callId === callId)
      if (entry) {
        entry.output = message
        entry.isError = true
        entry.status = 'error'
        if (denial) entry.denial = denial
      } else {
        entries.push({
          id: `tool-${callId}`,
          kind: 'tool',
          runId,
          callId,
          name: String(event.name ?? 'tool'),
          ...(event.args !== undefined ? { args: event.args } : {}),
          output: message,
          isError: true,
          ...(denial ? { denial } : {}),
          ...(event.step === undefined ? {} : { step: Number(event.step) }),
          ...(typeof event.subagent === 'string' ? { subagent: event.subagent } : {}),
          ts,
          status: 'error',
        })
      }
      break
    }
    case 'final': {
      const text = String(event.content ?? '')
      const last = entries.at(-1)
      if (last?.kind === 'assistant' && last.text === text) break
      entries.push({ id: `final-${ts}-${entries.length}`, kind: 'assistant', runId, text, ts, final: true })
      break
    }
    case 'retry':
      entries.push({ id: `notice-${ts}-${entries.length}`, kind: 'notice', runId, text: `retrying (${String(event.reason ?? 'invalid response')})`, ts, level: 'warn' })
      break
    default:
      break
  }
}
