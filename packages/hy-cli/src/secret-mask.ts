/**
 * WP-61: display-only secret masking (DSH's `dsh-client-ui-secret-mask`).
 *
 * The transcript keeps the original text; the GUI masks what a key *looks* like
 * before rendering, so a pasted key is not shown to someone looking at the
 * screen (a screen share, a demo, a photo). Masking must never change stored
 * content or what the model receives.
 */

/** Prefixes a key keeps visible so the user can still recognise it. */
const KEEP = 6

interface Pattern {
  name: string
  re: RegExp
}

const PATTERNS: Pattern[] = [
  // `api_key=…`, `token: "…"`, `password=…` assignments come first: the name
  // stays readable and a value that also looks like a key is masked once.
  // The parameter name may be prefixed (`OPENAI_API_KEY=`), so the match cannot
  // start at a word boundary.
  {
    name: 'assignment',
    re: /([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret))(\s*[:=]\s*["']?)([A-Za-z0-9._~+/-]{12,})/gi,
  },
  // OpenAI/Anthropic/DeepSeek style: sk-…, sk-ant-…, sk-proj-…
  { name: 'sk', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  // GitHub tokens
  { name: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  // AWS access key id
  { name: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Slack
  { name: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  // Google API keys
  { name: 'google', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  // Bearer tokens in copied curl commands
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  // PEM private keys (the whole block, including the body)
  { name: 'pem', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
]

function maskOne(value: string): string {
  const visible = value.slice(0, KEEP)
  return `${visible}${'•'.repeat(Math.min(12, Math.max(4, value.length - KEEP)))}`
}

export interface MaskResult {
  text: string
  /** How many secrets were replaced (the GUI can show "3 masked"). */
  masked: number
  /** Pattern names that matched, for diagnostics (never the values). */
  kinds: string[]
}

const MASK = '••••'

/** Masks likely secrets in `text`, leaving the rest byte-for-byte intact. */
export function maskSecrets(text: string, options: { replacement?: string } = {}): MaskResult {
  if (!text) return { text, masked: 0, kinds: [] }
  let out = text
  let masked = 0
  const kinds: string[] = []
  const custom = options.replacement !== undefined
  const replacement = options.replacement ?? MASK
  /** A custom replacement is used verbatim; the default keeps a prefix. */
  const maskedValue = (value: string): string => (custom ? replacement : maskOne(value))
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0
    if (!pattern.re.test(out)) continue
    pattern.re.lastIndex = 0
    kinds.push(pattern.name)
    out = out.replace(pattern.re, (...args: unknown[]) => {
      masked += 1
      if (pattern.name === 'assignment') {
        // Keep the parameter name readable: `api_key=••••`.
        const [, key, separator] = args as [string, string, string, number, string]
        return `${key}${separator}${replacement}`
      }
      if (pattern.name === 'bearer') {
        return `Bearer ${replacement}`
      }
      if (pattern.name === 'pem') return replacement
      return maskedValue(String(args[0]))
    })
  }
  return { text: out, masked, kinds }
}

/** Whether masking would change anything (cheap check for badges). */
export function containsSecret(text: string): boolean {
  return maskSecrets(text).masked > 0
}
