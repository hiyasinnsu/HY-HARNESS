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

function summarize(steps, toolCalls, turns, extra = {}) {
  const input = steps.reduce((a, s) => a + s.input, 0)
  const hit = steps.reduce((a, s) => a + s.hit, 0)
  const output = steps.reduce((a, s) => a + s.output, 0)
  const activeMs = turns.reduce((a, t) => a + Math.max(0, t.end - t.start), 0)
  return {
    requests: steps.length,
    input,
    hit,
    miss: input - hit,
    output,
    hitRate: input > 0 ? Math.round((hit / input) * 10_000) / 100 : 0,
    toolCalls,
    turns: turns.length,
    turnMs: turns.map((t) => t.end - t.start),
    activeMs,
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
  const steps = []
  let toolCalls = 0
  const turns = []
  const open = new Map()
  for (const e of events) {
    if (e.type === 'step/end') {
      const u = e.payload?.usage ?? {}
      steps.push({ input: u.inputTokens ?? 0, hit: u.cacheHitTokens ?? 0, output: u.outputTokens ?? 0 })
    } else if (e.type === 'tool/result') toolCalls++
    else if (e.type === 'turn/start' && !String(e.runId ?? '').includes('.sub')) open.set(e.runId, e.ts)
    else if (e.type === 'turn/end' && open.has(e.runId)) {
      turns.push({ start: open.get(e.runId), end: e.ts })
      open.delete(e.runId)
    }
  }
  return summarize(steps, toolCalls, turns, { logFile: file })
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
  while (pending.length > 0) {
    const current = pending.shift()
    if (seen.has(current)) continue
    seen.add(current)
    let turnStart
    for (const e of dshEvents(current)) {
      if (e.type === 'assistant/message' && e.data?.usage) {
        const u = e.data.usage
        const hit = u.cacheReadTokens ?? 0
        steps.push({ input: (u.inputTokens ?? 0) + hit + (u.cacheWriteTokens ?? 0), hit, output: u.outputTokens ?? 0 })
      } else if (e.type === 'tool/call') toolCalls++
      else if (main && e.type === 'turn/start') turnStart = e.time
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
  return summarize(steps, toolCalls, turns, { logFile: file })
}
