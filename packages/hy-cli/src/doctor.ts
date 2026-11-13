// CP-39: `hy doctor` — a single diagnostic report for support and first-run
// troubleshooting. The report is built from injected facts so it can be tested
// without spawning the exec server; the CLI supplies the real ones.

import fs from 'node:fs'
import path from 'node:path'
import { roleApiKeyEnv, type HarnessConfig, type RoleConfig } from '../../core/dist/index.js'

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

/**
 * True when the role can authenticate: a literal key, a set env var, or a
 * provider that needs no key. The env name comes from `roleApiKeyEnv`, the one
 * place that knows the provider defaults (`undefined` = keyless), so doctor
 * cannot drift from the roles it diagnoses.
 */
export function roleHasCredentials(role: RoleConfig): boolean {
  if (role.apiKey !== undefined && role.apiKey.length > 0) return true
  const env = roleApiKeyEnv(role)
  return env === undefined || (process.env[env] ?? '').length > 0
}

/** Every role in the configuration, in report order; optional roles may be absent. */
function configuredRoles(config: HarnessConfig): Array<[string, RoleConfig]> {
  const roles: Array<[string, RoleConfig | undefined]> = [
    ['worker', config.role],
    ['orchestrator', config.orchestratorRole],
    ['subagent', config.subagentRole],
    ['grader', config.graderRole],
    ['compactor', config.compactorRole],
    ['summarizer', config.summarizerRole],
    ['advisor', config.advisorRole],
    ['guardian', config.guardianRole],
  ]
  return roles.filter((entry): entry is [string, RoleConfig] => entry[1] !== undefined)
}

/**
 * B11: sandbox gaps that are expected on a working setup: the ones every
 * confined mode has (`hy_sandbox_windows::known_gaps`) and non-ACL volumes.
 */
export const EXPECTED_SANDBOX_GAPS: ReadonlySet<string> = new Set([
  'reads-not-confined',
  'network-not-confined',
  'named-pipe-grandchildren',
  'late-hard-links',
  'low-integrity',
  'non-acl-volumes',
])

/** The kind of a gap: the text before its first colon. */
export function gapKind(gap: string): string {
  const colon = gap.indexOf(':')
  return (colon >= 0 ? gap.slice(0, colon) : gap).trim()
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
    // B11: the gaps every confined mode has, and non-ACL volumes (allowed on
    // purpose, 2026-11-03), stay 'ok' with their detail shown. A failed
    // denyRead / read-only grant, or a gap this version does not know, is a
    // configuration that did not take effect and gets 'warn'.
    const unexpected = gaps.filter((gap) => !EXPECTED_SANDBOX_GAPS.has(gapKind(gap)))
    checks.push({
      name: 'sandbox',
      status: input.sandbox.available && unexpected.length === 0 ? 'ok' : 'warn',
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
  // Every role the configuration carries, not just the three the agent uses
  // first: the summarizer, advisor, guardian and orchestrator make their own
  // requests with their own key and model, so a missing key there used to fail
  // a feature later instead of showing up here. Optional roles are skipped.
  for (const [label, role] of configuredRoles(input.config)) {
    const credentialed = roleHasCredentials(role)
    checks.push({
      name: `role:${label}`,
      status: credentialed ? 'ok' : 'warn',
      detail: credentialed ? `${role.provider}/${role.model}` : `${role.provider}/${role.model} has no API key`,
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