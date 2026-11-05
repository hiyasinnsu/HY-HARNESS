// Spill and compaction (design §8, CUJ 2).
//
// * Spill: a tool output over `thresholdBytes` goes to
//   `<spillDir>/<session>/<call>.txt`; the model sees its head and tail plus a
//   `SpillRef` it can read back with `read_file({ path: "spill://…" })`.
// * Trigger: the last provider-reported input tokens reach
//   `triggerRatio × contextWindowTokens`.
// * Tier 1 (tool-result pruner): tool outputs older than the last
//   `keepRecentTurns` assistant/user pairs become locators (spilled first if
//   they were not, so nothing is lost).
// * Tier 2 (shadowed-range summary): when the calibrated estimate is still
//   over the trigger, the `compactor` role summarizes the older pairs. Cuts are
//   made only between pairs, so a tool call is never separated from its
//   result. The summary is appended to the objective message; the Ledger is
//   re-rendered verbatim by the agent on every request, so constraints and
//   notes never depend on the summary.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  estimateTokens,
  type ChatMessage,
  type ContextManager,
  type LlmProvider,
  type SessionLog,
  type SpillRef,
} from '../../core/dist/index.js'

export interface SpillCompactionOptions {
  /** `<stateDir>/spill`. */
  spillDir: string
  sessionId: string
  contextWindowTokens: number
  thresholdBytes?: number
  triggerRatio?: number
  keepRecentTurns?: number
  /** Without one, only tier 1 runs. */
  compactor?: LlmProvider
  /** Keys of the agent notes, so the summary does not paraphrase them. */
  ledgerKeys?: () => string[]
  log?: SessionLog
  /** CP-19: lifecycle notifications around tier-2 compaction. */
  hooks?: {
    preCompact?: (info: { pairs: number; tokens: number }) => Promise<void> | void
    postCompact?: (info: { pairs: number; summarized: boolean }) => Promise<void> | void
  }
}

const HEAD = 4_000
const TAIL = 4_000
const PRUNED_MARK = '[pruned to save context'
const SUMMARY_OPEN = '<session_summary>'

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length
}


/**
 * CP-17: keep image attachments only in the last `keep` messages that carry
 * them. A dropped attachment becomes a text note, so the transcript still says
 * an image was there.
 */
export function pruneImages(messages: ChatMessage[], keep = 2): ChatMessage[] {
  const withImages = messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => (entry.message.images?.length ?? 0) > 0)
  if (withImages.length <= Math.max(0, keep)) return messages
  const drop = new Set(withImages.slice(0, withImages.length - Math.max(0, keep)).map((entry) => entry.index))
  return messages.map((message, index) => {
    if (!drop.has(index) || !message.images?.length) return message
    const { images: _images, ...rest } = message
    const note = `[${message.images.length} image(s) removed to save context; read them again with read_image if needed]`
    return { ...rest, content: `${message.content}\n\n${note}` }
  })
}
export class SpillCompaction implements ContextManager {
  private readonly thresholdBytes: number
  private readonly triggerRatio: number
  private readonly keepRecentTurns: number
  private pruneSeq = 0
  /** CP-22: warm summaries keyed by the segment prefix they cover. */
  private readonly summaries = new Map<string, string>()
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(private readonly options: SpillCompactionOptions) {
    this.thresholdBytes = options.thresholdBytes ?? 32 * 1024
    this.triggerRatio = options.triggerRatio ?? 0.75
    this.keepRecentTurns = options.keepRecentTurns ?? 2
  }

  private spill(callId: string, text: string): SpillRef {
    const dir = path.join(this.options.spillDir, this.options.sessionId)
    fs.mkdirSync(dir, { recursive: true })
    const safe = callId.replace(/[^\w.-]/g, '_')
    fs.writeFileSync(path.join(dir, `${safe}.txt`), text, 'utf8')
    const spillId = `${this.options.sessionId}/${safe}`
    return { spillId, path: `spill://${spillId}`, byteLength: Buffer.byteLength(text), totalLines: lineCount(text) }
  }

  toolOutput(callId: string, output: string): { visible: string; spillRef?: SpillRef } {
    if (Buffer.byteLength(output) <= this.thresholdBytes) return { visible: output }
    const ref = this.spill(callId, output)
    const visible =
      `${output.slice(0, HEAD)}\n` +
      `… [${ref.byteLength} bytes / ${ref.totalLines} lines in total; the middle is not shown. ` +
      `Read it with read_file({ "path": "${ref.path}", "startLine": N, "endLine": M })] …\n` +
      `${output.slice(-TAIL)}\nSpillRef: ${JSON.stringify(ref)}`
    return { visible, spillRef: ref }
  }

