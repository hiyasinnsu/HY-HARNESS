// Live, synthetic check: native PTC, fast -> thorough -> fast, and cache usage.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const [workspaceArg, configArg, outputArg] = process.argv.slice(2)
if (!workspaceArg || !configArg || !outputArg) throw new Error('usage: node cache-switch-check.mjs <new-workspace> <sanitized-config-dir> <new-result-dir>')
const ws = path.resolve(workspaceArg)
const config = path.resolve(configArg)
const out = path.resolve(outputArg)
if (fs.existsSync(ws) || fs.existsSync(`${ws}.state`) || fs.existsSync(out)) throw new Error('experiment paths must be new')
fs.mkdirSync(ws, { recursive: false })
fs.mkdirSync(out, { recursive: false })
fs.writeFileSync(path.join(ws, 'notes.txt'), 'Public synthetic fixture.\n')
const commands = [
  'Use run_code to call tools.search.glob({ pattern: "*.txt" }) and report the file names.',
  '/work-mode thorough',
  'Reply with only the word SECOND.',
  '/work-mode fast',
  'Reply with only the word THIRD.',
  'Reply with only the word FOURTH.',
  '/exit',
]
const started = new Date().toISOString()
const files = ['packages/core/dist/agent.js', 'packages/core/dist/prompt.js', 'packages/core/dist/llm.js', 'packages/core/dist/tool-registry.js', 'packages/hy-cli/dist/main.js', 'packages/hy-cli/dist/session-app.js']
const hashes = Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]))
const args = [path.join(repo, 'packages/hy-cli/dist/main.js'), 'chat', '--cwd', ws, '--state-dir', `${ws}.state`, '--json', '--full-auto', '--ptc', '--work-mode', 'fast', '--exec-server', path.join(repo, 'target/release/hy-exec-server.exe')]
const result = spawnSync(process.execPath, args, { input: `${commands.join('\n')}\n`, env: { ...process.env, HY_CONFIG_DIR: config }, cwd: ws, encoding: 'utf8', timeout: 600_000, maxBuffer: 30_000_000, windowsHide: true })
fs.writeFileSync(path.join(out, 'stdout.jsonl'), result.stdout ?? '')
fs.writeFileSync(path.join(out, 'stderr.log'), result.stderr ?? '')
const log = path.join(`${ws}.state`, 'session.v1.jsonl')
const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []
let mode = 'Fast'
const steps = []
for (const event of events) {
  if (event.type === 'context/update') mode = event.payload.content.match(/Work mode: (Fast|Thorough)/)?.[1] ?? mode
  if (event.type === 'step/end') steps.push({ mode, step: event.payload.stepIndex, model: event.payload.model, systemSha256: event.payload.systemSha256, usage: event.payload.usage })
}
const summary = {
  started, commands, hashes, exit: result.status, signal: result.signal, error: result.error?.message,
  sessionLog: log,
  modes: events.filter(e => e.type === 'context/update').map(e => e.payload.content.match(/Work mode: (Fast|Thorough)/)?.[1] ?? 'missing'),
  steps,
  ptcCalls: events.filter(e => e.type === 'tool/result' && e.payload.name === 'run_code').map(e => ({ isError: e.payload.isError, output: e.payload.output })),
  turns: events.filter(e => e.type === 'turn/end').map(e => e.payload.status),
  retries: events.filter(e => e.type === 'turn/retry').map(e => e.payload),
}
summary.checks = {
  turnsCompleted: summary.turns.length === 4 && summary.turns.every(s => s === 'completed'),
  modesApplied: JSON.stringify(summary.modes) === JSON.stringify(['Fast', 'Thorough', 'Fast']),
  systemUnchanged: steps.length > 0 && steps.every(s => typeof s.systemSha256 === 'string' && s.systemSha256.length > 0) && new Set(steps.map(s => s.systemSha256)).size === 1,
  modelCorrect: steps.length > 0 && steps.every(s => s.model === 'opencode:deepseek-v4.1-flash'),
  ptcSucceeded: summary.ptcCalls.some(call => !call.isError && String(call.output).includes('notes.txt')),
  reportedHitAfterSwitch: steps.some(s => s.mode === 'Thorough' && (s.usage?.cacheHitTokens ?? 0) > 0),
}
fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify({ exit: result.status, turns: summary.turns, modes: summary.modes, steps: summary.steps.length, ptcCalls: summary.ptcCalls.length, output: out }))
if (result.status !== 0 || !summary.checks.turnsCompleted || !summary.checks.modesApplied || !summary.checks.systemUnchanged || !summary.checks.modelCorrect || !summary.checks.ptcSucceeded) process.exitCode = 1
