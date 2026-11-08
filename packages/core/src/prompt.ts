import { TOOL_SPECS, deferredTools, jsonSchemaToTs, nativeParameters, offeredTools, renderSdk, renderToolPrompt, type Schema, type ToolSpec } from './tool-registry.js'
import type { NativeToolDef } from './llm.js'
import { renderSkillCatalog, type SkillInfo } from './skills.js'
import { RICH_TOOL_DOCS, withParamDocs } from './tool-docs.js'

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
  /** Opening of the system prompt: `lean` (default) or `legacy`. */
  promptVariant?: PromptVariant
}

/** System-prompt variants compared in the harness benchmark. */
export type PromptVariant = 'lean' | 'legacy' | 'lean2' | 'lean3' | 'lean4'

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
  // With tool search off every deferred tool is active from the start, so
  // there is nothing left to load and `tool_search` is not offered.
  if (deferredTools(features, allSpecs(extras), extras.allowTools).some((t) => !extras.activeTools?.has(t.name))) features.add('deferred')
  return features
}

/** The wire tools as native function definitions. */
export function nativeToolDefs(ptc: boolean, objective: boolean, extras: PromptExtras): NativeToolDef[] {
  // lean4: the detailed descriptions (tool-docs.ts), with a description for every parameter.
  const rich = extras.promptVariant === 'lean4'
  return offeredTools(ptc, allSpecs(extras), objective, promptFeatures(extras), extras.allowTools, extras.activeTools).map((t) => {
    const doc = rich ? RICH_TOOL_DOCS[t.name] : undefined
    const sdk = t.name === 'run_code' && ptc
      ? `\nInside run_code, use only this SDK (no require, import, fs, process or network):\n${renderSdk(allSpecs(extras), objective, promptFeatures(extras), extras.allowTools, extras.activeTools)}`
      : ''
    const params = doc ? withParamDocs(nativeParameters(t), doc.params) : nativeParameters(t)
    const code = params.properties?.code
    return {
      name: t.name,
      description: doc?.description ?? t.description,
      parameters: sdk && code ? { ...params, properties: { ...params.properties, code: { ...code, description: `${code.description ?? ''}${sdk}` } } } : params,
    }
  })
}

/** The long-running goal and its policy (the agent sends it in the session context). */
export function goalPrompt(goal: { objective: string }): string {
  return `Long-running goal (current objective):\n${goal.objective}\nGoal policy:\n- Work autonomously toward the objective. Do not ask for confirmation or approval of a plan, and do not end a turn with a plan, promise, or "I will proceed" message.\n- If work remains, call a tool. Use get_goal before update_goal and pass the exact id and revision.\n- Mark complete only when the objective is achieved. The host's Grader verifies the claim; if it rejects the claim, continue with the unmet criteria.\n- Mark blocked only when the same condition persists for at least three consecutive goal rounds, and report it in blocked_reason. Difficulty or remaining work is not blocked.\n- Use ask_user only for an ambiguous instruction, a prerequisite change that needs approval, or an impossible goal. For a destructive or irreversible action, ask before doing it.\n- If plan mode is active, plan and wait for the user instead of changing files.`
}

/** Opens / closes the session-context block the agent appends to the conversation. */
export const SESSION_CONTEXT_OPEN = '<hy_session_context>'
export const SESSION_CONTEXT_CLOSE = '</hy_session_context>'

/**
 * The parts of the old system prompt that change during a session (date, goal,
 * project constraints, agent notes, memory), as one block. The agent appends it
 * to the conversation when it differs from the last one sent, instead of
 * rewriting the system prompt: the request prefix stays byte-identical, so the
 * provider's prefix cache keeps the whole history (DSH "in-history" updates).
 */
/** The work modes, in the order the GUI and the CLI list them; `fast` is the default. */
export const WORK_MODES = ['fast', 'thorough', 'reflective'] as const
export type WorkMode = (typeof WORK_MODES)[number]

export function isWorkMode(value: unknown): value is WorkMode {
  return typeof value === 'string' && (WORK_MODES as readonly string[]).includes(value)
}

/** What each mode tells the model; sent in the session context, never in the system prompt. */
const WORK_MODE_TEXT: Record<WorkMode, string> = {
  fast: 'Work mode: Fast. Keep the whole objective in view and make the smallest complete change. Check the essential requirements and their relevant failure paths in proportion to the risks, then deliver promptly. Never skip checks needed for safety or correctness, or claim more than was verified.',
  thorough:
    'Work mode: Thorough. Work carefully through the whole objective and its details. Inspect connected behavior and edge cases, verify changes and relevant failure paths, and resolve defects before delivering. Prioritize checks that reveal distinct risks; repeat equivalent checks when variability or new evidence warrants it. Keep investigation proportional to the requirements and risks; deliver once the necessary checks are complete. Be honest about what was not verified; perfection cannot be guaranteed.',
  // 2026-11-09, the user's wording (思索).
  reflective:
    "Work mode: Reflective. Keep the larger purpose firmly in view, and keep checking that the overall direction of the project is right. When the purpose is unclear, ask the user and align your understanding before going further (use ask_user when available). Always weigh priorities by what achieving the purpose needs: settle the requirements that bear on the purpose thoroughly, and do not get caught up in requirements that do not matter. In the final report, list everything you judged low priority as well, and be honest about what was not verified.",
}