  /** CP-22: hash of the first `segments - dropLast` steps (roles + content). */
  private segmentKey(messages: ChatMessage[], dropLast: number): string {
    const [, , ...rest] = messages
    const segments: ChatMessage[][] = []
    for (const message of rest) {
      if (message.role === 'assistant' || segments.length === 0) segments.push([message])
      else segments.at(-1)!.push(message)
    }
    const covered = Math.max(0, segments.length - Math.max(0, dropLast))
    const text = segments
      .slice(0, covered)
      .map((segment) => segment.map((message) => `${message.role}:${message.content}`).join('\\n'))
      .join('\\n\\n')
    return createHash('sha1').update(text).digest('hex')
  }

  /** CP-22: the prompt both the warm-up and the synchronous path send. */
  private summaryMessages(messages: ChatMessage[], dropLast: number): ChatMessage[] {
    const [, objective, ...rest] = messages
    const segments: ChatMessage[][] = []
    for (const message of rest) {
      if (message.role === 'assistant' || segments.length === 0) segments.push([message])
      else segments.at(-1)!.push(message)
    }
    const older = segments.slice(0, Math.max(0, segments.length - Math.max(0, dropLast)))
    const keys = this.options.ledgerKeys?.() ?? []
    const previous = objective!.content.includes(SUMMARY_OPEN)
      ? objective!.content.slice(objective!.content.indexOf(SUMMARY_OPEN))
      : ''
    const transcript = older
      .map((segment) =>
        segment
          .map((message) => `${message.role === 'assistant' ? 'ASSISTANT' : 'USER'}: ${message.content.slice(0, 2_000)}`)
          .join('\\n'),
      )
      .join('\\n\\n')
    return [
      {
        role: 'system',
        content:
          'You compress the earlier part of a coding agent session so it can continue in less context. ' +
          'Keep decisions, files read or changed, commands run and their outcomes, and open problems. ' +
          `Do not restate these agent notes, which are kept separately: ${keys.length > 0 ? keys.join(', ') : '(none)'}. ` +
          'Reply with a JSON object {"summary":"<Markdown summary under 300 words>"}.',
      },
      {
        role: 'user',
        content: `${previous ? `Earlier summary:\n${previous}\n\n` : ''}Transcript to summarize:\n${transcript}`,
      },
    ]
  }

