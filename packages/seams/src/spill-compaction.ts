// Spill and compaction (design §8, CUJ 2).
//
// * Spill: a tool output over `thresholdBytes` goes to
//   `<spillDir>/<session>/<call>.txt`; the model sees its head and tail plus a
//   `SpillRef` it can read back with `read_file({ path: "spill://…" })`.
// * Trigger: the last provider-reported input tokens reach
//   `triggerRatio × contextWindowTokens`.
// * Tier 1 (tool-result pruner): leave recent outputs intact and replace older
//   ones from newest to oldest until there is headroom. The unchanged front
//   of the conversation stays eligible for the provider's cache.
// * Tier 2 (shadowed-range summary): when the calibrated estimate is still
//   over the trigger, the `compactor` role summarizes the older pairs. Cuts are
//   made only between pairs, so a tool call is never separated from its
//   result. The summary is appended to the objective message; the Ledger is
//   re-rendered verbatim by the agent on every request, so constraints and
//   notes never depend on the summary.
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  estimateTokens,
  type ChatMessage,
  type CompleteOptions,
  type ContextManager,
  type LlmProvider,
  type SessionEvent,
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
  onResult?: (event: SessionEvent) => void
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
/** Below the compaction trigger, images are kept until this many messages carry them. */
export const MAX_IMAGE_MESSAGES = 16

