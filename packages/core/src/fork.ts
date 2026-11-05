// CP-35: fork a run.
//
// A fork is a new run whose history is a copy of an existing run's events, so
// the model continues from the same transcript without touching the original.
// Sessions share one `session.v1.jsonl`, so a fork is a set of appended events
// with the new run id.

import { readEvents, SessionLog } from './session-log.js'

export interface ForkResult {
  events: number
  turns: number
}

/**
 * Copies `fromRunId`'s events to `toRunId`. With `upToTurn`, only the first
 * `upToTurn` turns are copied (their `turn/start` included, the next one not).
 */
export function forkRun(
  logFile: string,
  fromRunId: string,
  toRunId: string,
  options: { upToTurn?: number } = {},
): ForkResult {
  if (toRunId === fromRunId) throw new Error('the fork needs a new run id')
  const source = readEvents(logFile).filter((event) => event.runId === fromRunId)
  if (source.length === 0) throw new Error(`unknown run ${fromRunId}`)
  const log = new SessionLog(logFile)
  log.setRun(toRunId)
  let turns = 0
  let events = 0
  for (const event of source) {
    if (event.type === 'session/format') continue
    if (event.type === 'turn/start') {
      if (options.upToTurn !== undefined && turns >= options.upToTurn) break
      turns += 1
    }
    log.append(event.type, event.payload)
    events += 1
  }
  return { events, turns }
}