/**
 * CP-34: what an approval request will do, on one screen.
 *
 * The approval card used to show only the command. This module adds the
 * working directory, the sandbox effect, the paths the command names and the
 * hosts it is likely to contact, and turns a decision scope into what the
 * server remembers:
 *
 * - `once`: nothing is remembered.
 * - `session`: the same command (same sandbox, whitespace-normalised) is
 *   approved again without asking until the GUI server stops.
 * - `always`: an allow rule is appended to the user policy (`policy.star`),
 *   so later sessions skip the prompt too. Never for unconfined or
 *   low-integrity requests: those always need a person.
 *
 * Network targets are a best-effort reading of the command line (URLs and
 * well-known network commands); network confinement itself is out of scope
 * for this plan (CP-03/04), so the card says "may contact", not "will".
 */
import fs from 'node:fs'
import path from 'node:path'

export type ApprovalScope = 'once' | 'session' | 'always'

export interface ApprovalRequestLike {
  command: string
  sandbox?: string
  cwd?: string
  justification?: string
  matchedRule?: string
}

export interface ApprovalDetails {
  cwd: string
  sandbox: string
  /** One line: what the sandbox lets the command do. */
  effect: string
  /** Paths named on the command line (as written), at most 12. */
  paths: string[]
  /** Hosts or registries the command may contact, at most 8. */
  network: string[]
  /** False when `always` may not be offered (user-only sandboxes). */
  persistable: boolean
}

const USER_ONLY = new Set(['unconfined', 'low-integrity'])

const EFFECTS: Record<string, string> = {
  'read-only': 'confined: may read, may not write anywhere',
  'workspace-write': 'confined: may write inside the workspace roots only',
  'low-integrity': 'low integrity: may write the workspace, other granted roots and LocalLow',
  unconfined: 'UNCONFINED: runs with your full user rights',
}

/** Shell-like split: double/single quotes group, backslashes stay (Windows paths). */
export function splitCommand(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) out.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
    started = true
  }
  if (started) out.push(current)
  return out
}

const NETWORK_COMMANDS: Array<{ match: (t: string[]) => boolean; target: (t: string[]) => string }> = [
  { match: (t) => ['npm', 'npm.cmd', 'pnpm', 'yarn', 'npx'].includes(t[0] ?? '') && ['install', 'i', 'add', 'update', 'up', 'dlx', 'publish', 'exec'].includes(t[1] ?? ''), target: () => 'registry.npmjs.org' },
  { match: (t) => ['npx', 'npx.cmd'].includes(t[0] ?? ''), target: () => 'registry.npmjs.org' },
  { match: (t) => ['pip', 'pip3', 'uv'].includes(t[0] ?? '') && ['install', 'download', 'add', 'sync'].includes(t[1] ?? ''), target: () => 'pypi.org' },
  { match: (t) => t[0] === 'cargo' && ['install', 'add', 'update', 'fetch', 'publish'].includes(t[1] ?? ''), target: () => 'crates.io' },
  { match: (t) => t[0] === 'git' && ['clone', 'fetch', 'pull', 'push', 'ls-remote'].includes(t[1] ?? ''), target: (t) => t.find((x) => /^(https?:|git@|ssh:)/.test(x)) ?? 'the git remote' },
  { match: (t) => t[0] === 'gh', target: () => 'api.github.com' },
]

