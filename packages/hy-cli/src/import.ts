/**
 * CP-31: `hy import claude|dsh` — bring an existing setup over.
 *
 * Claude Code:
 *   CLAUDE.md (project, ~/.claude)        → AGENTS.md (project, user config dir)
 *   .mcp.json, ~/.claude.json mcpServers  → mcpServers (project, user config)
 *   .claude/settings*.json hooks          → hooks (event and tool names mapped)
 *   .claude/skills/<name>/                → skills (project, user)
 *   .claude/commands/<name>.md            → prompts/<name>.md
 *   ~/.claude/projects/<ws>/memory/*.md   → workspace memory entries
 * DSH (DeepSeek Harness):
 *   ~/.dsh/sessions/<ws>/<id>/session.v4.jsonl.zstd → threads in this
 *   workspace's session log (user, assistant, tool calls and results)
 *
 * Nothing is written until the plan is shown and accepted: `planImport`
 * returns every change with a diff, `applyImport` writes the accepted kinds.
 * A second plan after an apply is all `skip` (the import is idempotent).
 * Credentials are never read (DSH's .credentials.yaml, Claude's OAuth data);
 * MCP `env` blocks are copied as they are, which the plan says.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { MemoryStore, SessionLog, readEvents, sessionLogPath, type HooksConfig, type HookSpec } from '../../core/dist/index.js'

export type ImportSource = 'claude' | 'dsh'
export type ImportKind = 'agents' | 'mcp' | 'hooks' | 'skills' | 'prompts' | 'memory' | 'sessions'

export interface ImportItem {
  kind: ImportKind
  /** File or config the change goes to. */
  target: string
  action: 'create' | 'update' | 'skip'
  summary: string
  /** A readable diff (`+` / `-` lines) of what changes. */
  diff: string
  /** Writes the change; absent for `skip`. */
  apply?: () => string
}

export interface ImportContext {
  workspaceRoot: string
  stateDir: string
  /** HY's user config directory (config.json, skills/, prompts/, AGENTS.md). */
  userConfigDir: string
  /** The home directory to read ~/.claude, ~/.claude.json and ~/.dsh from. */
  home?: string
}

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function lineDiff(before: string, after: string): string {
  if (before === after) return ''
  const a = before.replace(/\r\n/g, '\n').split('\n')
  const b = after.replace(/\r\n/g, '\n').split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const context = start > 0 ? [`  ${a[start - 1]}`] : []
  return [...context, ...a.slice(start, endA).map((l) => `- ${l}`), ...b.slice(start, endB).map((l) => `+ ${l}`)].join('\n')
}

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

function writeFile(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  return file
}

// ---------------------------------------------------------------- AGENTS.md

const IMPORT_MARK = '<!-- imported from CLAUDE.md by hy import -->'

function agentsItem(source: string, target: string): ImportItem | undefined {
  const claude = readText(source)?.trim()
  if (!claude) return undefined
  const current = readText(target)
  if (current !== undefined && (current.includes(claude) || current.includes(IMPORT_MARK))) {
    return { kind: 'agents', target, action: 'skip', summary: `${path.basename(source)} is already in ${target}`, diff: '' }
  }
  const next = current === undefined ? `${claude}\n` : `${current.trimEnd()}\n\n${IMPORT_MARK}\n## Imported from CLAUDE.md\n\n${claude}\n`
  return {
    kind: 'agents',
    target,
    action: current === undefined ? 'create' : 'update',
    summary: current === undefined ? `create AGENTS.md from ${source}` : `append ${source} to the existing AGENTS.md`,
    diff: lineDiff(current ?? '', next),
    apply: () => writeFile(target, next),
  }
}

// ---------------------------------------------------------------- config merges

/** Adds `additions` under `key` of a JSON config file, never overwriting a name that exists. */
function mergeConfigItem(kind: ImportKind, target: string, key: 'mcpServers' | 'hooks', additions: Record<string, unknown>, summary: (names: string[]) => string): ImportItem | undefined {
  const names = Object.keys(additions)
  if (names.length === 0) return undefined
  const current = readJson(target) ?? {}
  const existing = (current[key] as Record<string, unknown> | undefined) ?? {}
  let merged: Record<string, unknown>
  let added: string[]
  if (key === 'hooks') {
    // Hooks append per event, skipping a command that is already there.
    merged = { ...existing }
    added = []
    for (const [event, specs] of Object.entries(additions) as Array<[string, HookSpec[]]>) {
      const have = (merged[event] as HookSpec[] | undefined) ?? []
      const fresh = specs.filter((spec) => !have.some((h) => JSON.stringify(h.command) === JSON.stringify(spec.command)))
      if (fresh.length) {
        merged[event] = [...have, ...fresh]
        added.push(...fresh.map(() => event))
      }
    }
  } else {
    added = names.filter((n) => !(n in existing))
    merged = { ...existing, ...Object.fromEntries(added.map((n) => [n, additions[n]])) }
  }
  if (added.length === 0) return { kind, target, action: 'skip', summary: `${key} already contains ${names.join(', ')}`, diff: '' }
  const next = { ...current, [key]: merged }
  const before = fs.existsSync(target) ? pretty(current) : ''
  return {
    kind,
    target,
    action: fs.existsSync(target) ? 'update' : 'create',
    summary: summary([...new Set(added)]),
    diff: lineDiff(before, pretty(next)),
    apply: () => writeFile(target, pretty(next)),
  }
}

