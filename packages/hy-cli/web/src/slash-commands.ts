/**
 * CP-32: the one list of GUI commands.
 *
 * The composer's `/command` parser, the `/help` modal and the Ctrl+K palette
 * all read this table, so a command added here is typed, listed and searchable
 * at once and the three can no longer drift apart (they did: `/feedback` and
 * `/clear` worked but were missing from `/help`, and the palette ran a second
 * switch with a duplicated case).
 *
 * Pure module: no DOM, so `web/test/slash-commands.test.mjs` runs it directly.
 */

export interface CommandSpec {
  /** Dispatcher id, also the palette row's `data-command`. */
  id: string
  /** Slash name without the leading `/`; absent for palette-only actions. */
  slash?: string
  /** Other slash names for the same command. */
  aliases?: readonly string[]
  /** Argument usage shown in `/help`, e.g. `<name>` or `[title]`. */
  args?: string
  /** One line for `/help` and the palette. */
  desc: string
  /** Palette label; absent when the command is slash-only. */
  label?: string
  /** Icon name (web/src/icons.ts). */
  icon: string
  /** Opens this section of the details panel (`data-section`). */
  section?: DetailsSection
}

export type DetailsSection = 'session' | 'stats' | 'notes' | 'skills' | 'mcp' | 'plugins' | 'memory'

export const COMMANDS: readonly CommandSpec[] = [
  { id: 'new', slash: 'new', aliases: ['clear'], desc: 'Start a fresh session', label: 'New chat', icon: 'plus' },
  { id: 'status', slash: 'status', desc: 'Show run, model, sandbox and token usage', label: 'Session status', icon: 'info', section: 'session' },
  { id: 'usage', slash: 'usage', desc: 'Show token usage and timing for this session', label: 'Token usage', icon: 'clock', section: 'stats' },
  { id: 'diff', slash: 'diff', desc: 'Show changes since the run started', label: 'Diff panel', icon: 'diff' },
  { id: 'undo', slash: 'undo', desc: 'Restore files to before the last turn', label: 'Undo last turn', icon: 'refresh' },
  { id: 'notes', slash: 'notes', desc: 'Show the rationale ledger notes', label: 'Rationale notes', icon: 'plan', section: 'notes' },
  { id: 'plan', slash: 'plan', desc: "Show the agent's current plan", label: 'Plan panel', icon: 'plan' },
  { id: 'plan-mode', slash: 'plan-mode', args: '[off]', desc: 'Toggle read-only planning mode', label: 'Toggle plan mode', icon: 'plan' },
  { id: 'interaction-mode', slash: 'interaction-mode', args: '[autonomous|collaborative]', desc: 'Choose how the agent involves you', icon: 'plan' },
  { id: 'work-mode', slash: 'work-mode', args: '[fast|thorough|reflective]', desc: 'Choose the work mode', icon: 'plan' },
  { id: 'goal', slash: 'goal', args: '[objective|edit|pause|resume|clear]', desc: 'Set or control the long-running goal', label: 'Set or edit goal', icon: 'target' },
  { id: 'compact', slash: 'compact', desc: 'Compact the conversation now', label: 'Compact conversation', icon: 'cpu' },
  { id: 'model', slash: 'model', args: '<name>', desc: 'Switch the worker model', icon: 'cpu' },
  { id: 'review', slash: 'review', desc: 'Run a read-only review of uncommitted changes', label: 'Review changes', icon: 'search' },
  { id: 'init', slash: 'init', desc: 'Draft an AGENTS.md for this repository', label: 'Draft AGENTS.md', icon: 'edit' },
  { id: 'skills', slash: 'skills', desc: 'List the skills offered to the agent', label: 'Skills', icon: 'book', section: 'skills' },
  { id: 'mcp', slash: 'mcp', desc: 'List the MCP tools of this session', label: 'MCP tools', icon: 'cpu', section: 'mcp' },
  { id: 'plugins', slash: 'plugins', desc: 'List the plugin tools of this session', label: 'Plugin tools', icon: 'cpu', section: 'plugins' },
  { id: 'memories', slash: 'memories', aliases: ['memory'], desc: 'Show the workspace memory', label: 'Workspace memory', icon: 'read', section: 'memory' },
  { id: 'hooks', slash: 'hooks', desc: 'List the configured hooks', label: 'Hooks', icon: 'bolt' },
  { id: 'doctor', slash: 'doctor', desc: 'Check the installation, sandbox and configuration', label: 'Doctor', icon: 'shield' },
  { id: 'rename', slash: 'rename', args: '[title]', desc: 'Rename this chat (no title: open the dialog)', label: 'Rename chat', icon: 'edit' },
  { id: 'fork', slash: 'fork', desc: 'Copy this chat into a new one', label: 'Fork chat', icon: 'git' },
  { id: 'archive', slash: 'archive', desc: 'Archive this chat, or unarchive it', label: 'Archive chat', icon: 'archive' },
  { id: 'resume', slash: 'resume', args: '[search]', desc: 'Find an earlier chat and open it', label: 'Resume a chat', icon: 'clock' },
  { id: 'find', slash: 'find', args: '[text]', desc: 'Search this transcript (F3 / Ctrl+F)', label: 'Find in transcript', icon: 'search' },
  { id: 'raw', slash: 'raw', desc: 'Switch between rendered Markdown and the raw text', label: 'Toggle raw transcript', icon: 'read' },
  { id: 'rewind', slash: 'rewind', args: '[turn]', desc: 'Rewind files and chat to before a turn (Esc Esc)', label: 'Rewind to a turn', icon: 'refresh' },
  { id: 'worktree', slash: 'worktree', args: '[name]', desc: 'Work in an isolated git worktree; apply or remove it later', label: 'Worktrees', icon: 'git' },
  { id: 'import', slash: 'import', args: '[claude|dsh]', desc: 'Bring AGENTS.md, MCP, hooks, skills, prompts, memory or sessions over from Claude Code or DSH', label: 'Import from Claude Code / DSH', icon: 'external' },
  { id: 'export', slash: 'export', desc: 'Export this session as Markdown', label: 'Export as Markdown', icon: 'external' },
  { id: 'feedback', slash: 'feedback', args: '[text]', desc: 'Rate the last answer', label: 'Rate last answer', icon: 'alert' },
  { id: 'settings', slash: 'settings', aliases: ['config'], desc: 'Open model and sandbox settings', label: 'Settings', icon: 'settings' },
  { id: 'help', slash: 'help', desc: 'Show this help', label: 'Help / commands', icon: 'question' },
  // Palette-only actions.
  { id: 'ralph', desc: 'Start a verifier loop', label: 'Verifier loop', icon: 'plan' },
  { id: 'files', desc: 'Show the files panel', label: 'Files panel', icon: 'folder' },
  { id: 'trace', desc: 'Show the trace panel', label: 'Trace panel', icon: 'clock' },
  { id: 'browser', desc: 'Show the browser panel', label: 'Browser panel', icon: 'globe' },
  { id: 'terminal', desc: 'Show the terminal panel', label: 'Terminal panel', icon: 'terminal' },
  { id: 'generate-title', desc: 'Generate a title for this chat', label: 'Generate title', icon: 'bolt' },
  { id: 'outline', desc: 'Jump to a turn', label: 'Turn outline', icon: 'plan' },
  { id: 'shortcuts', desc: 'Edit keyboard shortcuts', label: 'Keyboard shortcuts', icon: 'bolt' },
  { id: 'theme', desc: 'Switch between light and dark', label: 'Toggle theme', icon: 'sun' },
]

