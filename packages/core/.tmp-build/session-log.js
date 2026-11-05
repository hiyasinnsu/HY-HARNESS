import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
/** Reads a log, ignoring a truncated last line (design §1). */
export function readEvents(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // A crash mid-write leaves at most one partial line.
        }
    }
    return out;
}
/** Last seq per log file, shared by every SessionLog of this process. */
const lastSeq = new Map();
export class SessionLog {
    file;
    sessionId = randomUUID();
    runId;
    round;
    constructor(file) {
        this.file = file;
        // Continue the file's numbering so seq orders events of all sessions in it.
        if (!lastSeq.has(file))
            lastSeq.set(file, readEvents(file).reduce((max, e) => Math.max(max, e.seq ?? 0), 0));
    }
    /** Tags the following events with a run (and a ralph round). */
    setRun(runId, round) {
        this.runId = runId;
        this.round = round;
    }
    get currentRunId() {
        return this.runId;
    }
    append(type, payload) {
        const seq = (lastSeq.get(this.file) ?? 0) + 1;
        lastSeq.set(this.file, seq);
        const event = {
            v: 1,
            seq,
            ts: Date.now(),
            sessionId: this.sessionId,
            ...(this.runId !== undefined ? { runId: this.runId } : {}),
            ...(this.round !== undefined ? { round: this.round } : {}),
            type,
            payload,
        };
        fs.appendFileSync(this.file, JSON.stringify(event) + '\n', 'utf8');
        return event;
    }
    events() {
        return readEvents(this.file);
    }
}
