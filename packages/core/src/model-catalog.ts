import type { ProviderKind, RoleConfig } from './config.js'

/**
 * WP-41: one place that knows a model's limits and quirks. Roles still carry
 * their own values (a user can point at any model), but when the role does not
 * say otherwise these entries fill in the context window, output cap, price and
 * the API compatibility flags that used to be hard-coded per provider.
 */
export interface ModelCompat {
  /** OpenAI's newer models reject `max_tokens` in favour of `max_completion_tokens`. */
  tokenField?: 'max_tokens' | 'max_completion_tokens'
  /** Reasoning effort and tools cannot be sent together. */
  effortWithTools?: boolean
  /** The model only accepts the default temperature. */
  temperature?: boolean
}

export interface ModelInfo {
  /** `provider:model`, the key `hy models` prints. */
  id: string
  provider: ProviderKind
  model: string
  label: string
  contextWindowTokens: number
  maxOutputTokens: number
  pricing?: { inputPerMTokUsd: number; cachedInputPerMTokUsd?: number; outputPerMTokUsd: number }
  capabilities: { tools: boolean; vision: boolean; reasoning: boolean; cache: boolean }
  compat?: ModelCompat
}

/**
 * The catalog is deliberately small: models the harness has been tested against
 * or whose limits are documented. Anything else still works — a role just has to
 * state its own `contextWindowTokens` / `maxOutputTokens`.
 */
export const MODEL_CATALOG: readonly ModelInfo[] = [
  {
    id: 'ollama:qwen2.5:3b',
    provider: 'ollama',
    model: 'qwen2.5:3b',
    label: 'Qwen 2.5 3B (local)',
    contextWindowTokens: 32_768,
    maxOutputTokens: 8_192,
    pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
    capabilities: { tools: true, vision: false, reasoning: false, cache: false },
  },
  {
    id: 'deepseek:deepseek-v4.1-flash',
    provider: 'deepseek',
    model: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 262_144,
    capabilities: { tools: true, vision: true, reasoning: true, cache: true },
  },
  {
    id: 'opencode:deepseek-v4.1-flash',
    provider: 'opencode',
    model: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash (OpenCode Go)',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 131_072,
    capabilities: { tools: true, vision: true, reasoning: true, cache: true },
  },
  {
    id: 'openai-compatible:gpt-4.1-mini',
    provider: 'openai-compatible',
    model: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini',
    contextWindowTokens: 1_047_576,
    maxOutputTokens: 32_768,
    capabilities: { tools: true, vision: true, reasoning: false, cache: true },
  },
  {
    id: 'openai-responses:gpt-4.1-mini',
    provider: 'openai-responses',
    model: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini (Responses)',
    contextWindowTokens: 1_047_576,
    maxOutputTokens: 32_768,
    capabilities: { tools: true, vision: true, reasoning: false, cache: true },
    compat: { tokenField: 'max_tokens', temperature: false },
  },
  {
    id: 'anthropic:claude-sonnet-4-5',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_768,
    capabilities: { tools: true, vision: true, reasoning: true, cache: true },
  },
  {
    id: 'gemini:gemini-3.8-flash',
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 65_536,
    capabilities: { tools: true, vision: true, reasoning: true, cache: true },
  },
  {
    id: 'mock:mock',
    provider: 'mock',
    model: 'mock',
    label: 'Mock (offline)',
    contextWindowTokens: 32_768,
    maxOutputTokens: 4_096,
    pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
    capabilities: { tools: true, vision: true, reasoning: false, cache: false },
  },
]

const BY_ID = new Map(MODEL_CATALOG.map((entry) => [entry.id, entry]))

/** The catalog entry for a provider + model, or undefined for an unknown model. */
export function findModel(provider: ProviderKind, model: string): ModelInfo | undefined {
  return BY_ID.get(`${provider}:${model}`)
}

/** The catalog entry a role points at (undefined when the model is not listed). */
export function catalogForRole(role: RoleConfig): ModelInfo | undefined {
  return findModel(role.provider, role.model)
}

/**
 * The token-limit parameter an OpenAI-style endpoint expects. The catalog wins;
 * otherwise the historical heuristic (reasoning models use the newer field).
 */
export function tokenFieldFor(provider: ProviderKind, model: string): 'max_tokens' | 'max_completion_tokens' {
  const entry = findModel(provider, model)
  if (entry?.compat?.tokenField) return entry.compat.tokenField
  return /(^o\d|gpt-5|gpt-6|reason)/i.test(model) ? 'max_completion_tokens' : 'max_tokens'
}

/** Whether reasoning effort and tools may be sent together (the catalog is authoritative). */
export function effortWithToolsFor(provider: ProviderKind, model: string): boolean {
  const entry = findModel(provider, model)
  if (entry?.compat?.effortWithTools !== undefined) return entry.compat.effortWithTools
  return !/gpt-6\.1-terra/i.test(model)
}

/** Whether the model accepts a non-default temperature. */
export function temperatureAllowedFor(provider: ProviderKind, model: string): boolean {
  const entry = findModel(provider, model)
  if (entry?.compat?.temperature !== undefined) return entry.compat.temperature
  return tokenFieldFor(provider, model) === 'max_tokens'
}

/** Vision input, from the catalog; a role's explicit `vision` still wins. */
export function catalogVision(provider: ProviderKind, model: string): boolean | undefined {
  return findModel(provider, model)?.capabilities.vision
}
