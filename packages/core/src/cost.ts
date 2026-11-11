// B1: what a session's tokens cost, from the prices the user registered.
//
// The harness ships no prices (they change and differ by plan): a price comes
// from a role's `pricing` or the model's `models[]` entry. Without one the cost
// is unknown and nothing is shown or capped.

import type { HarnessConfig, ProviderKind, RoleConfig } from './config.js'
import { findModel } from './model-catalog.js'

export interface ModelPricing {
  inputPerMTokUsd: number
  cachedInputPerMTokUsd?: number
  outputPerMTokUsd: number
}

/** The registered price for a provider + model: a role's own price first, then the model registry. */
export function pricingFor(config: Pick<HarnessConfig, 'role' | 'orchestratorRole' | 'subagentRole' | 'graderRole' | 'compactorRole' | 'summarizerRole'> & { advisorRole?: RoleConfig; guardianRole?: RoleConfig }, provider: string, model: string): ModelPricing | undefined {
  const roles = [config.role, config.orchestratorRole, config.subagentRole, config.graderRole, config.compactorRole, config.summarizerRole, config.advisorRole, config.guardianRole]
  for (const role of roles) {
    if (role && role.provider === provider && role.model === model && role.pricing) return role.pricing
  }
  return findModel(provider as ProviderKind, model)?.pricing
}

/**
 * USD for the given usage. Cache-hit tokens are billed at the cached price
 * (the input price when none is registered). When the provider did not
 * report the cache split, every input token is counted at the full price, so
 * the figure is an upper bound (`approximate`).
 */
export function estimateCostUsd(
  usage: { inputTokens: number; outputTokens: number; cacheHitTokens?: number; cacheMissTokens?: number; cacheUsageComplete?: boolean },
  pricing: ModelPricing,
): { usd: number; approximate: boolean } {
  const complete = usage.cacheUsageComplete !== false && usage.cacheHitTokens !== undefined
  const hit = complete ? Math.max(0, usage.cacheHitTokens ?? 0) : 0
  const miss = complete ? Math.max(0, usage.cacheMissTokens ?? Math.max(0, usage.inputTokens - hit)) : Math.max(0, usage.inputTokens)
  const cached = pricing.cachedInputPerMTokUsd ?? pricing.inputPerMTokUsd
  const usd = (miss * pricing.inputPerMTokUsd + hit * cached + Math.max(0, usage.outputTokens) * pricing.outputPerMTokUsd) / 1_000_000
  return { usd, approximate: !complete }
}
