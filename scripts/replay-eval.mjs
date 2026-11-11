#!/usr/bin/env node
// F1: replay saved session logs through the current agent loop (no model, no
// API cost) and report where the current code decides differently.
//
//   pnpm eval:replay <session.v1.jsonl> [more logs] [--json] [--run <runId>]
//
// Build first (`pnpm build` or `tsc -b packages/core`). A divergence is not a
// failure by itself: it is where a guard change acts on real history. Read the
// listed decisions to judge whether the change helps.
import { agentRuns, readEvents, replayRun } from '../packages/core/dist/index.js'

const args = process.argv.slice(2)
const json = args.includes('--json')
const runFilter = args.includes('--run') ? args[args.indexOf('--run') + 1] : undefined
const files = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--run')
if (files.length === 0) {
  console.error('usage: pnpm eval:replay <session.v1.jsonl> [...] [--json] [--run <runId>]')
  process.exit(2)
}

const results = []
for (const file of files) {
  const runs = agentRuns(readEvents(file)).filter((run) => !runFilter || run.runId === runFilter)
  for (const run of runs) results.push({ file, ...(await replayRun(run)) })
}

const count = (status) => results.filter((r) => r.status === status).length
if (json) {
  console.log(JSON.stringify({ total: results.length, same: count('same'), diverged: count('diverged'), unreplayable: count('unreplayable'), results }, null, 2))
} else {
  console.log(`replayed ${results.length} agent run(s): ${count('same')} same, ${count('diverged')} diverged, ${count('unreplayable')} unreplayable`)
  for (const r of results.filter((x) => x.status === 'diverged')) {
    const at = r.divergedAt ?? 0
    console.log(`\n${r.runId} (seq ${r.startSeq}, ${r.file})`)
    console.log(`  step ${at + 1}: logged ${r.logged[at] ?? '(nothing)'}  →  now ${r.replayed[at] ?? '(nothing)'}`)
    if (r.note) console.log(`  note: ${r.note}`)
  }
}
