import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/** Keep replays bounded; xterm keeps its own scrollback on the client. */
const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_INPUT_CHARS = 64 * 1024;
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;
function clamp(value, min, max, fallback) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    return Math.max(min, Math.min(max, Math.floor(value)));
}
/** The interactive shell for this platform. HY_PTY_SHELL is an executable override (tests). */
function shellSpec() {
    const override = process.env.HY_PTY_SHELL?.trim();
    if (override)
        return { file: override, args: [], label: path.basename(override) };
    if (process.platform === 'win32') {
        const pwsh = process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe') : '';
        if (pwsh && fs.existsSync(pwsh))
            return { file: pwsh, args: ['-NoLogo'], label: 'pwsh' };
        const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        if (fs.existsSync(powershell))
            return { file: powershell, args: ['-NoLogo'], label: 'PowerShell' };
        return { file: process.env.ComSpec ?? 'cmd.exe', args: [], label: 'cmd' };
    }
    const shell = process.env.SHELL ?? '/bin/bash';
    return { file: shell, args: ['-l'], label: path.basename(shell) };
}
function childEnv() {
    const out = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined)
            out[key] = value;
    }
    out.TERM = 'xterm-256color';
    out.COLORTERM = 'truecolor';
    out.HY_HARNESS = '1';
    return out;
}
/**
 * A single long-lived shell for one GUI session. It is deliberately independent
 * of the one-shot `exec/command` path: the PTY is user-driven, is never offered
 * to the model, and therefore does not pass through tool approvals.
 */
export class PersistentPty {
    cwd;
    proc;
    listeners = new Set();
    output = '';
    exit;
    error;
    shell = '';
    cols = 120;
    rows = 30;
    constructor(cwd) {
        this.cwd = cwd;
    }
    get running() {
        return this.proc !== undefined;
    }
    start(options = {}) {
        const cols = clamp(options.cols, MIN_COLS, MAX_COLS, this.cols);
        const rows = clamp(options.rows, MIN_ROWS, MAX_ROWS, this.rows);
        this.cols = cols;
        this.rows = rows;
        if (this.proc) {
            this.proc.resize(cols, rows);
            return this.status();
        }
        const spec = shellSpec();
        const pty = require('node-pty');
        this.output = '';
        this.exit = undefined;
        this.error = undefined;
        this.shell = spec.label;
        try {
            const proc = pty.spawn(spec.file, spec.args, {
                name: 'xterm-256color',
                cols,
                rows,
                cwd: this.cwd,
                env: childEnv(),
            });
            this.proc = proc;
            proc.onData((data) => {
                if (this.proc !== proc)
                    return;
                this.append(data);
                this.emit({ type: 'data', data });
            });
            proc.onExit(({ exitCode, signal }) => {
                // stop() clears this.proc before kill(); a restarted shell must not be
                // clobbered by the old process's late exit event.
                if (this.proc !== proc)
                    return;
                this.proc = undefined;
                this.exit = { exitCode, ...(signal !== undefined ? { signal } : {}) };
                this.emit({ type: 'exit', exitCode, ...(signal !== undefined ? { signal } : {}) });
            });
        }
        catch (cause) {
            this.error = cause instanceof Error ? cause.message : String(cause);
            throw cause;
        }
        return this.status();
    }
    write(data) {
        if (!this.proc)
            throw new Error('the persistent shell is not running');
        if (data.length > MAX_INPUT_CHARS)
            throw new Error('terminal input is too large');
        if (data.length > 0)
            this.proc.write(data);
    }
    resize(cols, rows) {
        this.cols = clamp(cols, MIN_COLS, MAX_COLS, this.cols);
        this.rows = clamp(rows, MIN_ROWS, MAX_ROWS, this.rows);
        this.proc?.resize(this.cols, this.rows);
        return this.status();
    }
    clear() {
        this.output = '';
        this.emit({ type: 'reset', status: this.status() });
        return this.status();
    }
    stop() {
        const proc = this.proc;
        if (proc) {
            this.proc = undefined;
            try {
                proc.kill();
            }
            catch {
                // The process may already have exited between the check and kill.
            }
        }
        return this.status();
    }
    dispose() {
        this.stop();
        this.listeners.clear();
        this.output = '';
    }
    status() {
        return {
            running: this.proc !== undefined,
            ...(this.proc ? { pid: this.proc.pid } : {}),
            shell: this.shell,
            cwd: this.cwd,
            cols: this.cols,
            rows: this.rows,
            output: this.output,
            ...(this.exit ? { exit: this.exit } : {}),
            ...(this.error ? { error: this.error } : {}),
        };
    }
    onEvent(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    append(data) {
        this.output += data;
        if (this.output.length > MAX_OUTPUT_CHARS) {
            this.output = this.output.slice(this.output.length - MAX_OUTPUT_CHARS);
        }
    }
    emit(event) {
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            }
            catch {
                this.listeners.delete(listener);
            }
        }
    }
}