/**
 * How the agent involves the user, combined with any work mode (2026-11-09,
 * the user's wording: 自律 / 共創). `autonomous` is the default: it matches
 * how the agent behaved before the setting existed.
 */
export const INTERACTION_MODES = ['autonomous', 'collaborative'] as const
export type InteractionMode = (typeof INTERACTION_MODES)[number]

export function isInteractionMode(value: unknown): value is InteractionMode {
  return typeof value === 'string' && (INTERACTION_MODES as readonly string[]).includes(value)
}

const INTERACTION_MODE_TEXT: Record<InteractionMode, string> = {
  autonomous:
    "Interaction: Autonomous. Judge for yourself and proceed without waiting for the user's instructions. When a choice is needed, decide it yourself in line with the overall direction of the project. If the direction is unclear, do not ask about it piecemeal while working: ask as early as possible, at the point where the user is setting the direction, so the direction is settled first. Ask the user only about choices that cost significant time or money; even for those, if the user has given a general guideline for such choices, follow it and decide yourself.",
  collaborative:
    'Interaction: Collaborative. Keep aligning your views with the user as you go. Do not decide on your own anything that sets the direction of the project: present the options and ask the user (use ask_user when available). Where the user has given a general guideline for a kind of choice, decide yourself only within what that guideline covers.',
}

export function sessionContextBlock(parts: { date?: string; goal?: { objective: string }; workMode?: WorkMode; interactionMode?: InteractionMode; sections?: readonly string[] }): string {
  const body = [
    'Current session context (it replaces any earlier hy_session_context block):',
    ...(parts.date ? [`Today is ${parts.date}.`] : []),
    ...(parts.workMode ? [WORK_MODE_TEXT[parts.workMode]] : []),
    ...(parts.interactionMode ? [INTERACTION_MODE_TEXT[parts.interactionMode]] : []),
    ...(parts.goal ? [goalPrompt(parts.goal)] : []),
    ...(parts.sections ?? []).filter(Boolean),
  ]
  return `${SESSION_CONTEXT_OPEN}\n${body.join('\n\n')}\n${SESSION_CONTEXT_CLOSE}`
}

/** The last session-context block in the conversation (it always ends a user message). */
export function lastSessionContext(messages: readonly { role: string; content: string }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    const text = message.content.trimEnd()
    if (!text.endsWith(SESSION_CONTEXT_CLOSE)) continue
    const start = text.lastIndexOf(SESSION_CONTEXT_OPEN)
    if (start >= 0) return text.slice(start)
  }
  return undefined
}

/**
 * The static part of the system prompt. It must not change during a session:
 * the date, goal, project constraints, agent notes and memory travel in the
 * conversation as a session-context block (`sessionContextBlock`). Tools that
 * need a feature (skills, MCP) appear only when the session has it.
 */
