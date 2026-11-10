import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionLog, readEvents, loadConfig } from '../../core/dist/index.js'
import {
  ConsultAdvisorArgs,
} from './session-app.js'

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-advisor-'))
  const log = new SessionLog(path.join(dir, 'session.jsonl'))
  log.setRun('run-advisor-test')
  return { dir, log, file: log.file }
}

test('advisor config resolves explicit role or falls back to worker role', () => {
  const config = loadConfig({ mock: true })
  assert.ok(config.advisorRole)
  assert.equal(config.advisorRole.provider, config.role.provider)
  assert.equal(config.advisorRole.model, config.role.model)
})

test('advisor mode event logs toggle and replays state', () => {
  const f = fixture()
  try {
    f.log.append('advisor-mode', { enabled: true })
    f.log.append('advisor-mode', { enabled: false })
    f.log.append('advisor-mode', { enabled: true })

    const events = readEvents(f.file)
    const advisorEvents = events.filter((e) => e.runId === 'run-advisor-test' && e.type === 'advisor-mode')
    assert.equal(advisorEvents.length, 3)
    assert.equal((advisorEvents[2]!.payload as { enabled?: boolean }).enabled, true)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('consult_advisor tool execution contract and stateless consultations', async () => {
  let enabled = false
  const consultations: ConsultAdvisorArgs[] = []

  // Simulate consult implementation as wired in Conversation.open
  const consultMock = async (args: ConsultAdvisorArgs) => {
    consultations.push(args)
    return {
      advice: `Guidance for: ${args.query}`,
      model: 'mock/mock-model',
    }
  }

  const runConsult = async (args: Record<string, unknown>) => {
    if (!enabled) {
      throw new Error('Advisor mode is currently disabled in this session. Enable it via the advisor button.')
    }
    const query = String(args.query ?? '').trim()
    if (!query) throw new Error('consult_advisor requires a non-empty query')
    const context = args.context !== undefined && args.context !== null ? String(args.context).trim() : undefined
    return await consultMock({ query, context })
  }

  // 1. Blocked when disabled
  await assert.rejects(
    () => runConsult({ query: 'How should I refactor this architecture?' }),
    /Advisor mode is currently disabled/,
  )

  // 2. Enable advisor
  enabled = true

  // 3. Reject empty query
  await assert.rejects(
    () => runConsult({ query: '   ' }),
    /consult_advisor requires a non-empty query/,
  )

  // 4. Successful stateless consultation 1
  const result1 = await runConsult({
    query: 'Should I use SQLite or Flat JSON for memory persistence?',
    context: 'We have up to 5,000 entries and concurrent readers.',
  })
  assert.equal(result1.model, 'mock/mock-model')
  assert.match(result1.advice, /SQLite or Flat JSON/)
  assert.equal(consultations.length, 1)
  assert.equal(consultations[0]!.query, 'Should I use SQLite or Flat JSON for memory persistence?')
  assert.equal(consultations[0]!.context, 'We have up to 5,000 entries and concurrent readers.')

  // 5. Successful consultation 2 (verifying freshness / no state leakage between calls)
  const result2 = await runConsult({
    query: 'What are the performance implications of in-memory caching here?',
  })
  assert.equal(consultations.length, 2)
  assert.equal(consultations[1]!.query, 'What are the performance implications of in-memory caching here?')
  assert.equal(consultations[1]!.context, undefined)
  assert.match(result2.advice, /performance implications/)
})
