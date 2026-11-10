import type { ProviderKind, RoleConfig } from './config.js'

/**
 * Per-model compatibility flags. Kept separate from the limits: these describe
 * what a particular endpoint accepts, and every one of them has a runtime
 * fallback (a rejected field is dropped and the request retried once).
 */
export interface ModelCompat {
  /** The token-limit field the endpoint accepts; default `max_tokens`. */
  tokenField?: 'max_tokens' | 'max_completion_tokens'
  /** Whether reasoning effort and function tools may be sent together; default true. */
  effortWithTools?: boolean
  /** Whether a non-default temperature is accepted; default true. */
  temperature?: boolean
  /** Whether earlier assistant reasoning is returned to the server; default false. */
  reasoningEcho?: boolean
}

/**
 * One model the user registered in `config.json` (`models[]`). The harness
 * ships no per-model facts: context windows, output caps, prices and API
 * quirks change over time and cannot be kept current inside a released
 * binary. Anything not registered falls back to the role's own values and to
 * the adaptive request negotiation.
 */
export interface ModelInfo {
  /** `provider:model`, the key `hy models` prints. */
  id: string
  provider: ProviderKind
  model: string
  label: string
  /** Informational; compaction uses the role's `contextWindowTokens`. */
  contextWindowTokens?: number
  maxOutputTokens?: number
  pricing?: { inputPerMTokUsd: number; cachedInputPerMTokUsd?: number; outputPerMTokUsd: number }
  capabilities?: { tools?: boolean; vision?: boolean; reasoning?: boolean; cache?: boolean }
  compat?: ModelCompat
}

/** Entries registered by the user at load time. */
let REGISTRY: readonly ModelInfo[] = []
let BY_ID = new Map<string, ModelInfo>()

/**
 * Replaces the registry with the user's `models[]` entries. Called once by
 * `loadConfig`; a later call in the same process replaces the previous set.
 */
export function setModelRegistry(entries: readonly ModelInfo[]): void {
  const cleaned = entries
    .filter((entry) => entry && typeof entry.provider === 'string' && typeof entry.model === 'string' && entry.model.trim().length > 0)
    .map((entry) => ({ ...entry, model: entry.model.trim(), id: `${entry.provider}:${entry.model.trim()}` }))
  REGISTRY = cleaned
  BY_ID = new Map(cleaned.map((entry) => [entry.id, entry]))
}

/** The registered models, in registration order. */
export function modelCatalog(): readonly ModelInfo[] {
  return REGISTRY
}

/** The registry entry for a provider + model, or undefined when unregistered. */
export function findModel(provider: ProviderKind, model: string): ModelInfo | undefined {
  return BY_ID.get(`${provider}:${model}`)
}

/** The registry entry a role points at (undefined when the model is not registered). */
export function catalogForRole(role: RoleConfig): ModelInfo | undefined {
  return findModel(role.provider, role.model)
}

/**
 * The token-limit parameter an endpoint expects. Unregistered models get
 * `max_tokens`; if the endpoint rejects it, the request is retried once with
 * the other field (`alternateTokenField` in `llm.ts`).
 */
export function tokenFieldFor(provider: ProviderKind, model: string): 'max_tokens' | 'max_completion_tokens' {
  return findModel(provider, model)?.compat?.tokenField ?? 'max_tokens'
}

/** Whether reasoning effort and tools may be sent together (unregistered: yes). */
export function effortWithToolsFor(provider: ProviderKind, model: string): boolean {
  return findModel(provider, model)?.compat?.effortWithTools ?? true
}

/** Whether the model accepts a non-default temperature (unregistered: yes). */
export function temperatureAllowedFor(provider: ProviderKind, model: string): boolean {
  return findModel(provider, model)?.compat?.temperature ?? true
}

/**
 * Whether earlier assistant reasoning is sent back. Undefined means "decide
 * from what the endpoint returned": a response that carried reasoning turns
 * echoing on for the rest of the session.
 */
export function reasoningEchoFor(provider: ProviderKind, model: string): boolean | undefined {
  return findModel(provider, model)?.compat?.reasoningEcho
}

/** Vision input, from the registry; a role's explicit `vision` still wins. */
export function catalogVision(provider: ProviderKind, model: string): boolean | undefined {
  return findModel(provider, model)?.capabilities?.vision
}
