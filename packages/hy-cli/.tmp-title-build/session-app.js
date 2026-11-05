import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Agent, ExecRpcClient, Hooks, LazyProvider, Ledger, LspManager, McpManager, MemoryStore, MockCompactorProvider, MockGuardianProvider, READ_ONLY_TOOLS, SessionLog, ToolRuntime, createHarnessContext, createProvider, discoverPinned, discoverSkills, ensureStateDirs, loadConfig, loadPlugins, readEvents, rebuildHistory, resolveServerPath, sessionLogPath, usesNativeTools, } from '../../core/dist/index.js';
import { Guardian, SpillCompaction, createApprover, } from '../../seams/dist/index.js';
import { cleanThinkingSummary, hasJapanese } from './summary-text.js';
/**
 * One session's context plumbing (design §8): the run's Ledger rebuilt from
 * the log, spill files under the state directory, and the compaction policy.
 */
export function sessionContext(config, log, runId, budget) {
    const ledger = Ledger.forRun(log, runId, discoverPinned(config.workspaceRoot, config.rules), {
        maxEntries: config.limits.rationaleMaxEntries,
        maxTokens: config.limits.rationaleMaxTokens,
    });
    const spillDir = path.join(config.stateDir, 'spill');
    const context = new SpillCompaction({
        spillDir,
        sessionId: log.sessionId,
        contextWindowTokens: config.role.contextWindowTokens,
        thresholdBytes: config.limits.spillThresholdBytes,
        triggerRatio: config.limits.compactionTriggerRatio,
        keepRecentTurns: config.limits.keepRecentTurns,
        compactor: meter(new LazyProvider(() => config.compactorRole.provider === 'mock'
            ? new MockCompactorProvider()
            : createProvider(config.compactorRole, config.workspaceRoot, runId)), 'compactor', budget),
        ledgerKeys: () => ledger.list().map((n) => n.key),
        log,
    });
    return { ledger, spillDir, context };
}
/** Counts a role's usage against the run's Budget4D, when there is one. */
function meter(provider, role, budget) {
    return budget ? budget.meter(provider, role) : provider;
}
/**
 * The approval chain for `prompt` decisions: `--yes`, then Guardian when
 * configured, then the user when a terminal is attached; otherwise denied.
 */