function hostOf(token: string): string | undefined {
  const url = /^(?:https?|wss?|ftp):\/\/([^/\s:'"]+)/i.exec(token)
  if (url) return url[1]!.toLowerCase()
  const scp = /^[\w.-]+@([\w.-]+):/.exec(token)
  return scp ? scp[1]!.toLowerCase() : undefined
}

function looksLikePath(token: string): boolean {
  if (token.startsWith('-') || /^[a-z]+:\/\//i.test(token) || /^[\w.-]+@[\w.-]+:/.test(token)) return false
  if (/^[a-zA-Z]:[\\/]/.test(token) || token.startsWith('\\\\') || token.startsWith('/') || token.startsWith('./') || token.startsWith('.\\') || token.startsWith('../') || token.startsWith('..\\') || token.startsWith('~')) return true
  // relative paths with a separator or a file extension
  return /[\\/]/.test(token) || /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(token)
}

export function describeApproval(request: ApprovalRequestLike, workspaceRoot: string): ApprovalDetails {
  const tokens = splitCommand(request.command)
  // Redirections (`> out.txt`, `2>&1`) name paths too.
  const words = tokens.flatMap((t) => {
    const m = /^\d?>>?(.+)$/.exec(t)
    return m && !m[1]!.startsWith('&') ? [m[1]!] : [t]
  })
  const paths = [...new Set(words.slice(1).filter(looksLikePath))].slice(0, 12)
  const network = new Set<string>()
  for (const t of words) {
    const host = hostOf(t)
    if (host) network.add(host)
  }
  // `cmd /c npm install`, `powershell -Command ...`: look past the wrapper too.
  const starts = words.map((_, i) => i).filter((i) => i === 0 || /^(\/c|-c|-command|&&|;|\|)$/i.test(words[i - 1] ?? ''))
  for (const i of starts) {
    const rest = words.slice(i).map((w) => w.toLowerCase())
    for (const rule of NETWORK_COMMANDS) if (rule.match(rest)) network.add(rule.target(words.slice(i)))
    if (/^(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)(\.exe)?$/i.test(rest[0] ?? '') && ![...network].some(Boolean)) network.add('a web address')
  }
  const sandbox = request.sandbox ?? 'unknown'
  return {
    cwd: request.cwd ?? workspaceRoot,
    sandbox,
    effect: EFFECTS[sandbox] ?? 'sandbox not reported',
    paths,
    network: [...network].slice(0, 8),
    persistable: !USER_ONLY.has(sandbox),
  }
}

/** The key a `session` approval is remembered under. */
export function approvalKey(request: ApprovalRequestLike): string {
  return `${request.sandbox ?? ''}\u0000${request.command.trim().replace(/\s+/g, ' ')}`
}

const starString = (value: string) => JSON.stringify(value)

/**
 * The `prefix_rule` an `always` approval writes: the exact token prefix of the
 * command, kept in its sandbox, with the command itself as the match example
 * (the policy loader checks examples, so a bad rule fails loudly).
 */
export function alwaysRule(request: ApprovalRequestLike, when = new Date()): string {
  if (USER_ONLY.has(request.sandbox ?? '')) throw new Error(`a ${request.sandbox} approval cannot be remembered; it always needs a person`)
  const tokens = splitCommand(request.command)
  if (tokens.length === 0) throw new Error('empty command')
  const pattern = `[${tokens.map(starString).join(', ')}]`
  const sandbox = request.sandbox && !USER_ONLY.has(request.sandbox) ? `, sandbox = ${starString(request.sandbox)}` : ''
  return `# Approved "always" from the HY-HARNESS GUI on ${when.toISOString().slice(0, 10)}.\nprefix_rule(pattern = ${pattern}, decision = "allow"${sandbox}, justification = ${starString('approved always by the user')}, match = [${starString(request.command.trim())}])\n`
}

/** Appends an `always` rule to the user policy, creating the file if needed. */
export function rememberAlways(policyPath: string, request: ApprovalRequestLike, when = new Date()): string {
  const rule = alwaysRule(request, when)
  fs.mkdirSync(path.dirname(policyPath), { recursive: true })
  const existing = fs.existsSync(policyPath) ? fs.readFileSync(policyPath, 'utf8') : ''
  const separator = existing && !existing.endsWith('\n') ? '\n\n' : existing ? '\n' : ''
  fs.writeFileSync(policyPath, `${existing}${separator}${rule}`, 'utf8')
  return rule
}
