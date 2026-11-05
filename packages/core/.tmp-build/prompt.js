import { TOOL_SPECS, jsonSchemaToTs, nativeParameters, offeredTools, renderSdk, renderToolPrompt } from './tool-registry.js';
import { renderSkillCatalog } from './skills.js';
function allSpecs(extras) {
    return extras.extraTools?.length ? [...TOOL_SPECS, ...extras.extraTools] : TOOL_SPECS;
}
/** The optional tool families a session has. */
export function promptFeatures(extras) {
    const features = new Set();
    if ((extras.skills ?? []).length > 0)
        features.add('skills');
    if (extras.mcpCatalog)
        features.add('mcp');
    if (extras.delegate)
        features.add('delegate');
    if (extras.web)
        features.add('web');
    if (extras.search)
        features.add('search');
    if (extras.lsp)
        features.add('lsp');
    if (extras.memory)
        features.add('memory');
    if (extras.ask)
        features.add('ask');
    return features;
}
/** The wire tools as native function definitions. */
export function nativeToolDefs(ptc, objective, extras) {
    return offeredTools(ptc, allSpecs(extras), objective, promptFeatures(extras), extras.allowTools).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: nativeParameters(t),
    }));
}
/**
 * The static part of the system prompt. Project constraints and agent notes
 * are appended per request by the agent from the Ledger (design §8). Tools
 * that need a feature (skills, MCP) appear only when the session has it.
 */
export function buildSystemPrompt(workspaceRoot, ptc = false, objective = false, extras = {}) {
    const features = promptFeatures(extras);
    const catalog = [renderSkillCatalog(extras.skills ?? []), extras.mcpCatalog ?? ''].filter(Boolean).join('\n\n');
    const header = `You are HY-HARNESS, a careful autonomous coding agent working in:
${workspaceRoot}${extras.date ? `\nToday is ${extras.date}.` : ''}
${extras.roleInstruction ? `\n${extras.roleInstruction.trim()}\n` : ''}
Private reasoning style: write your thinking in Japanese. Use a blunt, concise tone such as 「〜だ。〜する。〜が分かった。」. No polite forms, filler, or restating the request. Start with one sentence saying what you will do next.
${process.platform === 'win32'
        ? 'Shell environment: Windows PowerShell. Use PowerShell syntax (Get-ChildItem, Select-String, Get-Content, Get-ChildItem -Recurse). Do not use Unix grep/head/find. The shell cwd is the workspace root; use a relative cwd or an absolute path inside the workspace, and quote paths with spaces.'
        : 'Shell environment: POSIX shell. Use relative paths or absolute paths inside the workspace; quote paths with spaces.'}`;
    const common = `Read a file before editing it. apply_patch rejects stale or unread files.
Prefer small, verifiable steps. Inspect shell output before continuing.
Never claim success without checking the result.
Do not try to read or write outside the workspace.
If a path is missing, locate it with tools.search.glob / tools.search.grep inside run_code instead of guessing similar paths.
For a large edit, split it into several apply_patch calls; do not emit an entire large file in one response.
To create or replace a whole file, give apply_patch file + content; to edit part of a file, a unified diff in patch.`;
    if (extras.native) {
        const sdk = ptc
            ? `\nInside run_code, use only this SDK (no require, import, fs, process or network):\n${renderSdk(allSpecs(extras), objective, features, extras.allowTools)}\n`
            : '';
        const finish = objective
            ? 'Finish only by calling claim_complete with what changed and how you verified it; a reply without a tool call does not finish this run.'
            : extras.finalSchema
                ? `When the work is done, reply without a tool call, with only JSON of type ${jsonSchemaToTs(extras.finalSchema)}.`
                : 'When the work is done, reply without a tool call: a short summary of what changed and what you verified.';
        return `${header}${sdk}${catalog ? `\n${catalog}\n` : ''}
Rules:
Use the provided tools through function calls; call several at once when they are independent.
${finish}
${common}
`;
    }
    return `${header}
${renderToolPrompt(ptc, allSpecs(extras), objective, features, extras.allowTools)}
${catalog ? `\n${catalog}\n` : ''}
Rules:
1. Reply with exactly one JSON object and no markdown fences, prose, or comments.
2. To call a tool: {"tool":"<name>","args":{...}}; several independent calls: {"calls":[{"tool":"<name>","args":{...}},...]}
3. To finish: ${objective
        ? '{"tool":"claim_complete","args":{"summary":"<what changed and how you verified it>"}}. Replies without a tool call do not finish this run'
        : extras.finalSchema
            ? `{"final": <JSON value of type ${jsonSchemaToTs(extras.finalSchema)}>}`
            : '{"final":"<short summary of what changed and what you verified>"}'}
4. Read a file before editing it. apply_patch rejects stale or unread files.
5. Prefer small, verifiable steps. Inspect shell output before continuing.
6. Never claim success without checking the result.
7. Do not try to read or write outside the workspace.
8. To create or replace a whole file, prefer:
   {"tool":"apply_patch","args":{"file":"NOTES.md","content":"line 1\\nline 2\\n"}}
   To edit part of a file, use a unified diff in "patch".
9. If a path is missing, use tools.search.glob / tools.search.grep inside run_code; do not guess similar paths.
10. For a large edit, split it into several apply_patch calls; do not emit a whole large file in one response.
`;
}
