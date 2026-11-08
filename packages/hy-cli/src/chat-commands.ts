/**
 * CP-32: the `hy chat` REPL's built-in commands and their text output.
 *
 * The GUI keeps its own table in web/src/slash-commands.ts (the web bundle has
 * its own rootDir); chat-commands.test.ts checks that every command here has a
 * GUI twin, so `/help` lists the same commands in both.
 */
import type { HookListing } from '../../core/dist/index.js'

export interface ChatCommand {
  name: string
  args?: string
  desc: string
}

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  { name: 'status', desc: 'run, model, sandbox, turns and tokens' },
  { name: 'usage', desc: 'token usage of this process (total and last step)' },
  { name: 'diff', desc: 'changes since the session started' },
  { name: 'undo', desc: 'restore the files to before the last turn and drop the turn' },
  { name: 'notes', desc: "the run's rationale notes" },
  { name: 'plan', desc: "the agent's current plan (update_plan)" },
  { name: 'skills', desc: 'the skills offered to the agent' },
  { name: 'mcp', desc: 'the MCP tools of this session' },
  { name: 'plugins', desc: 'the plugin tools of this session' },
  { name: 'memories', desc: 'the workspace memory' },
  { name: 'hooks', desc: 'the configured hooks' },
  { name: 'doctor', desc: 'check the installation, sandbox and configuration' },
  { name: 'config', desc: 'where the configuration and state live' },
  { name: 'review', args: '[base]', desc: 'a read-only review of uncommitted changes (or base...HEAD)' },
  { name: 'init', desc: 'draft an AGENTS.md for this repository' },
  { name: 'compact', desc: 'compact the conversation now' },
  { name: 'plan-mode', args: '[off]', desc: 'read-only planning until turned off' },
  { name: 'work-mode', args: '[fast|thorough]', desc: 'choose fast delivery or thorough verification' },
  { name: 'model', args: '<name>', desc: 'switch the worker model' },
  { name: 'new', desc: 'start a new run (fresh conversation)' },
  { name: 'help', desc: 'this list' },
  { name: 'exit', desc: 'leave (the run can be continued with hy resume <run-id>)' },
]

/** CLI-only commands: the GUI has no REPL to leave. */
export const CLI_ONLY = new Set(['exit', 'quit'])

/** Built-in commands; a custom prompt with the same name does not shadow them. */
export const BUILTIN_COMMANDS: ReadonlySet<string> = new Set([...CHAT_COMMANDS.map((c) => `/${c.name}`), '/quit'])

export function chatHelp(): string {
  const usage = (c: ChatCommand) => `/${c.name}${c.args ? ` ${c.args}` : ''}`
  const width = Math.max(...CHAT_COMMANDS.map((c) => usage(c).length), '/<prompt> [args]'.length) + 2
  const rows = CHAT_COMMANDS.map((c) => `  ${usage(c).padEnd(width)}${c.desc}`)
  // Custom prompts sit before /new, /help and /exit, as they always did.
  rows.splice(rows.length - 3, 0, `  ${'/<prompt> [args]'.padEnd(width)}run prompts/<prompt>.md ($ARGUMENTS, $1..$9)`)
  return ['Commands:', ...rows].join('\n')
}

export function formatUsage(u: {
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  lastInputTokens: number
  lastOutputTokens: number
}): string {
  const lines = [
    `tokens this process: in ${u.inputTokens}, out ${u.outputTokens}`,
    `last step: in ${u.lastInputTokens}, out ${u.lastOutputTokens}`,
  ]
  const cached = u.cacheHitTokens + u.cacheMissTokens
  if (cached > 0) lines.push(`prompt cache: ${u.cacheHitTokens} hit / ${u.cacheMissTokens} miss (${Math.round((100 * u.cacheHitTokens) / cached)}%)`)
  return lines.join('\n')
}

export function formatHooks(hooks: readonly HookListing[]): string {
  if (hooks.length === 0) return 'no hooks configured'
  return hooks
    .map((h) => `${h.event}: ${h.command.join(' ')}${h.tools?.length ? ` [${h.tools.join(', ')}]` : ''}${h.timeoutMs ? ` (${h.timeoutMs} ms)` : ''}`)
    .join('\n')
}

export function formatDoctor(report: { version: string; checks: ReadonlyArray<{ name: string; status: string; detail: string }> }): string {
  return [
    `HY-HARNESS ${report.version}`,
    ...report.checks.map((c) => `${c.status === 'ok' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'FAIL'} ${c.name}: ${c.detail}`),
  ].join('\n')
}