function imageMessages(messages: readonly ChatMessage[]): number {
  return messages.filter((message) => (message.images?.length ?? 0) > 0).length
}

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
  /** CP-22: warm summaries keyed by the segment prefix they cover. */
  private readonly summaries = new Map<string, string>()
  private readonly inflight = new Map<string, Promise<void>>()

  /** The window compaction aims under; lowered when the provider states a smaller one. */
  private contextWindowTokens: number

  constructor(private readonly options: SpillCompactionOptions) {
    this.contextWindowTokens = options.contextWindowTokens
    this.thresholdBytes = options.thresholdBytes ?? 32 * 1024
    this.triggerRatio = options.triggerRatio ?? 0.75
    this.keepRecentTurns = options.keepRecentTurns ?? 2
  }

  private spill(callId: string, text: string): SpillRef {
    const dir = path.join(this.options.spillDir, this.options.sessionId)
    fs.mkdirSync(dir, { recursive: true })
    const safe = callId.replace(/[^\w.-]/g, '_')
    const target = path.join(dir, `${safe}.txt`)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, text, 'utf8')
      fs.renameSync(temporary, target)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
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
          .join('\n'),
      )
      .join('\n\n')
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
  afterResponse(messages: ChatMessage[], completion: { usage: { inputTokens: number } }, replayTools?: CompleteOptions['tools']): void {
    // Decide whether a summary is needed after pruning. Replaying a warm prefix can be large.
    if (replayTools || !this.options.compactor || this.keepRecentTurns <= 1) return
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

  /** The provider stated the model's real window: compact for that one from now on. */
  learnContextWindow(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0 && tokens < this.contextWindowTokens) {
      this.options.log?.append('context/window-learned', { from: this.contextWindowTokens, to: tokens })
      this.contextWindowTokens = tokens
    }
  }

  private overTrigger(tokens: number): boolean {
    return tokens >= this.triggerRatio * this.contextWindowTokens
  }

  private report(outcome: 'shortened' | 'summarized' | 'partial' | 'failed'): void {
    const event = this.options.log?.append('compaction/result', { outcome })
    if (event) this.options.onResult?.(event)
  }

  /** Compacts when the last request was over the trigger (see `compactRequest`). */
  async beforeRequest(messages: ChatMessage[], lastInputTokens: number, replayTools?: CompleteOptions['tools']): Promise<ChatMessage[]> {
    return this.compactRequest(messages, lastInputTokens, replayTools, false)
  }

  /**
   * Compacts now, whatever the last request reported: tier 1 (pruning) and,
   * when a compactor is configured, tier 2 (summary). The agent calls this
   * after the provider rejected a request for exceeding the context window;
   * the reported usage is then either the rejected request's or missing, so
   * the local estimate (`lastInputTokens = 0` and the 1.35 safety factor)
   * decides how far to prune. A failure here must not fail the turn a second
   * time: the input comes back unchanged.
   */
  async forceCompact(messages: ChatMessage[], replayTools?: CompleteOptions['tools']): Promise<ChatMessage[]> {
    try {
      return await this.compactRequest(messages, 0, replayTools, true)
    } catch (error) {
      try {
        const reason = error instanceof Error ? error.message : String(error)
        this.options.log?.append('compaction/failed', { reason: reason.slice(0, 300), forced: true })
        this.report('failed')
      } catch {
        // Reporting must not turn a compaction failure into a failed turn.
      }
      return messages
    }
  }

  /** `force` ignores the trigger: the caller already knows the context is too large. */
  private async compactRequest(
    messages: ChatMessage[],
    lastInputTokens: number,
    replayTools: CompleteOptions['tools'] | undefined,
    force: boolean,
  ): Promise<ChatMessage[]> {
    // CP-17: older images are dropped (the model can re-read them), but only
    // when it pays: dropping one rewrites an earlier message, so the provider's
    // prefix cache misses from there on. Below the trigger images stay (they
    // are cached like any other prefix) unless more than MAX_IMAGES pile up;
    // then they are cut back to the recent ones in one go, not one per request.
    // When lastInputTokens is 0 (Step 1 of a turn, or before any provider response),
    // estimate the tokens from the message content with a safety factor (1.35) to
    // account for multilingual and code tokenization density.
    const estimatedRaw = estimateTokens(messages.map((m) => m.content).join('\n'))
    const effectiveTokens = lastInputTokens > 0 ? lastInputTokens : Math.ceil(estimatedRaw * 1.35)
    const over = force || this.overTrigger(effectiveTokens)
    const media = over || imageMessages(messages) > MAX_IMAGE_MESSAGES ? pruneImages(messages, this.keepRecentTurns) : messages
    if (!over || media.length < 2) {
      if (media !== messages) this.report('shortened')
      return media
    }
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
    if (older.length === 0) {
      if (media !== messages) this.report('shortened')
      return media
    }

    // Calibrate the estimator against what the provider just reported, or fallback.
    const ratio = lastInputTokens > 0 ? lastInputTokens / Math.max(1, estimatedRaw) : 1.35

    // Tier 1: older tool outputs → locators. Other user messages (a steering
    // message, a retry nudge) are left alone.
    const replacements: Array<{ sourceSha256: string; occurrence: number; content: string }> = []
    const seen = new Map<string, number>()
    const tier1 = older.flat()
    const candidates = tier1.flatMap((message, index) => {
      const header = message.role === 'user' ? /^TOOL (RESULT|ERROR) \(([^)]*)\):\n?/.exec(message.content)?.[0] : undefined
      if (!header || message.content.includes(PRUNED_MARK) || message.content.length < 300) return []
      const sourceSha256 = createHash('sha256').update(message.content).digest('hex')
      const occurrence = (seen.get(sourceSha256) ?? 0) + 1
      seen.set(sourceSha256, occurrence)
      return [{ index, header, sourceSha256, occurrence }]
    })
    // Drop below the trigger in one pass so small additions do not prune on every step.
    const target = this.contextWindowTokens * this.triggerRatio * 0.8
    let remaining = estimateTokens(media.map((message) => message.content).join('\n'))
    for (const { index, header, sourceSha256, occurrence } of candidates.reverse()) {
      if (remaining * ratio <= target) break
      const original = tier1[index]!.content
      const ref = this.spill(`pruned-${sourceSha256}`, original.slice(header.length))
      const content = `${header}${PRUNED_MARK}; read_file({ "path": "${ref.path}" }) returns the previous tool-result text and any spill links]`
      replacements.push({ sourceSha256, occurrence, content })
      tier1[index] = { role: 'user', content }
      remaining -= estimateTokens(original) - estimateTokens(content)
    }
    let compacted: ChatMessage[] = [system!, objective!, ...tier1, ...recent.flat()]
    if (replacements.length > 0) this.options.log?.append('compaction/prune', { pruned: replacements.length, replacements })
    const estimate = Math.ceil(estimateTokens(compacted.map((m) => m.content).join('\n')) * ratio)
    const shortened = media !== messages || replacements.length > 0
    // A forced compaction has no trustworthy trigger left (the provider
    // rejected the request), so it goes on to the summary whenever one is
    // configured; without a compactor, tier 1 is all there is.
    if (!(force || this.overTrigger(estimate)) || !this.options.compactor) {
      if (shortened) this.report('shortened')
      return compacted
    }

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
          const prompt = this.summaryMessages(media, this.keepRecentTurns)
          const limits = { maxTokens: 800, temperature: 0 }
          let replayed: string | undefined
          if (replayTools && lastInputTokens > 0 && effectiveTokens < this.contextWindowTokens * 0.95 && imageMessages(messages) === 0) {
            const prefix = messages.slice(0, messages.length - recent.flat().length)
            try {
              const result = await this.options.compactor.complete([...prefix, { role: 'user', content:
                'Summarize the conversation above so work can resume. Preserve decisions, user constraints, files, command results and open work. ' +
                'Do not call tools. Return only a JSON object with a "summary" field containing concise Markdown.',
              }], { ...limits, tools: replayTools })
              this.options.log?.append('compaction/replay', { usage: result.usage })
              if (!result.toolCalls?.length && result.content.trim()) replayed = result.content
            } catch {
              // The configured compactor can still use the smaller transcript.
            }
          }
          completionText = replayed ?? (await this.options.compactor.complete(prompt, limits)).content
        }
      }
      if (!completionText.trim()) throw new Error('compactor returned an empty summary')
    } catch (error) {
      // CP-22: a failed summary keeps the tier-1 result instead of failing the turn.
      const reason = error instanceof Error ? error.message : String(error)
      this.options.log?.append('compaction/failed', { reason: reason.slice(0, 300), pairs: older.length })
      await this.options.hooks?.postCompact?.({ pairs: older.length, summarized: false })
      this.report(shortened ? 'partial' : 'failed')
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
    this.report('summarized')
    return compacted
  }
}
