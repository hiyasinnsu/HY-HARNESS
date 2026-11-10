// Budget4D (design §7, Goal 4): rounds, tokens, USD and wall-clock time, with
// every role's usage counted. Each role's provider is wrapped by `meter()`:
// before a call it refuses when a dimension is spent, clamps `max_tokens` to
// the remaining token budget, and clamps it further (or refuses) when the
// worst-case cost — estimated input + clamped output at the role's prices —
// would exceed the remaining USD. The current round's abort signal (round
// timeout, Ctrl-C) is checked at the same point.
import {
  AbortRunError,
  estimateTokens,
  type ChatMessage,
  type CompleteOptions,
  type Completion,
  type LlmProvider,
} from '../../core/dist/index.js'

export interface Pricing {
  inputPerMTokUsd: number
  cachedInputPerMTokUsd?: number
  outputPerMTokUsd: number
}

export interface Budget4DLimits {
  maxRounds: number
  maxTotalTokens: number
  /** `undefined`: no USD cap (then pricing is not required). */
  maxCostUsd?: number
  maxWallClockMs: number
}

export const DEFAULT_BUDGET: Budget4DLimits = {
  maxRounds: 5,
  maxTotalTokens: 500_000,
  maxWallClockMs: 30 * 60_000,
}

export type BudgetDimension = 'rounds' | 'tokens' | 'usd' | 'wall-clock'

export class BudgetExhaustedError extends AbortRunError {
  constructor(
    readonly dimension: BudgetDimension,
    message: string,
  ) {
    super(`budget exhausted (${dimension}): ${message}`)
    this.name = 'BudgetExhaustedError'
  }
}

/** The current round was aborted (round timeout, Ctrl-C). */
export class RoundAbortedError extends AbortRunError {
  constructor(reason: string) {
    super(`round aborted: ${reason}`)
    this.name = 'RoundAbortedError'
  }
}

export class Budget4D {
  rounds = 0
  tokensUsed = 0
  costUsd = 0
  private readonly startedAt: number
  private roundSignal: AbortSignal | undefined

  /**
   * Fails at startup when a USD cap is set and a role in use has no pricing
   * (design §7 "check budget preconditions").
   */
  constructor(
    readonly limits: Budget4DLimits,
    private readonly pricing: Readonly<Record<string, Pricing | undefined>>,
    private readonly now: () => number = Date.now,
  ) {
    if (limits.maxCostUsd !== undefined) {
      const missing = Object.entries(pricing)
        .filter(([, p]) => p === undefined)
        .map(([role]) => role)
      if (missing.length > 0) {
        throw new Error(
          `a USD budget of ${limits.maxCostUsd} is set but these roles have no pricing: ${missing.join(', ')}. ` +
            'Add roles.<role>.pricing to the user config, or pass --max-cost-usd off.',
        )
      }
    }
    this.startedAt = now()
  }

  /** Starts a round; refuses when the round budget is spent. */
  startRound(): number {
    if (this.rounds >= this.limits.maxRounds) {
      throw new BudgetExhaustedError('rounds', `${this.limits.maxRounds} rounds used`)
    }
    this.rounds += 1
    return this.rounds
  }

  setRoundSignal(signal: AbortSignal | undefined): void {
    this.roundSignal = signal
  }

  elapsedMs(): number {
    return this.now() - this.startedAt
  }

  remainingWallClockMs(): number {
    return Math.max(0, this.limits.maxWallClockMs - this.elapsedMs())
  }

  snapshot() {
    return {
      rounds: this.rounds,
      tokensUsed: this.tokensUsed,
      costUsd: Number(this.costUsd.toFixed(6)),
      elapsedMs: this.elapsedMs(),
      limits: this.limits,
    }
  }

  /** Clamped `max_tokens` for one call, or a BudgetExhaustedError. */
  admit(role: string, inputEstimate: number, requestedMaxTokens: number): number {
    const reason = this.roundSignal?.reason
    if (this.roundSignal?.aborted) throw new RoundAbortedError(reason instanceof Error ? reason.message : String(reason))
    if (this.elapsedMs() >= this.limits.maxWallClockMs) {
      throw new BudgetExhaustedError('wall-clock', `${this.limits.maxWallClockMs} ms elapsed`)
    }
    const tokensLeft = this.limits.maxTotalTokens - this.tokensUsed
    if (inputEstimate >= tokensLeft) {
      throw new BudgetExhaustedError('tokens', `${this.tokensUsed} of ${this.limits.maxTotalTokens} tokens used; the next request needs ~${inputEstimate}`)
    }
    let maxTokens = Math.min(requestedMaxTokens, tokensLeft - inputEstimate)
    if (this.limits.maxCostUsd !== undefined) {
      const p = this.pricing[role] ?? { inputPerMTokUsd: 0, outputPerMTokUsd: 0 }
      const usdLeft = this.limits.maxCostUsd - this.costUsd
      const inputCost = (inputEstimate * p.inputPerMTokUsd) / 1e6
      if (p.outputPerMTokUsd > 0) {
        maxTokens = Math.min(maxTokens, Math.floor(((usdLeft - inputCost) * 1e6) / p.outputPerMTokUsd))
      } else if (inputCost > usdLeft) {
        maxTokens = 0
      }
      if (maxTokens < 1) {
        throw new BudgetExhaustedError('usd', `$${this.costUsd.toFixed(4)} of $${this.limits.maxCostUsd} spent; the next ${role} request could exceed it`)
      }
    }
    return maxTokens
  }

  /**
   * Adds one response's usage. `cachedInputTokens` is the prompt-cache hit part
   * of `inputTokens`; with `cachedInputPerMTokUsd` set on the role's pricing it
   * is charged at that (usually much lower) rate. The field is optional so
   * callers that only have totals keep working.
   */
  record(role: string, usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }): void {
    this.tokensUsed += usage.inputTokens + usage.outputTokens
    const p = this.pricing[role]
    if (!p) return
    const cached = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens ?? 0))
    const cachedRate = p.cachedInputPerMTokUsd ?? p.inputPerMTokUsd
    this.costUsd += ((usage.inputTokens - cached) * p.inputPerMTokUsd + cached * cachedRate + usage.outputTokens * p.outputPerMTokUsd) / 1e6
  }

  /** Wraps a role's provider so every call is admitted and recorded. */
  meter(provider: LlmProvider, role: string): LlmProvider {
    return {
      name: provider.name,
      complete: async (messages: ChatMessage[], options: CompleteOptions): Promise<Completion> => {
        const estimate = estimateTokens(messages.map((m) => m.content).join('\n'))
        const maxTokens = this.admit(role, estimate, options.maxTokens)
        let completion: Completion
        try {
          completion = await provider.complete(messages, {
            ...options,
            maxTokens,
            ...(this.roundSignal ? { signal: this.roundSignal } : {}),
          })
        } catch (error) {
          if (this.roundSignal?.aborted) {
            const reason = this.roundSignal.reason
            throw new RoundAbortedError(reason instanceof Error ? reason.message : String(reason))
          }
          throw error
        }
        // `cacheHitTokens` is the prompt-cache part of the input; `record`
        // prices it at `cachedInputPerMTokUsd` when the role sets one.
        this.record(role, {
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
          ...(completion.usage.cacheHitTokens === undefined ? {} : { cachedInputTokens: completion.usage.cacheHitTokens }),
        })
        return completion
      },
    }
  }
}
