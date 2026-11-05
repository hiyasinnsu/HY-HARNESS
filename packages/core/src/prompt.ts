import { TOOL_SPECS, deferredTools, jsonSchemaToTs, nativeParameters, offeredTools, renderSdk, renderToolPrompt, type Schema, type ToolSpec } from './tool-registry.js'
import type { NativeToolDef } from './llm.js'
import { renderSkillCatalog, type SkillInfo } from './skills.js'

export interface PromptExtras {
  skills?: readonly SkillInfo[]
  /** `McpManager.renderCatalog()`; empty when no MCP tools. */
  mcpCatalog?: string
  /** Offer `delegate` (top-level sessions only: subagents cannot delegate). */
  delegate?: boolean
  /** Only these tools are offered (read-only subagents, `hy review`). */
  allowTools?: ReadonlySet<string>
  /** Offer `web_fetch`. */
  web?: boolean
  /** Offer `web_search` (a search endpoint is configured). */
  search?: boolean
  /** Offer `lsp` (a language server is configured). */
  lsp?: boolean
  /** Offer `memory` (workspace memory is on). */
  memory?: boolean
  /** The final answer must be JSON matching this schema. */
  finalSchema?: Schema
  /** Offer `ask_user` (interactive sessions). */
  ask?: boolean
  /** Current long-running goal (DSH-style). The objective is stable across the request series. */
  goal?: { objective: string; phase: string; blockerReason?: string }
  /** Today's date (YYYY-MM-DD), stated in the prompt. */
  date?: string
  /**
   * Native function calling: the tools travel as function definitions
   * (`nativeToolDefs`), not as text, and the final answer is plain text.
   */
  native?: boolean
  /** Plugin tools, offered beside the built-ins. */
  extraTools?: readonly ToolSpec[]
  /** Role-specific text placed after the workspace header (orchestrator / worker). */
  roleInstruction?: string
  /** CP-10: deferred tools the model has already loaded with `tool_search`. */
  activeTools?: ReadonlySet<string>
}

function allSpecs(extras: PromptExtras): readonly ToolSpec[] {
  return extras.extraTools?.length ? [...TOOL_SPECS, ...extras.extraTools] : TOOL_SPECS
}

/** The optional tool families a session has. */
export function promptFeatures(extras: PromptExtras): Set<string> {
  const features = new Set<string>()
  if ((extras.skills ?? []).length > 0) features.add('skills')
  if (extras.mcpCatalog) features.add('mcp')
  if (extras.delegate) features.add('delegate')
  if (extras.web) features.add('web')
  if (extras.search) features.add('search')
  if (extras.lsp) features.add('lsp')
  if (extras.memory) features.add('memory')
  if (extras.ask) features.add('ask')
  // CP-10: advertise `tool_search` only when there is something to load.
  if (deferredTools(features, allSpecs(extras), extras.allowTools).length > 0) features.add('deferred')
  return features
}

/** The wire tools as native function definitions. */
export function nativeToolDefs(ptc: boolean, objective: boolean, extras: PromptExtras): NativeToolDef[] {
  return offeredTools(ptc, allSpecs(extras), objective, promptFeatures(extras), extras.allowTools, extras.activeTools).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: nativeParameters(t),
  }))
}

/**
 * The static part of the system prompt. Project constraints and agent notes
 * are appended per request by the agent from the Ledger (design §8). Tools
 * that need a feature (skills, MCP) appear only when the session has it.
 */
