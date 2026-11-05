import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionIndex, searchableText } from './session-index.js'
import type { SessionEvent } from './session-log.js'

let seq = 0
const ev = (type: string, payload: unknown, runId = 'run-a'): SessionEvent => ({
  v: 1,
  seq: ++seq,
  ts: 1_700_000_000_000 + seq,
  sessionId: 's',
  runId,
  type,
  payload,
})

function logFile(dir: string, events: SessionEvent[]): string {
  const file = path.join(dir, 'session.v1.jsonl')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, events.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8')
  return file
}

test('the index finds Japanese and English text by substring', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-index-'))
  try {
    const file = logFile(dir, [
      ev('session/format', { format: 2 }),
      ev('user/message', { content: 'データベースの接続が切れる不具合を直してほしい' }),
      ev('assistant/message', { content: 'まず接続プールの設定を確認します。' }),
      ev('tool/result', { name: 'shell', output: 'Error: ECONNRESET while connecting to postgres', isError: true }),
      ev('assistant/message', { content: '{"tool":"read_file","args":{"path":"db.ts"}}' }),
      ev('user/message', { content: 'unrelated note about styling' }, 'run-b'),
    ])
    const index = SessionIndex.open(dir, dir)
    try {
      assert.equal(index.sync(file), 4, 'tool-call JSON is not indexed')
      assert.equal(index.sync(file), 0, 'a second sync has nothing to add')
      const japanese = index.search('接続')
      assert.equal(japanese.length, 2, JSON.stringify(japanese))
      assert.equal(japanese[0]!.runId, 'run-a')
      const english = index.search('ECONNRESET')
      assert.equal(english.length, 1)
      assert.equal(english[0]!.kind, 'tool/result')
      assert.match(english[0]!.snippet, /ECONNRESET/)
      // Filters and limits.
      assert.equal(index.search('unrelated').length, 1)
      assert.equal(index.search('unrelated', { excludeRunId: 'run-b' }).length, 0)
      assert.equal(index.search('接続', { limit: 1 }).length, 1)
      assert.equal(index.search('接続', { cwd: path.join(dir, 'elsewhere') }).length, 0)
      // Two characters cannot use the trigram tokenizer; LIKE still answers.
      assert.equal(index.search('接続').length, 2)
      const status = index.status()
      assert.equal(status.sessions, 2)
      assert.equal(status.events, 4)
      assert.ok(status.bytes > 0)
    } finally {
      index.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('incremental sync skips a torn last line and picks it up later', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-index-tail-'))
  try {
    const file = logFile(dir, [ev('user/message', { content: 'first question about caching' })])
    const torn = JSON.stringify(ev('user/message', { content: 'second question about indexing' }))
    fs.appendFileSync(file, torn.slice(0, 20), 'utf8')
    const index = SessionIndex.open(dir, dir)
    try {
      assert.equal(index.sync(file), 1)
      assert.equal(index.search('indexing').length, 0, 'the torn line is not indexed')
      fs.appendFileSync(file, `${torn.slice(20)}\n`, 'utf8')
      assert.equal(index.sync(file), 1, 'the completed line is picked up')
      assert.equal(index.search('indexing').length, 1)
    } finally {
      index.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a deleted or corrupt index is rebuilt from the log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-index-rebuild-'))
  try {
    const file = logFile(dir, [ev('user/message', { content: 'remember the flaky test' })])
    const first = SessionIndex.open(dir, dir)
    assert.equal(first.sync(file), 1)
    first.close()
    const dbFile = first.file
    assert.ok(fs.existsSync(dbFile))
    // Deleted: a fresh index starts empty and re-indexes on sync.
    fs.rmSync(dbFile, { force: true })
    let index = SessionIndex.open(dir, dir)
    assert.equal(index.status().events, 0)
    assert.equal(index.sync(file), 1)
    index.close()
    // Corrupt: open replaces it instead of throwing forever.
    fs.writeFileSync(dbFile, 'not a database at all', 'utf8')
    index = SessionIndex.open(dir, dir)
    try {
      assert.equal(index.sync(file), 1)
      assert.equal(index.search('flaky').length, 1)
      // rebuild() drops everything and re-reads the log.
      assert.equal(index.rebuild(file), 1)
      assert.equal(index.search('flaky').length, 1)
    } finally {
      index.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('only prose is searchable', () => {
  assert.equal(searchableText(ev('user/message', { content: 'hello' })), 'hello')
  assert.equal(searchableText(ev('assistant/message', { content: 'plain answer' })), 'plain answer')
  assert.equal(searchableText(ev('assistant/message', { content: '{"tool":"shell","args":{}}' })), undefined)
  assert.equal(searchableText(ev('assistant/message', { content: '{"calls":[{"tool":"shell"}]}' })), undefined)
  assert.equal(searchableText(ev('tool/result', { output: 'output text' })), 'output text')
  assert.equal(searchableText(ev('step/end', { usage: {} })), undefined)
  assert.equal(searchableText(ev('user/steer', { content: 'mid-run note' })), 'mid-run note')
})