export function approvals(config, objective, budget, askUser, sessionId) {
    const guardian = config.guardianRole === undefined
        ? undefined
        : new Guardian({
            provider: meter(config.guardianRole.provider === 'mock'
                ? new MockGuardianProvider()
                : createProvider(config.guardianRole, config.workspaceRoot, sessionId), 'guardian', budget),
            objective,
            approveBelow: config.guardianApproveBelow,
        });
    const approve = createApprover({
        autoApprove: config.autoApprove,
        autoApproveConfined: config.fullAuto,
        ...(guardian !== undefined ? { guardian } : {}),
        ...(askUser !== undefined ? { askUser } : {}),
    });
    return { approve, ...(guardian !== undefined ? { guardian } : {}) };
}
/** Opens the execution daemon and loads the workspace configuration. */
export async function openClient(overrides, execServer) {
    const config = loadConfig(overrides);
    ensureStateDirs(config.stateDir);
    const serverPath = resolveServerPath(execServer);
    const client = await ExecRpcClient.start(serverPath, {
        protocolVersion: 1,
        workspaceRoot: config.workspaceRoot,
        stateDir: config.stateDir,
        sandbox: config.sandbox,
        extraWritableRoots: config.extraWritableRoots,
        envPassthrough: config.envPassthrough,
        projectTrusted: config.projectTrusted,
        protectedPaths: config.protectedPaths,
        ...(config.userPolicyPath !== undefined ? { userPolicyPath: config.userPolicyPath } : {}),
        ...(config.projectPolicyPath !== undefined ? { projectPolicyPath: config.projectPolicyPath } : {}),
    });
    return { config, client };
}
export function eventPrinter(json, runId) {
    return (event) => {
        if (json) {
            console.log(JSON.stringify({ runId, ...event }));
            return;
        }
        switch (event.type) {
            case 'assistant':
                console.error(`\n[step ${String(event.step)}] ${String(event.content)}`);
                break;
            case 'tool':
                console.error(`\n[tool] ${String(event.name)} ${JSON.stringify(event.args)}`);
                console.error(JSON.stringify(event.result, null, 2).slice(0, 4_000));
                break;
            case 'tool-error':
                console.error(`\n[tool error] ${String(event.name)}: ${String(event.message)}`);
                break;
            case 'retry':
                console.error(`\n[retry] step ${String(event.step)}: ${String(event.content)}`);
                break;
            case 'final':
                break;
        }
    };
}
export const PLAN_MODE_TOOLS = new Set([...READ_ONLY_TOOLS, 'ask_user']);
/** The user's (and a trusted project's) hooks, or undefined when none are configured. */
export function sessionHooks(config) {
    const hooks = new Hooks(config.hooks, config.notify, (line) => console.error(`[hy] ${line}`));
    return hooks.empty ? undefined : hooks;
}
/** `--output-schema`: the final answer of run/resume must be JSON matching it. */
let sessionOutputSchema;
export function setOutputSchema(schema) {
    sessionOutputSchema = schema;
}
/** This process's language servers (started on first lsp use, closed on exit). */
let sessionLsp;
export function lspFor(config) {
    if (Object.keys(config.lsp).length === 0)
        return undefined;
    sessionLsp ??= new LspManager(config.workspaceRoot, config.lsp);
    return sessionLsp;
}
/** This process's MCP servers (started by run/chat/resume/ralph, closed on exit). */
export let sessionMcp;
/** This process's plugin tools (loaded once with the MCP servers). */
export let sessionPlugins;
let loadedPluginKey = '';
let loadedMcpKey = '';
export function pluginSpecs() {
    return [...(sessionPlugins?.tools.values() ?? [])].map((t) => t.spec);
}
/** A read-only tool set plus the plugin tools that declare themselves read-only. */
export function withReadOnlyPlugins(base) {
    const extra = [...(sessionPlugins?.tools.values() ?? [])].filter((t) => t.spec.readOnly).map((t) => t.name);
    return extra.length === 0 ? base : new Set([...base, ...extra]);
}
/** Starts what a session needs from the user's configuration: plugins and MCP servers. */
export async function startServices(config) {
    const pluginKey = config.plugins.join('\0');
    if (config.plugins.length === 0) {
        sessionPlugins = undefined;
        loadedPluginKey = '';
    }
    else if (!sessionPlugins || loadedPluginKey !== pluginKey) {
        sessionPlugins = await loadPlugins(config.plugins);
        loadedPluginKey = pluginKey;
        console.error(`[hy] plugins: ${sessionPlugins.tools.size} tool(s) from ${config.plugins.length} module(s)`);
        for (const e of sessionPlugins.errors)
            console.error(`[hy] plugin error: ${e}`);
    }
    await startMcp(config);
}
/** Reloads user/project plugin modules (cache-busted). New sessions use the new tools. */
export async function reloadPlugins(config) {
    sessionPlugins = await loadPlugins(config.plugins, { cacheBust: true });
    loadedPluginKey = config.plugins.join('\0');
    return sessionPlugins;
}
async function startMcp(config) {
    const names = Object.keys(config.mcpServers);
    const mcpKey = names.join('\0');
    if (names.length === 0) {
        sessionMcp?.close();
        sessionMcp = undefined;
        loadedMcpKey = '';
        return;
    }
    if (sessionMcp && loadedMcpKey === mcpKey)
        return;
    sessionMcp?.close();
    sessionMcp = await McpManager.start(config.mcpServers);
    loadedMcpKey = mcpKey;
    console.error(`[hy] mcp: ${sessionMcp.tools.length} tool(s) from ${names.length - sessionMcp.errors.length}/${names.length} server(s)`);
    for (const e of sessionMcp.errors)
        console.error(`[hy] mcp server failed: ${e}`);
}
/** Closes this process's MCP servers and language servers. */
export async function closeServices() {
    sessionMcp?.close();
    sessionMcp = undefined;
    loadedMcpKey = '';
    sessionPlugins = undefined;
    loadedPluginKey = '';
    await sessionLsp?.close();
    sessionLsp = undefined;
}
let subagents = 0;
async function runSubagent(config, client, o) {
    subagents += 1;
    const runId = `${o.parentRunId}.sub${subagents}`;
    const log = new SessionLog(sessionLogPath(config.stateDir));
    log.setRun(runId);
    log.append('subagent/start', { parentRunId: o.parentRunId, readOnly: o.readOnly });
    const allowTools = o.readOnly ? withReadOnlyPlugins(READ_ONLY_TOOLS) : undefined;
    const mcp = o.readOnly ? undefined : sessionMcp;
    const hooks = sessionHooks(config);
    const tools = new ToolRuntime(client, config.workspaceRoot, o.approve, false, {
        spillDir: o.spillDir,
        // Jobs are tagged with the parent run, so its rollback kills them.
        runId: o.parentRunId,
        skills: o.skills,
        roots: config.workspaceRoots,
        ...(allowTools ? { allowTools } : {}),
        ...(mcp ? { mcp } : {}),
        ...(hooks ? { hooks } : {}),
        ...(config.web ? { web: config.web } : {}),
        ...(lspFor(config) ? { lsp: lspFor(config) } : {}),
        ...(sessionPlugins?.tools.size ? { plugins: sessionPlugins.tools } : {}),
        ...(config.memory ? { memory: MemoryStore.forStateDir(config.stateDir) } : {}),
        ...(o.writeScope ? { writeScope: o.writeScope } : {}),
        ...(o.shellGuard ? { shellGuard: o.shellGuard } : {}),
        ...(o.shellLock ? { shellLock: o.shellLock } : {}),
        ...(o.noBackgroundShell ? { noBackgroundShell: true } : {}),
        ...(o.minForegroundWaitMs !== undefined ? { minForegroundWaitMs: o.minForegroundWaitMs } : {}),
        ...(o.shellTimeoutMs !== undefined ? { shellTimeoutMs: o.shellTimeoutMs } : {}),
    });
    const subagentRole = config.subagentRole;
    const agent = new Agent({
        provider: createProvider(subagentRole, config.workspaceRoot, runId),
        tools,
        sessionLog: log,
        workspaceRoot: config.workspaceRoot,
        maxSteps: config.maxSteps,
        maxOutputTokens: subagentRole.maxOutputTokens,
        temperature: subagentRole.temperature ?? 0,
        ...(subagentRole.effort ? { effort: subagentRole.effort } : {}),
        nativeTools: usesNativeTools(subagentRole),
        ptc: config.ptc,
        skills: o.skills,
        web: config.web !== undefined,
        search: config.web?.searchUrl !== undefined,
        lsp: lspFor(config) !== undefined,
        extraTools: pluginSpecs(),
        ...(config.memory ? { memory: MemoryStore.forStateDir(config.stateDir) } : {}),
        ...(o.roleInstruction ? { roleInstruction: o.roleInstruction } : {}),
        ...(allowTools ? { allowTools } : {}),
        ...(mcp ? { mcpCatalog: mcp.renderCatalog() } : {}),
        onEvent: (event) => o.print({ ...event, subagent: runId }),
    });
    const result = await agent.run(o.task);
    return { final: result.final, steps: result.steps };
}
/** Summarizes a visible thinking trace in Japanese (the Summarizer role). */
export async function summarizeThinking(config, text, sessionId, signal) {
    const trace = text.trim();
    if (!trace)
        return '';
    if (config.summarizerRole.provider === 'mock')
        return 'モックの思考要約です。';
    const provider = createProvider(config.summarizerRole, config.workspaceRoot, sessionId);
    // The UI shows a provisional summary immediately; this refinement must not
    // spend time on a reasoning phase.
    const effort = config.summarizerRole.effort ?? (config.summarizerRole.provider === 'opencode' ? 'none' : undefined);
    const options = { maxTokens: 160, temperature: 0, json: false, ...(effort ? { effort } : {}), ...(signal ? { signal } : {}) };
    const completion = await provider.complete([
        {
            role: 'system',
            content: 'コーディングエージェントの思考ログを、日本語の平文1〜3文に要約する。\n' +
                '敬語は使わず「〜だ。〜する。〜が分かった。」のように、簡潔でフランクに書く。\n' +
                'JSON、Markdown、箇条書き、見出し、コードフェンス、引用符は禁止。\n' +
                '入力が英語・中国語でも日本語にする。\n' +
                '入力のJSONキーや値、ファイルパス、コマンドをそのまま列挙しない。\n' +
                '推測や新しい方針を追加しない。\n' +
                '例: 主要なファイルを確認して構成を把握する。次に実装状況を短くまとめる。',
        },
        { role: 'user', content: trace.slice(0, 6_000) },
    ], options);
    let summary = cleanThinkingSummary(completion.content);
    if (!summary)
        throw new Error('summarizer returned an empty summary');
    if (!hasJapanese(summary)) {
        // The model ignored the language instruction; translate once instead of
        // showing an English/Chinese sentence under a "要約" label.
        const translated = await provider.complete([
            {
                role: 'system',
                content: '次の文章を、敬語を使わない簡潔な日本語に翻訳する。JSON、見出し、前置き、引用符は使わず、翻訳本文だけを返す。',
            },
            { role: 'user', content: summary.slice(0, 4_000) },
        ], options);
        const clean = cleanThinkingSummary(translated.content);
        if (clean && hasJapanese(clean))
            summary = clean;
        else
            throw new Error('summarizer returned a non-Japanese summary');
    }
    return summary;
}
/**
 * One conversational run (`hy run`, `hy chat`, `hy resume`): the run's log,
 * ledger and tools, and a checkpoint before every turn so `/undo` and
 * `hy undo` can restore the files.
 */
