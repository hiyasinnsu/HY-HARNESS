import type { RoleConfig } from './config.js'

/**
 * WP-42: typed bundles (the lightweight replacement for DSH's ordered YAML
 * profile patches). A bundle is a named, compile-time object that can narrow the
 * tool set, add a prompt section, suggest role defaults and name the UI panels
 * and slash commands it expects.
 *
 * Resolution is `core` → the selected profile's `bundles` → the user config's
 * `bundles` → `--bundle` flags. Narrowing bundles only ever *take tools away*
 * (the resolved allowlist is their intersection), so a bundle can never widen
 * what the policy or the sandbox allows, and a bundle that says nothing about
 * tools leaves the host's configured tool set alone.
 */
export interface Bundle {
  name: string
  description: string
  /**
   * When set, the session's tools are limited to these names. Only narrowing
   * bundles (`minimal`, `audit`, `orchestrator`) set it: `core`, `ptc` and
   * `worker` mean "whatever the host's configuration already offers", so a
   * bundle never silently disables web access, LSP, memory or `run_code`.
   */
  allowTools?: readonly string[]
  /** Appended to the system prompt (after the role instruction). */
  prompt?: string
  /** Role defaults a bundle suggests (a role's own value still wins). */
  roleDefaults?: Partial<Pick<RoleConfig, 'maxOutputTokens' | 'temperature' | 'effort' | 'nativeTools'>>
  /** Panels the GUI should show for this bundle. */
  panels?: readonly string[]
  /** Slash commands that make sense in this bundle. */
  commands?: readonly string[]
}

/** Reading-only tools, shared by `minimal` and `audit`. */
const READ_TOOLS = ['read_file', 'search_glob', 'search_grep'] as const

/** The tools a narrow bundle keeps; each is also in the host's own tool set. */
const CORE_TOOLS = [
  ...READ_TOOLS,
  'apply_patch',
  'shell',
  'update_plan',
  'todo_write',
  'present',
] as const

export const BUNDLES: Record<string, Bundle> = {
  core: {
    name: 'core',
    description: 'The host default: every tool the configuration enables.',
    panels: ['files', 'diff', 'plan'],
    commands: ['/help', '/model', '/plan'],
  },
  ptc: {
    name: 'ptc',
    description: 'The default tools; pair with --ptc to advertise run_code.',
    prompt: 'Prefer run_code when a task needs several chained tool calls: only the return value comes back.',
    panels: ['files', 'diff', 'plan', 'trace'],
  },
  minimal: {
    name: 'minimal',
    description: 'Reading only: three tools, no writes and no shell.',
    allowTools: READ_TOOLS,
    prompt: 'This session is read-only: investigate and answer; do not propose edits you cannot make.',
    panels: ['files'],
    commands: ['/help'],
  },
  audit: {
    name: 'audit',
    description: 'A read-only review session (the three reading tools plus web fetch).',
    allowTools: [...READ_TOOLS, 'web_fetch', 'web_search'],
    prompt: 'Review what exists. Report findings with file paths and line numbers; change nothing.',
    panels: ['files', 'diff'],
  },
  orchestrator: {
    name: 'orchestrator',
    description: 'Planning and delegation only: no file writes, no shell.',
    allowTools: [...CORE_TOOLS.filter((tool) => tool !== 'apply_patch' && tool !== 'shell'), 'delegate', 'ask_user'],
    panels: ['plan', 'files'],
  },
  worker: {
    name: 'worker',
    // B5: the core tools plus `lsp` (offered only when a language server is
    // configured), so a worker can read diagnostics after an edit. The rest of
    // the default set (run_code, web, MCP) stays out to keep the worker small.
    description: 'The core tools plus lsp, without delegation (workers do not spawn workers).',
    allowTools: [...CORE_TOOLS, 'lsp'],
    panels: ['files', 'diff', 'plan'],
  },
}

export interface ResolvedBundles {
  /** The bundles in resolution order (core first). */
  names: string[]
  /** The intersection of every narrowing bundle's allowlist; undefined = no restriction. */
  tools?: Set<string>
  /** Prompt sections, in order. */
  prompts: string[]
  panels: string[]
  commands: string[]
  roleDefaults: Partial<Pick<RoleConfig, 'maxOutputTokens' | 'temperature' | 'effort' | 'nativeTools'>>
}

/**
 * Resolves bundle names (in priority order) into their combined contribution.
 * Unknown names are an error: a typo must not silently produce a wider session.
 */
export function resolveBundles(names: readonly string[], extra: Record<string, Bundle> = {}): ResolvedBundles {
  const registry = { ...BUNDLES, ...extra }
  const ordered: string[] = []
  for (const name of ['core', ...names]) {
    const trimmed = name.trim()
    if (!trimmed || ordered.includes(trimmed)) continue
    if (!registry[trimmed]) {
      throw new Error(`unknown bundle ${trimmed}; available: ${Object.keys(registry).join(', ')}`)
    }
    ordered.push(trimmed)
  }
  const bundles = ordered.map((name) => registry[name]!)
  let tools: Set<string> | undefined
  for (const bundle of bundles) {
    if (!bundle.allowTools) continue
    tools = tools ? new Set([...tools].filter((tool) => bundle.allowTools!.includes(tool))) : new Set(bundle.allowTools)
  }
  const prompts: string[] = []
  const panels: string[] = []
  const commands: string[] = []
  const roleDefaults: ResolvedBundles['roleDefaults'] = {}
  for (const bundle of bundles) {
    if (bundle.prompt) prompts.push(bundle.prompt)
    for (const panel of bundle.panels ?? []) if (!panels.includes(panel)) panels.push(panel)
    for (const command of bundle.commands ?? []) if (!commands.includes(command)) commands.push(command)
    Object.assign(roleDefaults, bundle.roleDefaults ?? {})
  }
  return {
    names: ordered,
    ...(tools ? { tools } : {}),
    prompts,
    panels,
    commands,
    roleDefaults,
  }
}
