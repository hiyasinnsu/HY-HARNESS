// node bench/harness/report.mjs <results-dir> [more dirs...]
// Means with 95% confidence intervals (Student t) per harness, the HY - DSH
// difference with a Welch interval, and task success rates. Writes report.md
// next to the first runs.jsonl and prints it.
import fs from 'node:fs'
import path from 'node:path'
import { readDshSession, readHySession } from './logs.mjs'

const dirs = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--pair')
if (dirs.length === 0) {
  console.error('usage: node bench/harness/report.mjs <results-dir> [...]')
  process.exit(2)
}
const records = dirs.flatMap((d) =>
  fs.existsSync(path.join(d, 'runs.jsonl'))
    ? fs.readFileSync(path.join(d, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [],
)
// Re-read cache accounting from the original log: older records treated an
// absent provider field as zero and cannot establish a complete hit rate.
for (const r of records) {
  if (r.logMissing) continue
  const fresh = r.sessionId ? readDshSession(r.sessionId) : r.logFile && fs.existsSync(r.logFile) ? readHySession(path.dirname(r.logFile)) : undefined
  if (fresh) {
    for (const key of ['modelWaitMs', 'harnessMs', 'brokenCalls', 'notFound', 'subRequests', 'subInput', 'subOutput', 'subToolCalls']) if (r[key] === undefined) r[key] = fresh[key]
    for (const key of ['input', 'hit', 'miss', 'hitRate', 'cacheReportedSteps', 'cacheTotalSteps']) r[key] = fresh[key]
  } else {
    r.hit = r.miss = r.hitRate = null
  }
}

// Two-sided 95% t quantiles by degrees of freedom.
const T95 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042]
const t95 = (df) => (df < 1 ? NaN : df < T95.length ? T95[Math.floor(df)] : 1.96)
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const variance = (xs) => {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)
}
function ci(xs) {
  const m = mean(xs)
  const half = t95(xs.length - 1) * Math.sqrt(variance(xs) / xs.length)
  return { m, lo: m - half, hi: m + half, n: xs.length }
}
function welch(a, b) {
  const va = variance(a) / a.length
  const vb = variance(b) / b.length
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1))
  const d = mean(a) - mean(b)
  const half = t95(df) * Math.sqrt(va + vb)
  return { d, lo: d - half, hi: d + half, significant: d - half > 0 || d + half < 0 }
}

const METRICS = [
  ['input', 'Prompt tokens (cached + uncached)', (r) => typeof r.input === 'number' ? r.input : NaN],
  ['miss', 'Uncached prompt tokens', (r) => typeof r.miss === 'number' ? r.miss : NaN],
  ['output', 'Output tokens', (r) => r.output],
  ['hitRate', 'Cache hit rate (%)', (r) => typeof r.hitRate === 'number' ? r.hitRate : NaN],
  ['toolCalls', 'Tool calls', (r) => r.toolCalls],
  ['requests', 'Model requests', (r) => r.requests],
  // Provider speed varies a lot between requests: compare harness time
  // (time in turns minus model wait) first. Old runs without the split show –.
  ['harnessMin', 'Time excl. model wait (min)', (r) => (r.exit === 0 && typeof r.harnessMs === 'number' ? r.harnessMs / 60_000 : NaN)],
  ['waitMin', 'Model wait (min)', (r) => (typeof r.modelWaitMs === 'number' ? r.modelWaitMs / 60_000 : NaN)],
  ['activeMin', 'Time in turns (min)', (r) => (r.exit === 0 ? r.activeMs / 60_000 : NaN)],
  ['wallMin', 'Wall time (min)', (r) => r.wallMs / 60_000],
  // Subagent work (B10): the rows above are the main session only, as in
  // earlier reports; these add what delegated subagents used, and the sum.
  ['subRequests', 'Subagent model requests', (r) => (typeof r.subRequests === 'number' ? r.subRequests : NaN)],
  ['subInput', 'Subagent prompt tokens', (r) => (typeof r.subInput === 'number' ? r.subInput : NaN)],
  ['totalInput', 'Prompt tokens incl. subagents', (r) => (typeof r.input === 'number' && typeof r.subInput === 'number' ? r.input + r.subInput : NaN)],
  ['totalOutput', 'Output tokens incl. subagents', (r) => (typeof r.subOutput === 'number' ? r.output + r.subOutput : NaN)],
  ['brokenCalls', 'Tool calls written as text (retried)', (r) => r.brokenCalls ?? NaN],
  ['notFound', 'Reads of missing paths', (r) => r.notFound ?? NaN],
  ['solved', 'Solved (exit 0 and every hidden check passed)', (r) => (solved(r) ? 1 : 0)],
  ['checks', 'Hidden checks passed', (r) => passed(r)],
]

// `reward` (a suite's all-pass flag) is a summary, not one more check.
const checkEntries = (r) => Object.entries(r.checks ?? {}).filter(([k]) => k !== 'reward')
const passed = (r) => checkEntries(r).filter(([, v]) => v).length
const checkCount = (r) => checkEntries(r).length
const solved = (r) => r.exit === 0 && (typeof r.checks?.reward === 'boolean' ? r.checks.reward : checkCount(r) > 0 && passed(r) === checkCount(r))

const fmt = (x, metric) => {
  if (!Number.isFinite(x)) return '–'
  if (metric === 'hitRate') return x.toFixed(1)
  if (['activeMin', 'wallMin', 'harnessMin', 'waitMin', 'checks', 'solved', 'brokenCalls', 'notFound'].includes(metric)) return x.toFixed(2)
  return Math.round(x).toLocaleString('en-US')
}

