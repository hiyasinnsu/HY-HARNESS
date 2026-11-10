/**
 * WP-53: the first-run onboarding choices.
 *
 * The wizard is three steps — workspace, sandbox mode, model — and is only a
 * front end: it writes `<stateDir>/onboarding.json`, and the next `hy web`
 * applies those choices to the worker role *unless* the command line already
 * said otherwise (`--sandbox` / `--model` / `--provider` win). Nothing here
 * weakens the default: without a completed wizard the sandbox stays
 * `workspace-write` and the model stays whatever the config and flags resolved to.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  findModel,
  parseSandboxMode,
  roleApiKey,
  type CliOverrides,
  type HarnessConfig,
  type ProviderKind,
  type SandboxMode,
} from '../../core/dist/index.js'

export const ONBOARDING_STEPS = ['workspace', 'sandbox', 'model'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export const PROVIDERS: readonly ProviderKind[] = [
  'ollama',
  'openai-compatible',
  'anthropic',
  'deepseek',
  'opencode',
  'gemini',
  'mock',
]

/** The modes a user may pick in the wizard (a user policy owns `low-integrity`). */
export const ONBOARDING_SANDBOXES: readonly SandboxMode[] = ['workspace-write', 'read-only', 'unconfined']

const KEY_ENV: Record<string, string | undefined> = {
  deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
  'openai-responses': 'OPENAI_API_KEY',
}

export interface OnboardingState {
  complete: boolean
  /** The user pressed "skip": the wizard is done and nothing was changed. */
  skipped?: boolean
  sandbox?: SandboxMode
  provider?: ProviderKind
  model?: string
  baseUrl?: string
  workspace?: string
  completedAt?: number
}

export class OnboardingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OnboardingError'
  }
}

export function onboardingFile(stateDir: string): string {
  return path.join(stateDir, 'onboarding.json')
}

function isSandbox(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (ONBOARDING_SANDBOXES as readonly string[]).includes(value)
}

function isProvider(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
}

export function readOnboarding(stateDir: string): OnboardingState {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(onboardingFile(stateDir), 'utf8'))
  } catch {
    return { complete: false }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { complete: false }
  const parsed = raw as Record<string, unknown>
  return {
    complete: parsed.complete === true,
    ...(parsed.skipped === true ? { skipped: true } : {}),
    ...(isSandbox(parsed.sandbox) ? { sandbox: parsed.sandbox } : {}),
    ...(isProvider(parsed.provider) ? { provider: parsed.provider } : {}),
    ...(typeof parsed.model === 'string' && parsed.model.trim() ? { model: parsed.model.trim() } : {}),
    ...(typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim() ? { baseUrl: parsed.baseUrl.trim() } : {}),
    ...(typeof parsed.workspace === 'string' && parsed.workspace ? { workspace: parsed.workspace } : {}),
    ...(typeof parsed.completedAt === 'number' ? { completedAt: parsed.completedAt } : {}),
  }
}

export interface OnboardingPatch {
  /** Finish the wizard; the choices below are saved with it. */
  complete?: boolean
  /** Finish without changing anything (the app keeps its current defaults). */
  skip?: boolean
  sandbox?: string
  provider?: string
  model?: string
  baseUrl?: string
  workspace?: string
}

