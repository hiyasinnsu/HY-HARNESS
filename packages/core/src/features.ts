// CP-38: feature flags.
//
// A small registry with a maturity level per feature. Stable features are on by
// default; experimental ones are off until the user enables them. Overrides
// live in the user config (`features.<name> = true|false`) and are resolved
// once at load, so every consumer sees the same value.

export interface FeatureSpec {
  name: string
  maturity: 'stable' | 'experimental'
  /** On unless the user disabled it. Experimental features default off. */
  defaultOn: boolean
  description: string
}

export const FEATURES: readonly FeatureSpec[] = [
  {
    name: 'streaming',
    maturity: 'stable',
    defaultOn: true,
    description: 'Stream model output deltas to the GUI (OpenAI-compatible adapters).',
  },
  {
    name: 'tool-search',
    maturity: 'stable',
    defaultOn: true,
    description: 'Load low-frequency tools with tool_search instead of the initial prompt.',
  },
  {
    name: 'doctor-json',
    maturity: 'stable',
    defaultOn: true,
    description: 'Machine-readable `hy doctor --json` output.',
  },
]

export type FeatureOverrides = Readonly<Record<string, boolean>>

/** Resolved flags: every registry entry plus any unknown override (kept as-is). */
export function resolveFeatures(overrides: FeatureOverrides = {}): Record<string, boolean> {
  const resolved: Record<string, boolean> = {}
  for (const spec of FEATURES) resolved[spec.name] = spec.defaultOn
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof value === 'boolean') resolved[name] = value
  }
  return resolved
}

export function featureEnabled(features: FeatureOverrides | undefined, name: string): boolean {
  const value = features?.[name]
  if (typeof value === 'boolean') return value
  return FEATURES.find((spec) => spec.name === name)?.defaultOn ?? false
}

/** Rejects an unknown name so a typo does not silently do nothing. */
export function assertFeatureName(name: string): void {
  if (!FEATURES.some((spec) => spec.name === name)) {
    throw new Error(`unknown feature ${JSON.stringify(name)}; known: ${FEATURES.map((spec) => spec.name).join(', ')}`)
  }
}