const BY_SLASH = new Map<string, CommandSpec>()
for (const command of COMMANDS) {
  for (const name of [command.slash, ...(command.aliases ?? [])]) {
    if (name) BY_SLASH.set(name, command)
  }
}

export interface ParsedSlash {
  /** The typed name, lowercased, without `/`. */
  name: string
  args: string
  /** Undefined when no command has that name. */
  command?: CommandSpec
}

/** Parses `/name args…`; undefined when the text is not a command. */
export function parseSlash(text: string): ParsedSlash | undefined {
  const match = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return undefined
  const name = match[1]!.toLowerCase()
  const command = BY_SLASH.get(name)
  return { name, args: (match[2] ?? '').trim(), ...(command ? { command } : {}) }
}

/** `/help` rows: usage and description, in table order. */
export function helpRows(): Array<{ usage: string; desc: string }> {
  return COMMANDS.filter((c) => c.slash).map((c) => {
    const names = [c.slash, ...(c.aliases ?? [])].map((n) => `/${n}`).join(', ')
    return { usage: c.args ? `${names} ${c.args}` : names, desc: c.desc }
  })
}

/**
 * Palette rows for a query: label, slash names and description all match, so
 * "/ren", "rename" and "title" find the same row. Label hits come first.
 */
export function filterCommands(query: string): CommandSpec[] {
  const q = query.trim().toLowerCase().replace(/^\//, '')
  const rows = COMMANDS.filter((c) => c.label)
  if (!q) return rows
  const scored = rows
    .map((c) => {
      const label = c.label!.toLowerCase()
      const names = [c.slash, ...(c.aliases ?? [])].filter(Boolean) as string[]
      const score = label.startsWith(q)
        ? 4
        : names.some((n) => n.startsWith(q))
          ? 3
          : label.includes(q)
            ? 2
            : c.desc.toLowerCase().includes(q)
              ? 1
              : 0
      return { c, score }
    })
    .filter((r) => r.score > 0)
  return scored.sort((a, b) => b.score - a.score).map((r) => r.c)
}

/** Composer completion: commands whose slash name starts with what was typed. */
export function slashCompletions(typed: string): CommandSpec[] {
  const match = /^\/([\w-]*)$/.exec(typed)
  if (!match) return []
  const prefix = match[1]!.toLowerCase()
  return COMMANDS.filter((c) => c.slash && [c.slash, ...(c.aliases ?? [])].some((n) => n.startsWith(prefix)))
}
