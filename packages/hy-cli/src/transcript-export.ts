// A chat's complete history for debugging: every event of the run (and of its
// subagents) from the session log, in order, including turns that were later
// undone, retries, thinking, tool calls with their arguments and the full tool
// results (spilled outputs are read back from the spill directory).
//
// `markdown` is for reading; `json` keeps the raw events for tooling. With
// `mask`, API-key-like strings are replaced, as in the GUI.
import type { SessionEvent } from '../../core/dist/index.js'
import { maskSecrets } from './secret-mask.js'

export interface ExportOptions {
  runId: string
  workspaceRoot: string
  /** Reads a `spill://…` reference; undefined when it is gone. */
  readSpill?: (ref: string) => string | undefined
  mask?: boolean
  /** Fixed clock for tests. */
  now?: number
  /** The projected chat entries, included in the JSON export. */
  entries?: readonly unknown[]
}

/** Spilled outputs are included up to this many characters each. */
const MAX_SPILL_CHARS = 200_000

/** The run's events and those of its subagents (`<run>.subN`), in log order. */
export function runEvents(events: readonly SessionEvent[], runId: string): SessionEvent[] {
  return events
    .filter((e) => e.runId === runId || (e.runId?.startsWith(`${runId}.sub`) ?? false))
    .sort((a, b) => a.seq - b.seq)
}

function fence(text: string): string {
  // A fence longer than any backtick run inside keeps the block intact.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}\n${text.replace(/\s+$/, '')}\n${ticks}`
}

function time(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19)
}

/** An assistant reply in the text protocol: a tool call, a batch, a final answer or plain text. */
function describeAssistant(content: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return content
  }
  const action = parsed as { tool?: unknown; args?: unknown; calls?: unknown; final?: unknown }
  if (typeof action.tool === 'string') return `**Tool call:** \`${action.tool}\`\n\n${fence(JSON.stringify(action.args ?? {}, null, 2))}`
  if (Array.isArray(action.calls)) {
    return action.calls
      .map((c) => {
        const call = c as { tool?: unknown; args?: unknown }
        return `**Tool call:** \`${String(call.tool)}\`\n\n${fence(JSON.stringify(call.args ?? {}, null, 2))}`
      })
      .join('\n\n')
  }
  if (action.final !== undefined) return typeof action.final === 'string' ? action.final : fence(JSON.stringify(action.final, null, 2))
  return fence(content)
}

export function exportMarkdown(events: readonly SessionEvent[], options: ExportOptions): string {
  const mine = runEvents(events, options.runId)
  const lines: string[] = [
    `# HY-HARNESS chat history: ${options.runId}`,
    '',
    `- Workspace: \`${options.workspaceRoot}\``,
    `- Exported: ${time(options.now ?? Date.now())} UTC`,
    `- Events: ${mine.length}`,
    '',
  ]
  for (const e of mine) {
    const p = (e.payload ?? {}) as Record<string, unknown>
    const who = e.runId !== options.runId ? ` (subagent ${e.runId})` : ''
    const at = `<sub>${time(e.ts)} · seq ${e.seq}</sub>`
    switch (e.type) {
      case 'turn/start':
        lines.push(`## Turn ${String(p.turn)}${who}`, at, '')
        break
      case 'turn/undo':
        lines.push(`> **Turn ${String(p.turn)} was undone** (everything since its start left the conversation). ${at}`, '')
        break
      case 'user/message':
      case 'user/steer':
        lines.push(`### ${e.type === 'user/steer' ? 'User (steering)' : 'User'}${who}`, at, '', String(p.content ?? ''), '')
        break
      case 'assistant/thinking':
        lines.push(`### Thinking${who}`, at, '', fence(String(p.content ?? '')), '')
        break
      case 'assistant/message':
        lines.push(`### Assistant${who}`, at, '', describeAssistant(String(p.content ?? '')), '')
        break
      case 'tool/result': {
        const name = String(p.name ?? '')
        const spill = (p.spillRef as { path?: string } | undefined)?.path
        let full: string | undefined
        if (spill && options.readSpill) {
          const text = options.readSpill(spill)
          if (text !== undefined) full = text.length > MAX_SPILL_CHARS ? `${text.slice(0, MAX_SPILL_CHARS)}\n… [truncated at ${MAX_SPILL_CHARS} characters]` : text
        }
        lines.push(
          `### Tool ${p.isError === true ? 'error' : 'result'}: \`${name}\`${who}`,
          `${at}${p.callId ? ` · ${String(p.callId)}` : ''}`,
          '',
          fence(String(p.output ?? '')),
          ...(full !== undefined ? ['', `Full output (${spill}):`, '', fence(full)] : []),
          '',
        )
        break
      }
      case 'step/end': {
        const usage = (p.usage ?? {}) as { inputTokens?: number; outputTokens?: number }
        lines.push(`- step ${String(p.stepIndex)} · ${String(p.model ?? '')} · in ${usage.inputTokens ?? 0} / out ${usage.outputTokens ?? 0} tokens ${at}`, '')
        break
      }
      default: {
        const json = JSON.stringify(e.payload ?? {})
        lines.push(`- \`${e.type}\`${who}: ${json.length > 2_000 ? `${json.slice(0, 2_000)}…` : json} ${at}`, '')
      }
    }
  }
  const text = `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
  return options.mask ? maskSecrets(text).text : text
}

export function exportJson(events: readonly SessionEvent[], options: ExportOptions): string {
  const text = JSON.stringify(
    {
      runId: options.runId,
      workspaceRoot: options.workspaceRoot,
      exportedAt: new Date(options.now ?? Date.now()).toISOString(),
      ...(options.entries ? { entries: options.entries } : {}),
      events: runEvents(events, options.runId),
    },
    null,
    2,
  )
  return options.mask ? maskSecrets(text).text : text
}
