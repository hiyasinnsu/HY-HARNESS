import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
/** Whether a role offers tools through native function calling. */
export function usesNativeTools(role) {
    if (role.nativeTools !== undefined)
        return role.nativeTools;
    return role.provider === 'ollama' || role.provider === 'openai-compatible' || role.provider === 'deepseek' || role.provider === 'opencode';
}
const SANDBOX_MODES = ['read-only', 'workspace-write', 'low-integrity', 'unconfined'];
/** Validates a sandbox mode from the CLI or `HY_SANDBOX`. */
export function parseSandboxMode(value) {
    if (SANDBOX_MODES.includes(value))
        return value;
    throw new Error(`unknown sandbox mode ${JSON.stringify(value)}; expected one of ${SANDBOX_MODES.join(', ')}`);
}
/**
 * The user's HY-HARNESS directory: `config.json`, `policy.star`, `AGENTS.md`
 * and `skills/` (`%APPDATA%\hy-harness`; `HY_CONFIG_DIR` overrides it).
 */
export function userConfigDir() {
    return process.env.HY_CONFIG_DIR ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'hy-harness');
}
export function canonicalWorkspace(cwd) {
    const root = path.resolve(cwd ?? process.cwd());
    return fs.realpathSync.native(root);
}
/** Validates user-added roots: absolute, existing, unique and outside the primary root. */
export function workspaceRootsFor(primary, extras = []) {
    const roots = [
        { id: 'main', path: primary, label: path.basename(primary) || primary, writable: true },
    ];
    const ids = new Set(['main']);
    const paths = new Set([path.resolve(primary)]);
    for (const extra of extras) {
        if (!extra || typeof extra.path !== 'string' || !path.isAbsolute(extra.path))
            continue;
        let real;
        try {
            const stat = fs.statSync(extra.path);
            if (!stat.isDirectory())
                continue;
            real = fs.realpathSync.native(extra.path);
        }
        catch {
            continue;
        }
        if (paths.has(path.resolve(real)))
            continue;
        let id = (extra.id ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
        if (!id || ids.has(id))
            id = `root-${roots.length + 1}`;
        while (ids.has(id))
            id = `${id}-${roots.length + 1}`;
        ids.add(id);
        paths.add(path.resolve(real));
        roots.push({
            id,
            path: real,
            label: (extra.label ?? path.basename(real) ?? id).trim() || id,
            writable: extra.writable === true,
        });
    }
    return roots;
}
export function stateDirFor(workspaceRoot) {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const id = workspaceId(workspaceRoot);
    return path.join(base, 'hy-harness', 'state', id);
}
export function workspaceId(workspaceRoot) {
    return createHash('sha256').update(workspaceRoot.toLowerCase()).digest('hex').slice(0, 16);
}
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
/**
 * Old OpenCode Go profiles used the DeepSeek-direct model name. The gateway
 * rejects it with HTTP 400 "Model is unavailable", so map it while loading.
 */
const OPENCODE_MODEL_ALIASES = {
    'deepseek-flash': 'deepseek-v4.1-flash',
    'deepseek-v4-flash': 'deepseek-v4.1-flash',
};
function isOpenCodeBaseUrl(baseUrl) {
    if (!baseUrl)
        return false;
    try {
        const host = new URL(baseUrl).hostname.toLowerCase();
        return host === 'opencode.ai' || host.endsWith('.opencode.ai');
    }
    catch {
        return false;
    }
}
function normalizeOpenCodeRole(role) {
    if (role.provider !== 'opencode' && !isOpenCodeBaseUrl(role.baseUrl))
        return;
    role.model = OPENCODE_MODEL_ALIASES[role.model] ?? role.model;
}
function defaultRole(provider) {
    switch (provider) {
        case 'ollama':
            return {
                provider,
                model: 'qwen2.5:3b',
                baseUrl: 'http://127.0.0.1:11434',
                contextWindowTokens: 32_768,
                maxOutputTokens: 4_096,
                temperature: 0,
                pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
            };
        case 'deepseek':
            return {
                provider,
                model: 'deepseek-flash',
                baseUrl: 'https://api.deepseek.com/v1',
                apiKeyEnv: 'DEEPSEEK_API_KEY',
                contextWindowTokens: 1_000_000,
                maxOutputTokens: 8_192,
                temperature: 0,
            };
        case 'openai-compatible':
            return {
                provider,
                model: 'gpt-4.1-mini',
                baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
                apiKeyEnv: 'OPENAI_API_KEY',
                contextWindowTokens: 128_000,
                maxOutputTokens: 8_192,
                temperature: 0,
            };
        case 'opencode':
            return {
                provider,
                model: 'deepseek-v4.1-flash',
                baseUrl: 'https://opencode.ai/inference/go/openai/v1',
                apiKeyEnv: 'OPENCODE_API_KEY',
                contextWindowTokens: 1_000_000,
                maxOutputTokens: 8_192,
                temperature: 0,
            };
        case 'gemini':
            // The Interactions API (verification/sources/gemini_thinking.txt).
            return {
                provider,
                model: 'gemini-3.8-flash',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                apiKeyEnv: 'GEMINI_API_KEY',
                contextWindowTokens: 1_048_576,
                maxOutputTokens: 8_192,
                temperature: 0,
            };
        case 'mock':
            return {
                provider,
                model: 'mock',
                contextWindowTokens: 32_768,
                maxOutputTokens: 4_096,
                temperature: 0,
                pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
            };
    }
}
function envProvider() {
    const v = process.env.HY_PROVIDER;
    if (v === 'ollama' || v === 'deepseek' || v === 'openai-compatible' || v === 'opencode' || v === 'gemini' || v === 'mock')
        return v;
    return undefined;
}
/** First-party automation presets are ordinary MCP servers, opt-in from the user config. */
function automationServers(user) {
    const out = {};
    const automation = user?.automation;
    if (!automation)
        return out;
    const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    if (automation.browser?.enabled === true) {
        const browser = automation.browser.browser ?? 'chrome';
        const cli = path.join(harnessRoot, 'node_modules', '@playwright', 'mcp', 'cli.js');
        const flags = [
            '--browser',
            browser,
            ...(automation.browser.headless === true ? ['--headless'] : []),
            ...(automation.browser.isolated === true ? ['--isolated'] : []),
        ];
        out.playwright = fs.existsSync(cli)
            ? {
                command: process.execPath,
                args: [cli, ...flags],
                // Electron's executable is the Node runtime for stdio MCP servers.
                env: { ELECTRON_RUN_AS_NODE: '1' },
                timeoutMs: 120_000,
                trusted: false,
            }
            : {
                command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
                args: ['-y', '@playwright/mcp@latest', ...flags],
                timeoutMs: 120_000,
                trusted: false,
            };
    }
    if (automation.desktop?.enabled === true) {
        const dist = path.join(harnessRoot, 'packages', 'core', 'dist', 'agent-desktop-mcp.mjs');
        const src = path.join(harnessRoot, 'packages', 'core', 'src', 'agent-desktop-mcp.mjs');
        const wrapper = fs.existsSync(dist) ? dist : src;
        const bin = path.join(harnessRoot, 'node_modules', 'agent-desktop', 'bin', 'agent-desktop');
        out['agent-desktop'] = {
            command: process.execPath,
            args: [wrapper],
            env: { ELECTRON_RUN_AS_NODE: '1', AGENT_DESKTOP_BIN: bin },
            timeoutMs: 120_000,
            trusted: false,
        };
    }
    return out;
}
export function loadConfig(overrides = {}) {
    const workspaceRoot = canonicalWorkspace(overrides.cwd);
    const userConfigPath = path.join(userConfigDir(), 'config.json');
    const user = applyProfile(readJson(userConfigPath), overrides.profile);
    const workspaceRoots = workspaceRootsFor(workspaceRoot, user?.workspaceRoots);
    const projectConfigPath = path.join(workspaceRoot, '.hy-harness', 'config.json');
    const project = readJson(projectConfigPath);
    const provider = overrides.mock === true
        ? 'mock'
        : overrides.provider ?? envProvider() ?? user?.roles?.worker?.provider ?? 'ollama';
    const role = {
        ...defaultRole(provider),
        ...(user?.roles?.worker ?? {}),
    };
    if (overrides.model !== undefined)
        role.model = overrides.model;
    if (overrides.baseUrl !== undefined)
        role.baseUrl = overrides.baseUrl;
    if (overrides.apiKeyEnv !== undefined)
        role.apiKeyEnv = overrides.apiKeyEnv;
    if (overrides.textTools === true)
        role.nativeTools = false;
    role.provider = provider;
    const graderProvider = overrides.mock === true ? 'mock' : user?.roles?.grader?.provider ?? provider;
    const graderRole = {
        ...defaultRole(graderProvider),
        ...(overrides.mock === true ? {} : user?.roles?.grader ?? {}),
    };
    graderRole.provider = graderProvider;
    // These roles inherit the worker until the user gives them their own model.
    const orchestratorProvider = overrides.mock === true ? 'mock' : user?.roles?.orchestrator?.provider ?? provider;
    const orchestratorRole = overrides.mock === true || user?.roles?.orchestrator === undefined
        ? role
        : {
            ...(orchestratorProvider === provider ? role : defaultRole(orchestratorProvider)),
            ...user.roles.orchestrator,
            provider: orchestratorProvider,
        };
    const subagentProvider = overrides.mock === true ? 'mock' : user?.roles?.subagent?.provider ?? provider;
    const subagentRole = overrides.mock === true || user?.roles?.subagent === undefined
        ? role
        : {
            ...(subagentProvider === provider ? role : defaultRole(subagentProvider)),
            ...user.roles.subagent,
            provider: subagentProvider,
        };
    let guardianRole;
    if (overrides.guardian === true || user?.roles?.guardian !== undefined) {
        const guardianProvider = overrides.mock === true ? 'mock' : user?.roles?.guardian?.provider ?? provider;
        guardianRole = { ...defaultRole(guardianProvider), ...(overrides.mock === true ? {} : user?.roles?.guardian ?? {}) };
        guardianRole.provider = guardianProvider;
    }
    const compactorProvider = overrides.mock === true ? 'mock' : user?.roles?.compactor?.provider ?? provider;
    const compactorRole = {
        ...(compactorProvider === provider ? role : defaultRole(compactorProvider)),
        ...(overrides.mock === true ? {} : user?.roles?.compactor ?? {}),
    };
    compactorRole.provider = compactorProvider;
    const summarizerProvider = overrides.mock === true ? 'mock' : user?.roles?.summarizer?.provider ?? provider;
    const summarizerRole = {
        ...(summarizerProvider === provider ? role : defaultRole(summarizerProvider)),
        ...(overrides.mock === true ? {} : user?.roles?.summarizer ?? {}),
    };
    summarizerRole.provider = summarizerProvider;
    for (const roleConfig of [role, graderRole, orchestratorRole, subagentRole, guardianRole, compactorRole, summarizerRole]) {
        if (roleConfig)
            normalizeOpenCodeRole(roleConfig);
    }
    const trustedProject = overrides.projectTrusted === true || (user?.trustedProjects ?? []).some((t) => path.resolve(t.path) === workspaceRoot);
    // Untrusted projects may only make these stricter than the defaults.
    const pl = project?.limits ?? {};
    const tighten = (v, def, stricter) => v === undefined || !Number.isFinite(v) ? def : trustedProject ? v : stricter(v, def);
    const limits = {
        rationaleMaxEntries: tighten(pl.rationaleMaxEntries, 12, Math.min),
        rationaleMaxTokens: tighten(pl.rationaleMaxTokens, 1_500, Math.min),
        spillThresholdBytes: tighten(pl.spillThresholdBytes, 32 * 1024, Math.min),
        compactionTriggerRatio: tighten(pl.compactionTriggerRatio, 0.75, Math.min),
        keepRecentTurns: tighten(pl.keepRecentTurns, 2, Math.max),
    };
    const pb = project?.budget4D ?? {};
    const projectCost = tighten(pb.maxCostUsd, 2, Math.min);
    const budget = {
        maxRounds: overrides.maxRounds ?? tighten(pb.maxRounds, 5, Math.min),
        maxTotalTokens: overrides.maxTotalTokens ?? tighten(pb.maxTotalTokens, 500_000, Math.min),
        maxCostUsd: overrides.maxCostUsd === 'off' ? undefined : overrides.maxCostUsd ?? projectCost,
        maxWallClockMs: overrides.maxWallClockMs ?? tighten(pb.maxWallClockMs, 30 * 60_000, Math.min),
    };
    const sandbox = overrides.sandbox ??
        (overrides.fullAuto ? 'workspace-write' : undefined) ??
        (process.env.HY_SANDBOX ? parseSandboxMode(process.env.HY_SANDBOX) : undefined) ??
        user?.sandboxMode ??
        'unconfined';
    const trusted = trustedProject;
    const userPolicyPath = user?.userPolicyPath ?? path.join(userConfigDir(), 'policy.star');
    const projectPolicyPath = path.join(workspaceRoot, '.hy-harness', 'policies', 'project.star');
    const mcpServers = {
        ...automationServers(user),
        ...(user?.mcpServers ?? {}),
        ...(trusted ? project?.mcpServers ?? {} : {}),
    };
    return {
        workspaceRoot,
        workspaceRoots,
        stateDir: path.resolve(overrides.stateDir ?? stateDirFor(workspaceRoot)),
        sandbox,
        role,
        graderRole,
        orchestratorRole,
        subagentRole,
        ...(guardianRole !== undefined ? { guardianRole } : {}),
        guardianApproveBelow: user?.guardian?.approveBelow ?? 80,
        compactorRole,
        summarizerRole,
        rules: overrides.rules ?? [],
        limits,
        budget,
        maxSteps: overrides.maxSteps ?? project?.limits?.maxSteps ?? 20,
        autoApprove: overrides.autoApprove ?? user?.autoApprove ?? false,
        fullAuto: overrides.fullAuto ?? user?.fullAuto ?? false,
        ptc: overrides.ptc ?? process.env.HY_PTC === '1',
        projectTrusted: trusted,
        protectedPaths: project?.protectedPaths ?? [],
        envPassthrough: user?.sandbox?.envPassthrough ?? [],
        extraWritableRoots: (user?.sandbox?.extraWritableRoots ?? []).map((r) => path.resolve(r)),
        ...(fs.existsSync(userPolicyPath) ? { userPolicyPath } : {}),
        ...(fs.existsSync(projectPolicyPath) ? { projectPolicyPath } : {}),
        mcpServers,
        hooks: mergeHooks(user?.hooks, trusted ? project?.hooks : undefined),
        lsp: user?.lsp ?? {},
        memory: overrides.memory === true || user?.memory?.enabled === true,
        plugins: [...(user?.plugins ?? []), ...(trusted ? (project?.plugins ?? []).map((p) => path.resolve(workspaceRoot, p)) : [])],
        ...(user?.notify?.length ? { notify: user.notify } : {}),
        ...(overrides.web === true || user?.web?.enabled === true ? { web: { ...(user?.web ?? {}), enabled: true } } : {}),
    };
}
/** The user config with `profiles[name]` laid over it (objects merged, other values replaced). */
function applyProfile(user, name) {
    if (name === undefined)
        return user;
    const profile = user?.profiles?.[name];
    if (!profile)
        throw new Error(`unknown profile ${name}; defined: ${Object.keys(user?.profiles ?? {}).join(', ') || 'none'}`);
    const merge = (a, b) => {
        if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
            const out = { ...a };
            for (const [k, v] of Object.entries(b))
                out[k] = merge(out[k], v);
            return out;
        }
        return b === undefined ? a : b;
    };
    return merge(user, profile);
}
function mergeHooks(a = {}, b = {}) {
    return {
        preToolUse: [...(a.preToolUse ?? []), ...(b.preToolUse ?? [])],
        postToolUse: [...(a.postToolUse ?? []), ...(b.postToolUse ?? [])],
        turnEnd: [...(a.turnEnd ?? []), ...(b.turnEnd ?? [])],
    };
}
export function roleApiKey(role) {
    if (role.provider === 'ollama' || role.provider === 'mock')
        return undefined;
    if (role.apiKey?.trim())
        return role.apiKey.trim();
    const env = role.apiKeyEnv ??
        (role.provider === 'deepseek'
            ? 'DEEPSEEK_API_KEY'
            : role.provider === 'gemini'
                ? 'GEMINI_API_KEY'
                : role.provider === 'opencode'
                    ? 'OPENCODE_API_KEY'
                    : 'OPENAI_API_KEY');
    return process.env[env];
}
