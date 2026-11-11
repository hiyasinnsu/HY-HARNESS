// Reads one benchmark session from each harness's own log and normalizes it:
//   input   = every prompt token the provider processed (cached or not)
//   hit     = prompt tokens served from the provider's cache
//   output  = completion tokens (reasoning included where reported)
// HY logs `step/end` usage with inputTokens = the whole prompt. DSH logs
// `assistant/message` usage with inputTokens = the uncached part only, plus
// cacheReadTokens / cacheWriteTokens, so its whole prompt is their sum.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

function summarize(steps, toolCalls, turns, modelWaitMs, extra = {}) {
  const input = steps.every((s) => typeof s.input === 'number') ? steps.reduce((a, s) => a + s.input, 0) : null
  const reported = steps.filter((s) => typeof s.hit === 'number').length
  // `hit` stays null unless every step reported, so runs stay comparable; the
  // sum over the steps that did report is exposed for partial analyses.
  const hit = steps.length > 0 && reported === steps.length ? steps.reduce((a, s) => a + s.hit, 0) : null
  const hitReported = steps.reduce((a, s) => a + (typeof s.hit === 'number' ? s.hit : 0), 0)
  const output = steps.reduce((a, s) => a + s.output, 0)
  const activeMs = turns.reduce((a, t) => a + Math.max(0, t.end - t.start), 0)
  return {
    requests: steps.length,
    input,
    hit,
    hitReported,
    hitComplete: steps.length > 0 && reported === steps.length,
    miss: input !== null && hit !== null ? input - hit : null,
    output,
    hitRate: input !== null && input > 0 && hit !== null ? Math.round((hit / input) * 10_000) / 100 : null,
    cacheReportedSteps: reported,
    cacheTotalSteps: steps.length,
    toolCalls,
    turns: turns.length,
    turnMs: turns.map((t) => t.end - t.start),
    activeMs,
    // Provider wait on the main session (its speed varies a lot between
    // requests); harnessMs is the rest of the time in turns: tools, the
    // harness itself, and anything else under the harness's control.
    modelWaitMs,
    harnessMs: Math.max(0, activeMs - modelWaitMs),
    ...extra,
  }
}

function findFile(dir, name) {
  if (!fs.existsSync(dir)) return undefined
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(p, name)
      if (found) return found
    } else if (entry.name === name) return p
  }
  return undefined
}

export function readHySession(stateDir) {
  const file = findFile(stateDir, 'session.v1.jsonl')
  if (!file) return undefined
  const events = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
  // Subagent (`*.sub`) work is reported separately: its requests and tools are
  // not the main session's, and mixing them skewed per-turn and cache numbers.
  const steps = []
  const subSteps = []
  let toolCalls = 0
  let subToolCalls = 0
  const turns = []
  const open = new Map()
  let modelWaitMs = 0
  let lastTs = 0
  // A tool call written as body text and sent back (agent retry), and reads of a path that does not exist.
  let brokenCalls = 0
  let notFound = 0
  // Requests that did not repeat the previous one's prefix, by what changed
  // first (logged since the prefix diagnostics; absent in older logs).
  const prefixBreaks = { system: 0, tools: 0, history: 0 }
  // Harness controls that fired on the main session.
  const guards = { verifyNudges: 0, stallNotes: 0, stallStops: 0 }
  for (const e of events) {
    const main = !String(e.runId ?? '').includes('.sub')
    if (e.type === 'step/end') {
      const u = e.payload?.usage ?? {}
      const row = { input: u.inputTokens ?? 0, hit: typeof u.cacheHitTokens === 'number' ? u.cacheHitTokens : null, output: u.outputTokens ?? 0 }
      if (main) steps.push(row)
      else subSteps.push(row)
      // latencyMs is logged since 2026-11-07; older logs: since the previous event.
      if (main) modelWaitMs += typeof e.payload?.latencyMs === 'number' ? e.payload.latencyMs : Math.max(0, e.ts - lastTs)
      const changed = e.payload?.prefix?.changed
      if (main && changed in prefixBreaks) prefixBreaks[changed]++
    } else if (main && e.type === 'turn/nudge' && e.payload?.reason === 'final-without-verification') guards.verifyNudges++
    else if (main && e.type === 'guard/stall') {
      if (e.payload?.level === 3) guards.stallStops++
      else guards.stallNotes++
    } else if (e.type === 'tool/result') {
      if (main) toolCalls++
      else subToolCalls++
      if (e.payload?.isError === true && /does not exist|ENOENT|not found/i.test(String(e.payload?.output ?? '')) && /read|search/.test(String(e.payload?.name))) notFound++
    } else if (e.type === 'turn/retry' && e.payload?.reason === 'broken-tool-call') brokenCalls++
    else if (e.type === 'turn/start' && !String(e.runId ?? '').includes('.sub')) open.set(e.runId, e.ts)
    else if (e.type === 'turn/end' && open.has(e.runId)) {
      turns.push({ start: open.get(e.runId), end: e.ts })
      open.delete(e.runId)
    }
    // Events written after the response arrives (reasoning, the token check)
    // must not count as the request start in the old-log estimate.
    if (main && !['step/end', 'assistant/thinking', 'token/estimate'].includes(e.type)) lastTs = e.ts
  }
  return summarize(steps, toolCalls, turns, modelWaitMs, {
    logFile: file,
    brokenCalls,
    notFound,
    prefixBreaks,
    guards,
    // Subagent work, reported separately (not part of the main session's totals).
    subRequests: subSteps.length,
    subInput: subSteps.every((s) => typeof s.input === 'number') ? subSteps.reduce((a, s) => a + s.input, 0) : null,
    subOutput: subSteps.reduce((a, s) => a + s.output, 0),
    subToolCalls,
  })
}

