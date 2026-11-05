import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionLog } from '../../core/dist/index.js'
import { ERROR, ProtocolRpcError } from './protocol.js'
import { listThreads, readThread } from './protocol-threads.js'

test('CP-25: thread/list groups the runs of one session log newest first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-threads-'))
  try {
    const file = path.join(dir, 'session.v1.jsonl')
    const log = new SessionLog(file)
    log.setRun('run-a')
    log.append('user/message', { content: 'old task' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    log.setRun('run-b')
    log.append('user/message', { content: 'Fix the build\nthen tests' })
    log.append('assistant/message', { content: '{"final":"ok"}' })
    log.append('tool/result', { name: 'shell', output: 'done' })

    const threads = listThreads(file)
    assert.equal(threads.length, 2)
    assert.equal(threads[0]!.threadId, 'run-b', 'the newest run comes first')
    assert.equal(threads[0]!.title, 'Fix the build')
    assert.equal(threads[0]!.turns, 1)
    assert.equal(threads[0]!.events, 3, 'session/format is not part of a run')
    assert.equal(threads[1]!.threadId, 'run-a')
    assert.deepEqual(listThreads(path.join(dir, 'missing.jsonl')), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-25: thread/read maps one run and rejects unknown runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-threads-'))
  try {
    const file = path.join(dir, 'session.v1.jsonl')
    const log = new SessionLog(file)
    log.setRun('run-a')
    log.append('user/message', { content: 'do it' })
    log.append('assistant/message', { content: '{"tool":"read_file","args":{"path":"a"}}' })
    log.append('tool/result', { name: 'read_file', output: 'content' })
    log.append('tool-error', { name: 'shell', message: 'boom' })
    log.setRun('run-b')
    log.append('user/message', { content: 'other run' })

    const view = readThread(file, 'run-a')
    assert.equal(view.threadId, 'run-a')
    assert.deepEqual(
      view.items.map((item) => item.role),
      ['user', 'assistant', 'tool', 'error'],
    )
    assert.equal(view.items[2]!.name, 'read_file')
    assert.equal(view.items[3]!.text, 'boom')
    assert.throws(
      () => readThread(file, 'no-such-run'),
      (error: unknown) => error instanceof ProtocolRpcError && error.code === ERROR.invalidParams,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-25: thread/list honours a limit parameter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-threads-'))
  try {
    const file = path.join(dir, 'session.v1.jsonl')
    const log = new SessionLog(file)
    for (const run of ['run-a', 'run-b', 'run-c']) {
      log.setRun(run)
      log.append('user/message', { content: run })
    }
    assert.equal(listThreads(file, { limit: 2 }).length, 2)
    assert.equal(listThreads(file, { limit: 0 }).length, 0)
    assert.equal(listThreads(file).length, 3)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-25: thread/read paginates with offset and limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-threads-'))
  try {
    const file = path.join(dir, 'session.v1.jsonl')
    const log = new SessionLog(file)
    log.setRun('run-a')
    for (let i = 0; i < 4; i++) log.append('user/message', { content: `m${i}` })
    const page = readThread(file, 'run-a', { offset: 1, limit: 2 })
    assert.equal(page.total, 4)
    assert.equal(page.title, 'm0')
    assert.equal(page.items.length, 2)
    assert.equal(page.items[0]!.text, 'm1')
    assert.equal(readThread(file, 'run-a', { offset: 3 }).items.length, 1)
    assert.equal(readThread(file, 'run-a', { limit: 0 }).items.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})