/** Claude's MCP server entry → HY's (`command`/`args`/`env`, or `url`). */
export function convertMcpServer(entry: unknown): Record<string, unknown> | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const e = entry as Record<string, unknown>
  if (typeof e.url === 'string') return { url: e.url, ...(e.headers && typeof e.headers === 'object' ? { headers: e.headers } : {}) }
  if (typeof e.command !== 'string') return undefined
  return {
    command: e.command,
    ...(Array.isArray(e.args) ? { args: e.args.map(String) } : {}),
    ...(e.env && typeof e.env === 'object' ? { env: e.env } : {}),
  }
}

const CLAUDE_EVENTS: Record<string, keyof HooksConfig> = {
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  UserPromptSubmit: 'userPromptSubmit',
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  Stop: 'stop',
  SubagentStop: 'subagentStop',
  PreCompact: 'preCompact',
}

const CLAUDE_TOOLS: Record<string, string[]> = {
  Bash: ['shell'],
  Edit: ['apply_patch'],
  MultiEdit: ['apply_patch'],
  Write: ['apply_patch'],
  NotebookEdit: ['apply_patch'],
  Read: ['read_file'],
  Grep: ['search_grep'],
  Glob: ['search_glob'],
  WebFetch: ['web_fetch'],
  WebSearch: ['web_search'],
  Task: ['delegate', 'spawn_agent'],
}

/** A shell command line as argv for HY's hook runner. */
export function shellArgv(command: string, platform = process.platform): string[] {
  return platform === 'win32' ? ['cmd', '/d', '/s', '/c', command] : ['sh', '-c', command]
}

/**
 * Claude Code hooks (`{ PreToolUse: [{ matcher: "Bash|Edit", hooks: [{ type:
 * "command", command, timeout }] }] }`) → HY hooks. Unknown events (e.g.
 * Notification) and matchers naming no HY tool are reported, not guessed.
 */
export function convertClaudeHooks(hooks: unknown, platform = process.platform): { hooks: Record<string, HookSpec[]>; skipped: string[] } {
  const out: Record<string, HookSpec[]> = {}
  const skipped: string[] = []
  if (!hooks || typeof hooks !== 'object') return { hooks: out, skipped }
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    const target = CLAUDE_EVENTS[event]
    if (!target) {
      skipped.push(`${event} (no HY event)`)
      continue
    }
    for (const group of Array.isArray(groups) ? groups : []) {
      const g = group as { matcher?: unknown; hooks?: unknown }
      const matcher = typeof g.matcher === 'string' ? g.matcher.trim() : ''
      let tools: string[] | undefined
      if (matcher && matcher !== '*') {
        const mapped = [...new Set(matcher.split('|').flatMap((name) => CLAUDE_TOOLS[name.trim()] ?? []))]
        if (mapped.length === 0) {
          skipped.push(`${event} matcher "${matcher}" (no HY tool)`)
          continue
        }
        tools = mapped
      }
      for (const hook of Array.isArray(g.hooks) ? g.hooks : []) {
        const h = hook as { type?: unknown; command?: unknown; timeout?: unknown }
        if (h.type !== 'command' || typeof h.command !== 'string' || !h.command.trim()) continue
        const spec: HookSpec = {
          command: shellArgv(h.command, platform),
          ...(tools && (target === 'preToolUse' || target === 'postToolUse') ? { tools } : {}),
          ...(typeof h.timeout === 'number' ? { timeoutMs: Math.round(h.timeout * 1000) } : {}),
        }
        ;(out[target] ??= []).push(spec)
      }
    }
  }
  return { hooks: out, skipped }
}

// ---------------------------------------------------------------- files

