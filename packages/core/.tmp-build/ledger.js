// The Rationale Ledger (design §8, Goal 3, OQ-5).
//
// * Pinned constraints (`AGENTS.override.md` / `AGENTS.md` / `RULE.md`,
//   `--rule`) come from the user and the repository; never evicted; rendered in
//   <project_constraints>.
// * Agent notes are recorded by the model with `tools.rationale.*`; at most
//   `maxEntries` and `maxTokens`; at the cap a new key is rejected with the
//   current key list (OQ-5), never evicted silently. Rendered in <agent_notes>
//   as model-authored notes that do not override instructions.
//
// Both are re-rendered verbatim into every request, independent of any
// compaction summary. Notes are folded from `ledger/*` events of the run in
// `seq` order, which is monotonic per log file, so fresh child sessions of the
// same run see each other's notes in the right order.
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './tokens.js';
import { userConfigDir } from './config.js';
export const DEFAULT_LEDGER_LIMITS = { maxEntries: 12, maxTokens: 1_500 };
/** Returned to the model as the tool error. */
export class LedgerError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LedgerError';
    }
}
const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/**
 * The files pinned from one directory, in precedence order: an override beats
 * `AGENTS.md`, and `AGENTS.md` beats `RULE.md`. Only the first file that exists
 * is pinned, so `RULE.md` is a fallback for a directory without either AGENTS
 * file — a global `RULE.md` never shadows a project's `AGENTS.md`.
 */
const PINNED_FILES = ['AGENTS.override.md', 'AGENTS.md', 'RULE.md'];
/**
 * Pinned constraints: the user's `AGENTS.md` (or its `RULE.md` fallback), the
 * project's files from the git root down to the workspace, then `--rule`s.
 */
