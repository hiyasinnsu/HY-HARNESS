import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queueBadgeLabel, sendIntent, steerToggleLabel } from '../dist/turn-queue-intent.js'

test('a submit during a running turn steers it instead of being rejected', () => {
  assert.equal(sendIntent(true), 'steer')
})

test('the composer can choose the queue instead of steering', () => {
  assert.equal(sendIntent(true, 'queue'), 'queue')
  assert.equal(sendIntent(true, 'steer'), 'steer')
})

test('a submit while idle sends immediately, whatever the toggle says', () => {
  assert.equal(sendIntent(false), 'send-now')
  assert.equal(sendIntent(false, 'queue'), 'send-now')
})

test('the steer toggle is labelled with what a submit will do', () => {
  assert.match(steerToggleLabel('steer', 'ja'), /割り込/)
  assert.match(steerToggleLabel('queue', 'ja'), /ターン後/)
  assert.notEqual(steerToggleLabel('steer', 'en'), steerToggleLabel('queue', 'en'))
})

test('an empty queue has no badge label', () => {
  assert.equal(queueBadgeLabel(0, 'en'), '')
  assert.equal(queueBadgeLabel(0, 'ja'), '')
})

test('the badge label contains the count', () => {
  assert.match(queueBadgeLabel(2, 'ja'), /2/)
  assert.match(queueBadgeLabel(2, 'ja'), /予約/)
})

test('the badge label is localised', () => {
  assert.match(queueBadgeLabel(2, 'en'), /queued/)
  assert.notEqual(queueBadgeLabel(2, 'en'), queueBadgeLabel(2, 'ja'))
})

test('a blank chat has no queue to show', () => {
  assert.equal(queueBadgeLabel(0, 'zh'), '')
})
