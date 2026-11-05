// CP-39: `hy doctor` — a single diagnostic report for support and first-run
// troubleshooting. The report is built from injected facts so it can be tested
// without spawning the exec server; the CLI supplies the real ones.

import fs from 'node:fs'
import path from 'node:path'
import type { HarnessConfig } from '../../core/dist/index.js'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface DoctorCheck {
  name: string
  status: CheckStatus
  detail: string
}

export interface DoctorInput {
  version: string
  node: string
  platform: string
  workspace: string
  config: HarnessConfig
  execServerPath: string
  sandbox?: {
    enforcement: string
    available: boolean
    gaps?: string[]
    denyRead?: string[]
    readOnly?: string[]
    error?: string
  }
  mcpServers?: string[]
  secretBin?: string
}

/** The report's sandbox input from a `sandbox/status` result. */
export function doctorSandbox(status: {
  enforcement: unknown
  workspaceWriteAvailable: boolean
  gaps?: string[] | null
  denyRead?: string[] | null
  readOnly?: string[] | null
}): NonNullable<DoctorInput['sandbox']> {
  return {
    enforcement: String(status.enforcement),
    available: status.workspaceWriteAvailable,
    gaps: status.gaps ?? [],
    denyRead: status.denyRead ?? [],
    readOnly: status.readOnly ?? [],
  }
}

const KEYLESS = new Set(['mock', 'ollama'])

/** True when the role can authenticate: a literal key, a set env var, or a keyless provider. */
export function roleHasCredentials(role: { provider: string; apiKey?: string; apiKeyEnv?: string }): boolean {
  if (KEYLESS.has(role.provider)) return true
  if (role.apiKey !== undefined && role.apiKey.length > 0) return true
  const env = role.apiKeyEnv ?? (role.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : role.provider === 'opencode' ? 'OPENCODE_API_KEY' : role.provider === 'gemini' ? 'GEMINI_API_KEY' : role.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY')
  return (process.env[env] ?? '').length > 0
}

export function buildDoctorReport(input: DoctorInput): { ok: boolean; version: string; checks: DoctorCheck[] } {
  const checks: DoctorCheck[] = []
  checks.push({ name: 'node', status: 'ok', detail: `${input.node} on ${input.platform}` })
  checks.push({
    name: 'workspace',
    status: fs.existsSync(input.workspace) ? 'ok' : 'fail',
    detail: input.workspace,
  })
  checks.push({
    name: 'config',
    status: 'ok',
    detail: `${input.config.role.provider}/${input.config.role.model}; sandbox ${input.config.sandbox} (${input.config.sandboxSource})`,
  })
  checks.push({
    name: 'exec-server',
    status: fs.existsSync(input.execServerPath) ? 'ok' : 'fail',
    detail: input.execServerPath,
  })
  if (input.sandbox === undefined) {
    checks.push({ name: 'sandbox', status: 'warn', detail: 'not checked (the exec server did not answer)' })
  } else if (input.sandbox.error) {
    checks.push({ name: 'sandbox', status: 'warn', detail: input.sandbox.error })
  } else {
    const gaps = input.sandbox.gaps ?? []
    checks.push({
      name: 'sandbox',
      status: input.sandbox.available ? (gaps.length > 0 ? 'ok' : 'ok') : 'warn',
      detail: `${input.sandbox.enforcement}; available=${String(input.sandbox.available)}${
        gaps.length > 0 ? `; gaps: ${gaps.join(', ')}` : ''
      }`,
    })
    if ((input.sandbox.denyRead ?? []).length > 0) {
      checks.push({ name: 'denyRead', status: 'ok', detail: `${input.sandbox.denyRead!.length} path(s)` })
    }
    if ((input.sandbox.readOnly ?? []).length > 0) {
      checks.push({ name: 'readOnly', status: 'ok', detail: `${input.sandbox.readOnly!.length} path(s)` })
    }
  }
  for (const [label, role] of [
    ['worker', input.config.role],
    ['grader', input.config.graderRole],
    ['compactor', input.config.compactorRole],
  ] as const) {
    checks.push({
      name: `role:${label}`,
      status: roleHasCredentials(role) ? 'ok' : 'warn',
      detail: roleHasCredentials(role) ? `${role.provider}/${role.model}` : `${role.provider}/${role.model} has no API key`,
    })
  }
  // CP-38: which feature flags are on (experimental ones are opt-in).
  const enabledFeatures = Object.entries(input.config.features ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name)
  checks.push({ name: 'features', status: 'ok', detail: enabledFeatures.length > 0 ? enabledFeatures.join(', ') : 'none' })
  const mcp = input.mcpServers ?? []
  checks.push({ name: 'mcp', status: 'ok', detail: mcp.length === 0 ? 'no servers configured' : mcp.join(', ') })
  if (input.secretBin) {
    checks.push({
      name: 'hy-secret',
      status: fs.existsSync(input.secretBin) ? 'ok' : 'warn',
      detail: input.secretBin,
    })
  }
  const update = input.config.update
  if (update) checks.push({ name: 'update-feed', status: 'ok', detail: update.feed ?? 'not configured' })
  const ok = !checks.some((check) => check.status === 'fail')
  return { ok, version: input.version, checks }
}

/** Locates `hy-secret.exe` similarly to the secret store (best effort). */
export function findSecretBinary(): string | undefined {
  const candidates = [
    process.env.HY_SECRET_BIN,
    path.join(process.cwd(), 'target', 'debug', 'hy-secret.exe'),
    path.join(process.cwd(), 'target', 'release', 'hy-secret.exe'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}