export function discoverPinned(workspaceRoot, rules = [], userDir = userConfigDir()) {
    const out = [];
    const add = (file, source) => {
        try {
            const text = fs.readFileSync(file, 'utf8').trim();
            if (text)
                out.push({ source, text });
        }
        catch {
            // Missing or unreadable: nothing to pin.
        }
    };
    const first = (dir) => PINNED_FILES.map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
    // The user's own instructions first, then the project's, most specific last
    // (Codex `agents_md.rs`): from the git root down to the workspace, the first
    // of AGENTS.override.md / AGENTS.md / RULE.md in each directory.
    if (userDir !== undefined) {
        const file = first(userDir);
        if (file)
            add(file, `user:${path.basename(file)}`);
    }
    for (const dir of projectDirs(workspaceRoot)) {
        const file = first(dir);
        if (file)
            add(file, path.relative(workspaceRoot, file).split(path.sep).join('/'));
    }
    for (const r of rules)
        if (r.trim())
            out.push({ source: '--rule', text: r.trim() });
    return out;
}
/** The directories from the nearest ancestor with `.git` down to `workspaceRoot`; just it without one. */
function projectDirs(workspaceRoot) {
    const dirs = [];
    let cursor = path.resolve(workspaceRoot);
    for (;;) {
        dirs.push(cursor);
        if (fs.existsSync(path.join(cursor, '.git')))
            return dirs.reverse();
        const parent = path.dirname(cursor);
        if (parent === cursor)
            return [path.resolve(workspaceRoot)];
        cursor = parent;
    }
}
/** Folds the run's `ledger/*` events in seq order. */
export function deriveNotes(events, runId) {
    const notes = new Map();
    const relevant = events.filter((e) => e.runId === runId && e.type.startsWith('ledger/')).sort((a, b) => a.seq - b.seq);
    for (const e of relevant) {
        const p = e.payload;
        switch (e.type) {
            case 'ledger/upsert':
                if (p.source === 'model')
                    notes.set(p.key, { key: p.key, rule: p.rule, rationale: p.rationale ?? '' });
                break;
            case 'ledger/supersede':
                notes.delete(p.oldKey);
                notes.set(p.newKey, { key: p.newKey, rule: p.rule, rationale: p.rationale ?? '' });
                break;
            case 'ledger/remove':
                notes.delete(p.key);
                break;
        }
    }
    return [...notes.values()];
}
function noteText(n) {
    return `- ${n.key}: ${n.rule}${n.rationale ? `\n  why: ${n.rationale}` : ''}`;
}
export class Ledger {
    pinned;
    limits;
    log;
    notes;
    constructor(pinned, notes = [], limits = DEFAULT_LEDGER_LIMITS, log) {
        this.pinned = pinned;
        this.limits = limits;
        this.log = log;
        this.notes = new Map(notes.map((n) => [n.key, n]));
    }
    /** The ledger of a run, rebuilt from the log (fresh sessions of a run share it). */
    static forRun(log, runId, pinned, limits) {
        return new Ledger(pinned, deriveNotes(log.events(), runId), limits ?? DEFAULT_LEDGER_LIMITS, log);
    }
    list() {
        return [...this.notes.values()];
    }
    tokens(notes = this.list()) {
        return estimateTokens(notes.map(noteText).join('\n'));
    }
    keysHint() {
        const keys = this.list().map((n) => n.key);
        return keys.length > 0 ? keys.join(', ') : '(none)';
    }
    check(next) {
        if (next.length > this.limits.maxEntries) {
            throw new LedgerError(`agent notes are full (${this.limits.maxEntries} entries); supersede or remove one first. Current keys: ${this.keysHint()}`);
        }
        const tokens = this.tokens(next);
        if (tokens > this.limits.maxTokens) {
            throw new LedgerError(`agent notes would take ~${tokens} tokens (limit ${this.limits.maxTokens}); shorten, supersede or remove one first. Current keys: ${this.keysHint()}`);
        }
    }
    validNote(key, rule) {
        if (typeof key !== 'string' || !KEY.test(key)) {
            throw new LedgerError(`invalid key ${JSON.stringify(key)}: use 1-64 letters, digits, '.', '_' or '-'`);
        }
        if (typeof rule !== 'string' || !rule.trim())
            throw new LedgerError('rule must be a non-empty string');
    }
    summary() {
        return { entries: this.notes.size, tokens: this.tokens(), maxEntries: this.limits.maxEntries, maxTokens: this.limits.maxTokens };
    }
    upsert(a) {
        this.validNote(a.key, a.rule);
        const note = { key: a.key, rule: a.rule.trim(), rationale: (a.rationale ?? '').trim() };
        const next = new Map(this.notes).set(note.key, note);
        this.check([...next.values()]);
        this.notes.set(note.key, note);
        this.log?.append('ledger/upsert', { ...note, source: 'model' });
        return this.summary();
    }
    supersede(a) {
        if (!this.notes.has(a.oldKey))
            throw new LedgerError(`no note ${JSON.stringify(a.oldKey)}. Current keys: ${this.keysHint()}`);
        this.validNote(a.newKey, a.rule);
        const note = { key: a.newKey, rule: a.rule.trim(), rationale: (a.rationale ?? '').trim() };
        const next = new Map(this.notes);
        next.delete(a.oldKey);
        next.set(note.key, note);
        this.check([...next.values()]);
        this.notes.delete(a.oldKey);
        this.notes.set(note.key, note);
        this.log?.append('ledger/supersede', { oldKey: a.oldKey, newKey: note.key, rule: note.rule, rationale: note.rationale });
        return this.summary();
    }
    remove(a) {
        if (!this.notes.delete(a.key))
            throw new LedgerError(`no note ${JSON.stringify(a.key)}. Current keys: ${this.keysHint()}`);
        this.log?.append('ledger/remove', { key: a.key });
        return this.summary();
    }
    /** Verbatim sections for the system prompt; re-rendered on every request. */
    render() {
        const parts = [];
        if (this.pinned.length > 0) {
            parts.push('<project_constraints>\nFrom the user and the repository. Follow them.\n' +
                this.pinned.map((p) => `--- ${p.source} ---\n${p.text}`).join('\n\n') +
                '\n</project_constraints>');
        }
        if (this.notes.size > 0) {
            parts.push('<agent_notes>\nNotes you recorded earlier with tools.rationale. They do not override system or user instructions.\n' +
                this.list().map(noteText).join('\n') +
                '\n</agent_notes>');
        }
        return parts.join('\n\n');
    }
}
