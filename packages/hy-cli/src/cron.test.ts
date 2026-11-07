import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cronMatches, nextCronTime, parseCron } from './cron.js'

const at = (iso: string) => new Date(iso)

test('cron matches steps, ranges and weekdays', () => {
  assert.equal(cronMatches('*/5 * * * *', at('2026-11-03T10:10:00')), true)
  assert.equal(cronMatches('*/5 * * * *', at('2026-11-03T10:11:00')), false)
  assert.equal(cronMatches('0 9 * * 1-5', at('2026-11-02T09:00:00')), true) // Monday
  assert.equal(cronMatches('0 9 * * 1-5', at('2026-11-01T09:00:00')), false) // Sunday
  assert.equal(cronMatches('0 0 1 * *', at('2026-11-01T00:00:00')), true)
  assert.equal(cronMatches('0 0 1 * *', at('2026-11-02T00:00:00')), false)
})

test('cron validates fields and computes the next minute', () => {
  assert.equal(parseCron('* * * *'), undefined)
  assert.equal(parseCron('61 * * * *'), undefined)
  assert.equal(parseCron('*/0 * * * *'), undefined)
  const next = nextCronTime('*/5 * * * *', at('2026-11-03T10:10:30'))
  assert.equal(next?.toISOString(), at('2026-11-03T10:15:00').toISOString())
})

test('a */n day or weekday field keeps its step (Vixie semantics)', () => {
  // Every other day of the month: the 2nd is not in */2 (1, 3, 5, ...).
  assert.equal(cronMatches('0 9 */2 * *', at('2026-03-02T09:00:00')), false)
  assert.equal(cronMatches('0 9 */2 * *', at('2026-03-03T09:00:00')), true)
  // A step on day-of-month and a restricted weekday: both must match.
  assert.equal(cronMatches('0 9 */2 * 1', at('2026-03-02T09:00:00')), false, 'Monday, even day')
  assert.equal(cronMatches('0 9 */2 * 1', at('2026-03-09T09:00:00')), true, 'Monday, odd day')
  // Two restricted fields still use OR.
  assert.equal(cronMatches('0 9 15 * 1', at('2026-03-02T09:00:00')), true, 'a Monday')
  assert.equal(cronMatches('0 9 15 * 1', at('2026-03-15T09:00:00')), true, 'the 15th')
  assert.equal(cronMatches('0 9 15 * 1', at('2026-03-03T09:00:00')), false)
})