// --- DSH: appended zstd frames of JSONL ---
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decodeFrames(buf) {
  const starts = []
  for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 1)) starts.push(i)
  let text = ''
  let consumed = 0
  for (let k = 0; k < starts.length; k++) {
    if (starts[k] < consumed) continue
    for (let j = k + 1; j <= starts.length; j++) {
      const end = j < starts.length ? starts[j] : buf.length
      try {
        text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
        consumed = end
        break
      } catch {
        // the magic bytes also occur inside compressed data: try a longer slice
      }
    }
  }
  return text
}
function dshEvents(file) {
  const buf = fs.readFileSync(file)
  const text = file.endsWith('.zstd') ? decodeFrames(buf) : buf.toString('utf8')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
}
function dshSessionDir(id) {
  const root = path.join(os.homedir(), '.dsh', 'sessions')
  if (!fs.existsSync(root)) return undefined
  for (const workspace of fs.readdirSync(root)) {
    const dir = path.join(root, workspace, id)
    if (fs.existsSync(dir)) return dir
  }
  return undefined
}
function dshLogFile(dir) {
  return fs.readdirSync(dir).map((n) => path.join(dir, n)).find((p) => /session\.v\d+\.jsonl(\.zstd)?$/.test(p))
}

export function readDshSession(sessionId) {
  const dir = dshSessionDir(sessionId)
  const file = dir && dshLogFile(dir)
  if (!file) return undefined
  const steps = []
  let toolCalls = 0
  const turns = []
  const pending = [file]
  const seen = new Set()
  let main = true
  let modelWaitMs = 0
  let notFound = 0
  const names = new Map()
  while (pending.length > 0) {
    const current = pending.shift()
    if (seen.has(current)) continue
    seen.add(current)
    let turnStart
    let stepStart
    for (const e of dshEvents(current)) {
      // Provider wait: from step/start to the step's assistant message (main session).
      if (main && e.type === 'step/start') stepStart = e.time
      if (e.type === 'assistant/message' && e.data?.usage) {
        if (main && stepStart !== undefined) {
          modelWaitMs += Math.max(0, e.time - stepStart)
          stepStart = undefined
        }
        const u = e.data.usage
        const output = u.outputTokens ?? 0
        const uncached = (u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0)
        const hit = typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : typeof u.totalTokens === 'number' && u.totalTokens === uncached + output ? 0 : null
        const input = hit !== null ? uncached + hit : typeof u.totalTokens === 'number' ? Math.max(0, u.totalTokens - output) : null
        steps.push({ input, hit, output })
      } else if (e.type === 'tool/call') {
        toolCalls++
        names.set(e.data?.callId, String(e.data?.name ?? ''))
      } else if (e.type === 'tool/result' && e.data?.message?.isError) {
        const text = (e.data.message.content ?? []).map((b) => b.text ?? '').join('')
        if (/not found|does not exist|ENOENT/i.test(text) && /read|glob|grep/.test(names.get(e.data.message.toolCallId) ?? '')) notFound++
      } else if (main && e.type === 'turn/start') turnStart = e.time
      else if (main && e.type === 'turn/end' && turnStart !== undefined) {
        turns.push({ start: turnStart, end: e.time })
        turnStart = undefined
      } else if (e.type === 'subagent/catalog' && e.data?.childId) {
        // Subagents keep their own session; their work counts toward the task.
        const childDir = dshSessionDir(e.data.childId) ?? path.join(path.dirname(dir), e.data.childId)
        const childFile = fs.existsSync(childDir) ? dshLogFile(childDir) : undefined
        if (childFile) pending.push(childFile)
      }
    }
    main = false
  }
  // DSH has no body-JSON retry path; 0 keeps the column comparable.
  return summarize(steps, toolCalls, turns, modelWaitMs, { logFile: file, brokenCalls: 0, notFound })
}
