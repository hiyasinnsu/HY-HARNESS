import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readHySession } from './logs.mjs'
import { runRounds } from './schedule.mjs'

function removeTemp(dir) {
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(dir, { recursive: true, force: true })
}

test('benchmark rounds rotate order and never overlap attempts of the same harness', async () => {
  const active = new Set()
  const started = []
  const finished = []
  await runRounds(['dsh', 'hy-fast', 'hy-thorough'], 3, 2, async (harness, round) => {
    assert.equal(active.has(harness), false)
    assert.ok(started.every(([, n]) => n <= round))
    assert.equal(finished.filter(([, n]) => n < round).length, (round - 1) * 3)
    active.add(harness)
    started.push([harness, round])
    await new Promise(resolve => setTimeout(resolve, harness === 'dsh' ? 8 : 1))
    active.delete(harness)
    finished.push([harness, round])
  })
  assert.deepEqual(started.filter(([, n]) => n === 1).map(([h]) => h), ['dsh', 'hy-fast', 'hy-thorough'])
  assert.deepEqual(started.filter(([, n]) => n === 2).map(([h]) => h), ['hy-fast', 'hy-thorough', 'dsh'])
  assert.deepEqual(started.filter(([, n]) => n === 3).map(([h]) => h), ['hy-thorough', 'dsh', 'hy-fast'])
  assert.equal(finished.length, 9)
})

test('benchmark config passes fixture Git trust to HY without restoring unrelated user integrations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-bench-config-'))
  try {
    const user = path.join(dir, 'user')
    fs.mkdirSync(user)
    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({
      sandbox: { envPassthrough: ['KEEP_ME'] }, mcpServers: { private: {} }, automation: { private: {} }, workspaceRoots: ['private'],
    }))
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--suite', 'stats', '--runs', '0', '--harness', 'hy', '--stamp', 'test', '--workdir', path.join(dir, 'work'), '--out', path.join(dir, 'results')], {
      encoding: 'utf8', env: { ...process.env, HY_CONFIG_DIR: user }, timeout: 20_000,
    })
    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'work', 'test-hy-config', 'config.json'), 'utf8'))
    assert.deepEqual(config.sandbox.envPassthrough, ['KEEP_ME', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'])
    for (const key of ['mcpServers', 'automation', 'workspaceRoots']) assert.equal(config[key], undefined)
  } finally {
    removeTemp(dir)
  }
})

test('benchmark rejects a different worker model before an attempt starts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-bench-model-'))
  try {
    const user = path.join(dir, 'user')
    fs.mkdirSync(user)
    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ roles: { worker: { provider: 'opencode', model: 'another-model', effort: 'max' } } }))
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--suite', 'stats', '--runs', '1', '--harness', 'hy-fast', '--stamp', 'test', '--workdir', path.join(dir, 'work'), '--out', path.join(dir, 'results')], { encoding: 'utf8', env: { ...process.env, HY_CONFIG_DIR: user }, timeout: 20_000 })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /benchmark worker must use opencode\/deepseek-v4\.1-flash/)
    assert.equal(fs.existsSync(path.join(dir, 'results', 'test', 'runs.jsonl')), false)
  } finally {
    removeTemp(dir)
  }
})

test('benchmark retains existing workspaces and records setup failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-bench-existing-'))
  try {
    const work = path.join(dir, 'work')
    const ws = path.join(work, 'test-dsh-1')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'keep.txt'), 'keep')
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--suite', 'tb2-async-windows', '--runs', '1', '--harness', 'dsh', '--stamp', 'test', '--workdir', work, '--out', path.join(dir, 'results')], { encoding: 'utf8', timeout: 20_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(path.join(ws, 'keep.txt'), 'utf8'), 'keep')
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'results', 'test', 'runs.jsonl'), 'utf8'))
    assert.equal(record.failureStage, 'setup')
    assert.equal(record.logMissing, true)
  } finally {
    removeTemp(dir)
  }
})

test('an empty fixture gets an initial commit and a failed launch is recorded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-bench-empty-'))
  try {
    const work = path.join(dir, 'work')
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--suite', 'tb2-async-windows', '--runs', '1', '--harness', 'dsh', '--stamp', 'test', '--workdir', work, '--out', path.join(dir, 'results')], { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: dir }, timeout: 20_000 })
    assert.equal(result.status, 0, result.stderr)
    const ws = path.join(work, 'test-dsh-1')
    const git = spawnSync('git', ['log', '-1', '--format=%s'], { cwd: ws, encoding: 'utf8' })
    assert.equal(git.status, 0, git.stderr)
    assert.equal(git.stdout.trim(), 'fixture')
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'results', 'test', 'runs.jsonl'), 'utf8'))
    assert.equal(record.failureStage, 'run')
    assert.equal(record.logMissing, true)
  } finally {
    removeTemp(dir)
  }
})

test('a timed-out attempt with passing checks is not reported as solved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-bench-report-'))
  try {
    const record = { harness: 'hy', n: 1, exit: null, checks: { example: true }, input: 1, miss: 1, output: 1, hitRate: 0, toolCalls: 1, requests: 1, activeMs: 0, wallMs: 900000, modelWaitMs: 1, harnessMs: 0, notFound: 0 }
    fs.writeFileSync(path.join(dir, 'runs.jsonl'), JSON.stringify(record) + '\n')
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./report.mjs', import.meta.url)), dir], { encoding: 'utf8', timeout: 20_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Solved \(exit 0 and every hidden check passed\) \| 0\/1/)
    assert.match(result.stdout, /– \(incomplete\)/)
  } finally {
    removeTemp(dir)
  }
})

test('missing cache fields do not become zero-hit measurements', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-bench-usage-'))
  try {
    const file = path.join(dir, 'session.v1.jsonl')
    const event = (usage) => JSON.stringify({ type: 'step/end', payload: { usage }, ts: 1, runId: 'run' })
    fs.writeFileSync(file, [event({ inputTokens: 10, outputTokens: 1, cacheHitTokens: 0 }), event({ inputTokens: 20, outputTokens: 1 })].join('\n') + '\n')
    const partial = readHySession(dir)
    assert.equal(partial.input, 30)
    assert.equal(partial.hitRate, null)
    assert.equal(partial.miss, null)
    assert.equal(partial.cacheReportedSteps, 1)
    fs.writeFileSync(file, [event({ inputTokens: 10, outputTokens: 1, cacheHitTokens: 0 }), event({ inputTokens: 20, outputTokens: 1, cacheHitTokens: 10 })].join('\n') + '\n')
    assert.equal(readHySession(dir).hitRate, 33.33)
  } finally {
    removeTemp(dir)
  }
})
