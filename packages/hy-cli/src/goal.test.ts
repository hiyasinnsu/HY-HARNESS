import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionLog, readEvents } from '../../core/dist/index.js'
import { GoalError, GoalStore } from './goal.js'

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-goal-'))
  const log = new SessionLog(path.join(dir, 'session.jsonl'))
  log.setRun('run-goal')
  return { dir, log, file: log.file }
}

test('goal lifecycle persists phases, revisions and activation', () => {
  const f = fixture()
  try {
    const goals = new GoalStore(f.log, 'run-goal', [])
    const created = goals.create('ship the migration', 10)
    assert.equal(created.phase, 'active')
    assert.equal(created.activation, 'armed')
    assert.equal(created.maxGoalRounds, 10)
    assert.equal(created.revision, 1)

    const paused = goals.pause()
    assert.equal(paused.phase, 'paused')
    assert.equal(paused.activation, 'disarmed')
    assert.equal(goals.beginRound(), undefined, 'a paused goal does not start a round')

    const resumed = goals.resume()
    assert.equal(resumed.phase, 'active')
    assert.equal(resumed.activation, 'armed')
    const round = goals.beginRound()
    assert.equal(round?.round, 1)
    assert.equal(goals.view()?.roundsStarted, 1)

    const completed = goals.complete()
    assert.equal(completed.phase, 'complete')
    assert.equal(goals.beginRound(), undefined)

    goals.clear()
    assert.equal(goals.view(), undefined)

    // A new process replays the log but never auto-arms the goal.
    const replayed = new GoalStore(f.log, 'run-goal', readEvents(f.file))
    assert.equal(replayed.view(), undefined, 'the clear tombstone wins')
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('goal replay disarms an active goal on a session-start edge', () => {
  const f = fixture()
  try {
    const goals = new GoalStore(f.log, 'run-goal', [])
    goals.create('keep going')
    const replayed = new GoalStore(f.log, 'run-goal', readEvents(f.file))
    assert.equal(replayed.view()?.phase, 'active')
    assert.equal(replayed.view()?.activation, 'disarmed')
    assert.equal(replayed.beginRound(), undefined)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('a legacy goal/set objective loads as an active goal', () => {
  const f = fixture()
  try {
    f.log.append('goal/set', { goal: 'legacy objective' })
    const goals = new GoalStore(f.log, 'run-goal', readEvents(f.file))
    assert.equal(goals.view()?.objective, 'legacy objective')
    assert.equal(goals.view()?.phase, 'active')
    assert.equal(goals.view()?.activation, 'disarmed')
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('blocked needs the same condition for three rounds; a human can block immediately', () => {
  const f = fixture()
  try {
    const goals = new GoalStore(f.log, 'run-goal', [])
    goals.create('blocked task')
    goals.beginRound()
    assert.throws(() => goals.block('missing credentials'), (error: unknown) => error instanceof GoalError && error.code === 'GOAL_BLOCK_NEEDS_ROUNDS')
    goals.beginRound()
    assert.throws(() => goals.block('missing credentials'), /2\/3/)
    goals.beginRound()
    const blocked = goals.block('missing credentials')
    assert.equal(blocked.phase, 'blocked')
    assert.equal(blocked.blockerReason, 'missing credentials')

    const resumed = goals.resume()
    assert.equal(resumed.phase, 'active')
    const immediate = goals.block('user stopped', { immediate: true })
    assert.equal(immediate.phase, 'blocked')
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('round cap and grader failures become blocked states', () => {
  const f = fixture()
  try {
    const capped = new GoalStore(f.log, 'run-goal', [])
    capped.create('cap', 2)
    assert.equal(capped.beginRound()?.round, 1)
    assert.equal(capped.beginRound()?.round, 2)
    assert.equal(capped.beginRound(), undefined)
    assert.equal(capped.view()?.phase, 'blocked')
    assert.equal(capped.view()?.blockerReason, 'round-limit')

    const graded = new GoalStore(f.log, 'run-goal', [])
    graded.create('grade', 10)
    graded.judgeFailed()
    graded.judgeFailed()
    const blocked = graded.judgeFailed()
    assert.equal(blocked.phase, 'blocked')
    assert.equal(blocked.blockerReason, 'grader-rejected')
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})
