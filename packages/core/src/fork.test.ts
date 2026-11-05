import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { forkRun } from './fork.js'
import { SessionLog, readEvents } from './session-log.js'

function seed(dir: string): string {
  const file = path.join(dir, 'session.v1.jsonl')
  const log = new SessionLog(file)
  log.setRun('run-a')
  log.append('turn/start', { turn: 1 })
  log.append('user/message', { content: 'first' })
  log.append('assistant/message', { content: '{"final":"one"}' })
  log.append('turn/start', { turn: 2 })
  log.append('user/message', { content: 'second' })
  log.append('assistant/message', { content: '{"final":"two"}' })
  return file
}

test('CP-35: a fork copies the whole run under a new id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-fork-'))
  try {
    const file = seed(dir)
    const result = forkRun(file, 'run-a', 'run-b')
    assert.deepEqual(result, { events: 6, turns: 2 })
    const forked = readEvents(file).filter((event) => event.runId === 'run-b')
    assert.deepEqual(
      forked.map((event) => event.type),
      ['turn/start', 'user/message', 'assistant/message', 'turn/start', 'user/message', 'assistant/message'],
    )
    assert.equal((forked[1]!.payload as { content: string }).content, 'first')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-35: a fork can stop after a turn and rejects bad input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-fork-'))
  try {
    const file = seed(dir)
    const result = forkRun(file, 'run-a', 'run-c', { upToTurn: 1 })
    assert.equal(result.turns, 1)
    assert.equal(result.events, 3)
    const forked = readEvents(file).filter((event) => event.runId === 'run-c')
    assert.equal(forked.at(-1)!.type, 'assistant/message')
    assert.throws(() => forkRun(file, 'missing', 'run-d'), /unknown run missing/)
    assert.throws(() => forkRun(file, 'run-a', 'run-a'), /new run id/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})