export class Conversation {
    ctx;
    config;
    client;
    log;
    runId;
    sessionRole;
    build;
    context;
    ledger;
    tools;
    skills;
    hooks;
    delegate;
    history = [];
    turns = 0;
    usage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
    lastUsage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
    checkpoints = true;
    agent;
    planMode = false;
    planTools = PLAN_MODE_TOOLS;
    planOnly = false;
    goal;
    constructor(ctx, config, client, log, runId, sessionRole, build, context, ledger, tools, skills, hooks, delegate) {
        this.ctx = ctx;
        this.config = config;
        this.client = client;
        this.log = log;
        this.runId = runId;
        this.sessionRole = sessionRole;
        this.build = build;
        this.context = context;
        this.ledger = ledger;
        this.tools = tools;
        this.skills = skills;
        this.hooks = hooks;
        this.delegate = delegate;
        this.agent = build(sessionRole);
    }
    static create(config, client, runId, json, askUser, answer, onEvent, options = {}) {
        const log = new SessionLog(sessionLogPath(config.stateDir));
        log.setRun(runId);
        const { ledger, spillDir, context } = sessionContext(config, log, runId);
        const { approve } = approvals(config, '(interactive session)', undefined, askUser, runId);
        const skills = discoverSkills(config.workspaceRoot);
        const mcp = sessionMcp;
        const hooks = sessionHooks(config);
        const print = onEvent ?? eventPrinter(json, runId);
        const delegate = (task, readOnly) => runSubagent(config, client, {
            task,
            readOnly,
            parentRunId: runId,
            approve,
            skills,
            spillDir,
            print,
            ...(options.writeScope ? { writeScope: options.writeScope } : {}),
            ...(options.shellGuard ? { shellGuard: options.shellGuard } : {}),
            ...(options.shellLock ? { shellLock: options.shellLock } : {}),
            ...(options.noBackgroundShell ? { noBackgroundShell: true } : {}),
            ...(options.minForegroundWaitMs !== undefined ? { minForegroundWaitMs: options.minForegroundWaitMs } : {}),
            ...(options.shellTimeoutMs !== undefined ? { shellTimeoutMs: options.shellTimeoutMs } : {}),
            ...(options.roleInstruction ? { roleInstruction: options.roleInstruction } : {}),
        });
        const pluginMap = options.tooling?.plugins
            ? new Map([...(sessionPlugins?.tools ?? new Map()), ...options.tooling.plugins])
            : sessionPlugins?.tools;
        const extraSpecs = [...pluginSpecs(), ...(options.tooling?.specs ?? [])];
        const extrasAllowed = new Set(options.tooling?.allowed ?? []);
        const planTools = new Set([...withReadOnlyPlugins(PLAN_MODE_TOOLS), ...extrasAllowed]);
        const delegateEnabled = options.delegate !== false;
        const tools = new ToolRuntime(client, config.workspaceRoot, approve, false, {
            ledger,
            spillDir,
            runId,
            skills,
            roots: config.workspaceRoots,
            delegate,
            ...(mcp ? { mcp } : {}),
            ...(hooks ? { hooks } : {}),
            ...(config.web ? { web: config.web } : {}),
            ...(lspFor(config) ? { lsp: lspFor(config) } : {}),
            ...(pluginMap?.size ? { plugins: pluginMap } : {}),
            ...(config.memory ? { memory: MemoryStore.forStateDir(config.stateDir) } : {}),
            ...(answer ? { askUser: answer } : {}),
            ...(options.writeScope ? { writeScope: options.writeScope } : {}),
            ...(options.shellGuard ? { shellGuard: options.shellGuard } : {}),
            ...(options.shellLock ? { shellLock: options.shellLock } : {}),
            ...(options.noBackgroundShell ? { noBackgroundShell: true } : {}),
            ...(options.minForegroundWaitMs !== undefined ? { minForegroundWaitMs: options.minForegroundWaitMs } : {}),
            ...(options.shellTimeoutMs !== undefined ? { shellTimeoutMs: options.shellTimeoutMs } : {}),
        });
        // Rebuilt by /model and /plan-mode; the conversation and tools stay.
        const build = (role, allowTools, signal, callIdPrefix) => {
            const allow = options.planOnly ? planTools : allowTools;
            return new Agent({
                provider: createProvider(role, config.workspaceRoot, runId),
                tools,
                sessionLog: log,
                workspaceRoot: config.workspaceRoot,
                maxSteps: config.maxSteps,
                maxOutputTokens: role.maxOutputTokens,
                temperature: role.temperature ?? 0,
                ...(role.effort ? { effort: role.effort } : {}),
                nativeTools: usesNativeTools(role),
                ptc: config.ptc,
                ledger,
                context,
                skills,
                delegate: delegateEnabled,
                ...(options.roleInstruction ? { roleInstruction: options.roleInstruction } : {}),
                web: config.web !== undefined,
                search: config.web?.searchUrl !== undefined,
                lsp: lspFor(config) !== undefined,
                extraTools: extraSpecs,
                ...(config.memory ? { memory: MemoryStore.forStateDir(config.stateDir) } : {}),
                ask: answer !== undefined,
                ...(allow ? { allowTools: allow } : {}),
                ...(mcp ? { mcpCatalog: mcp.renderCatalog() } : {}),
                ...(sessionOutputSchema ? { finalSchema: sessionOutputSchema } : {}),
                ...(signal ? { signal } : {}),
                ...(callIdPrefix ? { callIdPrefix } : {}),
                onEvent: print,
            });
        };
        const ctx = createHarnessContext({
            execRpc: client,
            sessionLog: log,
            ledger,
            spillStore: context,
            tools,
        });
        const conv = new Conversation(ctx, config, client, log, runId, options.role ?? config.role, build, context, ledger, tools, skills, hooks, delegate);
        // Continue an earlier run (`hy resume`): its history and turn count.
        const events = readEvents(log.file);
        conv.history = rebuildHistory(events, runId);
        const mine = events.filter((e) => e.runId === runId);
        conv.turns = mine.filter((e) => e.type === 'turn/start').length - mine.filter((e) => e.type === 'turn/undo').length;
        for (const e of mine) {
            if (e.type === 'goal/set')
                conv.goal = typeof e.payload.goal === 'string' ? String(e.payload.goal) : undefined;
            if (e.type === 'step/end') {
                const u = e.payload.usage;
                if (u) {
                    const input = Number(u.inputTokens ?? 0);
                    const output = Number(u.outputTokens ?? 0);
                    const hit = Number(u.cacheHitTokens ?? 0);
                    const miss = Number(u.cacheMissTokens ?? Math.max(0, input - hit));
                    conv.usage.inputTokens += input;
                    conv.usage.outputTokens += output;
                    conv.usage.cacheHitTokens += hit;
                    conv.usage.cacheMissTokens += miss;
                    conv.lastUsage.inputTokens = input;
                    conv.lastUsage.outputTokens = output;
                    conv.lastUsage.cacheHitTokens = hit;
                    conv.lastUsage.cacheMissTokens = miss;
                }
            }
        }
        conv.planTools = planTools;
        conv.planOnly = options.planOnly === true;
        conv.checkpoints = options.checkpoints !== false;
        if (options.planOnly === true || options.initialPlanMode === true)
            conv.setPlanMode(true);
        return conv;
    }
    async turn(message, images = [], signal, meta) {
        this.turns += 1;
        this.log.append('turn/start', { turn: this.turns });
        if (this.checkpoints) {
            try {
                await this.client.checkpointCreate(this.runId, `t${this.turns}`);
            }
            catch (error) {
                // Not a git repository (or git is missing): no /undo, the turn still runs.
                this.checkpoints = false;
                console.error(`[hy] checkpoints off: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const roots = this.config.workspaceRoots;
        const rootCatalog = roots.length > 1
            ? [
                '[workspace roots]',
                ...roots.map((root) => `- ${root.id}: ${root.path} (${root.writable === true ? 'writable' : 'read-only'})`),
                'Use "rootId:relative/path" with read_file / search_glob / search_grep; pass root: "rootId" to apply_patch / shell.',
                'Extra writable roots are explicit user choices: direct whole-file apply_patch writes and shell writes are outside the primary git checkpoint/undo and may be outside the OS sandbox.',
                'Only the primary root (main) has LSP and checkpoint/undo support.',
            ].join('\n')
            : '';
        const text = [
            this.goal ? `[session goal: ${this.goal}]` : '',
            rootCatalog,
            // Orchestrator sessions are always read-only; its role prompt already
            // defines that. Sending the generic plan-mode instruction as well made
            // the model narrate "plan mode" and stop for approval on every step.
            this.planMode && !this.planOnly
                ? '[plan mode: read-only. Investigate, then propose a plan with update_plan and explain it in your final answer; do not change files until the user leaves plan mode.]'
                : '',
            message,
        ]
            .filter(Boolean)
            .join('\n\n');
        this.tools.setSignal(signal);
        this.agent = this.build(this.sessionRole, this.planMode ? this.planTools : undefined, signal, `t${this.turns}-`);
        try {
            const result = await this.agent.run(text, this.history, images, meta?.source);
            this.history = result.history;
            await this.hooks?.turnEnd({ runId: this.runId, turn: this.turns, final: result.final, cwd: this.config.workspaceRoot });
            this.lastUsage.inputTokens = result.usage.inputTokens;
            this.lastUsage.outputTokens = result.usage.outputTokens;
            this.lastUsage.cacheHitTokens = result.usage.cacheHitTokens ?? 0;
            this.lastUsage.cacheMissTokens = result.usage.cacheMissTokens ?? 0;
            this.usage.inputTokens += result.usage.inputTokens;
            this.usage.outputTokens += result.usage.outputTokens;
            this.usage.cacheHitTokens += result.usage.cacheHitTokens ?? 0;
            this.usage.cacheMissTokens += result.usage.cacheMissTokens ?? 0;
            return result.final;
        }
        finally {
            this.tools.setSignal(undefined);
            this.agent = this.build(this.sessionRole, this.planMode ? this.planTools : undefined);
        }
    }
    /** Restores the files to before the last turn and drops it from the conversation. */
    async undo() {
        if (this.turns === 0)
            return 'nothing to undo';
        if (!this.checkpoints)
            return 'undo is unavailable: checkpoints are off';
        const turn = this.turns;
        const result = await this.client.checkpointRollback(this.runId, `t${turn}`);
        this.log.append('turn/undo', { turn });
        this.history = rebuildHistory(readEvents(this.log.file), this.runId);
        this.turns -= 1;
        return `undid turn ${turn}: restored ${result.restored.length}, deleted ${result.deleted.length} file(s)`;
    }
    async diff() {
        if (!this.checkpoints || this.turns === 0)
            return 'no checkpoint yet';
        const d = await this.client.checkpointDiff(this.runId, 't1', 64 * 1024);
        return d.patch.trim() ? `${d.stat}\n${d.patch}` : 'no changes since the session started';
    }
    status() {
        return [
            `run: ${this.runId}`,
            `workspace: ${this.config.workspaceRoot}`,
            `model: ${this.sessionRole.provider}/${this.sessionRole.model}`,
            `sandbox: ${this.config.sandbox}`,
            ...(this.goal ? [`goal: ${this.goal}`] : []),
            `turns: ${this.turns}, messages: ${this.history.length}`,
            `tokens this process: in ${this.usage.inputTokens}, out ${this.usage.outputTokens}`,
        ].join('\n');
    }
    usageSnapshot() {
        return {
            ...this.usage,
            lastInputTokens: this.lastUsage.inputTokens,
            lastOutputTokens: this.lastUsage.outputTokens,
            lastCacheHitTokens: this.lastUsage.cacheHitTokens,
            lastCacheMissTokens: this.lastUsage.cacheMissTokens,
        };
    }
    currentEffort() {
        return this.sessionRole.effort;
    }
    currentModel() {
        return { provider: this.sessionRole.provider, model: this.sessionRole.model };
    }
    setEffort(effort) {
        if (effort)
            this.sessionRole.effort = effort;
        else
            delete this.sessionRole.effort;
        this.agent = this.build(this.sessionRole, this.planMode ? this.planTools : undefined);
        return effort ? `reasoning effort: ${effort}` : 'reasoning effort: provider default';
    }
    plan() {
        const plan = this.tools.currentPlan();
        const mark = { pending: '[ ]', in_progress: '[>]', completed: '[x]' };
        return plan.length === 0 ? 'no plan' : plan.map((s) => `${mark[s.status]} ${s.step}`).join('\n');
    }
    skillList() {
        return this.skills.length === 0
            ? 'no skills (add <name>/SKILL.md under .hy-harness/skills, .agents/skills or the user skills directory)'
            : this.skills.map((s) => `${s.name} (${s.scope}): ${s.description}`).join('\n');
    }
    notes() {
        const notes = this.ledger.list();
        return notes.length === 0 ? 'no notes' : notes.map((n) => `- ${n.key}: ${n.rule}`).join('\n');
    }
    /** Compacts the conversation now (the same tiers as the automatic trigger). */
    async compact() {
        const before = this.history.length;
        const compacted = await this.context.beforeRequest([{ role: 'system', content: '' }, ...this.history], Number.MAX_SAFE_INTEGER);
        this.history = compacted.slice(1);
        this.log.append('compaction/manual', { before, after: this.history.length });
        return `compacted: ${before} → ${this.history.length} messages`;
    }
    /** Plan mode (DSH plan): reading tools only until the user turns it off. */
    setPlanMode(on) {
        if (this.planOnly && !on)
            return 'plan mode stays on for the orchestrator';
        this.planMode = on;
        const allow = on ? this.planTools : undefined;
        this.tools.setAllowTools(allow);
        this.agent = this.build(this.sessionRole, allow);
        this.log.append('plan-mode', { on });
        return on ? 'plan mode on: the agent can only read and plan' : 'plan mode off: the agent may change files again';
    }
    isPlanMode() {
        return this.planMode;
    }
    currentGoal() {
        return this.goal;
    }
    /** A session objective kept in every user turn until cleared. */
    setGoal(goal) {
        this.goal = goal.trim() || undefined;
        this.log.append('goal/set', { goal: this.goal ?? '' });
        return this.goal ? `goal: ${this.goal}` : 'goal cleared';
    }
    /** Switches the worker model for the following turns (`/model <name>`). */
    setModel(model) {
        const role = { ...this.sessionRole, model };
        const wasConfigRole = this.sessionRole === this.config.role;
        this.sessionRole = role;
        if (wasConfigRole)
            this.config.role = role;
        this.agent = this.build(role, this.planMode ? this.planTools : undefined);
        this.log.append('model/switch', { model });
        return `model: ${role.provider}/${model}`;
    }
}
export function newRunId() {
    return `run-${randomBytes(6).toString('hex')}`;
}
function displayUserText(text) {
    return text
        .replace(/^\[session goal: [^\]]*\]\n?/, '')
        .replace(/^\[plan mode: read-only\.[^\]]*\]\n?/, '')
        .replace(/^\n+/, '');
}
/** Runs in the log, newest first; ralph runs (rounds) are marked and cannot be resumed. */
export function listRuns(events) {
    const runs = new Map();
    for (const e of events) {
        // Subagent runs (`<run>.subN`) belong to their parent.
        if (!e.runId || e.runId.includes('.sub'))
            continue;
        let r = runs.get(e.runId);
        if (!r) {
            r = { runId: e.runId, started: e.ts, last: e.ts, turns: 0, first: '', ralph: false };
            runs.set(e.runId, r);
        }
        r.last = Math.max(r.last, e.ts);
        if (e.round !== undefined || e.type.startsWith('ralph/'))
            r.ralph = true;
        if (e.type === 'turn/start' || e.type === 'round/start')
            r.turns += 1;
        if (e.type === 'turn/undo')
            r.turns -= 1;
        if (e.type === 'user/message' && !r.first)
            r.first = displayUserText(String(e.payload.content ?? ''));
    }
    return [...runs.values()].sort((a, b) => b.last - a.last);
}