function copyTreeItem(kind: ImportKind, source: string, target: string, label: string): ImportItem {
  if (fs.existsSync(target)) return { kind, target, action: 'skip', summary: `${label} already exists`, diff: '' }
  const files: string[] = []
  const walk = (dir: string, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), path.join(rel, e.name))
      else if (e.isFile()) files.push(path.join(rel, e.name))
    }
  }
  if (fs.statSync(source).isDirectory()) walk(source)
  else files.push('')
  return {
    kind,
    target,
    action: 'create',
    summary: `copy ${label}`,
    diff: files.map((f) => `+ ${path.join(target, f)}`).join('\n'),
    apply: () => {
      fs.cpSync(source, target, { recursive: true, errorOnExist: false, force: false })
      return target
    },
  }
}

/** ~/.claude/projects/<key> uses the path with every non-alphanumeric character as '-'. */
export function claudeProjectKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).replace(/[^A-Za-z0-9]/g, '-')
}

const MEMORY_KEY = /[^A-Za-z0-9._-]/g

function memoryItems(ctx: ImportContext, home: string): ImportItem[] {
  const dir = path.join(home, '.claude', 'projects', claudeProjectKey(ctx.workspaceRoot), 'memory')
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n.toUpperCase() !== 'MEMORY.MD')
  } catch {
    return []
  }
  const store = MemoryStore.forStateDir(ctx.stateDir)
  const target = path.join(ctx.stateDir, 'memory.json')
  return names.map((name) => {
    const key = `claude.${name.replace(/\.md$/i, '')}`.replace(MEMORY_KEY, '-').slice(0, 60)
    // Front matter is metadata; the body is the memory.
    const body = (readText(path.join(dir, name)) ?? '').replace(/^---[\s\S]*?---\s*/, '').trim()
    const existing = store.list().find((e) => e.key === key)
    if (!body || existing?.text === body) return { kind: 'memory' as const, target, action: 'skip' as const, summary: `memory ${key} is up to date`, diff: '' }
    return {
      kind: 'memory' as const,
      target,
      action: existing ? ('update' as const) : ('create' as const),
      summary: `memory entry ${key} from ${name}`,
      diff: lineDiff(existing?.text ?? '', body),
      apply: () => {
        // A full memory is reported, not silently truncated.
        store.save(key, body)
        return `${target}#${key}`
      },
    }
  })
}

// ---------------------------------------------------------------- Claude Code

