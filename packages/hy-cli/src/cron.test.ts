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