/** Validates a patch and persists it atomically. */
export function writeOnboarding(stateDir: string, patch: OnboardingPatch): OnboardingState {
  const previous = readOnboarding(stateDir)
  const next: OnboardingState = { ...previous }
  if (patch.sandbox !== undefined) {
    if (!isSandbox(patch.sandbox)) {
      throw new OnboardingError(`sandbox must be one of ${ONBOARDING_SANDBOXES.join(', ')}`)
    }
    next.sandbox = parseSandboxMode(patch.sandbox)
  }
  if (patch.provider !== undefined) {
    if (!isProvider(patch.provider)) throw new OnboardingError(`provider must be one of ${PROVIDERS.join(', ')}`)
    next.provider = patch.provider
  }
  if (patch.model !== undefined) {
    const model = patch.model.trim()
    if (!model) throw new OnboardingError('model must not be empty')
    next.model = model
  }
  if (patch.baseUrl !== undefined) {
    const baseUrl = patch.baseUrl.trim()
    if (baseUrl) {
      let url: URL
      try {
        url = new URL(baseUrl)
      } catch {
        throw new OnboardingError('baseUrl must be an http(s) URL')
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OnboardingError('baseUrl must be an http(s) URL')
      next.baseUrl = baseUrl.replace(/\/+$/, '')
    } else {
      delete next.baseUrl
    }
  }
  if (patch.workspace !== undefined) next.workspace = patch.workspace
  if (patch.complete === true || patch.skip === true) {
    next.complete = true
    next.completedAt = Date.now()
    if (patch.skip === true) next.skipped = true
    else delete next.skipped
  }
  const file = onboardingFile(stateDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return next
}

export interface OnboardingView {
  complete: boolean
  skipped: boolean
  steps: readonly OnboardingStep[]
  workspace: { root: string; name: string }
  sandbox: SandboxMode
  model: { provider: ProviderKind; model: string; baseUrl: string | null; apiKeyEnv: string | null; hasApiKey: boolean }
  saved: { sandbox: SandboxMode | null; provider: ProviderKind | null; model: string | null; baseUrl: string | null }
  choices: { sandboxes: readonly SandboxMode[]; providers: readonly ProviderKind[] }
}

export function onboardingView(config: HarnessConfig, state: OnboardingState): OnboardingView {
  const role = config.role
  return {
    complete: state.complete,
    skipped: state.skipped === true,
    steps: ONBOARDING_STEPS,
    workspace: { root: config.workspaceRoot, name: path.basename(config.workspaceRoot) || config.workspaceRoot },
    sandbox: config.sandbox,
    model: {
      provider: role.provider,
      model: role.model,
      baseUrl: role.baseUrl ?? null,
      apiKeyEnv: role.apiKeyEnv ?? (KEY_ENV[role.provider] ?? null),
      hasApiKey: roleApiKey(role) !== undefined,
    },
    saved: {
      sandbox: state.sandbox ?? null,
      provider: state.provider ?? null,
      model: state.model ?? null,
      baseUrl: state.baseUrl ?? null,
    },
    choices: { sandboxes: ONBOARDING_SANDBOXES, providers: PROVIDERS },
  }
}

/**
 * Applies a completed wizard to the resolved config. Explicit flags win, so a
 * `hy web --sandbox read-only` never turns into the saved mode.
 */
export function applyOnboardingDefaults(
  config: HarnessConfig,
  overrides: CliOverrides = {},
): { state: OnboardingState; applied: string[] } {
  const state = readOnboarding(config.stateDir)
  const applied: string[] = []
  if (!state.complete || state.skipped === true) return { state, applied }
  if (state.sandbox !== undefined && overrides.sandbox === undefined && config.sandbox !== state.sandbox) {
    config.sandbox = state.sandbox
    applied.push(`sandbox=${state.sandbox}`)
  }
  // `--mock` is an explicit provider choice too: a saved model must not turn a
  // deterministic test run into a request to a real API.
  if (state.model !== undefined && overrides.model === undefined && overrides.mock !== true) {
    const provider = state.provider ?? config.role.provider
    const providerChanged = config.role.provider !== provider
    if (providerChanged && overrides.provider === undefined) config.role.provider = provider
    config.role.model = state.model
    if (overrides.baseUrl === undefined) {
      if (state.baseUrl !== undefined && config.role.provider === provider) config.role.baseUrl = state.baseUrl
      // A saved url belongs to the provider it was typed for; a new provider
      // falls back to its own default instead of sending requests to the old host.
      else if (providerChanged && overrides.provider === undefined) delete config.role.baseUrl
    }
    if (providerChanged && overrides.provider === undefined) {
      const keyEnv = KEY_ENV[config.role.provider]
      if (keyEnv) config.role.apiKeyEnv = keyEnv
      else delete config.role.apiKeyEnv
    }
    // The catalog knows the limits of a listed model; an unlisted one keeps the
    // role's own limits (never guess a smaller context window for it).
    const listed = findModel(config.role.provider, config.role.model)
    if (listed?.contextWindowTokens !== undefined) config.role.contextWindowTokens = listed.contextWindowTokens
    if (listed?.maxOutputTokens !== undefined) config.role.maxOutputTokens = listed.maxOutputTokens
    applied.push(`model=${config.role.provider}:${config.role.model}`)
  }
  return { state, applied }
}