export function buildSystemPrompt(workspaceRoot: string, ptc = false, objective = false, extras: PromptExtras = {}): string {
  const features = promptFeatures(extras)
  const catalog = [renderSkillCatalog(extras.skills ?? []), extras.mcpCatalog ?? ''].filter(Boolean).join('\n\n')
  // Cross-session prefix cache (DSH: "the system prompt is identical across
  // checkouts"): everything up to `sessionPart` is the same for every session
  // with the same tool set, whatever the workspace or role, so a new chat, a
  // worker or a subagent reuses the cached prefix another session wrote. What
  // differs per session comes last: workspace, skill / MCP catalog, role.
  const sessionPart = `
This session:
Workspace root: ${workspaceRoot}${extras.date ? `\nToday is ${extras.date}.` : ''}
${catalog ? `\n${catalog}\n` : ''}${extras.roleInstruction ? `\n${extras.roleInstruction.trim()}\n` : ''}${extras.goal ? `\n${goalPrompt(extras.goal)}\n` : ''}`
  // `lean` was the default from 2026-11-07 to 2026-11-09 (now `lean4`, set in
  // the config; this builder still falls back to `lean`). In the benchmark the longer
  // `legacy` opening (Japanese reasoning, style rules, a pointer to the
  // session part) made no measurable difference. The reasoning line keeps
  // only the tone so the rest of the prompt can be measured from here.
  // `lean2` (2026-11-07, user-drafted, under evaluation): drops the
  // body-JSON warnings (the agent already retries a broken call), "never
  // claim success" and "instead of guessing similar paths" (the not-found
  // error already says how to search); adds intent, no partial solutions, a
  // self-contained final answer, asking only for real decisions, and hedging
  // uncertain points in the concise reasoning.
  const lean2 = extras.promptVariant === 'lean2'
  const opening = lean2
    ? `You are HY-HARNESS, an autonomous coding agent.
Private reasoning style: use a concise tone. Do not state uncertain points as certain; present them as possibilities.`
    : extras.promptVariant !== 'legacy'
      ? `You are HY-HARNESS, a careful autonomous coding agent.
Private reasoning style: use a concise tone.`
      : `You are HY-HARNESS, a careful autonomous coding agent. The workspace and this session's role are given at the end of these instructions.
Private reasoning style: write your thinking in Japanese. Use a blunt, concise tone such as 「〜だ。〜する。〜が分かった。」. No polite forms, filler, or restating the request. Start with one sentence saying what you will do next.`
  const header = opening
  const common = `Prefer small, verifiable steps.
Never claim success without checking the result.
Do not try to read or write outside the workspace.`
  if (extras.native) {
    const finish = objective
      ? 'Finish only by calling claim_complete with what changed and how you verified it; a reply without a tool call does not finish this run.'
      : extras.finalSchema
        ? `When the work is done, reply without a tool call, with only JSON of type ${jsonSchemaToTs(extras.finalSchema)}.`
        : 'When the work is done, reply without a tool call: a short summary of what changed and what you verified.'
    if (extras.promptVariant === 'lean4') {
      // `lean4` (2026-11-07; the config default since 2026-11-09): lean3 with the detailed tool
      // descriptions (tool-docs.ts); the lines they now cover are dropped here:
      // the shell line, read-before-edit, where to search, how to patch.
      const ending = objective || extras.finalSchema ? `\n${finish}` : ''
      return `You are HY-HARNESS, an autonomous coding agent.
Private reasoning style: use a concise tone. Do not state uncertain points as certain; present them as possibilities.
Tool use:
Make independent calls together, at the same time.
Do not try to read or write outside the workspace.
Rules:
Read the user's intent and its background before acting.
Do not settle for a partial solution.
To continue working, your reply must contain a tool call. A reply without a tool call is your final answer: make it self-contained, and do not end it with a plan or an offer. Ask the user only when a decision is genuinely theirs; say what you need decided and why (use ask_user when available).
In the final answer, lead with the conclusion; if you did work, summarize clearly what changed and what you verified.
Do not implement a lot at once; proceed in small, verifiable steps.${ending}
${sessionPart}`
    }
    if (extras.promptVariant === 'lean3') {
      // `lean3` (2026-11-07, user-drafted, under evaluation): lean2 regrouped
      // into tool use and rules; the shell is the fallback when no tool fits,
      // and the shell / patch details the tool descriptions already carry
      // are dropped.
      const ending = objective || extras.finalSchema ? `\n${finish}` : ''
      return `You are HY-HARNESS, an autonomous coding agent.
Private reasoning style: use a concise tone. Do not state uncertain points as certain; present them as possibilities.
Tool use:
Make independent calls together, at the same time.
Do not try to read or write outside the workspace.
Rules:
Read the user's intent and its background before acting.
Do not settle for a partial solution.
To continue working, your reply must contain a tool call. A reply without a tool call is your final answer: make it self-contained, and do not end it with a plan or an offer. Ask the user only when a decision is genuinely theirs; say what you need decided and why (use ask_user when available).
In the final answer, lead with the conclusion; if you did work, summarize clearly what changed and what you verified.
Do not implement a lot at once; proceed in small, verifiable steps.${ending}
${sessionPart}`
    }
    if (lean2) {
      // Objective runs and structured output keep their own ending rule.
      const ending = objective || extras.finalSchema ? `\n${finish}` : ''
      return `${header}
Rules:
Use the provided tools through function calls; call several at once when they are independent.
Read the user's intent and its background before acting.
Do not settle for a partial solution.
To continue working, your reply must contain a tool call. A reply without a tool call is your final answer: make it self-contained, and do not end it with a plan or an offer. Ask the user only when a decision is genuinely theirs; say what you need decided and why (use ask_user when available).
In the final answer, lead with the conclusion; if you did work, summarize clearly what changed and what you verified.${ending}
Prefer small, verifiable steps.
Do not try to read or write outside the workspace.
${sessionPart}`
    }
    return `${header}
Rules:
Use the provided tools through function calls; call several at once when they are independent.
Call tools only through function calls; never write JSON such as {"tool":...} or {"calls":[...]} in the body. Write plain prose in the body, and only for the final answer.
Such JSON, especially a truncated fragment, is never a final answer: emit a real function call, or plain prose only when the work is done.
If work remains, your reply must contain a tool call. Do not end with a plan, a promise, or a confirmation request; prose without a tool call is treated as the final answer.
${finish}
${common}
${sessionPart}`
  }
  // Text-only providers have no separate tool-definition channel, so their
  // tool descriptions remain in the dedicated tool section of this prompt.
  return `${header}
${renderToolPrompt(ptc, allSpecs(extras), objective, features, extras.allowTools, extras.activeTools)}

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
4. ${common.replaceAll('\n', '\n   ')}
${sessionPart}`
}
