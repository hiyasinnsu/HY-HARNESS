import type { SessionEvent } from '../../core/dist/index.js'

export interface UsageView {
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  cacheUsageComplete: boolean
  lastInputTokens: number
  lastOutputTokens: number
  lastCacheHitTokens: number
  lastCacheMissTokens: number
}

/** Both lanes belong to one user-visible chat; keep their total cost visible. */
export function combineUsage(primary: UsageView, dialogue?: UsageView): UsageView {
  if (!dialogue) return primary
  return { ...primary,
    inputTokens: primary.inputTokens + dialogue.inputTokens,
    outputTokens: primary.outputTokens + dialogue.outputTokens,
    cacheHitTokens: primary.cacheHitTokens + dialogue.cacheHitTokens,
    cacheMissTokens: primary.cacheMissTokens + dialogue.cacheMissTokens,
    cacheUsageComplete: primary.cacheUsageComplete && dialogue.cacheUsageComplete,
  }
}

/**
 * Rebuilds a run's usage from its log so a restart keeps the token and cache
 * counters visible before the conversation is reopened for a new turn.
 */
export function usageOf(events: readonly SessionEvent[], runId: string): UsageView {
  const usage: UsageView = {
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheUsageComplete: true,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    lastCacheHitTokens: 0,
    lastCacheMissTokens: 0,
  }
  for (const e of events) {
    if (e.runId !== runId || e.type !== 'step/end') continue
    const payload = e.payload as {
      usage?: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number }
    }
    const u = payload.usage
    if (!u) {
      usage.cacheUsageComplete = false
      continue
    }
    if (u.cacheHitTokens === undefined || u.cacheMissTokens === undefined) usage.cacheUsageComplete = false
    const input = Number(u.inputTokens ?? 0)
    const output = Number(u.outputTokens ?? 0)
    const hit = Number(u.cacheHitTokens ?? 0)
    const miss = Number(u.cacheMissTokens ?? Math.max(0, input - hit))
    usage.inputTokens += input
    usage.outputTokens += output
    usage.cacheHitTokens += hit
    usage.cacheMissTokens += miss
    usage.lastInputTokens = input
    usage.lastOutputTokens = output
    usage.lastCacheHitTokens = hit
    usage.lastCacheMissTokens = miss
  }
  return usage
}
