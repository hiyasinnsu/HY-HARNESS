import { test } from 'node:test'
import assert from 'node:assert/strict'
// Import the built module: the other web tests do the same, and it keeps this
// file runnable without Node's TypeScript stripping.
import { orchestrationIntent } from '../dist/orchestration-intent.js'

test('a fresh chat starts an orchestration even while another one is active', () => {
  assert.equal(
    orchestrationIntent({ freshChat: true, activeRunId: 'run-old', currentRunId: undefined }),
    'start',
  )
})

test('a fresh chat starts an orchestration when nothing is active', () => {
  assert.equal(
    orchestrationIntent({ freshChat: true, activeRunId: undefined, currentRunId: undefined }),
    'start',
  )
})

test('viewing the active orchestrator stops it', () => {
  assert.equal(
    orchestrationIntent({ freshChat: false, activeRunId: 'run-orch', currentRunId: 'run-orch' }),
    'stop',
  )
})

test('viewing another chat opens the active orchestrator instead of stopping it', () => {
  assert.equal(
    orchestrationIntent({ freshChat: false, activeRunId: 'run-orch', currentRunId: 'run-chat' }),
    'open-active',
  )
  assert.equal(
    orchestrationIntent({ freshChat: false, activeRunId: 'run-orch', currentRunId: undefined }),
    'open-active',
  )
})

test('a fresh chat stays a start even when the active orchestrator is open', () => {
  // A blank chat is a new entry point, not the orchestrator itself: it must not
  // stop the orchestration it was created from.
  assert.equal(
    orchestrationIntent({ freshChat: true, activeRunId: 'run-orch', currentRunId: 'run-orch' }),
    'start',
  )
  assert.equal(
    orchestrationIntent({ freshChat: true, activeRunId: 'run-orch', currentRunId: 'run-chat' }),
    'start',
  )
})