// Only a recorded provider failure is excluded; zero requests alone does not
// establish whether the provider, harness, or local environment was at fault.
const failedByProvider = (r) => r.providerFailure === true
const valid = records.filter((r) => !r.logMissing && !failedByProvider(r))
const harnesses = [...new Set(valid.map((r) => r.harness))]
const by = Object.fromEntries(harnesses.map((h) => [h, valid.filter((r) => r.harness === h)]))
const lines = []
const meta = dirs.map((d) => path.join(d, 'meta.json')).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
lines.push(`# Harness benchmark ${meta.map((m) => m.stamp).join(', ')}`)
lines.push('')
lines.push(`Model ${meta[0]?.model ?? '?'} (OpenCode Go), effort ${meta[0]?.effort ?? '?'}; suite ${meta[0]?.suite ?? 'stats'}${meta[0]?.suiteDescription ? ` (${meta[0].suiteDescription})` : ''}; ${meta[0]?.tasks?.length ?? '?'} task(s) given in one session per run.`)
lines.push(`Runs: ${harnesses.map((h) => `${h} ${by[h].length}`).join(', ')}${records.some((r) => r.logMissing) ? ` (${records.filter((r) => r.logMissing).length} without a readable log, excluded)` : ''}${records.some(failedByProvider) ? ` (${records.filter(failedByProvider).map((r) => `${r.harness} #${r.n}`).join(', ')}: provider outage, excluded)` : ''}.`)
lines.push('')
// The difference column compares the first two harnesses: a variant against
// `hy`, or `hy` against `dsh` (`--pair a,b` picks them explicitly).
const pairArg = process.argv.indexOf('--pair')
const order = (h) => (h === 'dsh' ? 2 : h === 'hy' ? 1 : 0)
const [A, B] = pairArg > 0 ? process.argv[pairArg + 1].split(',') : [...harnesses].sort((a, b) => order(a) - order(b) || a.localeCompare(b))
const paired = Boolean(A && B && by[A] && by[B])
lines.push(`| Metric | ${harnesses.map((h) => `${h} mean [95% CI]`).join(' | ')}${paired ? ` | ${A} − ${B} [95% CI] |` : ' |'}`)
lines.push(`|---|${harnesses.map(() => '---|').join('')}${paired ? '---|' : ''}`)
for (const [key, label, get] of METRICS) {
  const cells = harnesses.map((h) => {
    if (key === 'solved') return `${by[h].filter(solved).length}/${by[h].length}`
    const c = ci(by[h].map(get))
    return `${fmt(c.m, key)} [${fmt(c.lo, key)}, ${fmt(c.hi, key)}]`
  })
  let diff = ''
  if (paired && key !== 'solved' && by[A].length > 1 && by[B].length > 1) {
    const w = welch(by[A].map(get), by[B].map(get))
    diff = ` ${fmt(w.d, key)} [${fmt(w.lo, key)}, ${fmt(w.hi, key)}]${w.significant ? ' *' : ''} |`
  } else if (paired) diff = ' – |'
  lines.push(`| ${label} | ${cells.join(' | ')} |${diff}`)
}
lines.push('')
lines.push('`*` = the 95% interval of the difference excludes 0.')
lines.push('Time and token intervals are exploratory approximations; success counts are shown without a t interval.')
lines.push('Cache totals and rates are unavailable when any step lacks provider-reported cache data.')
lines.push('')
lines.push('## Hidden checks (success rate)')
lines.push('')
const checkNames = [...new Set(valid.flatMap((r) => Object.keys(r.checks)))]
lines.push(`| Check | ${harnesses.join(' | ')} |`)
lines.push(`|---|${harnesses.map(() => '---|').join('')}`)
for (const name of checkNames) {
  lines.push(`| ${name} | ${harnesses.map((h) => `${by[h].filter((r) => r.checks[name]).length}/${by[h].length}`).join(' | ')} |`)
}
lines.push('')
lines.push('## Runs')
lines.push('')
lines.push('| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |')
lines.push('|---|---|---|---|---|---|---|---|---|---|')
for (const r of records) {
  if (failedByProvider(r)) {
    lines.push(`| ${r.harness} | ${r.n} | ${r.exit} | – | (provider outage: ${r.providerErrors ?? 'no requests'}) | | | | | |`)
    continue
  }
  if (r.logMissing) {
    lines.push(`| ${r.harness} | ${r.n} | ${r.exit} | ${passed(r)}/${checkCount(r)} | (${r.failureStage ? `${r.failureStage} failure: ${String(r.failure).replaceAll('|', '\\|').replaceAll('\n', ' ')}` : 'no log'}) | | | | | |`)
    continue
  }
  lines.push(
    `| ${r.harness} | ${r.n} | ${r.exit} | ${passed(r)}/${checkCount(r)} | ${r.input?.toLocaleString('en-US') ?? '–'} | ${r.miss?.toLocaleString('en-US') ?? '–'} | ${r.hitRate ?? `– (${r.cacheReportedSteps ?? '?'}/${r.cacheTotalSteps ?? '?'} steps)`} | ${r.toolCalls} | ${r.requests} | ${r.exit === 0 ? (r.activeMs / 60_000).toFixed(1) : '– (incomplete)'} |`,
  )
}
const text = `${lines.join('\n')}\n`
fs.writeFileSync(path.join(dirs[0], 'report.md'), text)
console.log(text)
