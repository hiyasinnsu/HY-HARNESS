// Token estimation for pre-flight decisions only (design §1 "Token accounting"):
// sizing ledger entries, budget admission, and deciding whether compaction
// tier 1 was enough (SpillCompaction corrects it by the last reported usage).
// Budgets and the compaction trigger use provider-reported usage.
//
// estimate = ceil(asciiChars × a + nonAsciiChars × b), with per-provider
// coefficients; DeepSeek documents a = 0.3, b = 0.6 [V:M-8]. A single
// `bytes / 4` is biased differently per language and provider.
export const DEFAULT_COEFFICIENTS = { ascii: 0.3, nonAscii: 0.6 };
export function estimateTokens(text, c = DEFAULT_COEFFICIENTS) {
    let ascii = 0;
    let other = 0;
    for (const ch of text) {
        if (ch.codePointAt(0) < 0x80)
            ascii += 1;
        else
            other += 1;
    }
    return Math.ceil(ascii * c.ascii + other * c.nonAscii);
}