  /** CP-22: starts (or reuses) a background summary for the next request. */
  afterResponse(messages: ChatMessage[], completion: { usage: { inputTokens: number } }): void {
    if (!this.options.compactor || this.keepRecentTurns <= 1) return
    if (!this.overTrigger(completion.usage.inputTokens)) return
    const key = this.segmentKey(messages, this.keepRecentTurns - 1)
    if (this.summaries.has(key) || this.inflight.has(key)) return
    const prompt = this.summaryMessages(messages, this.keepRecentTurns - 1)
    const promise = (async () => {
      const completion2 = await this.options.compactor!.complete(prompt, { maxTokens: 800, temperature: 0 })
      const raw = completion2.content.trim()
      let summary = raw
      if (raw.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw) as { summary?: unknown }
          if (typeof parsed.summary === 'string' && parsed.summary.trim()) summary = parsed.summary.trim()
        } catch {
          // Keep raw text when not JSON.
        }
      }
      this.summaries.set(key, summary)
      if (this.summaries.size > 4) this.summaries.delete(this.summaries.keys().next().value as string)
    })()
      .catch(() => undefined)
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, promise)
  }

  private overTrigger(tokens: number): boolean {
    return tokens >= this.triggerRatio * this.options.contextWindowTokens
  }

  async beforeRequest(messages: ChatMessage[], lastInputTokens: number): Promise<ChatMessage[]> {
    // CP-17: images are expensive regardless of the token trigger, so older
    // ones are dropped before anything else (the model can re-read them).
    const media = pruneImages(messages, this.keepRecentTurns)
    if (!this.overTrigger(lastInputTokens) || media.length < 2) return media
    const [system, objective, ...rest] = media
    // One step is an assistant message plus the user message(s) that answer it.
    // A steering message (WP-21) adds a second user message to a step, so the
    // grouping follows the assistant boundary instead of the index parity: a
    // tool call then always stays next to its result, whichever way the step
    // grew.
    const segments: ChatMessage[][] = []
    for (const message of rest) {
      if (message.role === 'assistant' || segments.length === 0) segments.push([message])
      else segments.at(-1)!.push(message)
    }
    const keep = Math.max(0, segments.length - this.keepRecentTurns)
    const older = segments.slice(0, keep)
    const recent = segments.slice(keep)
    if (older.length === 0) return media

    // Calibrate the estimator against what the provider just reported.
    const ratio = lastInputTokens / Math.max(1, estimateTokens(media.map((m) => m.content).join('\n')))

    // Tier 1: older tool outputs → locators. Other user messages (a steering
    // message, a retry nudge) are left alone.
    let pruned = 0
    const tier1 = older.map((segment) =>
      segment.map((message): ChatMessage => {
        if (message.role !== 'user') return message
        const m = /^TOOL (RESULT|ERROR) \(([^)]*)\):\n?/.exec(message.content)
        if (!m || message.content.includes(PRUNED_MARK) || message.content.length < 300) return message
        const existing = /SpillRef: (\{.*\})\s*$/.exec(message.content)
        const ref: SpillRef = existing ? (JSON.parse(existing[1]!) as SpillRef) : this.spill(`pruned-${++this.pruneSeq}`, message.content.slice(m[0].length))
        pruned += 1
        return { role: 'user', content: `${m[0]}${PRUNED_MARK}; read_file({ "path": "${ref.path}" }) returns the full output]` }
      }),
    )
    let compacted: ChatMessage[] = [system!, objective!, ...tier1.flat(), ...recent.flat()]
    if (pruned > 0) this.options.log?.append('compaction/prune', { pruned })
    const estimate = Math.ceil(estimateTokens(compacted.map((m) => m.content).join('\n')) * ratio)
    if (!this.overTrigger(estimate) || !this.options.compactor) return compacted

    // Tier 2: summarize the older steps (cut between steps only).
    const previous = objective!.content.includes(SUMMARY_OPEN)
      ? objective!.content.slice(objective!.content.indexOf(SUMMARY_OPEN))
      : ''
    await this.options.hooks?.preCompact?.({ pairs: older.length, tokens: lastInputTokens })
    const cacheKey = this.segmentKey(media, this.keepRecentTurns)
    let completionText: string
    try {
      const cached = this.summaries.get(cacheKey)
      if (cached !== undefined) {
        // CP-22: the warm-up already summarized exactly this prefix.
        completionText = JSON.stringify({ summary: cached })
        this.summaries.delete(cacheKey)
      } else {
        const inflight = this.inflight.get(cacheKey)
        if (inflight) await inflight
        const warm = this.summaries.get(cacheKey)
        if (warm !== undefined) {
          completionText = JSON.stringify({ summary: warm })
          this.summaries.delete(cacheKey)
        } else {
          const completion = await this.options.compactor.complete(this.summaryMessages(media, this.keepRecentTurns), {
            maxTokens: 800,
            temperature: 0,
          })
          completionText = completion.content
        }
      }
    } catch (error) {
      // CP-22: a failed summary keeps the tier-1 result instead of failing the turn.
      const reason = error instanceof Error ? error.message : String(error)
      this.options.log?.append('compaction/failed', { reason: reason.slice(0, 300), pairs: older.length })
      await this.options.hooks?.postCompact?.({ pairs: older.length, summarized: false })
      return compacted
    }
    const raw = completionText.trim()
    let summary = raw
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as { summary?: unknown }
        if (typeof parsed.summary === 'string' && parsed.summary.trim()) summary = parsed.summary.trim()
      } catch {
        // Keep raw text when not JSON (e.g. scripted/mock providers).
      }
    }
    const original = previous ? objective!.content.slice(0, objective!.content.indexOf(SUMMARY_OPEN)).trimEnd() : objective!.content
    const withSummary: ChatMessage = {
      role: 'user',
      content: `${original}\n\n${SUMMARY_OPEN}\nSummary of earlier steps (written by the compactor):\n${summary}\n</session_summary>`,
    }
    compacted = [system!, withSummary, ...recent.flat()]
    await this.options.hooks?.postCompact?.({ pairs: older.length, summarized: true })
    const lastSeq = this.options.log?.events().at(-1)?.seq ?? 0
    this.options.log?.append('compaction/summary', { shadowedThroughSeq: lastSeq, summaryMarkdown: summary, pairs: older.length })
    return compacted
  }
}
