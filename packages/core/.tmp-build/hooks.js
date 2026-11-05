// User hooks: commands run at fixed points of a session (Codex `notify` and
// hook runtime, DSH hook plugins). They come from the user's config or a
// trusted project's, and run unconfined, as the user, without a shell:
//
//   "hooks": {
//     "preToolUse":  [{ "command": ["node", "check.mjs"], "tools": ["shell"] }],
//     "postToolUse": [{ "command": ["node", "log.mjs"] }],
//     "turnEnd":     [{ "command": ["node", "notify.mjs"] }]
//   },
//   "notify": ["powershell", "-File", "toast.ps1"]
//
// Each hook gets one JSON object on stdin. A preToolUse hook that exits with
// code 2 blocks the call; its stderr is the reason the model sees. Any other
// failure is reported and ignored. `notify` gets the turn-end JSON as its last
// argument (Codex's convention) and is not awaited for long.
import { spawn } from 'node:child_process';
export function runHook(command, stdin, timeoutMs = 10_000, extraArg) {
    return new Promise((resolve) => {
        const [exe, ...args] = command;
        if (!exe) {
            resolve({ code: null, stdout: '', stderr: 'empty hook command', timedOut: false });
            return;
        }
        const child = spawn(exe, extraArg === undefined ? args : [...args, extraArg], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);
        child.stdout.on('data', (d) => (stdout = (stdout + d.toString('utf8')).slice(-8_000)));
        child.stderr.on('data', (d) => (stderr = (stderr + d.toString('utf8')).slice(-8_000)));
        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ code: null, stdout, stderr: error.message, timedOut });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr, timedOut });
        });
        child.stdin.on('error', () => {
            // The hook may exit without reading stdin.
        });
        child.stdin.end(stdin);
    });
}
export class Hooks {
    config;
    notifyCommand;
    report;
    constructor(config = {}, notifyCommand, report = () => { }) {
        this.config = config;
        this.notifyCommand = notifyCommand;
        this.report = report;
    }
    get empty() {
        return !this.config.preToolUse?.length && !this.config.postToolUse?.length && !this.config.turnEnd?.length && !this.notifyCommand;
    }
    matching(list, tool) {
        return (list ?? []).filter((h) => !h.tools || h.tools.includes(tool));
    }
    /** Runs the preToolUse hooks; returns the block reason when one exits with 2. */
    async preToolUse(tool, args) {
        for (const h of this.matching(this.config.preToolUse, tool)) {
            const r = await runHook(h.command, JSON.stringify({ event: 'preToolUse', tool, args }), h.timeoutMs);
            if (r.code === 2)
                return r.stderr.trim() || `blocked by hook ${h.command.join(' ')}`;
            if (r.code !== 0)
                this.report(`hook ${h.command.join(' ')} failed (${r.timedOut ? 'timed out' : `exit ${String(r.code)}`}): ${r.stderr.trim().slice(0, 300)}`);
        }
        return undefined;
    }
    async postToolUse(tool, args, outcome) {
        for (const h of this.matching(this.config.postToolUse, tool)) {
            const r = await runHook(h.command, JSON.stringify({ event: 'postToolUse', tool, args, ...outcome }), h.timeoutMs);
            if (r.code !== 0)
                this.report(`hook ${h.command.join(' ')} failed (exit ${String(r.code)}): ${r.stderr.trim().slice(0, 300)}`);
        }
    }
    async turnEnd(payload) {
        const json = JSON.stringify({ event: 'turnEnd', type: 'agent-turn-complete', ...payload });
        for (const h of this.config.turnEnd ?? []) {
            const r = await runHook(h.command, json, h.timeoutMs);
            if (r.code !== 0)
                this.report(`hook ${h.command.join(' ')} failed (exit ${String(r.code)}): ${r.stderr.trim().slice(0, 300)}`);
        }
        if (this.notifyCommand) {
            const r = await runHook(this.notifyCommand, '', 10_000, json);
            if (r.code !== 0)
                this.report(`notify failed (exit ${String(r.code)}): ${r.stderr.trim().slice(0, 300)}`);
        }
    }
}
