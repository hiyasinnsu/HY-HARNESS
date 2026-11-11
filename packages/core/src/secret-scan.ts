// E1: credentials kept out of what the model receives and out of commits.
//
// GitHub tokens were already masked (`redactGitHubSecrets`); a credential of any
// other service in a shell or tool result went to the model and could be
// written back into a file and published (the §5.79 incident was a GitHub
// header, but the same path exists for every key). This module adds:
// - the token formats of common providers, PEM private keys, credentials in
//   URLs and Authorization headers;
// - the exact values of the harness's own environment variables that hold
//   keys (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`), so a key in an
//   unknown format is still caught when it leaks verbatim.
//
// Only high-confidence shapes are masked here. Masking changes what the model
// sees, and a false positive in a source file it edits would make it copy
// `[redacted]` back; JWTs and `password = "..."` assignments are common in
// test fixtures, so they are left to the display-only mask in the GUI.

import { redactGitHubSecrets } from './github.js'

interface SecretPattern {
  kind: string
  re: RegExp
  /** Capture group kept in front of the mask (a header name, a URL scheme and user). */
  keep?: number
}

const PATTERNS: SecretPattern[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'openai-anthropic', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'stripe', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { kind: 'gitlab', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'huggingface', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: 'npm', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // scheme://user:password@host — the password goes, the rest stays readable.
  { kind: 'url-credentials', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{6,}(?=@)/gi, keep: 1 },
  { kind: 'authorization', re: /(\b(?:authorization|proxy-authorization|x-api-key|api-key)["']?\s*[:=]\s*["']?\s*(?:(?:basic|bearer|token)\s+)?)[A-Za-z0-9._~+/=-]{16,}/gi, keep: 1 },
]

const SECRET_ENV_NAME = /(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|ACCESS_KEY|PRIVATE_KEY)$|^(?:.*_)?(?:API_?KEY|TOKEN|SECRET)_/i

let envValues: { source: NodeJS.ProcessEnv; values: string[] } | undefined

/**
 * The values of this process's credential-like environment variables. Short or
 * trivial values (`1`, `true`, a path) are left out: masking them would hide
 * ordinary text.
 */
function secretEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  if (envValues && envValues.source === env) return envValues.values
  const values = Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= 12 && !/\s/.test(value) && !/^[A-Za-z]:\\|^\//.test(value))
    .map(([, value]) => value as string)
    // Longest first, so a value that contains another is masked whole.
    .sort((a, b) => b.length - a.length)
  envValues = { source: env, values }
  return values
}

/** The kinds of credential found in `text` (empty when none). */
export function findSecrets(text: string, options: { env?: NodeJS.ProcessEnv } = {}): string[] {
  const kinds = new Set<string>()
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i.test(text)) kinds.add('github')
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0
    if (pattern.re.test(text)) kinds.add(pattern.kind)
  }
  if (secretEnvValues(options.env).some((value) => text.includes(value))) kinds.add('environment-credential')
  return [...kinds]
}

/** `text` with every recognized credential replaced by `[redacted]`. */
export function redactSecrets(text: string, options: { env?: NodeJS.ProcessEnv; token?: string } = {}): string {
  let out = redactGitHubSecrets(text, options.token)
  for (const value of secretEnvValues(options.env)) if (out.includes(value)) out = out.replaceAll(value, '[redacted]')
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0
    out = out.replace(pattern.re, (...match) => `${pattern.keep ? String(match[pattern.keep] ?? '') : ''}[redacted]`)
  }
  return out
}
