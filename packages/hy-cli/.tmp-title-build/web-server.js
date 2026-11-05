import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { MemoryStore, canonicalWorkspace, loadConfig, readEvents, SessionLog, sessionLogPath, spillFile, userConfigDir, workspaceRootsFor, } from '../../core/dist/index.js';
import { Conversation, closeServices, listRuns, newRunId, openClient, reloadPlugins, sessionMcp, sessionPlugins, startServices, summarizeThinking, } from './session-app.js';
import { applyAgentEvent, projectChat } from './chat-projection.js';
import { usageOf } from './usage.js';
import { instantThinkingSummary } from './summary-text.js';
import { cronMatches, nextCronTime, parseCron } from './cron.js';
import { PersistentPty } from './pty.js';
import { DEFAULT_MAX_WORKERS, canSpawnWorker, loadOrchestrationState, normalizeScopes, saveOrchestrationState, scopeOwners, scopesOverlap, workerOwnsScope, } from './orchestration.js';
/**
 * Sandbox modes only the user may approve (the same rule as Guardian's): the
 * orchestrator is a model and must not approve commands that would run
 * unconfined or low-integrity, MCP calls or web fetches.
 */
export function userOnlyApproval(request) {
    return request?.sandbox === 'unconfined' || request?.sandbox === 'low-integrity';
}
function readAutomationStore(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
            schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
            webhooks: Array.isArray(parsed.webhooks) ? parsed.webhooks : [],
            runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-100) : [],
        };
    }
    catch {
        return { schedules: [], webhooks: [], runs: [] };
    }
}
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.map': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
};
const TREE_SKIP = new Set(['.git', 'node_modules', '.hy-harness', 'target', 'dist', '.next', 'coverage']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
function logLine(options, line) {
    ;
    (options.log ?? ((l) => console.error(l)))(`[hy web] ${line}`);
}
function json(res, status, value) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(value));
}
function text(res, status, value, type = 'text/plain; charset=utf-8') {
    res.statusCode = status;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.end(value);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Never send a directly stored API key back to the browser. */
function redactUserConfig(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return raw;
    const copy = JSON.parse(JSON.stringify(raw));
    const roles = copy.roles;
    if (roles && typeof roles === 'object' && !Array.isArray(roles)) {
        for (const role of Object.values(roles)) {
            if (!role || typeof role !== 'object' || Array.isArray(role))
                continue;
            const r = role;
            if (typeof r.apiKey === 'string' && r.apiKey.length > 0) {
                delete r.apiKey;
                r.apiKeySet = true;
            }
        }
    }
    return copy;
}
/**
 * The `hy run` / `hy ralph` arguments of an unattended automation run.
 *
 * * Trust is decided for the target directory, not for the server's
 *   workspace: `--trust` is passed only when the target is the server's own
 *   workspace and that one is trusted; otherwise the child decides from the
 *   user's `trustedProjects`. `--unattended-ok` is never passed, so a verifier
 *   loop on an untrusted repository is refused (OQ-3), as on the command line.
 * * A webhook run never gets `--yes`: its objective carries external payload
 *   text, and auto-approval would turn a prompt injection into unapproved
 *   commands. `prompt` decisions then go to Guardian when configured (it never
 *   approves unconfined commands) and are otherwise denied.
 */
export function automationArgs(kind, target, objective, config) {
    const ralph = target.verifyCmds.length > 0;
    const args = [ralph ? 'ralph' : 'run', objective, '--cwd', target.cwd];
    for (const cmd of target.verifyCmds)
        args.push('--verify-cmd', cmd);
    if (config.role.provider === 'mock')
        args.push('--mock');
    else {
        args.push('--provider', config.role.provider, '--model', config.role.model);
        if (config.role.baseUrl)
            args.push('--base-url', config.role.baseUrl);
        if (config.role.apiKeyEnv)
            args.push('--api-key-env', config.role.apiKeyEnv);
    }
    args.push('--sandbox', config.sandbox);
    if (kind !== 'webhook' && (target.autoApprove || config.autoApprove))
        args.push('--yes');
    if (config.guardianRole)
        args.push('--guardian');
    if (config.projectTrusted && canonicalWorkspace(target.cwd) === config.workspaceRoot)
        args.push('--trust');
    if (config.web)
        args.push('--web');
    if (config.ptc)
        args.push('--ptc');
    if (config.memory)
        args.push('--memory');
    args.push('--max-cost-usd', config.budget.maxCostUsd === undefined ? 'off' : String(config.budget.maxCostUsd));
    return args;
}
/**
 * Constant-time comparison of a presented secret with the expected one, so the
 * response time does not reveal how much of the token matched (the server can
 * be reachable from a tailnet with `hy web --tailscale`).
 */
export function sameSecret(presented, expected) {
    if (typeof presented !== 'string')
        return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
/** Upper bound for a user-assigned chat name. */
export const MAX_CHAT_TITLE_LENGTH = 120;
/**
 * Normalizes a user-assigned chat name: collapses whitespace, trims, and
 * caps the length. An empty value returns null, which clears the override so
 * the automatic title derived from the first message comes back. Pure, so the
 * API handler and its tests share one rule.
 */
export function normalizeChatTitle(raw) {
    const value = raw.replace(/\s+/g, " ").trim();
    return value ? value.slice(0, MAX_CHAT_TITLE_LENGTH) : null;
}
function parseCookies(header) {
    const out = {};
    if (!header)
        return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0)
            continue;
        out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
    return out;
}
function sseWrite(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function sseHeaders(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
}
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += b.length;
        if (size > MAX_BODY_BYTES)
            throw new Error('request body is too large');
        chunks.push(b);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw)
        return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('body must be a JSON object');
    return parsed;
}
function searchWorkspaceFiles(root, query, limit = 50) {
    const needle = query.toLowerCase();
    const out = [];
    let visited = 0;
    const walk = (dir, rel) => {
        if (out.length >= limit || visited > 10_000)
            return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (out.length >= limit || visited > 10_000)
                return;
            if (entry.isSymbolicLink())
                continue;
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (!TREE_SKIP.has(entry.name))
                    walk(path.join(dir, entry.name), childRel);
            }
            else if (entry.isFile()) {
                visited += 1;
                if (childRel.toLowerCase().includes(needle))
                    out.push(childRel);
            }
        }
    };
    walk(root, '');
    return out;
}
function pluginFilesIn(dir) {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && /\.(mjs|js)$/i.test(entry.name))
            .map((entry) => path.join(dir, entry.name))
            .sort();
    }
    catch {
        return [];
    }
}
function pluginCatalog(config) {
    return {
        configured: config.plugins,
        tools: [...(sessionPlugins?.tools.values() ?? [])].map((t) => ({
            name: t.name,
            description: t.spec.description,
            readOnly: t.spec.readOnly,
            plugin: t.plugin,
        })),
        errors: sessionPlugins?.errors ?? [],
        directories: [
            { path: path.join(userConfigDir(), 'plugins'), files: pluginFilesIn(path.join(userConfigDir(), 'plugins')) },
            { path: path.join(config.workspaceRoot, '.hy-harness', 'plugins'), files: pluginFilesIn(path.join(config.workspaceRoot, '.hy-harness', 'plugins')) },
        ],
    };
}
function safeWorkspacePath(root, rel) {
    const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (cleaned.split('/').some((p) => p === '..'))
        throw new Error(`path escapes the workspace: ${rel}`);
    const full = path.resolve(root, cleaned);
    const rootResolved = path.resolve(root);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
        throw new Error(`path escapes the workspace: ${rel}`);
    }
    if (fs.existsSync(full)) {
        const real = fs.realpathSync.native(full);
        const realRoot = fs.realpathSync.native(rootResolved);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
            throw new Error(`path escapes the workspace: ${rel}`);
        }
        return real;
    }
    return full;
}
function roleSummary(role) {
    return {
        provider: role.provider,
        model: role.model,
        ...(role.baseUrl !== undefined ? { baseUrl: role.baseUrl } : {}),
        ...(role.apiKeyEnv !== undefined ? { apiKeyEnv: role.apiKeyEnv } : {}),
        ...(role.effort !== undefined ? { effort: role.effort } : {}),
        contextWindowTokens: role.contextWindowTokens,
        maxOutputTokens: role.maxOutputTokens,
        ...(role.temperature !== undefined ? { temperature: role.temperature } : {}),
        ...(role.pricing !== undefined ? { pricing: role.pricing } : {}),
        nativeTools: role.nativeTools,
    };
}
function configSummary(config) {
    return {
        workspace: config.workspaceRoot,
        roots: config.workspaceRoots.map((root) => ({
            id: root.id,
            path: root.path,
            label: root.label ?? path.basename(root.path),
            writable: root.writable === true,
        })),
        stateDir: config.stateDir,
        sandbox: config.sandbox,
        worker: roleSummary(config.role),
        orchestrator: roleSummary(config.orchestratorRole),
        subagent: roleSummary(config.subagentRole),
        guardian: config.guardianRole ? roleSummary(config.guardianRole) : null,
        grader: roleSummary(config.graderRole),
        compactor: roleSummary(config.compactorRole),
        summarizer: roleSummary(config.summarizerRole),
        guardianApproveBelow: config.guardianApproveBelow,
        maxSteps: config.maxSteps,
        ptc: config.ptc,
        autoApprove: config.autoApprove,
        fullAuto: config.fullAuto,
        trusted: config.projectTrusted,
        limits: config.limits,
        budget: config.budget,
        features: {
            web: config.web !== undefined,
            search: config.web?.searchUrl !== undefined,
            memory: config.memory,
            mcp: Object.keys(config.mcpServers),
            plugins: config.plugins.length,
            lsp: Object.keys(config.lsp),
            guardian: config.guardianRole !== undefined,
        },
        settingsPath: path.join(userConfigDir(), 'config.json'),
    };
}
function sessionSummary(config, events, sessions, uiState, orchestration, deleted = new Set()) {
    const active = orchestration?.active;
    return listRuns(events)
        .filter((run) => !deleted.has(run.runId))
        .map((r) => {
        const live = sessions.get(r.runId);
        const worker = active?.workers.find((w) => w.runId === r.runId);
        const kind = live?.kind ?? (active?.orchestratorRunId === r.runId ? 'orchestrator' : worker ? 'worker' : 'chat');
        return {
            ...r,
            busy: live?.busy === true,
            planMode: live?.planMode === true,
            kind,
            ...(live?.parentRunId ?? worker ? { parentRunId: live?.parentRunId ?? active?.orchestratorRunId } : {}),
            ...(active?.id !== undefined && kind !== 'chat' ? { orchestrationId: active.id } : {}),
            ...(worker ? { workerStatus: worker.status } : {}),
            ...(worker ? { workerTitle: worker.title } : {}),
            pinned: uiState.pinned.includes(r.runId),
            archived: uiState.archived.includes(r.runId),
            // Absent when the user never named the chat: the client then falls
            // back to the automatic title derived from the first message.
            ...(uiState.titles[r.runId] ? { title: uiState.titles[r.runId] } : {}),
            lastError: live?.lastError ?? worker?.lastError,
        };
    })
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last - a.last);
}
function startOfRun(events, runId) {
    const first = events.find((e) => e.runId === runId);
    return first?.ts ?? Date.now();
}
function planModeOf(events, runId) {
    let on = false;
    for (const e of events) {
        if (e.runId !== runId || e.type !== 'plan-mode')
            continue;
        on = e.payload.on === true;
    }
    return on;
}
function runExists(events, runId) {
    return events.some((e) => e.runId === runId && !e.runId.includes('.sub'));
}
function goalOf(events, runId) {
    let goal;
    for (const e of events) {
        if (e.runId !== runId || e.type !== 'goal/set')
            continue;
        const value = e.payload.goal;
        goal = typeof value === 'string' && value.trim() ? value : undefined;
    }
    return goal;
}
function jobsOf(entries) {
    const jobs = new Map();
    for (const entry of entries) {
        if (entry.kind !== 'tool' || !entry.result || typeof entry.result !== 'object')
            continue;
        const result = entry.result;
        if (typeof result.jobId !== 'string')
            continue;
        const args = (entry.args ?? {});
        jobs.set(result.jobId, {
            jobId: result.jobId,
            command: typeof args.command === 'string' ? args.command : entry.name,
            status: typeof result.status === 'string' ? result.status : 'unknown',
            started: entry.ts,
            updated: entry.ts,
        });
    }
    return jobs;
}
function parseImages(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((item) => !!item && typeof item === 'object')
        .filter((item) => typeof item.mimeType === 'string' && item.mimeType.startsWith('image/') && typeof item.data === 'string' && item.data.length > 0)
        .slice(0, 8)
        .map((item) => ({ mimeType: String(item.mimeType), data: String(item.data) }));
}
function sessionState(session) {
    return {
        runId: session.runId,
        kind: session.kind,
        ...(session.parentRunId !== undefined ? { parentRunId: session.parentRunId } : {}),
        ...(session.orchestrationId !== undefined ? { orchestrationId: session.orchestrationId } : {}),
        ...(session.workerStatus !== undefined ? { workerStatus: session.workerStatus } : {}),
        ...(session.workerTitle !== undefined ? { workerTitle: session.workerTitle } : {}),
        busy: session.busy,
        turns: session.conv?.turns ?? session.turns,
        planMode: session.conv?.isPlanMode() ?? session.planMode,
        goal: session.conv?.currentGoal() ?? session.goal ?? null,
        usage: session.conv?.usageSnapshot() ?? session.usage,
        effort: session.conv?.currentEffort() ?? session.effort ?? '',
        model: session.model,
        ...(session.lastError !== undefined ? { lastError: session.lastError } : {}),
    };
}
function broadcast(session, event) {
    const payload = `event: session\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of [...session.subscribers]) {
        try {
            res.write(payload);
        }
        catch {
            session.subscribers.delete(res);
        }
    }
}
function refreshTranscript(session, stateDir) {
    session.entries = projectChat(readEvents(sessionLogPath(stateDir)), session.runId);
}
function markdownExport(session) {
    const lines = [`# HY-HARNESS run ${session.runId}`, ''];
    for (const entry of session.entries) {
        if (entry.kind === 'user')
            lines.push('## You', '', entry.text, '');
        else if (entry.kind === 'assistant')
            lines.push('## HY-HARNESS', '', entry.text, '');
        else if (entry.kind === 'notice')
            lines.push(`> ${entry.text}`, '');
        else if (entry.kind === 'tool') {
            lines.push(`<details><summary>${entry.name}${entry.status === 'error' ? ' (error)' : ''}</summary>`, '', '```', entry.output ?? '', '```', '', '</details>', '');
        }
        else if (entry.kind === 'plan') {
            lines.push('### Plan', '', ...entry.plan.map((p) => `- [${p.status === 'completed' ? 'x' : ' '}] ${p.step}`), '');
        }
    }
    return lines.join('\n');
}
export async function startWebServer(options) {
    const { config, client } = await openClient(options.overrides, options.execServer);
    await startServices(config);
    const logFile = sessionLogPath(config.stateDir);
    const token = options.token ?? randomBytes(24).toString('hex');
    const host = options.host ?? '127.0.0.1';
    const sessions = new Map();
    const deletedRuns = new Set();
    const ralphJobs = new Map();
    const globalSubscribers = new Set();
    const uiStatePath = path.join(config.stateDir, 'ui-state.json');
    let uiState = { pinned: [], archived: [], deleted: [], titles: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(uiStatePath, 'utf8'));
        uiState = {
            pinned: Array.isArray(parsed.pinned) ? parsed.pinned.filter((x) => typeof x === 'string') : [],
            archived: Array.isArray(parsed.archived) ? parsed.archived.filter((x) => typeof x === 'string') : [],
            deleted: Array.isArray(parsed.deleted) ? parsed.deleted.filter((x) => typeof x === 'string') : [],
            titles: parsed.titles && typeof parsed.titles === 'object' && !Array.isArray(parsed.titles)
                ? Object.fromEntries(Object.entries(parsed.titles).filter((entry) => typeof entry[1] === 'string' && entry[1].trim().length > 0))
                : {},
        };
    }
    catch {
        // First launch or an unreadable file: start with no pins/archives.
    }
    for (const id of uiState.deleted.slice(-200))
        deletedRuns.add(id);
    const saveUiState = () => {
        fs.mkdirSync(path.dirname(uiStatePath), { recursive: true });
        const tmp = `${uiStatePath}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(uiState, null, 2)}\n`, 'utf8');
        fs.renameSync(tmp, uiStatePath);
    };
    const orchestrationPath = path.join(config.stateDir, 'orchestration.json');
    let orchestration = loadOrchestrationState(orchestrationPath);
    let orchestratorInbox = [];
    let orchestratorStarting = false;
    let orchestratorTimer;
    const shellQueue = (() => {
        let tail = Promise.resolve();
        return {
            acquire() {
                let release;
                const next = new Promise((resolve) => {
                    release = resolve;
                });
                const wait = tail;
                tail = next;
                return wait.then(() => release);
            },
        };
    })();
    const automationPath = path.join(userConfigDir(), 'automation.json');
    let automation = readAutomationStore(automationPath);
    const automationRuns = new Map();
    const automationChildren = new Map();
    const activeAutomationTargets = new Set();
    const saveAutomation = () => {
        fs.mkdirSync(path.dirname(automationPath), { recursive: true });
        automation.runs = automation.runs.slice(-100);
        const tmp = `${automationPath}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(automation, null, 2)}\n`, 'utf8');
        fs.renameSync(tmp, automationPath);
    };
    const cliMain = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js');
    const startAutomationRun = (kind, target, trigger) => {
        if (activeAutomationTargets.has(target.id))
            throw new Error('this automation target is already running');
        const ralph = target.verifyCmds.length > 0;
        const objective = trigger && typeof trigger === 'object' && typeof trigger.objective === 'string'
            ? String(trigger.objective)
            : target.objective;
        const args = [cliMain, ...automationArgs(kind, target, objective, config)];
        const id = `auto-${randomBytes(5).toString('hex')}`;
        const run = {
            id,
            kind,
            targetId: target.id,
            name: target.name,
            status: 'running',
            output: [],
            started: Date.now(),
        };
        automationRuns.set(id, run);
        activeAutomationTargets.add(target.id);
        target.lastStatus = 'running';
        target.lastRunId = id;
        if (kind === 'webhook')
            target.lastTriggeredAt = Date.now();
        else
            target.lastRunAt = Date.now();
        saveAutomation();
        const child = spawn(process.execPath, args, {
            cwd: target.cwd,
            env: process.env,
            windowsHide: true,
        });
        automationChildren.set(id, child);
        const append = (line) => {
            if (!line.trim())
                return;
            run.output.push(line);
            if (run.output.length > 2000)
                run.output.splice(0, run.output.length - 2000);
            const match = /\[hy\] (?:run|ralph) (run-[a-z0-9]+)/.exec(line);
            if (match?.[1])
                run.runId = match[1];
        };
        for (const stream of [child.stdout, child.stderr]) {
            let buffer = '';
            stream?.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() ?? '';
                for (const line of lines)
                    append(line);
            });
            stream?.on('end', () => {
                if (buffer)
                    append(buffer);
                buffer = '';
            });
        }
        child.on('error', (error) => {
            append(`[automation] ${errorMessage(error)}`);
            run.status = 'failed';
            run.error = errorMessage(error);
            run.ended = Date.now();
            target.lastStatus = 'failed';
            activeAutomationTargets.delete(target.id);
            automationChildren.delete(id);
            saveAutomation();
        });
        child.on('close', (code) => {
            if (run.status === 'running') {
                run.status = code === 0 ? 'succeeded' : 'failed';
                run.ended = Date.now();
                target.lastStatus = run.status;
            }
            activeAutomationTargets.delete(target.id);
            automationChildren.delete(id);
            automation.runs.push({ ...run, output: run.output.slice(-200) });
            saveAutomation();
        });
        return run;
    };
    const tickAutomation = () => {
        if (closing)
            return;
        const now = new Date();
        for (const schedule of automation.schedules) {
            if (!schedule.enabled || activeAutomationTargets.has(schedule.id))
                continue;
            if (!cronMatches(schedule.cron, now))
                continue;
            if (schedule.lastRunAt !== undefined && new Date(schedule.lastRunAt).toDateString() === now.toDateString()) {
                const last = new Date(schedule.lastRunAt);
                if (last.getHours() === now.getHours() && last.getMinutes() === now.getMinutes())
                    continue;
            }
            try {
                startAutomationRun('schedule', schedule);
            }
            catch (error) {
                console.error(`[hy web] schedule ${schedule.id}: ${errorMessage(error)}`);
            }
        }
    };
    const automationTimer = setInterval(tickAutomation, 20_000);
    if (typeof automationTimer.unref === 'function')
        automationTimer.unref();
    let closing = false;
    let sandbox;
    try {
        sandbox = await client.sandboxStatus();
    }
    catch (error) {
        sandbox = { error: errorMessage(error) };
    }
    const startRalphJob = (body) => {
        const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
        const verifyCmds = Array.isArray(body.verifyCmds)
            ? body.verifyCmds.filter((c) => typeof c === 'string' && c.trim().length > 0)
            : typeof body.verifyCmd === 'string' && body.verifyCmd.trim()
                ? [body.verifyCmd.trim()]
                : [];
        if (!objective)
            throw new Error('objective is required');
        if (verifyCmds.length === 0)
            throw new Error('at least one verify command is required');
        const id = `ralph-${randomBytes(5).toString('hex')}`;
        const job = {
            id,
            objective,
            status: 'running',
            output: [],
            started: Date.now(),
        };
        const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js');
        const args = [cli, 'ralph', objective, '--cwd', config.workspaceRoot, '--state-dir', config.stateDir, '--unattended-ok'];
        for (const cmd of verifyCmds)
            args.push('--verify-cmd', cmd);
        if (config.role.provider === 'mock')
            args.push('--mock');
        else {
            args.push('--provider', config.role.provider, '--model', config.role.model);
            if (config.role.baseUrl)
                args.push('--base-url', config.role.baseUrl);
            if (config.role.apiKeyEnv)
                args.push('--api-key-env', config.role.apiKeyEnv);
        }
        args.push('--sandbox', config.sandbox);
        if (config.autoApprove || body.autoApprove === true)
            args.push('--yes');
        if (config.guardianRole || body.guardian === true)
            args.push('--guardian');
        if (config.projectTrusted)
            args.push('--trust');
        if (config.web)
            args.push('--web');
        if (config.ptc)
            args.push('--ptc');
        if (config.memory)
            args.push('--memory');
        const number = (key, fallback) => {
            const raw = body[key];
            const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : fallback;
            return value !== undefined && Number.isFinite(value) ? value : undefined;
        };
        const maxRounds = number('maxRounds');
        const maxTokens = number('maxTotalTokens');
        const maxWall = number('maxWallClockMs');
        const roundTimeout = number('roundTimeoutMs');
        if (maxRounds !== undefined)
            args.push('--max-rounds', String(maxRounds));
        if (maxTokens !== undefined)
            args.push('--max-total-tokens', String(maxTokens));
        if (maxWall !== undefined)
            args.push('--max-wall-clock-ms', String(maxWall));
        if (roundTimeout !== undefined)
            args.push('--round-timeout-ms', String(roundTimeout));
        const maxCost = body.maxCostUsd === 'off' ? 'off' : number('maxCostUsd');
        args.push('--max-cost-usd', maxCost === undefined ? (config.budget.maxCostUsd === undefined ? 'off' : String(config.budget.maxCostUsd)) : String(maxCost));
        if (body.noGrader === true)
            args.push('--no-grader');
        if (body.allowProtectedEdits === true)
            args.push('--allow-protected-edits');
        const child = spawn(process.execPath, args, {
            cwd: config.workspaceRoot,
            env: process.env,
            windowsHide: true,
        });
        job.child = child;
        const append = (line) => {
            if (!line.trim())
                return;
            job.output.push(line);
            if (job.output.length > 2000)
                job.output.splice(0, job.output.length - 2000);
            const run = /\[hy\] ralph (run-[a-z0-9]+):/.exec(line);
            if (run?.[1])
                job.runId = run[1];
        };
        for (const stream of [child.stdout, child.stderr]) {
            let buffer = '';
            stream?.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() ?? '';
                for (const line of lines)
                    append(line);
            });
            stream?.on('end', () => {
                if (buffer)
                    append(buffer);
                buffer = '';
            });
        }
        child.on('error', (error) => {
            append(`[desktop] ${errorMessage(error)}`);
            job.status = 'failed';
            job.ended = Date.now();
        });
        child.on('close', (code) => {
            if (job.status !== 'cancelled')
                job.status = code === 0 ? 'succeeded' : 'failed';
            job.ended = Date.now();
            job.child = undefined;
            broadcastSessions();
        });
        ralphJobs.set(id, job);
        return job;
    };
    const orchestrationView = () => ({
        active: orchestration.active
            ? { ...orchestration.active, workers: orchestration.active.workers.map((worker) => workerCard(worker)) }
            : null,
    });
    const broadcastOrchestration = () => {
        const payload = { type: 'orchestration', orchestration: orchestrationView() };
        for (const res of [...globalSubscribers]) {
            try {
                sseWrite(res, 'orchestration', payload);
            }
            catch {
                globalSubscribers.delete(res);
            }
        }
    };
    const persistOrchestration = () => {
        saveOrchestrationState(orchestrationPath, orchestration);
        broadcastOrchestration();
    };
    const dropRunFromLog = (runId) => {
        const kept = readEvents(logFile).filter((event) => event.runId !== runId && !event.runId?.startsWith(`${runId}.sub`));
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, kept.length > 0 ? `${kept.map((event) => JSON.stringify(event)).join('\n')}\n` : '', 'utf8');
    };
    /**
     * Deleting a running chat aborts its turn, but the agent can still append a
     * final event after the first rewrite. Keep the run tombstoned and rewrite
     * once the turn has actually stopped, so it cannot reappear in the sidebar.
     */
    const cleanUpDeletedRun = (runId, session) => {
        let attempts = 0;
        const tick = () => {
            if (session.busy && attempts < 120) {
                attempts += 1;
                setTimeout(tick, 250);
                return;
            }
            try {
                dropRunFromLog(runId);
            }
            catch (error) {
                console.error(`[hy] deleting run log failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            broadcastSessions();
        };
        setTimeout(tick, 250);
    };
    const rootById = (id) => config.workspaceRoots.find((root) => root.id === id) ?? config.workspaceRoots[0];
    const qualifyRootPath = (id, rel) => (id === 'main' ? rel : `${id}:${rel}`);
    const broadcastSessions = () => {
        const payload = { type: 'sessions', sessions: sessionSummary(config, readEvents(logFile), sessions, uiState, orchestration, deletedRuns) };
        for (const res of [...globalSubscribers]) {
            try {
                sseWrite(res, 'sessions', payload);
            }
            catch {
                globalSubscribers.delete(res);
            }
        }
    };
    const kindOfRun = (runId) => {
        const active = orchestration.active?.status === 'active' ? orchestration.active : undefined;
        if (active?.orchestratorRunId === runId)
            return 'orchestrator';
        return active?.workers.some((w) => w.runId === runId) ? 'worker' : 'chat';
    };
    const workerOfRun = (runId) => orchestration.active?.status === 'active' ? orchestration.active.workers.find((w) => w.runId === runId) : undefined;
    const modelForKind = (kind) => {
        const role = kind === 'orchestrator' ? config.orchestratorRole : config.role;
        return { provider: role.provider, model: role.model };
    };
    const ensureSession = (runId) => {
        if (deletedRuns.has(runId))
            return undefined;
        const existing = sessions.get(runId);
        if (existing)
            return existing;
        const events = readEvents(logFile);
        if (!runExists(events, runId))
            return undefined;
        const entries = projectChat(events, runId);
        const worker = workerOfRun(runId);
        const kind = kindOfRun(runId);
        const session = {
            runId,
            kind,
            ...(worker && orchestration.active ? { parentRunId: orchestration.active.orchestratorRunId } : {}),
            ...(worker && orchestration.active ? { orchestrationId: orchestration.active.id } : {}),
            ...(worker ? { workerStatus: worker.status, workerTitle: worker.title } : {}),
            busy: false,
            entries,
            subscribers: new Set(),
            pendingApprovals: new Map(),
            pendingQuestions: new Map(),
            planMode: kind === 'orchestrator' ? true : planModeOf(events, runId),
            model: modelForKind(kind),
            goal: goalOf(events, runId),
            turns: events.filter((e) => e.runId === runId && (e.type === 'turn/start' || e.type === 'round/start')).length -
                events.filter((e) => e.runId === runId && e.type === 'turn/undo').length,
            usage: usageOf(events, runId),
            jobs: jobsOf(entries),
            pinned: uiState.pinned.includes(runId),
            archived: uiState.archived.includes(runId),
            createdAt: startOfRun(events, runId),
            updatedAt: Date.now(),
        };
        sessions.set(runId, session);
        return session;
    };
    const newSession = (kind = 'chat', meta) => {
        const runId = newRunId();
        const session = {
            runId,
            kind,
            ...(meta?.parentRunId !== undefined ? { parentRunId: meta.parentRunId } : {}),
            ...(meta?.orchestrationId !== undefined ? { orchestrationId: meta.orchestrationId } : {}),
            busy: false,
            entries: [],
            subscribers: new Set(),
            pendingApprovals: new Map(),
            pendingQuestions: new Map(),
            planMode: kind === 'orchestrator',
            turns: 0,
            model: modelForKind(kind),
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                cacheHitTokens: 0,
                cacheMissTokens: 0,
                lastInputTokens: 0,
                lastOutputTokens: 0,
                lastCacheHitTokens: 0,
                lastCacheMissTokens: 0,
            },
            jobs: new Map(),
            pinned: false,
            archived: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        sessions.set(runId, session);
        try {
            // Persist the empty chat immediately so it appears in the session list
            // before the first answer and survives a restart.
            const log = new SessionLog(sessionLogPath(config.stateDir));
            log.setRun(runId);
            log.append('session/start', { createdAt: session.createdAt, kind });
        }
        catch {
            // The in-memory session still works when the state directory is read-only.
        }
        broadcastSessions();
        return session;
    };
    const ensureConversation = (session) => {
        if (session.conv)
            return session.conv;
        const options = conversationOptions(session);
        session.conv = Conversation.create(config, client, session.runId, false, (request) => requestApproval(session, request), session.kind === 'worker' ? undefined : (question) => requestQuestion(session, question), (event) => onAgentEvent(session, event), options);
        session.turns = session.conv.turns;
        session.planMode = session.conv.isPlanMode();
        session.goal = session.conv.currentGoal();
        session.model = session.conv.currentModel();
        return session.conv;
    };
    const promptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
    const promptText = (name, fallback) => {
        try {
            return fs.readFileSync(path.join(promptDir, name), 'utf8').trim();
        }
        catch {
            return fallback;
        }
    };
    const orchestratorPrompt = () => promptText('orchestrator.md', 'You are the orchestrator. Stay in plan mode, never edit files, and manage worker sessions with the orchestrator tools.');
    const workerPrompt = (record) => {
        const base = promptText('worker.md', 'You are a worker managed by an orchestrator. Work only inside your assigned scope.');
        return `${base}\n\nAssigned title: ${record?.title ?? '(unknown)'}\nAssigned scope: ${record?.scope.join(', ') ?? '(unknown)'}\nThis is a shared workspace. The host refuses git and creates/owns checkpoints; do not try to work around those restrictions.`;
    };
    function pluginTool(name, description, input, readOnly, run) {
        return [
            name,
            {
                name,
                description,
                input,
                readOnly,
                run,
                spec: { name, wire: true, readOnly, description, input, output: {} },
                plugin: 'orchestration',
            },
        ];
    }
    const object = (properties, required = []) => ({
        type: 'object',
        properties,
        required,
    });
    function orchestrationTooling() {
        const plugins = new Map();
        const add = (name, description, input, readOnly, run) => {
            const [key, tool] = pluginTool(name, description, input, readOnly, run);
            plugins.set(key, tool);
        };
        add('orchestrator_spawn', 'Create an ordinary worker session for a runnable task. Start work as soon as the task is clear; do not wait for plan approval. Scope is one or more disjoint repository-relative directories. The worker may write only below them. The host rejects overlapping scopes and too many workers.', object({
            title: { type: 'string', description: 'Short task title.' },
            task: { type: 'string', description: 'Self-contained task, including acceptance checks and verification.' },
            scope: {
                type: 'array',
                items: { type: 'string' },
                description: 'Repository-relative directories the worker may edit. Never . or **.',
            },
        }, ['title', 'task', 'scope']), false, async (args) => spawnWorker(String(args.title ?? ''), String(args.task ?? ''), Array.isArray(args.scope) ? args.scope.map(String) : []));
        add('orchestrator_send', 'Send a correction or follow-up to an existing worker. The worker keeps its scope. Do not use this to start a second worker in the same scope.', object({
            workerId: { type: 'string' },
            message: { type: 'string', description: 'Concrete change, evidence needed, or decision.' },
        }, ['workerId', 'message']), false, async (args) => sendWorker(String(args.workerId ?? ''), String(args.message ?? '')));
        add('orchestrator_workers', 'List the active workers, their scopes, status, last event and last report.', object({}), true, async () => ({
            workers: orchestration.active?.workers.map(workerCard) ?? [],
            maxWorkers: orchestration.active?.maxWorkers ?? 0,
        }));
        add('orchestrator_diff', 'Read the current git status and diff for one worker scope, plus changes outside every active scope.', object({
            workerId: { type: 'string' },
            maxBytes: { type: 'integer', minimum: 1024 },
        }, ['workerId']), true, async (args) => workerDiff(String(args.workerId ?? ''), typeof args.maxBytes === 'number' ? args.maxBytes : undefined));
        add('orchestrator_stop', 'Stop a worker turn. Its scope stays reserved until you close it, so partial changes cannot collide with new work.', object({ workerId: { type: 'string' }, reason: { type: 'string' } }, ['workerId']), false, async (args) => stopWorker(String(args.workerId ?? ''), typeof args.reason === 'string' ? args.reason : undefined));
        add('orchestrator_approve', 'Approve or deny a worker command after asking the user when needed. This resolves that worker approval request.', object({
            workerId: { type: 'string' },
            requestId: { type: 'string' },
            approved: { type: 'boolean' },
            reason: { type: 'string' },
        }, ['workerId', 'requestId', 'approved']), false, async (args) => approveWorker(String(args.workerId ?? ''), String(args.requestId ?? ''), args.approved === true, typeof args.reason === 'string' ? args.reason : undefined));
        add('orchestrator_close', 'Close a reviewed worker, mark it done and release its scope. Stop a running worker first; this records its final summary.', object({ workerId: { type: 'string' }, summary: { type: 'string' } }, ['workerId']), false, async (args) => closeWorker(String(args.workerId ?? ''), typeof args.summary === 'string' ? args.summary : undefined));
        const specs = [...plugins.values()].map((tool) => tool.spec);
        return { plugins, specs, allowed: new Set(plugins.keys()) };
    }
    function conversationOptions(session) {
        if (session.kind === 'orchestrator') {
            return {
                roleInstruction: orchestratorPrompt(),
                role: config.orchestratorRole,
                planOnly: true,
                initialPlanMode: true,
                checkpoints: false,
                delegate: false,
                tooling: orchestrationTooling(),
            };
        }
        if (session.kind === 'worker') {
            const record = workerOfRun(session.runId) ?? orchestration.active?.workers.find((w) => w.runId === session.runId);
            return {
                roleInstruction: workerPrompt(record),
                checkpoints: false,
                delegate: true,
                ...(record ? { writeScope: record.scope } : {}),
                shellGuard: (command) => {
                    if (/(^|[\s;&|()])git(?:\s|$)/i.test(command)) {
                        throw new Error('workers must not run git; the orchestrator owns repository state and reviews the diff');
                    }
                    if (/(^|[\s;&|()])hy\s+(?:undo|checkpoint|sandbox|ralph|run|resume|review)\b/i.test(command)) {
                        throw new Error('workers must not run harness state-changing commands');
                    }
                },
                shellLock: shellQueue,
                noBackgroundShell: true,
                minForegroundWaitMs: 10 * 60_000,
                shellTimeoutMs: 10 * 60_000,
            };
        }
        return session.planMode ? { initialPlanMode: true } : {};
    }
    const requestApproval = (session, request) => {
        const requestId = `apr-${randomBytes(6).toString('hex')}`;
        session.entries.push({ id: `approval-${requestId}`, kind: 'approval', runId: session.runId, requestId, request, ts: Date.now() });
        broadcast(session, { type: 'approval/request', requestId, request });
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                session.pendingApprovals.delete(requestId);
                session.entries.push({ id: `approval-timeout-${requestId}`, kind: 'notice', runId: session.runId, text: `approval timed out: ${request.command}`, ts: Date.now(), level: 'warn' });
                broadcast(session, { type: 'approval/timeout', requestId });
                resolve(false);
            }, 5 * 60_000);
            session.pendingApprovals.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, timer, request });
            if (session.kind === 'worker') {
                const record = workerOfRun(session.runId);
                if (record)
                    onWorkerApproval(record, requestId, request);
            }
        });
    };
    const requestQuestion = (session, question) => {
        const requestId = `ask-${randomBytes(6).toString('hex')}`;
        session.entries.push({ id: `question-${requestId}`, kind: 'question', runId: session.runId, requestId, question, ts: Date.now() });
        broadcast(session, { type: 'question/request', requestId, question });
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                session.pendingQuestions.delete(requestId);
                broadcast(session, { type: 'question/timeout', requestId });
                resolve('');
            }, 10 * 60_000);
            session.pendingQuestions.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, timer });
        });
    };
    const onAgentEvent = (session, event) => {
        if (session.kind === 'worker') {
            const record = workerOfRun(session.runId);
            if (record)
                onWorkerEvent(record);
        }
        // A subagent's internal stream belongs to its own transcript, not the parent.
        if (typeof event.subagent === 'string') {
            broadcast(session, { type: 'subagent/event', subagent: event.subagent, event });
            return;
        }
        let instantSummary;
        if (event.type === 'thinking' && typeof event.seq === 'number') {
            const seq = Number(event.seq);
            const text = String(event.content ?? '').trim();
            if (text) {
                instantSummary = instantThinkingSummary(text) || undefined;
                void summarizeThinking(config, text, session.runId)
                    .then((summary) => {
                    const entry = session.entries.find((candidate) => candidate.id === `think-${seq}`);
                    if (entry?.kind !== 'thinking')
                        return;
                    entry.summary = summary;
                    entry.summaryProvisional = false;
                    session.conv?.log.append('thinking/summary', { thinkingSeq: seq, summary });
                    session.updatedAt = Date.now();
                    broadcast(session, { type: 'thinking/summary', entryId: entry.id, summary });
                })
                    .catch((error) => {
                    // A missing or broken summarizer must not break the worker turn.
                    console.error(`[hy] thinking summary failed: ${error instanceof Error ? error.message : String(error)}`);
                });
            }
        }
        if (event.type === 'tool') {
            const result = event.result;
            if (result && typeof result === 'object' && typeof result.jobId === 'string') {
                const args = (event.args ?? {});
                const jobId = String(result.jobId);
                session.jobs.set(jobId, {
                    jobId,
                    command: typeof args.command === 'string' ? args.command : String(event.name ?? 'shell'),
                    status: typeof result.status === 'string' ? String(result.status) : 'unknown',
                    started: Date.now(),
                    updated: Date.now(),
                });
            }
        }
        applyAgentEvent(session.entries, session.runId, event);
        session.updatedAt = Date.now();
        broadcast(session, { type: 'agent', event });
        if (instantSummary) {
            const entry = session.entries.find((candidate) => candidate.id === `think-${event.seq}`);
            if (entry?.kind === 'thinking') {
                broadcast(session, { type: 'thinking/summary', entryId: entry.id, summary: entry.summary ?? instantSummary, provisional: true });
            }
        }
        if (event.type === 'step-end' || event.type === 'final')
            broadcast(session, { type: 'state', state: sessionState(session) });
    };
    const resolvePending = (session) => {
        for (const [id, pending] of session.pendingApprovals) {
            clearTimeout(pending.timer);
            pending.resolve(false);
            session.pendingApprovals.delete(id);
            broadcast(session, { type: 'approval/decision', requestId: id, approved: false, reason: 'run cancelled' });
        }
        for (const [id, pending] of session.pendingQuestions) {
            clearTimeout(pending.timer);
            pending.resolve('');
            session.pendingQuestions.delete(id);
            broadcast(session, { type: 'question/answer', requestId: id, answer: '' });
        }
    };
    const workerInbox = new Map();
    function activeOrchestration() {
        return orchestration.active?.status === 'active' ? orchestration.active : undefined;
    }
    function orchestratorSession() {
        const active = activeOrchestration();
        return active ? ensureSession(active.orchestratorRunId) : undefined;
    }
    function workerCard(record) {
        return {
            workerId: record.runId,
            title: record.title,
            task: record.task,
            scope: record.scope,
            status: record.status,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            lastEventAt: record.lastEventAt,
            lastSummary: record.lastSummary ?? null,
            lastError: record.lastError ?? null,
            closedAt: record.closedAt ?? null,
        };
    }
    function updateWorker(record, patch) {
        // A new run/successful turn must not keep showing the previous failure.
        const next = patch.status !== undefined && ['running', 'queued', 'waiting', 'done'].includes(patch.status)
            ? { ...patch, lastError: undefined }
            : patch;
        Object.assign(record, next, { updatedAt: Date.now() });
        const session = sessions.get(record.runId);
        if (session) {
            session.workerStatus = record.status;
            session.workerTitle = record.title;
            session.updatedAt = Date.now();
            broadcast(session, { type: 'state', state: sessionState(session) });
        }
        if (orchestration.active)
            orchestration.active.updatedAt = Date.now();
        persistOrchestration();
        broadcastSessions();
    }
    function workerForId(workerId) {
        const record = activeOrchestration()?.workers.find((w) => w.runId === workerId);
        if (!record)
            throw new Error(`unknown worker ${workerId}`);
        return record;
    }
    function workerTaskMessage(record) {
        return [
            record.task,
            '',
            '[orchestrator assignment]',
            `Title: ${record.title}`,
            `Worker: ${record.runId}`,
            `Scope: ${record.scope.join(', ')}`,
            'The workspace is shared with other workers. Edit only inside the scope above.',
            'Do not run git, undo, checkpoint, branch, merge, rebase, stash or worktree commands.',
            'The host serializes shell commands; keep them in the foreground.',
            'You may use delegate subagents. They inherit your scope and restrictions.',
            'Report what changed, the exact verification you ran, and anything left undone. Do not ask the user directly.',
        ].join('\n');
    }
    function workerReportMessage(record, outcome, text) {
        const status = outcome === 'completed' ? 'waiting for review' : outcome === 'aborted' ? 'stopped' : 'failed';
        return [
            '[worker report]',
            `worker: ${record.title} (${record.runId})`,
            `status: ${status}`,
            `scope: ${record.scope.join(', ')}`,
            outcome === 'completed' ? `report:\n${text.slice(0, 8000)}` : `error:\n${text.slice(0, 4000)}`,
            'Review with orchestrator_diff before accepting or closing this worker.',
        ].join('\n');
    }
    function queueOrchestratorNotice(text) {
        if (!activeOrchestration())
            return;
        orchestratorInbox.push(text);
        if (orchestratorInbox.length > 20)
            orchestratorInbox = orchestratorInbox.slice(-20);
        flushOrchestratorInbox();
    }
    function flushOrchestratorInbox() {
        if (orchestratorStarting || orchestratorInbox.length === 0)
            return;
        const active = activeOrchestration();
        if (!active) {
            orchestratorInbox = [];
            return;
        }
        const session = ensureSession(active.orchestratorRunId);
        if (!session) {
            orchestratorInbox = [];
            return;
        }
        if (session.busy)
            return;
        const text = orchestratorInbox.splice(0).join('\n\n').slice(0, 16_000);
        orchestratorStarting = true;
        void runTurn(session, text, [], { synthetic: true, source: 'worker', from: 'orchestrator' })
            .catch((error) => {
            session.lastError = errorMessage(error);
        })
            .finally(() => {
            orchestratorStarting = false;
            if (orchestratorInbox.length > 0)
                setTimeout(() => flushOrchestratorInbox(), 0);
        });
    }
    function onTurnFinished(session, outcome, text) {
        if (session.kind !== 'worker')
            return;
        if (orchestration.active?.status !== 'active')
            return;
        const record = workerOfRun(session.runId);
        if (!record || record.status === 'done')
            return;
        const status = outcome === 'completed' ? 'waiting' : outcome === 'aborted' ? 'stopped' : 'failed';
        updateWorker(record, {
            status,
            lastEventAt: Date.now(),
            ...(outcome === 'completed' ? { lastSummary: text.slice(0, 8_000) } : { lastError: text.slice(0, 4_000) }),
        });
        queueOrchestratorNotice(workerReportMessage(record, outcome, text));
        if (outcome === 'completed') {
            const queued = workerInbox.get(record.runId)?.shift();
            if (queued) {
                const worker = ensureSession(record.runId);
                if (worker && !worker.busy)
                    setTimeout(() => void runTurn(worker, queued, [], { synthetic: true, source: 'orchestrator', from: 'orchestrator' }), 0);
            }
        }
    }
    async function startOrchestration() {
        if (orchestration.active?.status === 'active')
            return orchestration.active;
        const previous = orchestration.active;
        if (previous) {
            const previousIds = [previous.orchestratorRunId, ...previous.workers.map((worker) => worker.runId)];
            uiState.archived = [...new Set([...uiState.archived, ...previousIds])];
            saveUiState();
            for (const id of previousIds) {
                const old = sessions.get(id);
                if (old) {
                    old.kind = 'chat';
                    old.workerStatus = undefined;
                    old.workerTitle = undefined;
                }
            }
        }
        const session = newSession('orchestrator');
        const now = Date.now();
        const record = {
            id: `orc-${randomBytes(6).toString('hex')}`,
            orchestratorRunId: session.runId,
            status: 'active',
            createdAt: now,
            updatedAt: now,
            maxWorkers: DEFAULT_MAX_WORKERS,
            workers: [],
        };
        session.orchestrationId = record.id;
        orchestration = { version: 1, active: record };
        persistOrchestration();
        broadcastSessions();
        return record;
    }
    async function stopOrchestration() {
        const active = orchestration.active;
        if (!active)
            return null;
        const stoppedIds = [active.orchestratorRunId, ...active.workers.map((worker) => worker.runId)];
        const orchestrator = sessions.get(active.orchestratorRunId);
        orchestrator?.controller?.abort();
        for (const worker of active.workers) {
            if (worker.status === 'running' || worker.status === 'queued' || worker.status === 'blocked') {
                const session = sessions.get(worker.runId);
                session?.controller?.abort();
                worker.status = 'stopped';
                worker.updatedAt = Date.now();
                if (session) {
                    session.workerStatus = 'stopped';
                    broadcast(session, { type: 'state', state: sessionState(session) });
                }
            }
        }
        active.status = 'stopped';
        active.updatedAt = Date.now();
        orchestratorInbox = [];
        // Closing the orchestration also closes its chats: archive them and turn
        // the old orchestrator session back into an ordinary, non-plan-only chat.
        uiState.archived = [...new Set([...uiState.archived, ...stoppedIds])];
        saveUiState();
        for (const id of stoppedIds) {
            const session = sessions.get(id);
            if (!session)
                continue;
            session.kind = 'chat';
            session.workerStatus = undefined;
            session.workerTitle = undefined;
            session.planMode = false;
            session.model = modelForKind('chat');
            session.effort = config.role.effort;
            delete session.conv;
            broadcast(session, { type: 'state', state: sessionState(session) });
        }
        persistOrchestration();
        broadcastSessions();
        return active;
    }
    async function spawnWorker(title, task, rawScope) {
        const active = activeOrchestration();
        if (!active)
            throw new Error('orchestration is not active');
        const cleanTitle = title.trim();
        const cleanTask = task.trim();
        if (!cleanTitle)
            throw new Error('title is required');
        if (!cleanTask)
            throw new Error('task is required');
        const scope = normalizeScopes(rawScope);
        if (!canSpawnWorker(active)) {
            throw new Error(`worker limit reached (${active.maxWorkers}); close a finished worker first`);
        }
        for (const owner of scopeOwners(active)) {
            for (const next of scope) {
                for (const current of owner.scope) {
                    if (scopesOverlap(next, current)) {
                        throw new Error(`scope ${next} overlaps ${current} owned by ${owner.title} (${owner.runId}); use one worker or sequence the tasks`);
                    }
                }
            }
        }
        const session = newSession('worker', { parentRunId: active.orchestratorRunId, orchestrationId: active.id });
        const now = Date.now();
        const record = {
            runId: session.runId,
            title: cleanTitle,
            task: cleanTask,
            scope,
            status: 'queued',
            createdAt: now,
            updatedAt: now,
            lastEventAt: now,
        };
        session.workerTitle = cleanTitle;
        session.workerStatus = 'queued';
        active.workers.push(record);
        updateWorker(record, { status: 'queued' });
        const message = workerTaskMessage(record);
        setTimeout(() => {
            const worker = ensureSession(record.runId);
            if (!worker)
                return;
            updateWorker(record, { status: 'running' });
            void runTurn(worker, message, [], { synthetic: true, source: 'orchestrator', from: 'orchestrator' }).catch((error) => {
                updateWorker(record, { status: 'failed', lastError: errorMessage(error) });
                queueOrchestratorNotice(workerReportMessage(record, 'error', errorMessage(error)));
            });
        }, 0);
        return workerCard(record);
    }
    async function sendWorker(workerId, message) {
        const record = workerForId(workerId);
        const text = message.trim();
        if (!text)
            throw new Error('message is required');
        if (record.status === 'done')
            throw new Error('worker is closed');
        const worker = ensureSession(workerId);
        if (!worker)
            throw new Error(`worker session not found: ${workerId}`);
        if (worker.busy) {
            const inbox = workerInbox.get(workerId) ?? [];
            inbox.push(text);
            workerInbox.set(workerId, inbox);
            updateWorker(record, { lastEventAt: Date.now() });
            return { workerId, queued: true, message: 'The worker is running; the message will be delivered after its current turn.' };
        }
        updateWorker(record, { status: 'running', lastEventAt: Date.now() });
        void runTurn(worker, text, [], { synthetic: true, source: 'orchestrator', from: 'orchestrator' }).catch((error) => {
            updateWorker(record, { status: 'failed', lastError: errorMessage(error) });
            queueOrchestratorNotice(workerReportMessage(record, 'error', errorMessage(error)));
        });
        return { workerId, queued: false };
    }
    async function stopWorker(workerId, reason) {
        const record = workerForId(workerId);
        const worker = sessions.get(workerId);
        worker?.controller?.abort();
        updateWorker(record, {
            status: 'stopped',
            ...(reason !== undefined ? { lastError: reason } : {}),
        });
        return workerCard(record);
    }
    async function closeWorker(workerId, summary) {
        const record = workerForId(workerId);
        sessions.get(workerId)?.controller?.abort();
        workerInbox.delete(workerId);
        updateWorker(record, {
            status: 'done',
            closedAt: Date.now(),
            ...(summary?.trim() ? { lastSummary: summary.trim().slice(0, 8_000) } : {}),
        });
        return workerCard(record);
    }
    /**
     * Resolves a worker's approval request. The orchestrator may approve only
     * requests that would run confined; the user may approve any (from the
     * worker's chat in the GUI).
     */
    async function approveWorker(workerId, requestId, approved, reason, by = 'orchestrator') {
        const record = workerForId(workerId);
        const worker = sessions.get(workerId);
        if (!worker)
            throw new Error(`worker session not found: ${workerId}`);
        const pending = worker.pendingApprovals.get(requestId);
        if (!pending)
            throw new Error(`no pending approval ${requestId} for ${workerId}`);
        if (approved && by === 'orchestrator' && userOnlyApproval(pending.request)) {
            throw new Error(`request ${requestId} would run ${pending.request?.sandbox ?? 'unconfined'}; only the user can approve it. ` +
                'Ask the user to approve or deny it in the worker chat, or deny it.');
        }
        clearTimeout(pending.timer);
        worker.pendingApprovals.delete(requestId);
        pending.resolve(approved);
        const entry = worker.entries.find((e) => e.kind === 'approval' && e.requestId === requestId);
        if (entry?.kind === 'approval')
            entry.decision = approved ? 'approved' : 'denied';
        worker.entries.push({
            id: `approval-decision-${requestId}`,
            kind: 'notice',
            runId: workerId,
            text: `${approved ? 'approved' : 'denied'} by ${by}${reason ? `: ${reason}` : ''}`,
            ts: Date.now(),
            level: approved ? 'info' : 'warn',
        });
        broadcast(worker, { type: 'approval/decision', requestId, approved, reason: reason ?? by });
        updateWorker(record, { status: 'running', lastEventAt: Date.now() });
        return { workerId, requestId, approved };
    }
    async function workerDiff(workerId, maxBytes = 64 * 1024) {
        const record = workerForId(workerId);
        const status = spawnSync('git', ['status', '--porcelain'], { cwd: config.workspaceRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
        const diff = spawnSync('git', ['diff', '--no-ext-diff', '--', ...record.scope], { cwd: config.workspaceRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
        const changed = [];
        const outside = [];
        if (!status.error) {
            for (const line of (status.stdout ?? '').split(/\r?\n/)) {
                if (line.length < 4)
                    continue;
                const pathText = line.slice(3).trim();
                const paths = pathText.includes(' -> ') ? pathText.split(' -> ') : [pathText];
                for (const p of paths) {
                    const normalized = p.replace(/\\/g, '/').replace(/^"|"$/g, '');
                    if (workerOwnsScope(record, normalized))
                        changed.push(normalized);
                    else if (!(activeOrchestration()?.workers ?? []).some((w) => workerOwnsScope(w, normalized)))
                        outside.push(normalized);
                }
            }
        }
        const body = diff.error ? `git diff failed: ${diff.error.message}` : diff.stdout ?? '';
        return {
            workerId,
            title: record.title,
            scope: record.scope,
            status: record.status,
            changed,
            outOfScope: outside,
            diff: body.slice(0, Math.max(1024, Math.min(maxBytes, 256 * 1024))),
            truncated: body.length > maxBytes,
        };
    }
    function onWorkerEvent(record) {
        record.lastEventAt = Date.now();
        if (record.status === 'queued')
            record.status = 'running';
        const session = sessions.get(record.runId);
        if (session)
            session.workerStatus = record.status;
    }
    function onWorkerApproval(record, requestId, request) {
        updateWorker(record, { status: 'blocked', lastEventAt: Date.now() });
        queueOrchestratorNotice([
            '[worker approval request]',
            `worker: ${record.title} (${record.runId})`,
            `requestId: ${requestId}`,
            `command: ${request.command}`,
            ...(request.justification ? [`justification: ${request.justification}`] : []),
            userOnlyApproval(request)
                ? `This would run ${request.sandbox}: only the user can approve it (in the worker chat). You may deny it with orchestrator_approve.`
                : 'Ask the user if needed, then call orchestrator_approve.',
        ].join('\n'));
    }
    function heartbeatCheck() {
        const active = activeOrchestration();
        if (!active)
            return;
        const now = Date.now();
        for (const worker of active.workers) {
            if (worker.status !== 'running')
                continue;
            if (now - worker.lastEventAt < 5 * 60_000)
                continue;
            if (worker.lastHeartbeatAt !== undefined && now - worker.lastHeartbeatAt < 5 * 60_000)
                continue;
            worker.lastHeartbeatAt = now;
            queueOrchestratorNotice([
                '[worker heartbeat]',
                `worker: ${worker.title} (${worker.runId})`,
                `status: running`,
                `last event: ${Math.round((now - worker.lastEventAt) / 60_000)} minute(s) ago`,
                `scope: ${worker.scope.join(', ')}`,
                'Check for a stall with orchestrator_workers; do not claim completion from this heartbeat.',
            ].join('\n'));
        }
        persistOrchestration();
    }
    async function runTurn(session, message, images, options = {}) {
        if (session.kind === 'worker' && options.from !== 'orchestrator') {
            throw new Error('worker chats are read-only; send instructions through the orchestrator');
        }
        const conv = ensureConversation(session);
        if (session.busy)
            throw new Error('this session is already running');
        const controller = new AbortController();
        session.controller = controller;
        session.busy = true;
        session.lastError = undefined;
        const turn = conv.turns + 1;
        session.turns = turn;
        if (options.synthetic) {
            const entry = { id: `event-${Date.now()}`, kind: 'notice', runId: session.runId, text: message, ts: Date.now() };
            session.entries.push(entry);
            broadcast(session, { type: 'entry', entry });
        }
        else {
            const entry = { id: `user-${Date.now()}`, kind: 'user', runId: session.runId, text: message, ts: Date.now(), ...(images.length > 0 ? { images: images.length } : {}) };
            session.entries.push(entry);
            broadcast(session, { type: 'entry', entry });
        }
        broadcast(session, { type: 'turn/start', turn });
        broadcast(session, { type: 'state', state: sessionState(session) });
        broadcastSessions();
        let final = '';
        try {
            final = await conv.turn(message, images, controller.signal, options.source ? { source: options.source } : undefined);
            session.planMode = conv.isPlanMode();
            broadcast(session, { type: 'turn/end', outcome: 'completed', final });
            onTurnFinished(session, 'completed', final);
        }
        catch (error) {
            const aborted = controller.signal.aborted;
            const text = aborted ? 'run cancelled' : errorMessage(error);
            session.lastError = text;
            broadcast(session, { type: 'turn/end', outcome: aborted ? 'aborted' : 'error', error: text });
            onTurnFinished(session, aborted ? 'aborted' : 'error', text);
        }
        finally {
            resolvePending(session);
            session.busy = false;
            session.controller = undefined;
            session.turns = conv.turns;
            session.planMode = conv.isPlanMode();
            session.updatedAt = Date.now();
            broadcast(session, { type: 'state', state: sessionState(session) });
            broadcastSessions();
            if (session.kind === 'orchestrator') {
                setTimeout(() => flushOrchestratorInbox(), 0);
            }
        }
    }
    const validateTarget = (body, existing) => {
        const cwd = path.resolve(typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd : existing?.cwd ?? config.workspaceRoot);
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
            throw new Error(`workspace does not exist: ${cwd}`);
        const objective = typeof body.objective === 'string' ? body.objective.trim() : existing?.objective ?? '';
        if (!objective)
            throw new Error('objective is required');
        const cron = typeof body.cron === 'string' ? body.cron.trim() : existing && 'cron' in existing ? existing.cron : '';
        if (cron && !parseCron(cron))
            throw new Error(`invalid cron expression: ${cron}`);
        const rawCmds = Array.isArray(body.verifyCmds)
            ? body.verifyCmds
            : typeof body.verifyCmd === 'string'
                ? [body.verifyCmd]
                : existing?.verifyCmds ?? [];
        const verifyCmds = rawCmds.filter((c) => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim());
        return {
            name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing?.name ?? 'Automation',
            cwd,
            objective,
            cron,
            verifyCmds,
            autoApprove: typeof body.autoApprove === 'boolean' ? body.autoApprove : existing?.autoApprove ?? false,
            enabled: typeof body.enabled === 'boolean' ? body.enabled : existing?.enabled ?? true,
        };
    };
    /**
     * Settings → Models/Effort and the other runtime options apply without
     * restarting the server or the exec client. The sandbox is fixed when the
     * exec client starts, so only that change still requires a restart.
     */
    const applyRuntimeSettings = async () => {
        try {
            const fresh = loadConfig(options.overrides);
            const sandboxPending = fresh.sandbox !== config.sandbox;
            config.role = fresh.role;
            config.graderRole = fresh.graderRole;
            config.orchestratorRole = fresh.orchestratorRole;
            config.subagentRole = fresh.subagentRole;
            if (fresh.guardianRole === undefined)
                delete config.guardianRole;
            else
                config.guardianRole = fresh.guardianRole;
            config.compactorRole = fresh.compactorRole;
            config.summarizerRole = fresh.summarizerRole;
            config.guardianApproveBelow = fresh.guardianApproveBelow;
            config.maxSteps = fresh.maxSteps;
            config.autoApprove = fresh.autoApprove;
            config.fullAuto = fresh.fullAuto;
            config.ptc = fresh.ptc;
            config.mcpServers = fresh.mcpServers;
            config.hooks = fresh.hooks;
            config.plugins = fresh.plugins;
            config.memory = fresh.memory;
            if (fresh.web === undefined)
                delete config.web;
            else
                config.web = fresh.web;
            try {
                // Reuse the existing plugin/MCP managers; they compare the new keys
                // and only restart what actually changed.
                await startServices(config);
            }
            catch (error) {
                console.error(`[hy] settings services reload failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            for (const session of sessions.values()) {
                // An idle conversation rebuilds its tools, approvals and MCP catalog
                // on the next turn; a running turn keeps its current agent.
                if (!session.busy) {
                    delete session.conv;
                    const role = session.kind === 'orchestrator' ? config.orchestratorRole : config.role;
                    session.effort = role.effort;
                    session.model = { provider: role.provider, model: role.model };
                }
                broadcast(session, { type: 'state', state: sessionState(session) });
            }
            return { hot: true, sandboxPending };
        }
        catch (error) {
            console.error(`[hy] settings reload failed: ${error instanceof Error ? error.message : String(error)}`);
            return { hot: false, sandboxPending: false };
        }
    };
    const refreshWorkspaceRoots = (extras) => {
        config.workspaceRoots = workspaceRootsFor(config.workspaceRoot, extras);
        for (const session of sessions.values()) {
            if (session.busy)
                continue;
            delete session.conv;
            const role = session.kind === 'orchestrator' ? config.orchestratorRole : config.role;
            session.model = { provider: role.provider, model: role.model };
            broadcast(session, { type: 'state', state: sessionState(session) });
        }
    };
    const server = http.createServer((req, res) => {
        void (async () => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src http: https:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
            const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
            let pathname;
            try {
                pathname = decodeURIComponent(url.pathname);
            }
            catch {
                json(res, 400, { error: 'invalid path' });
                return;
            }
            const method = req.method ?? 'GET';
            const authorized = () => {
                const cookies = parseCookies(req.headers.cookie);
                if (sameSecret(cookies.hy_web_token, token))
                    return true;
                const bearer = req.headers.authorization;
                return bearer?.startsWith('Bearer ') === true && sameSecret(bearer.slice(7), token);
            };
            const requireAuth = () => {
                if (authorized())
                    return true;
                json(res, 401, { error: 'unauthorized: open the URL printed by hy web / the desktop app' });
                return false;
            };
            // Launch URL: exchange the token for an HttpOnly same-site cookie.
            if (method === 'GET' && pathname === '/' && url.searchParams.has('token')) {
                if (!sameSecret(url.searchParams.get('token'), token)) {
                    text(res, 403, 'invalid or expired launch token');
                    return;
                }
                res.statusCode = 302;
                res.setHeader('Set-Cookie', `hy_web_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
                res.setHeader('Location', '/');
                res.end();
                return;
            }
            // Authenticated webhooks are not browser sessions: the per-webhook secret
            // is the credential. They are still loopback-only by default.
            const webhookPath = /^\/api\/webhooks\/([^/]+)$/.exec(pathname);
            if (webhookPath && method === 'POST') {
                const target = automation.webhooks.find((w) => w.id === webhookPath[1]);
                if (!target || !target.enabled) {
                    json(res, 404, { error: 'unknown or disabled webhook' });
                    return;
                }
                const provided = Buffer.from(String(req.headers['x-hy-webhook-secret'] ?? ''));
                const expected = Buffer.from(target.secret);
                if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
                    json(res, 401, { error: 'invalid webhook secret' });
                    return;
                }
                try {
                    const body = await readJson(req);
                    const payload = JSON.stringify(body).slice(0, 4000);
                    const objective = `${typeof body.objective === 'string' ? body.objective : target.objective}\n\n<webhook_payload>\n${payload}\n</webhook_payload>`;
                    const run = startAutomationRun('webhook', target, { objective });
                    json(res, 202, { accepted: true, runId: run.id });
                }
                catch (error) {
                    json(res, 409, { error: errorMessage(error) });
                }
                return;
            }
            if (pathname.startsWith('/api/')) {
                if (!requireAuth())
                    return;
                if (pathname === '/api/health' && method === 'GET') {
                    json(res, 200, { ok: true, version: 1, desktop: options.desktop === true });
                    return;
                }
                if (pathname === '/api/bootstrap' && method === 'GET') {
                    const events = readEvents(logFile);
                    json(res, 200, {
                        version: '0.1.0',
                        desktop: options.desktop === true,
                        workspace: {
                            root: config.workspaceRoot,
                            name: path.basename(config.workspaceRoot),
                            stateDir: config.stateDir,
                            roots: config.workspaceRoots.map((root) => ({
                                id: root.id,
                                path: root.path,
                                label: root.label ?? path.basename(root.path),
                                writable: root.writable === true,
                            })),
                        },
                        config: configSummary(config),
                        sessions: sessionSummary(config, events, sessions, uiState, orchestration, deletedRuns),
                        orchestration: orchestrationView(),
                        sandbox,
                        capabilities: sandbox,
                    });
                    return;
                }
                if (pathname === '/api/orchestration' && method === 'GET') {
                    json(res, 200, {
                        orchestration: orchestrationView(),
                        workers: orchestration.active?.workers.map(workerCard) ?? [],
                    });
                    return;
                }
                if (pathname === '/api/orchestration/start' && method === 'POST') {
                    try {
                        const record = await startOrchestration();
                        const session = ensureSession(record.orchestratorRunId);
                        json(res, 201, { runId: record.orchestratorRunId, orchestration: orchestrationView(), state: session ? sessionState(session) : undefined });
                    }
                    catch (error) {
                        json(res, 409, { error: errorMessage(error) });
                    }
                    return;
                }
                if (pathname === '/api/orchestration/stop' && method === 'POST') {
                    try {
                        const record = await stopOrchestration();
                        json(res, 200, { orchestration: orchestrationView(), stopped: record !== null });
                    }
                    catch (error) {
                        json(res, 409, { error: errorMessage(error) });
                    }
                    return;
                }
                const orchestrationWorkerMatch = /^\/api\/orchestration\/workers\/([^/]+)\/(stop|close)$/.exec(pathname);
                if (orchestrationWorkerMatch && method === 'POST') {
                    const workerId = orchestrationWorkerMatch[1];
                    try {
                        const result = orchestrationWorkerMatch[2] === 'stop' ? await stopWorker(workerId, 'stopped from the panel') : await closeWorker(workerId);
                        json(res, 200, { worker: result, orchestration: orchestrationView() });
                    }
                    catch (error) {
                        json(res, 409, { error: errorMessage(error) });
                    }
                    return;
                }
                if (pathname === '/api/automation' && method === 'GET') {
                    json(res, 200, {
                        schedules: automation.schedules.map((s) => ({ ...s, nextRun: nextCronTime(s.cron)?.toISOString() })),
                        webhooks: automation.webhooks.map((w) => ({ ...w, endpoint: `/api/webhooks/${w.id}` })),
                        runs: [...automationRuns.values()].slice(-20).map((r) => ({ ...r, output: r.output.slice(-200) })),
                        active: [...activeAutomationTargets],
                    });
                    return;
                }
                if (pathname === '/api/automation/schedules' && method === 'POST') {
                    try {
                        const fields = validateTarget(await readJson(req));
                        if (!fields.cron)
                            throw new Error('cron is required');
                        const schedule = {
                            ...fields,
                            id: `sch-${randomBytes(5).toString('hex')}`,
                            createdAt: Date.now(),
                        };
                        automation.schedules.push(schedule);
                        saveAutomation();
                        json(res, 201, schedule);
                    }
                    catch (error) {
                        json(res, 400, { error: errorMessage(error) });
                    }
                    return;
                }
                if (pathname === '/api/automation/webhooks' && method === 'POST') {
                    try {
                        const fields = validateTarget(await readJson(req));
                        const webhook = {
                            ...fields,
                            id: `wh-${randomBytes(5).toString('hex')}`,
                            secret: `whsec-${randomBytes(18).toString('hex')}`,
                            createdAt: Date.now(),
                        };
                        automation.webhooks.push(webhook);
                        saveAutomation();
                        json(res, 201, { ...webhook, endpoint: `/api/webhooks/${webhook.id}` });
                    }
                    catch (error) {
                        json(res, 400, { error: errorMessage(error) });
                    }
                    return;
                }
                const automationMatch = /^\/api\/automation\/(schedules|webhooks)\/([^/]+)(?:\/(run|enabled))?$/.exec(pathname);
                if (automationMatch) {
                    const kind = automationMatch[1] === 'schedules' ? 'schedules' : 'webhooks';
                    const id = automationMatch[2];
                    const action = automationMatch[3];
                    const list = kind === 'schedules' ? automation.schedules : automation.webhooks;
                    const target = list.find((t) => t.id === id);
                    if (!target) {
                        json(res, 404, { error: 'unknown automation target' });
                        return;
                    }
                    if (method === 'DELETE') {
                        const index = list.findIndex((t) => t.id === id);
                        list.splice(index, 1);
                        saveAutomation();
                        json(res, 200, { deleted: id });
                        return;
                    }
                    if (method === 'PUT') {
                        try {
                            const fields = validateTarget(await readJson(req), target);
                            if (kind === 'schedules' && !fields.cron)
                                throw new Error('cron is required');
                            Object.assign(target, fields);
                            saveAutomation();
                            json(res, 200, target);
                        }
                        catch (error) {
                            json(res, 400, { error: errorMessage(error) });
                        }
                        return;
                    }
                    if (action === 'enabled' && method === 'POST') {
                        const body = await readJson(req);
                        target.enabled = body.enabled === true;
                        saveAutomation();
                        json(res, 200, target);
                        return;
                    }
                    if (action === 'run' && method === 'POST') {
                        try {
                            const run = startAutomationRun('manual', target);
                            json(res, 202, run);
                        }
                        catch (error) {
                            json(res, 409, { error: errorMessage(error) });
                        }
                        return;
                    }
                    json(res, 405, { error: 'method not allowed' });
                    return;
                }
                const automationRunMatch = /^\/api\/automation\/runs\/([^/]+)$/.exec(pathname);
                if (automationRunMatch && method === 'GET') {
                    const id = automationRunMatch[1];
                    const run = automationRuns.get(id) ?? automation.runs.find((r) => r.id === id);
                    if (!run) {
                        json(res, 404, { error: 'unknown automation run' });
                        return;
                    }
                    json(res, 200, { ...run, output: run.output.slice(-200) });
                    return;
                }
                if (pathname === '/api/plugins' && method === 'GET') {
                    json(res, 200, pluginCatalog(config));
                    return;
                }
                if (pathname === '/api/plugins/reload' && method === 'POST') {
                    await reloadPlugins(config);
                    json(res, 200, { ...pluginCatalog(config), note: 'New sessions use the reloaded tools; existing conversations keep their loaded plugin map.' });
                    return;
                }
                if (pathname === '/api/sessions' && method === 'GET') {
                    const search = (url.searchParams.get('search') ?? '').toLowerCase();
                    const events = readEvents(logFile);
                    let runs = sessionSummary(config, events, sessions, uiState, orchestration, deletedRuns);
                    if (search) {
                        const hits = new Set(events
                            .filter((e) => (e.type === 'user/message' || e.type === 'assistant/message') && e.runId)
                            .filter((e) => String(e.payload.content ?? '').toLowerCase().includes(search))
                            .map((e) => e.runId.split('.sub')[0]));
                        runs = runs.filter((r) => hits.has(r.runId));
                    }
                    if (url.searchParams.get('archived') !== '1')
                        runs = runs.filter((r) => !r.archived);
                    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
                    json(res, 200, { sessions: runs.slice(0, limit) });
                    return;
                }
                if (pathname === '/api/sessions' && method === 'POST') {
                    const session = newSession();
                    json(res, 201, { runId: session.runId, state: sessionState(session) });
                    return;
                }
                if (pathname === '/api/ralph' && method === 'POST') {
                    const job = startRalphJob(await readJson(req));
                    json(res, 201, { id: job.id, status: job.status, objective: job.objective });
                    return;
                }
                const ralphMatch = /^\/api\/ralph\/([^/]+)(?:\/(cancel))?$/.exec(pathname);
                if (ralphMatch) {
                    const job = ralphJobs.get(ralphMatch[1]);
                    if (!job) {
                        json(res, 404, { error: 'unknown ralph job' });
                        return;
                    }
                    if (ralphMatch[2] === 'cancel' && method === 'POST') {
                        job.status = 'cancelled';
                        job.ended = Date.now();
                        job.child?.kill();
                        json(res, 200, { id: job.id, status: job.status });
                        return;
                    }
                    if (method === 'GET') {
                        json(res, 200, {
                            id: job.id,
                            status: job.status,
                            objective: job.objective,
                            ...(job.runId !== undefined ? { runId: job.runId } : {}),
                            output: job.output.join('\n'),
                            started: job.started,
                            ...(job.ended !== undefined ? { ended: job.ended } : {}),
                        });
                        return;
                    }
                }
                if (pathname === '/api/events' && method === 'GET') {
                    sseHeaders(res);
                    globalSubscribers.add(res);
                    sseWrite(res, 'sessions', { type: 'sessions', sessions: sessionSummary(config, readEvents(logFile), sessions, uiState, orchestration, deletedRuns) });
                    sseWrite(res, 'orchestration', { type: 'orchestration', orchestration: orchestrationView() });
                    const keepalive = setInterval(() => {
                        try {
                            res.write(': keepalive\n\n');
                        }
                        catch {
                            clearInterval(keepalive);
                        }
                    }, 15_000);
                    req.on('close', () => {
                        clearInterval(keepalive);
                        globalSubscribers.delete(res);
                    });
                    return;
                }
                const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(.*))?$/.exec(pathname);
                if (sessionMatch) {
                    const runId = sessionMatch[1];
                    const sub = sessionMatch[2] ?? '';
                    const session = ensureSession(runId);
                    if (!session) {
                        json(res, 404, { error: `unknown run ${runId}` });
                        return;
                    }
                    if (sub === '' && method === 'GET') {
                        json(res, 200, { runId, entries: session.entries, state: sessionState(session) });
                        return;
                    }
                    if (sub === '' && method === 'DELETE') {
                        if (session.kind !== 'chat') {
                            json(res, 409, { error: 'orchestrator and worker chats are managed by orchestration; stop orchestration or archive the chat instead' });
                            return;
                        }
                        session.controller?.abort();
                        resolvePending(session);
                        session.pty?.dispose();
                        for (const sse of session.ptySubscribers ?? []) {
                            try {
                                sse.end();
                            }
                            catch {
                                // already closed
                            }
                        }
                        session.ptySubscribers?.clear();
                        for (const sse of session.subscribers) {
                            try {
                                sse.end();
                            }
                            catch {
                                // already closed
                            }
                        }
                        session.subscribers.clear();
                        deletedRuns.add(runId);
                        sessions.delete(runId);
                        uiState.pinned = uiState.pinned.filter((id) => id !== runId);
                        uiState.archived = uiState.archived.filter((id) => id !== runId);
                        delete uiState.titles[runId];
                        uiState.deleted = [...new Set([...uiState.deleted, runId])].slice(-200);
                        saveUiState();
                        dropRunFromLog(runId);
                        broadcastSessions();
                        if (session.busy)
                            cleanUpDeletedRun(runId, session);
                        json(res, 200, { deleted: true, runId });
                        return;
                    }
                    if (sub === 'pty' && method === 'GET') {
                        json(res, 200, session.pty?.status() ?? {
                            running: false,
                            shell: '',
                            cwd: config.workspaceRoot,
                            cols: 120,
                            rows: 30,
                            output: '',
                        });
                        return;
                    }
                    if (sub === 'pty/start' && method === 'POST') {
                        const body = await readJson(req);
                        const cols = typeof body.cols === 'number' ? body.cols : undefined;
                        const rows = typeof body.rows === 'number' ? body.rows : undefined;
                        session.pty ??= new PersistentPty(config.workspaceRoot);
                        try {
                            json(res, 200, session.pty.start({ cols, rows }));
                        }
                        catch (error) {
                            json(res, 500, { error: errorMessage(error) });
                        }
                        return;
                    }
                    if (sub === 'pty/input' && method === 'POST') {
                        const pty = session.pty;
                        if (!pty) {
                            json(res, 409, { error: 'the persistent shell is not running' });
                            return;
                        }
                        const body = await readJson(req);
                        const data = typeof body.data === 'string' ? body.data : '';
                        try {
                            pty.write(data);
                            json(res, 200, { ok: true });
                        }
                        catch (error) {
                            json(res, 409, { error: errorMessage(error) });
                        }
                        return;
                    }
                    if (sub === 'pty/resize' && method === 'POST') {
                        const pty = session.pty;
                        if (!pty) {
                            json(res, 409, { error: 'the persistent shell is not running' });
                            return;
                        }
                        const body = await readJson(req);
                        const cols = typeof body.cols === 'number' ? body.cols : undefined;
                        const rows = typeof body.rows === 'number' ? body.rows : undefined;
                        json(res, 200, pty.resize(cols, rows));
                        return;
                    }
                    if (sub === 'pty/clear' && method === 'POST') {
                        const pty = session.pty;
                        if (!pty) {
                            json(res, 409, { error: 'the persistent shell is not running' });
                            return;
                        }
                        json(res, 200, pty.clear());
                        return;
                    }
                    if (sub === 'pty/stop' && method === 'POST') {
                        json(res, 200, session.pty?.stop() ?? { running: false });
                        return;
                    }
                    if (sub === 'pty/events' && method === 'GET') {
                        const pty = session.pty;
                        if (!pty) {
                            json(res, 409, { error: 'start the persistent shell first' });
                            return;
                        }
                        sseHeaders(res);
                        const subscribers = (session.ptySubscribers ??= new Set());
                        subscribers.add(res);
                        sseWrite(res, 'pty', { type: 'snapshot', status: pty.status() });
                        const unsubscribe = pty.onEvent((event) => {
                            try {
                                sseWrite(res, 'pty', event);
                            }
                            catch {
                                // The browser went away; req close removes the listener.
                            }
                        });
                        const keepalive = setInterval(() => {
                            try {
                                res.write(': keepalive\n\n');
                            }
                            catch {
                                clearInterval(keepalive);
                            }
                        }, 15_000);
                        req.on('close', () => {
                            clearInterval(keepalive);
                            subscribers.delete(res);
                            unsubscribe();
                        });
                        return;
                    }
                    if (sub === 'events' && method === 'GET') {
                        sseHeaders(res);
                        session.subscribers.add(res);
                        sseWrite(res, 'snapshot', { runId, entries: session.entries, state: sessionState(session) });
                        const keepalive = setInterval(() => {
                            try {
                                res.write(': keepalive\n\n');
                            }
                            catch {
                                clearInterval(keepalive);
                            }
                        }, 15_000);
                        req.on('close', () => {
                            clearInterval(keepalive);
                            session.subscribers.delete(res);
                        });
                        return;
                    }
                    if (sub === 'turn' && method === 'POST') {
                        if (session.kind === 'worker') {
                            json(res, 403, { error: 'worker chats are read-only; send instructions through the orchestrator' });
                            return;
                        }
                        if (session.busy) {
                            json(res, 409, { error: 'this session is already running' });
                            return;
                        }
                        const body = await readJson(req);
                        const message = typeof body.message === 'string' ? body.message : '';
                        if (!message.trim()) {
                            json(res, 400, { error: 'message is required' });
                            return;
                        }
                        const images = parseImages(body.images);
                        const nextTurn = (session.conv?.turns ?? session.turns) + 1;
                        void runTurn(session, message, images).catch((error) => {
                            session.busy = false;
                            session.controller = undefined;
                            session.lastError = errorMessage(error);
                            broadcast(session, { type: 'turn/end', outcome: 'error', error: session.lastError });
                        });
                        json(res, 202, { accepted: true, runId, turn: nextTurn });
                        return;
                    }
                    if (sub === 'cancel' && method === 'POST') {
                        session.controller?.abort();
                        resolvePending(session);
                        broadcast(session, { type: 'turn/cancelling', runId });
                        json(res, 200, { cancelling: true });
                        return;
                    }
                    if (sub === 'approval' && method === 'POST') {
                        const body = await readJson(req);
                        const requestId = typeof body.requestId === 'string' ? body.requestId : '';
                        const approved = body.approved === true;
                        const reason = typeof body.reason === 'string' ? body.reason : undefined;
                        if (session.kind === 'worker') {
                            // The user is the final authority, also for worker requests the
                            // orchestrator may not approve.
                            try {
                                json(res, 200, { ok: true, ...(await approveWorker(session.runId, requestId, approved, reason, 'user')) });
                            }
                            catch (error) {
                                json(res, 404, { error: errorMessage(error) });
                            }
                            return;
                        }
                        const pending = session.pendingApprovals.get(requestId);
                        if (!pending) {
                            json(res, 404, { error: `no pending approval ${requestId}` });
                            return;
                        }
                        session.pendingApprovals.delete(requestId);
                        pending.resolve(approved);
                        const entry = session.entries.find((e) => e.kind === 'approval' && e.requestId === requestId);
                        if (entry?.kind === 'approval')
                            entry.decision = approved ? 'approved' : 'denied';
                        broadcast(session, { type: 'approval/decision', requestId, approved, ...(reason ? { reason } : {}) });
                        json(res, 200, { ok: true });
                        return;
                    }
                    if (sub === 'answer' && method === 'POST') {
                        const body = await readJson(req);
                        const requestId = typeof body.requestId === 'string' ? body.requestId : '';
                        const answer = typeof body.answer === 'string' ? body.answer : '';
                        const pending = session.pendingQuestions.get(requestId);
                        if (!pending) {
                            json(res, 404, { error: `no pending question ${requestId}` });
                            return;
                        }
                        session.pendingQuestions.delete(requestId);
                        pending.resolve(answer);
                        const entry = session.entries.find((e) => e.kind === 'question' && e.requestId === requestId);
                        if (entry?.kind === 'question')
                            entry.answer = answer;
                        broadcast(session, { type: 'question/answer', requestId, answer });
                        json(res, 200, { ok: true });
                        return;
                    }
                    if (sub === 'undo' && method === 'POST') {
                        if (session.kind !== 'chat') {
                            json(res, 409, { error: 'undo is unavailable for orchestration sessions; a shared workspace has one checkpoint owner' });
                            return;
                        }
                        const conv = ensureConversation(session);
                        const result = await conv.undo();
                        refreshTranscript(session, config.stateDir);
                        broadcast(session, { type: 'transcript', entries: session.entries });
                        broadcast(session, { type: 'notice', text: result });
                        broadcast(session, { type: 'state', state: sessionState(session) });
                        json(res, 200, { result, entries: session.entries });
                        return;
                    }
                    if (sub === 'compact' && method === 'POST') {
                        const result = await ensureConversation(session).compact();
                        broadcast(session, { type: 'notice', text: result });
                        json(res, 200, { result });
                        return;
                    }
                    if (sub === 'plan-mode' && method === 'POST') {
                        const body = await readJson(req);
                        if (session.kind === 'orchestrator' && body.on !== true) {
                            json(res, 409, { error: 'the orchestrator is permanently in plan mode' });
                            return;
                        }
                        const conv = ensureConversation(session);
                        const on = body.on === true;
                        const result = conv.setPlanMode(on);
                        session.planMode = conv.isPlanMode();
                        broadcast(session, { type: 'notice', text: result });
                        broadcast(session, { type: 'state', state: sessionState(session) });
                        json(res, 200, { result, planMode: session.planMode });
                        return;
                    }
                    if (sub === 'effort' && method === 'POST') {
                        const body = await readJson(req);
                        const requested = typeof body.effort === 'string' ? body.effort.trim() : '';
                        if (requested !== '' && !EFFORT_VALUES.has(requested)) {
                            json(res, 400, { error: `effort must be one of ${[...EFFORT_VALUES].join(', ')}` });
                            return;
                        }
                        const result = ensureConversation(session).setEffort(requested || undefined);
                        session.effort = requested || undefined;
                        broadcast(session, { type: 'notice', text: result });
                        broadcast(session, { type: 'state', state: sessionState(session) });
                        json(res, 200, { result, effort: session.conv?.currentEffort() ?? '' });
                        return;
                    }
                    if (sub === 'model' && method === 'POST') {
                        const body = await readJson(req);
                        const model = typeof body.model === 'string' ? body.model.trim() : '';
                        if (!model) {
                            json(res, 400, { error: 'model is required' });
                            return;
                        }
                        const result = ensureConversation(session).setModel(model);
                        session.model = session.conv?.currentModel() ?? session.model;
                        broadcast(session, { type: 'notice', text: result });
                        broadcast(session, { type: 'state', state: sessionState(session) });
                        json(res, 200, { result });
                        return;
                    }
                    if (sub === 'pin' && method === 'POST') {
                        const body = await readJson(req);
                        const pinned = body.pinned === true;
                        uiState.pinned = pinned ? [...new Set([...uiState.pinned, runId])] : uiState.pinned.filter((id) => id !== runId);
                        session.pinned = pinned;
                        saveUiState();
                        broadcastSessions();
                        json(res, 200, { runId, pinned });
                        return;
                    }
                    if (sub === 'archive' && method === 'POST') {
                        const body = await readJson(req);
                        const archived = body.archived === true;
                        uiState.archived = archived ? [...new Set([...uiState.archived, runId])] : uiState.archived.filter((id) => id !== runId);
                        session.archived = archived;
                        saveUiState();
                        broadcastSessions();
                        json(res, 200, { runId, archived });
                        return;
                    }
                    if (sub === 'title' && method === 'POST') {
                        const body = await readJson(req);
                        if (typeof body.title !== 'string') {
                            json(res, 400, { error: 'title must be a string; send an empty string to restore the automatic name' });
                            return;
                        }
                        const title = normalizeChatTitle(body.title);
                        if (title)
                            uiState.titles[runId] = title;
                        else
                            delete uiState.titles[runId];
                        saveUiState();
                        broadcastSessions();
                        json(res, 200, { runId, title });
                        return;
                    }
                    if (sub === 'goal' && method === 'GET') {
                        json(res, 200, { goal: session.conv?.currentGoal() ?? session.goal ?? null });
                        return;
                    }
                    if (sub === 'goal' && method === 'POST') {
                        const body = await readJson(req);
                        const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
                        const conv = ensureConversation(session);
                        const result = conv.setGoal(goal);
                        session.goal = goal || undefined;
                        broadcast(session, { type: 'notice', text: result });
                        broadcast(session, { type: 'state', state: sessionState(session) });
                        json(res, 200, { result, goal: session.goal ?? null });
                        return;
                    }
                    if (sub === 'jobs' && method === 'GET') {
                        const jobs = await Promise.all([...session.jobs.values()].map(async (job) => {
                            try {
                                const info = await client.jobStatus(job.jobId);
                                job.status = info.state;
                                job.updated = Date.now();
                            }
                            catch {
                                // keep the last known status
                            }
                            return { ...job };
                        }));
                        json(res, 200, { jobs: jobs.sort((a, b) => b.started - a.started) });
                        return;
                    }
                    const jobMatch = /^jobs\/([^/]+)(?:\/(output|kill))?$/.exec(sub);
                    if (jobMatch) {
                        const jobId = jobMatch[1];
                        const action = jobMatch[2];
                        if (action === 'output' && method === 'GET') {
                            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
                            const output = await client.jobOutput(jobId, offset);
                            json(res, 200, output);
                            return;
                        }
                        if (action === 'kill' && method === 'POST') {
                            const info = await client.jobKill(jobId);
                            const job = session.jobs.get(jobId);
                            if (job) {
                                job.status = info.state;
                                job.updated = Date.now();
                            }
                            broadcast(session, { type: 'notice', text: `job ${jobId}: ${info.state}` });
                            json(res, 200, info);
                            return;
                        }
                        json(res, 404, { error: `unknown jobs endpoint ${sub}` });
                        return;
                    }
                    if (sub === 'subagents' && method === 'GET') {
                        const events = readEvents(logFile);
                        const ids = [...new Set(events.filter((e) => e.runId?.startsWith(`${runId}.sub`)).map((e) => e.runId))];
                        const subagents = ids.map((id) => {
                            const entries = projectChat(events, id);
                            const start = events.find((e) => e.runId === id && e.type === 'subagent/start');
                            const lastAssistant = [...entries].reverse().find((e) => e.kind === 'assistant');
                            return {
                                runId: id,
                                readOnly: start?.payload?.readOnly === true,
                                started: start?.ts ?? entries[0]?.ts ?? Date.now(),
                                entries: entries.length,
                                preview: lastAssistant?.kind === 'assistant' ? lastAssistant.text.slice(0, 240) : '',
                            };
                        });
                        json(res, 200, { subagents: subagents.sort((a, b) => a.started - b.started) });
                        return;
                    }
                    const subAgentMatch = /^subagents\/([^/]+)$/.exec(sub);
                    if (subAgentMatch && method === 'GET') {
                        const child = subAgentMatch[1];
                        if (child !== `${runId}.sub` && !child.startsWith(`${runId}.sub`)) {
                            json(res, 400, { error: 'not a subagent of this run' });
                            return;
                        }
                        const events = readEvents(logFile);
                        json(res, 200, { runId: child, entries: projectChat(events, child), events: events.filter((e) => e.runId === child) });
                        return;
                    }
                    if (sub === 'trajectory' && method === 'GET') {
                        const events = readEvents(logFile).filter((e) => e.runId === runId);
                        json(res, 200, { runId, events: events.slice(-2000) });
                        return;
                    }
                    if (sub === 'mcp-call' && method === 'POST') {
                        const body = await readJson(req);
                        const server = typeof body.server === 'string' ? body.server : '';
                        const tool = typeof body.tool === 'string' ? body.tool : '';
                        if (server !== 'playwright' && server !== 'agent-desktop') {
                            json(res, 403, { error: 'direct GUI calls are limited to the playwright and agent-desktop automation servers' });
                            return;
                        }
                        if (!sessionMcp || !sessionMcp.find(server, tool)) {
                            json(res, 400, { error: `MCP tool ${server}/${tool} is not available; enable it in Settings and restart` });
                            return;
                        }
                        try {
                            const result = await sessionMcp.call(server, tool, body.args ?? {});
                            json(res, 200, { result });
                        }
                        catch (error) {
                            json(res, 400, { error: errorMessage(error) });
                        }
                        return;
                    }
                    if (sub === 'mcp' && method === 'GET') {
                        json(res, 200, { tools: sessionMcp?.tools ?? [], errors: sessionMcp?.errors ?? [] });
                        return;
                    }
                    if (sub === 'plugins' && method === 'GET') {
                        json(res, 200, {
                            tools: [...(sessionPlugins?.tools.values() ?? [])].map((t) => ({
                                name: t.name,
                                description: t.spec.description,
                                readOnly: t.spec.readOnly,
                                plugin: t.plugin,
                            })),
                            errors: sessionPlugins?.errors ?? [],
                        });
                        return;
                    }
                    if (sub === 'memory' && method === 'GET') {
                        json(res, 200, { entries: MemoryStore.forStateDir(config.stateDir).list() });
                        return;
                    }
                    if (sub === 'terminal' && method === 'POST') {
                        const body = await readJson(req);
                        const command = typeof body.command === 'string' ? body.command.trim() : '';
                        if (!command) {
                            json(res, 400, { error: 'command is required' });
                            return;
                        }
                        try {
                            const result = await client.exec({
                                command,
                                mode: 'gate',
                                hardTimeoutMs: 120_000,
                                approval: { by: 'user', callId: `terminal-${Date.now()}` },
                            });
                            json(res, 200, { result });
                        }
                        catch (error) {
                            json(res, 400, { error: errorMessage(error) });
                        }
                        return;
                    }
                    if (sub === 'diff' && method === 'GET') {
                        try {
                            const diff = await ensureConversation(session).diff();
                            json(res, 200, { diff });
                        }
                        catch (error) {
                            json(res, 200, { diff: '', error: errorMessage(error) });
                        }
                        return;
                    }
                    if (sub === 'plan' && method === 'GET') {
                        json(res, 200, { plan: session.conv?.plan() ?? 'no plan', planMode: sessionState(session).planMode });
                        return;
                    }
                    if (sub === 'notes' && method === 'GET') {
                        json(res, 200, { notes: session.conv?.notes() ?? 'no notes' });
                        return;
                    }
                    if (sub === 'status' && method === 'GET') {
                        json(res, 200, { status: session.conv?.status() ?? `run: ${session.runId}\nworkspace: ${config.workspaceRoot}`, state: sessionState(session) });
                        return;
                    }
                    if (sub === 'skills' && method === 'GET') {
                        json(res, 200, { skills: session.conv?.skillList() ?? 'no skills loaded' });
                        return;
                    }
                    if (sub === 'export' && method === 'GET') {
                        const format = url.searchParams.get('format') ?? 'md';
                        if (format === 'json') {
                            json(res, 200, { runId, entries: session.entries, events: readEvents(logFile).filter((e) => e.runId === runId) });
                        }
                        else {
                            text(res, 200, markdownExport(session), 'text/markdown; charset=utf-8');
                        }
                        return;
                    }
                    if (sub === 'review' && method === 'POST') {
                        const conv = ensureConversation(session);
                        const review = await conv.delegate('Review the uncommitted changes in this workspace for correctness. Look for bugs, regressions, security problems and missing tests; read surrounding code when the diff is not enough. Report each finding as: severity (high/medium/low), file:line, what is wrong, and why it matters. If you find nothing that needs fixing, say so plainly.', true);
                        session.entries.push({ id: `review-${Date.now()}`, kind: 'assistant', runId: session.runId, text: review.final, ts: Date.now(), final: true });
                        broadcast(session, { type: 'entry', entry: session.entries.at(-1) });
                        json(res, 200, { final: review.final });
                        return;
                    }
                    json(res, 404, { error: `unknown endpoint ${pathname}` });
                    return;
                }
                if (pathname === '/api/workspace/roots' && method === 'GET') {
                    json(res, 200, { roots: configSummary(config).roots });
                    return;
                }
                if (pathname === '/api/workspace/roots' && method === 'POST') {
                    if ([...sessions.values()].some((session) => session.busy)) {
                        json(res, 409, { error: 'wait for running turns to finish before adding a root' });
                        return;
                    }
                    const body = await readJson(req);
                    const input = typeof body.path === 'string' ? body.path.trim() : '';
                    if (!input || !path.isAbsolute(input)) {
                        json(res, 400, { error: 'an absolute folder path is required' });
                        return;
                    }
                    let real;
                    try {
                        if (!fs.statSync(input).isDirectory())
                            throw new Error('not a directory');
                        real = fs.realpathSync.native(input);
                    }
                    catch (error) {
                        json(res, 400, { error: errorMessage(error) });
                        return;
                    }
                    if (config.workspaceRoots.some((root) => path.resolve(root.path).toLowerCase() === path.resolve(real).toLowerCase())) {
                        json(res, 409, { error: 'this folder is already a workspace root' });
                        return;
                    }
                    const settingsPath = path.join(userConfigDir(), 'config.json');
                    let user = {};
                    try {
                        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                            user = parsed;
                    }
                    catch {
                        user = {};
                    }
                    const extras = [
                        ...config.workspaceRoots.slice(1).map((root) => ({ ...root })),
                        { path: real, ...(typeof body.label === 'string' ? { label: body.label } : {}), writable: body.writable === true },
                    ];
                    config.workspaceRoots = workspaceRootsFor(config.workspaceRoot, extras);
                    user.workspaceRoots = config.workspaceRoots.slice(1);
                    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
                    fs.writeFileSync(settingsPath, `${JSON.stringify(user, null, 2)}\n`, 'utf8');
                    refreshWorkspaceRoots(user.workspaceRoots);
                    broadcastSessions();
                    json(res, 201, { roots: configSummary(config).roots });
                    return;
                }
                const rootMatch = /^\/api\/workspace\/roots\/([^/]+)$/.exec(pathname);
                if (rootMatch && method === 'DELETE') {
                    if ([...sessions.values()].some((session) => session.busy)) {
                        json(res, 409, { error: 'wait for running turns to finish before removing a root' });
                        return;
                    }
                    const id = decodeURIComponent(rootMatch[1]);
                    if (id === 'main') {
                        json(res, 400, { error: 'the primary root cannot be removed' });
                        return;
                    }
                    const settingsPath = path.join(userConfigDir(), 'config.json');
                    let user = {};
                    try {
                        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                            user = parsed;
                    }
                    catch {
                        user = {};
                    }
                    const extras = config.workspaceRoots.slice(1).filter((root) => root.id !== id);
                    config.workspaceRoots = workspaceRootsFor(config.workspaceRoot, extras);
                    user.workspaceRoots = config.workspaceRoots.slice(1);
                    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
                    fs.writeFileSync(settingsPath, `${JSON.stringify(user, null, 2)}\n`, 'utf8');
                    refreshWorkspaceRoots(user.workspaceRoots);
                    broadcastSessions();
                    json(res, 200, { roots: configSummary(config).roots });
                    return;
                }
                if (pathname === '/api/files/search' && method === 'GET') {
                    const query = (url.searchParams.get('q') ?? '').trim();
                    const root = rootById(url.searchParams.get('root'));
                    const files = query ? searchWorkspaceFiles(root.path, query).map((file) => qualifyRootPath(root.id, file)) : [];
                    json(res, 200, { root: root.id, files });
                    return;
                }
                if (pathname === '/api/files/tree' && method === 'GET') {
                    const rel = url.searchParams.get('path') ?? '';
                    const showHidden = url.searchParams.get('hidden') === '1';
                    const root = rootById(url.searchParams.get('root'));
                    const full = safeWorkspacePath(root.path, rel);
                    const stat = fs.statSync(full);
                    if (!stat.isDirectory()) {
                        json(res, 400, { error: 'not a directory' });
                        return;
                    }
                    const entries = fs.readdirSync(full, { withFileTypes: true })
                        .filter((e) => showHidden || !TREE_SKIP.has(e.name))
                        .map((e) => {
                        const child = path.posix.join(rel.replace(/\\/g, '/'), e.name);
                        let size;
                        try {
                            size = e.isFile() ? fs.statSync(path.join(full, e.name)).size : undefined;
                        }
                        catch {
                            size = undefined;
                        }
                        return { name: e.name, path: child, type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file', ...(size !== undefined ? { size } : {}) };
                    })
                        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
                        .slice(0, 1000);
                    json(res, 200, { root: root.id, path: rel, entries });
                    return;
                }
                if (pathname === '/api/files' && method === 'GET') {
                    const rel = url.searchParams.get('path') ?? '';
                    const root = rootById(url.searchParams.get('root'));
                    const spill = root.id === 'main' ? spillFile(path.join(config.stateDir, 'spill'), rel) : undefined;
                    const full = spill ?? safeWorkspacePath(root.path, rel);
                    const stat = fs.statSync(full);
                    if (!stat.isFile()) {
                        json(res, 400, { error: 'not a file' });
                        return;
                    }
                    if (stat.size > MAX_FILE_BYTES) {
                        json(res, 413, { error: `file is too large (${stat.size} bytes; limit ${MAX_FILE_BYTES})` });
                        return;
                    }
                    const bytes = fs.readFileSync(full);
                    if (bytes.subarray(0, 8192).includes(0)) {
                        json(res, 415, { error: 'binary file' });
                        return;
                    }
                    const content = bytes.toString('utf8');
                    json(res, 200, {
                        root: root.id,
                        path: qualifyRootPath(root.id, rel),
                        size: stat.size,
                        lines: content.split(/\r?\n/).length,
                        content,
                        truncated: false,
                    });
                    return;
                }
                if (pathname === '/api/settings' && method === 'GET') {
                    const settingsPath = path.join(userConfigDir(), 'config.json');
                    let user = {};
                    try {
                        user = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                    }
                    catch {
                        user = {};
                    }
                    json(res, 200, { path: settingsPath, user: redactUserConfig(user), active: configSummary(config) });
                    return;
                }
                if (pathname === '/api/settings' && method === 'PUT') {
                    const body = await readJson(req);
                    const settingsPath = path.join(userConfigDir(), 'config.json');
                    let user = {};
                    try {
                        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                            user = parsed;
                    }
                    catch {
                        user = {};
                    }
                    if (body.roles && typeof body.roles === 'object' && !Array.isArray(body.roles)) {
                        const roles = (user.roles && typeof user.roles === 'object' && !Array.isArray(user.roles) ? user.roles : {});
                        for (const [role, value] of Object.entries(body.roles)) {
                            if (!['worker', 'orchestrator', 'subagent', 'guardian', 'grader', 'compactor', 'summarizer'].includes(role))
                                continue;
                            if (!value || typeof value !== 'object' || Array.isArray(value))
                                continue;
                            const incoming = { ...value };
                            if (typeof incoming.apiKey === 'string') {
                                const key = incoming.apiKey.trim();
                                if (key)
                                    incoming.apiKey = key;
                                else
                                    delete incoming.apiKey;
                            }
                            delete incoming.apiKeySet;
                            const merged = {
                                ...(roles[role] && typeof roles[role] === 'object' && !Array.isArray(roles[role]) ? roles[role] : {}),
                                ...incoming,
                            };
                            if (merged.effort === null || merged.effort === '' || (typeof merged.effort === 'string' && !EFFORT_VALUES.has(merged.effort))) {
                                delete merged.effort;
                            }
                            roles[role] = merged;
                        }
                        user.roles = roles;
                    }
                    if (typeof body.autoApprove === 'boolean')
                        user.autoApprove = body.autoApprove;
                    if (typeof body.fullAuto === 'boolean')
                        user.fullAuto = body.fullAuto;
                    if (Array.isArray(body.models)) {
                        user.models = body.models.filter((model) => !!model &&
                            typeof model === 'object' &&
                            !Array.isArray(model) &&
                            typeof model.id === 'string' &&
                            typeof model.name === 'string' &&
                            typeof model.provider === 'string' &&
                            typeof model.model === 'string');
                    }
                    if (typeof body.sandboxMode === 'string' && ['unconfined', 'workspace-write', 'read-only'].includes(body.sandboxMode)) {
                        user.sandboxMode = body.sandboxMode;
                    }
                    if (Array.isArray(body.plugins)) {
                        user.plugins = body.plugins.filter((p) => typeof p === 'string' && p.trim().length > 0);
                    }
                    if (typeof body.memoryEnabled === 'boolean') {
                        user.memory = { ...(typeof user.memory === 'object' && user.memory !== null && !Array.isArray(user.memory) ? user.memory : {}), enabled: body.memoryEnabled };
                    }
                    if (typeof body.webEnabled === 'boolean') {
                        user.web = { ...(typeof user.web === 'object' && user.web !== null && !Array.isArray(user.web) ? user.web : {}), enabled: body.webEnabled };
                    }
                    if (body.automation && typeof body.automation === 'object' && !Array.isArray(body.automation)) {
                        user.automation = body.automation;
                    }
                    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
                    fs.writeFileSync(settingsPath, `${JSON.stringify(user, null, 2)}\n`, 'utf8');
                    const reloaded = await applyRuntimeSettings();
                    json(res, 200, {
                        saved: true,
                        path: settingsPath,
                        restartRequired: !reloaded.hot || reloaded.sandboxPending,
                        hotReloaded: reloaded.hot,
                        sandboxRestartRequired: reloaded.sandboxPending,
                    });
                    return;
                }
                json(res, 404, { error: `unknown endpoint ${pathname}` });
                return;
            }
            // Static client. The page is public; every API call above is authenticated.
            if (method !== 'GET' && method !== 'HEAD') {
                json(res, 405, { error: 'method not allowed' });
                return;
            }
            const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
            const full = path.resolve(WEB_ROOT, relative);
            if (full !== WEB_ROOT && !full.startsWith(`${WEB_ROOT}${path.sep}`)) {
                text(res, 403, 'forbidden');
                return;
            }
            let stat;
            try {
                stat = fs.statSync(full);
            }
            catch {
                text(res, 404, 'not found');
                return;
            }
            if (!stat.isFile()) {
                text(res, 404, 'not found');
                return;
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            if (method === 'HEAD') {
                res.end();
                return;
            }
            fs.createReadStream(full).pipe(res);
        })().catch((error) => {
            if (!res.headersSent)
                json(res, 500, { error: errorMessage(error) });
            else
                res.end();
        });
    });
    const listen = (port) => new Promise((resolve, reject) => {
        const onError = (error) => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
    let port = options.port ?? 3080;
    if (port !== 0) {
        for (let attempt = 0;; attempt++) {
            try {
                port = await listen(port);
                break;
            }
            catch (error) {
                const code = error.code;
                if (code !== 'EADDRINUSE' || attempt >= 10)
                    throw error;
                port += 1;
            }
        }
    }
    else {
        port = await listen(0);
    }
    const heartbeatTimer = setInterval(() => heartbeatCheck(), 60_000);
    heartbeatTimer.unref();
    if (orchestration.active?.status === 'active') {
        let interrupted = 0;
        for (const worker of orchestration.active.workers) {
            if (worker.status === 'running' || worker.status === 'queued' || worker.status === 'blocked') {
                worker.status = 'interrupted';
                worker.updatedAt = Date.now();
                worker.lastError = 'host restarted while the worker was active';
                interrupted += 1;
            }
        }
        if (interrupted > 0) {
            persistOrchestration();
            broadcastSessions();
            setTimeout(() => {
                queueOrchestratorNotice(`[host restart]\n${interrupted} worker(s) were interrupted. Inspect them with orchestrator_workers, then retry, send a correction, or close each one.`);
            }, 1_000).unref();
        }
    }
    const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const url = `http://${displayHost}:${port}/?token=${encodeURIComponent(token)}`;
    logLine(options, `listening on http://${displayHost}:${port}`);
    logLine(options, `workspace: ${config.workspaceRoot}`);
    logLine(options, `sandbox: ${config.sandbox}`);
    if (options.open)
        openBrowser(url);
    return {
        url,
        port,
        token,
        config,
        close: async () => {
            if (closing)
                return;
            closing = true;
            clearInterval(heartbeatTimer);
            clearInterval(automationTimer);
            for (const child of automationChildren.values())
                child.kill();
            automationChildren.clear();
            for (const job of ralphJobs.values()) {
                job.status = 'cancelled';
                job.child?.kill();
            }
            for (const session of sessions.values()) {
                session.controller?.abort();
                resolvePending(session);
                session.pty?.dispose();
                for (const res of session.ptySubscribers ?? []) {
                    try {
                        res.end();
                    }
                    catch {
                        // already closed
                    }
                }
                session.ptySubscribers?.clear();
                for (const res of session.subscribers) {
                    try {
                        res.end();
                    }
                    catch {
                        // already closed
                    }
                }
                session.subscribers.clear();
            }
            for (const res of globalSubscribers) {
                try {
                    res.end();
                }
                catch {
                    // already closed
                }
            }
            globalSubscribers.clear();
            await new Promise((resolve) => server.close(() => resolve()));
            await client.stop();
            await closeServices();
        },
    };
}
/** Opens a URL in the user's default browser. */
export function openBrowser(url) {
    const platform = process.platform;
    const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
}