export function planClaudeImport(ctx: ImportContext): ImportItem[] {
  const home = ctx.home ?? (process.env.HY_IMPORT_HOME || os.homedir())
  const ws = ctx.workspaceRoot
  const items: Array<ImportItem | undefined> = []
  const projectConfig = path.join(ws, '.hy-harness', 'config.json')
  const userConfig = path.join(ctx.userConfigDir, 'config.json')

  // Instructions.
  items.push(agentsItem(path.join(ws, 'CLAUDE.md'), path.join(ws, 'AGENTS.md')))
  items.push(agentsItem(path.join(ws, '.claude', 'CLAUDE.md'), path.join(ws, 'AGENTS.md')))
  items.push(agentsItem(path.join(home, '.claude', 'CLAUDE.md'), path.join(ctx.userConfigDir, 'AGENTS.md')))

  // MCP servers: project (.mcp.json) and user (~/.claude.json, top level and this project).
  const servers = (raw: unknown) =>
    Object.fromEntries(
      Object.entries((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>).flatMap(([name, entry]) => {
        const converted = convertMcpServer(entry)
        return converted ? [[name, converted]] : []
      }),
    )
  const envNote = (names: string[], all: Record<string, unknown>) => (names.some((n) => (all[n] as { env?: unknown })?.env) ? ' (env values copied as they are)' : '')
  const projectMcp = servers(readJson(path.join(ws, '.mcp.json'))?.mcpServers)
  items.push(mergeConfigItem('mcp', projectConfig, 'mcpServers', projectMcp, (n) => `project MCP servers ${n.join(', ')}${envNote(n, projectMcp)}; they start only in a trusted project`))
  const claudeJson = readJson(path.join(home, '.claude.json'))
  const projects = (claudeJson?.projects ?? {}) as Record<string, { mcpServers?: unknown }>
  const thisProject = Object.entries(projects).find(([p]) => path.resolve(p).toLowerCase() === path.resolve(ws).toLowerCase())?.[1]
  const userMcp = { ...servers(claudeJson?.mcpServers), ...servers(thisProject?.mcpServers) }
  items.push(mergeConfigItem('mcp', userConfig, 'mcpServers', userMcp, (n) => `user MCP servers ${n.join(', ')}${envNote(n, userMcp)}`))

  // Hooks.
  const projectHooks = convertClaudeHooks({
    ...((readJson(path.join(ws, '.claude', 'settings.json'))?.hooks as object) ?? {}),
    ...((readJson(path.join(ws, '.claude', 'settings.local.json'))?.hooks as object) ?? {}),
  })
  items.push(mergeConfigItem('hooks', projectConfig, 'hooks', projectHooks.hooks, (events) => `project hooks for ${events.join(', ')}${projectHooks.skipped.length ? `; not mapped: ${projectHooks.skipped.join('; ')}` : ''}`))
  const userHooks = convertClaudeHooks(readJson(path.join(home, '.claude', 'settings.json'))?.hooks)
  items.push(mergeConfigItem('hooks', userConfig, 'hooks', userHooks.hooks, (events) => `user hooks for ${events.join(', ')}${userHooks.skipped.length ? `; not mapped: ${userHooks.skipped.join('; ')}` : ''}`))

  // Skills.
  for (const [from, to, scope] of [
    [path.join(ws, '.claude', 'skills'), path.join(ws, '.hy-harness', 'skills'), 'project'],
    [path.join(home, '.claude', 'skills'), path.join(ctx.userConfigDir, 'skills'), 'user'],
  ] as const) {
    let names: string[] = []
    try {
      names = fs.readdirSync(from, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(from, e.name, 'SKILL.md'))).map((e) => e.name)
    } catch {
      continue
    }
    for (const name of names) items.push(copyTreeItem('skills', path.join(from, name), path.join(to, name), `${scope} skill ${name}`))
  }

  // Slash commands → prompts (both use $ARGUMENTS).
  for (const [from, to] of [
    [path.join(ws, '.claude', 'commands'), path.join(ws, '.hy-harness', 'prompts')],
    [path.join(home, '.claude', 'commands'), path.join(ctx.userConfigDir, 'prompts')],
  ] as const) {
    let names: string[] = []
    try {
      names = fs.readdirSync(from).filter((n) => /^[a-z0-9][a-z0-9_-]*\.md$/i.test(n))
    } catch {
      continue
    }
    for (const name of names) items.push(copyTreeItem('prompts', path.join(from, name), path.join(to, name.toLowerCase()), `prompt /${name.replace(/\.md$/i, '')}`))
  }

  items.push(...memoryItems(ctx, home))
  return items.filter((i): i is ImportItem => i !== undefined)
}

// ---------------------------------------------------------------- DSH

/** Decodes a DSH v4 session file: concatenated zstd frames of JSON lines. */
export function readDshSession(file: string): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(file)
  const starts: number[] = []
  for (let i = 0; i + 3 < raw.length; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) starts.push(i)
  }
  starts.push(raw.length)
  const records: Array<Record<string, unknown>> = []
  const decode = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync
  if (!decode) throw new Error('this Node cannot read zstd (Node 23.8+ is needed for DSH sessions)')
  for (let k = 0; k + 1 < starts.length; k++) {
    let text: string
    try {
      text = decode(raw.subarray(starts[k], starts[k + 1])).toString('utf8')
    } catch {
      // A false magic inside compressed data: merge with the next frame.
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // skip a torn line
      }
    }
  }
  return records
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
        .join('')
    : typeof content === 'string'
      ? content
      : ''

/** DSH records → HY session events for one imported run. */
export function convertDshSession(records: ReadonlyArray<Record<string, unknown>>): Array<{ type: string; payload: unknown; ts: number }> {
  const out: Array<{ type: string; payload: unknown; ts: number }> = []
  let turn = 0
  let title = ''
  for (const r of records) {
    const data = (r.data ?? {}) as Record<string, unknown>
    const ts = typeof r.time === 'number' ? r.time : typeof r.createdAt === 'number' ? r.createdAt : Date.now()
    switch (r.type) {
      case 'turn/start':
        turn += 1
        out.push({ type: 'turn/start', payload: { turn }, ts })
        break
      case 'user/message': {
        const text = textOf(data.content).trim()
        const kind = ((data.source ?? {}) as { kind?: unknown }).kind
        if (text && (kind === undefined || kind === 'user')) out.push({ type: 'user/message', payload: { content: text }, ts })
        break
      }
      case 'assistant/message': {
        const text = textOf(((data.message ?? {}) as { content?: unknown }).content).trim()
        if (text) out.push({ type: 'assistant/message', payload: { content: JSON.stringify({ final: text }) }, ts })
        break
      }
      case 'tool/call': {
        let args: unknown = {}
        try {
          args = JSON.parse(String(data.arguments ?? '{}'))
        } catch {
          args = { raw: String(data.arguments ?? '') }
        }
        out.push({ type: 'assistant/message', payload: { content: JSON.stringify({ tool: String(data.name ?? 'tool'), args }) }, ts })
        break
      }
      case 'tool/result': {
        const message = (data.message ?? {}) as { content?: unknown; isError?: unknown; toolCallId?: unknown }
        out.push({ type: 'tool/result', payload: { callId: String(message.toolCallId ?? ''), name: 'dsh-tool', output: textOf(message.content).slice(0, 20_000), isError: message.isError === true }, ts })
        break
      }
      case 'session/title':
        title = String(data.title ?? '')
        break
      default:
        break
    }
  }
  if (title) out.push({ type: 'session/imported', payload: { from: 'dsh', title }, ts: out.at(-1)?.ts ?? Date.now() })
  return out
}

