// Token estimation for pre-flight decisions only (design §1 "Token accounting"):
// sizing ledger entries, budget admission, and deciding whether compaction
// tier 1 was enough (SpillCompaction corrects it by the last reported usage).
// Budgets and the compaction trigger use provider-reported usage.
//
// estimate = ceil(asciiChars × a + nonAsciiChars × b), with per-provider
// coefficients; DeepSeek documents a = 0.3, b = 0.6 [V:M-8]. A single
// `bytes / 4` is biased differently per language and provider.

export interface TokenCoefficients {
  ascii: number
  nonAscii: number
}

export const DEFAULT_COEFFICIENTS: TokenCoefficients = { ascii: 0.3, nonAscii: 0.6 }

export function estimateTokens(text: string, c: TokenCoefficients = DEFAULT_COEFFICIENTS): number {
  let ascii = 0
  let other = 0
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) ascii += 1
    else other += 1
  }
  return Math.ceil(ascii * c.ascii + other * c.nonAscii)
}

/** CP-23: one estimate/actual pair from a provider call. */
export interface TokenSample {
  estimated: number
  actual: number
}

/**
 * CP-23: scales the coefficients by the observed actual/estimated ratio,
 * clamped so one odd request cannot swing the estimate wildly.
 */
export function calibratedCoefficients(
  samples: readonly TokenSample[],
  base: TokenCoefficients = DEFAULT_COEFFICIENTS,
): TokenCoefficients {
  let estimated = 0
  let actual = 0
  for (const sample of samples) {
    if (!Number.isFinite(sample.estimated) || !Number.isFinite(sample.actual)) continue
    if (sample.estimated <= 0 || sample.actual <= 0) continue
    estimated += sample.estimated
    actual += sample.actual
  }
  if (estimated === 0) return base
  const ratio = Math.min(2, Math.max(0.5, actual / estimated))
  return { ascii: base.ascii * ratio, nonAscii: base.nonAscii * ratio }
}