export function buildSystemPrompt(workspaceRoot: string, ptc = false, objective = false, extras: PromptExtras = {}): string {
  const features = promptFeatures(extras)
  const catalog = [renderSkillCatalog(extras.skills ?? []), extras.mcpCatalog ?? ''].filter(Boolean).join('\n\n')
  const header = `You are HY-HARNESS, a careful autonomous coding agent working in:
${workspaceRoot}${extras.date ? `\nToday is ${extras.date}.` : ''}
${extras.roleInstruction ? `\n${extras.roleInstruction.trim()}\n` : ''}
${extras.goal ? `\nLong-running goal (current objective):\n${extras.goal.objective}\nGoal policy:\n- Work autonomously toward the objective. Do not ask for confirmation or approval of a plan, and do not end a turn with a plan, promise, or "I will proceed" message.\n- If work remains, call a tool. Use get_goal before update_goal and pass the exact id and revision.\n- Mark complete only when the objective is achieved. The host's Grader verifies the claim; if it rejects the claim, continue with the unmet criteria.\n- Mark blocked only when the same condition persists for at least three consecutive goal rounds, and report it in blocked_reason. Difficulty or remaining work is not blocked.\n- Use ask_user only for an ambiguous instruction, a prerequisite change that needs approval, or an impossible goal. For a destructive or irreversible action, ask before doing it.\n- If plan mode is active, plan and wait for the user instead of changing files.\n` : ''}
Private reasoning style: write your thinking in Japanese. Use a blunt, concise tone such as 「〜だ。〜する。〜が分かった。」. No polite forms, filler, or restating the request. Start with one sentence saying what you will do next.
${
  process.platform === 'win32'
    ? 'Shell environment: Windows PowerShell. Use PowerShell syntax (Get-ChildItem, Select-String, Get-Content, Get-ChildItem -Recurse). Do not use Unix grep/head/find. The shell cwd is the workspace root; use a relative cwd or an absolute path inside the workspace, and quote paths with spaces.'
    : 'Shell environment: POSIX shell. Use relative paths or absolute paths inside the workspace; quote paths with spaces.'
}`

  const common = `Read a file before editing it. apply_patch rejects stale or unread files.
Prefer small, verifiable steps. Inspect shell output before continuing.
Never claim success without checking the result.
Do not try to read or write outside the workspace.
If a path is missing, locate it with tools.search.glob / tools.search.grep inside run_code instead of guessing similar paths.
For a large edit, split it into several apply_patch calls; do not emit an entire large file in one response.
To create or replace a whole file, give apply_patch file + content; to edit part of a file, a unified diff in patch.`
  if (extras.native) {
    const sdk = ptc
      ? `\nInside run_code, use only this SDK (no require, import, fs, process or network):\n${renderSdk(allSpecs(extras), objective, features, extras.allowTools)}\n`
      : ''
    const finish = objective
      ? 'Finish only by calling claim_complete with what changed and how you verified it; a reply without a tool call does not finish this run.'
      : extras.finalSchema
        ? `When the work is done, reply without a tool call, with only JSON of type ${jsonSchemaToTs(extras.finalSchema)}.`
        : 'When the work is done, reply without a tool call: a short summary of what changed and what you verified.'
    return `${header}${sdk}${catalog ? `\n${catalog}\n` : ''}
Rules:
Use the provided tools through function calls; call several at once when they are independent.
Call tools only through function calls; never write JSON such as {"tool":...} or {"calls":[...]} in the body. Write plain prose in the body, and only for the final answer.
Such JSON, especially a truncated fragment, is never a final answer: emit a real function call, or plain prose only when the work is done.
If work remains, your reply must contain a tool call. Do not end with a plan, a promise, or a confirmation request; prose without a tool call is treated as the final answer.
${finish}
${common}
`
  }
  return `${header}
${renderToolPrompt(ptc, allSpecs(extras), objective, features, extras.allowTools, extras.activeTools)}
${catalog ? `\n${catalog}\n` : ''}
Rules:
1. Reply with exactly one JSON object and no markdown fences, prose, or comments.
2. To call a tool: {"tool":"<name>","args":{...}}; several independent calls: {"calls":[{"tool":"<name>","args":{...}},...]}
3. To finish: ${
    objective
      ? '{"tool":"claim_complete","args":{"summary":"<what changed and how you verified it>"}}. Replies without a tool call do not finish this run'
      : extras.finalSchema
        ? `{"final": <JSON value of type ${jsonSchemaToTs(extras.finalSchema)}>}`
        : '{"final":"<short summary of what changed and what you verified>"}'
  }
4. Read a file before editing it. apply_patch rejects stale or unread files.
5. Prefer small, verifiable steps. Inspect shell output before continuing.
6. Never claim success without checking the result.
7. Do not try to read or write outside the workspace.
8. To create or replace a whole file, prefer:
   {"tool":"apply_patch","args":{"file":"NOTES.md","content":"line 1\\nline 2\\n"}}
   To edit part of a file, use a unified diff in "patch".
9. If a path is missing, use tools.search.glob / tools.search.grep inside run_code; do not guess similar paths.
10. For a large edit, split it into several apply_patch calls; do not emit a whole large file in one response.
`
}