function dshItems(ctx: ImportContext, home: string): ImportItem[] {
  const root = path.join(home, '.dsh', 'sessions')
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return []
  }
  const logFile = sessionLogPath(ctx.stateDir)
  const imported = new Set(readEvents(logFile).map((e) => e.runId).filter(Boolean))
  const wsKey = path.resolve(ctx.workspaceRoot).toLowerCase()
  const items: ImportItem[] = []
  for (const dir of dirs) {
    const sessionsDir = path.join(root, dir)
    let ids: string[] = []
    try {
      ids = fs.readdirSync(sessionsDir)
    } catch {
      continue
    }
    for (const id of ids) {
      const file = path.join(sessionsDir, id, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      let records: Array<Record<string, unknown>>
      try {
        records = readDshSession(file)
      } catch {
        continue
      }
      const header = records.find((r) => r.type === 'session')
      // Only this workspace's sessions (the header names its cwd).
      if (typeof header?.cwd !== 'string' || path.resolve(header.cwd).toLowerCase() !== wsKey) continue
      const runId = `dsh-${String(header.id ?? id).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`
      const events = convertDshSession(records)
      const turns = events.filter((e) => e.type === 'turn/start').length
      const first = events.find((e) => e.type === 'user/message')?.payload as { content?: string } | undefined
      const label = `DSH session ${id.slice(0, 8)} (${turns} turn${turns === 1 ? '' : 's'})`
      if (imported.has(runId)) {
        items.push({ kind: 'sessions', target: logFile, action: 'skip', summary: `${label} is already imported as ${runId}`, diff: '' })
        continue
      }
      if (turns === 0) continue
      items.push({
        kind: 'sessions',
        target: logFile,
        action: 'create',
        summary: `${label} → thread ${runId}`,
        diff: `+ ${runId}: ${(first?.content ?? '').split('\n')[0]!.slice(0, 100)}`,
        apply: () => {
          const log = new SessionLog(logFile)
          log.setRun(runId)
          for (const e of events) log.appendAt(e.type, e.payload, e.ts)
          return `${logFile}#${runId}`
        },
      })
    }
  }
  return items
}

export function planDshImport(ctx: ImportContext): ImportItem[] {
  return dshItems(ctx, ctx.home ?? (process.env.HY_IMPORT_HOME || os.homedir()))
}

export function planImport(source: ImportSource, ctx: ImportContext): ImportItem[] {
  return source === 'claude' ? planClaudeImport(ctx) : planDshImport(ctx)
}

/** Writes the accepted changes; returns what was written and what failed. */
export function applyImport(items: readonly ImportItem[], kinds?: ReadonlySet<ImportKind>): { written: string[]; failed: string[] } {
  const written: string[] = []
  const failed: string[] = []
  for (const item of items) {
    if (item.action === 'skip' || !item.apply || (kinds && !kinds.has(item.kind))) continue
    try {
      written.push(item.apply())
    } catch (error) {
      failed.push(`${item.summary}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { written, failed }
}

/** The plan as text: one block per change, with its diff. */
export function renderImportPlan(items: readonly ImportItem[]): string {
  if (items.length === 0) return 'nothing to import'
  return items
    .map((i) => {
      const head = `[${i.action}] ${i.kind}: ${i.summary}\n    → ${i.target}`
      return i.diff ? `${head}\n${i.diff.split('\n').map((l) => `    ${l}`).join('\n')}` : head
    })
    .join('\n\n')
}

/** JSON-safe view (no functions) for the GUI and `--json`. */
export function importPlanView(items: readonly ImportItem[]) {
  return items.map(({ kind, target, action, summary, diff }) => ({ kind, target, action, summary, diff }))
}
