import {
  parseApprovalPolicy,
  parseSandboxMode,
  type CliOverrides,
  type ProviderKind,
  type SandboxMode,
} from '../../core/dist/index.js'

export interface Parsed {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
  /** Repeatable options: `--rule`, `--verify-cmd`. */
  lists: Record<string, string[]>
}

const LIST_OPTIONS = new Set(['rule', 'verify-cmd', 'image', 'trusted-host', 'bundle'])
/** Flags that never take a value, so `--last "message"` keeps the message positional. */
const BOOLEAN_OPTIONS = new Set([
  'yes', 'ptc', 'mock', 'trust', 'guardian', 'no-grader', 'unattended-ok', 'allow-protected-edits', 'json', 'last', 'help', 'web',
  'full-auto', 'text-tools', 'memory', 'session-query', 'persistent-shell', 'no-open', 'desktop', 'devtools', 'tailscale', 'show-secrets', 'unsafe-unconfined',
  'mandatory', 'allow-insecure',
])

export function parseArgs(argv: string[]): Parsed {
  const command = argv[0] ?? 'help'
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  const lists: Record<string, string[]> = {}
  const set = (key: string, value: string) => {
    if (LIST_OPTIONS.has(key)) (lists[key] ??= []).push(value)
    else flags[key] = value
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq >= 0) {
        set(arg.slice(2, eq), arg.slice(eq + 1))
        continue
      }
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (!BOOLEAN_OPTIONS.has(key) && next !== undefined && !next.startsWith('--')) {
        set(key, next)
        i += 1
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { command, positional, flags, lists }
}

export function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

export function bool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true'
}

export function toOverrides(p: Parsed): CliOverrides {
  const provider = str(p.flags, 'provider') as ProviderKind | undefined
  const sandboxRaw = str(p.flags, 'sandbox')
  const sandbox: SandboxMode | undefined = bool(p.flags, 'unsafe-unconfined')
    ? 'unconfined'
    : sandboxRaw !== undefined
      ? parseSandboxMode(sandboxRaw)
      : undefined
  return {
    ...(str(p.flags, 'cwd') !== undefined ? { cwd: str(p.flags, 'cwd')! } : {}),
    ...(str(p.flags, 'state-dir') !== undefined ? { stateDir: str(p.flags, 'state-dir')! } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(str(p.flags, 'model') !== undefined ? { model: str(p.flags, 'model')! } : {}),
    ...(str(p.flags, 'base-url') !== undefined ? { baseUrl: str(p.flags, 'base-url')! } : {}),
    ...(str(p.flags, 'api-key-env') !== undefined ? { apiKeyEnv: str(p.flags, 'api-key-env')! } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(str(p.flags, 'approval') !== undefined ? { approvalPolicy: parseApprovalPolicy(str(p.flags, 'approval')!) } : {}),
    ...(bool(p.flags, 'yes') ? { autoApprove: true } : {}),
    ...(bool(p.flags, 'ptc') ? { ptc: true } : {}),
    ...(bool(p.flags, 'mock') ? { mock: true } : {}),
    ...(bool(p.flags, 'web') ? { web: true } : {}),
    ...(bool(p.flags, 'full-auto') ? { fullAuto: true } : {}),
    ...(bool(p.flags, 'text-tools') ? { textTools: true } : {}),
    ...(bool(p.flags, 'memory') ? { memory: true } : {}),
    ...(bool(p.flags, 'session-query') ? { sessionQuery: true } : {}),
    ...(bool(p.flags, 'persistent-shell') ? { persistentShell: true } : {}),
    ...((p.lists.bundle ?? []).length > 0 ? { bundle: p.lists.bundle! } : {}),
    ...(str(p.flags, 'profile') !== undefined ? { profile: str(p.flags, 'profile')! } : {}),
    ...(bool(p.flags, 'trust') ? { projectTrusted: true } : {}),
    ...(bool(p.flags, 'guardian') ? { guardian: true } : {}),
    ...(p.lists.rule ? { rules: p.lists.rule } : {}),
    ...(str(p.flags, 'max-rounds') !== undefined ? { maxRounds: Number(str(p.flags, 'max-rounds')) } : {}),
    ...(str(p.flags, 'max-total-tokens') !== undefined ? { maxTotalTokens: Number(str(p.flags, 'max-total-tokens')) } : {}),
    ...(str(p.flags, 'max-cost-usd') !== undefined
      ? { maxCostUsd: str(p.flags, 'max-cost-usd') === 'off' ? ('off' as const) : Number(str(p.flags, 'max-cost-usd')) }
      : {}),
    ...(str(p.flags, 'max-wall-clock-ms') !== undefined ? { maxWallClockMs: Number(str(p.flags, 'max-wall-clock-ms')) } : {}),
  }
}
