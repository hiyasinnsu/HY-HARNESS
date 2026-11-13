import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from './memory.js'
import { MAX_CANDIDATES, MemoryPipeline, parseMemoryCandidates } from './memory-pipeline.js'

function fakeProvider(reply: string | (() => never)) {
  return {
    name: 'fake',
    calls: [] as unknown[],
    complete: async () => {
      if (typeof reply === 'function') return reply()
      return { content: reply, usage: { inputTokens: 0, outputTokens: 0 } }
    },
  }
}

const digest = { objective: 'fix the build', final: 'done', tools: ['shell'], files: [], runId: 'run-1' }

test('CP-20: candidates are parsed strictly', () => {
  const parsed = parseMemoryCandidates(
    JSON.stringify({ memories: [{ key: 'build.tool', text: 'pnpm builds', evidence: 'pnpm build' }] }),
  )
  assert.deepEqual(parsed.candidates, [{ key: 'build.tool', text: 'pnpm builds', evidence: 'pnpm build' }])
  assert.equal(parseMemoryCandidates('not json').error, 'the extractor returned non-JSON')
  assert.equal(parseMemoryCandidates('{"memories":"x"}').error, 'the extractor returned no memories array')
  assert.equal(parseMemoryCandidates(JSON.stringify({ memories: [{ key: 'Bad Key!', text: 'x' }] })).error, 'no usable memories in the reply')
  assert.equal(parseMemoryCandidates(JSON.stringify({ memories: Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, text: 't' })) })).candidates.length, MAX_CANDIDATES)
})

test('CP-20: extraction merges notes, dedupes by key and records the run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-memory-'))
  try {
    const store = MemoryStore.forStateDir(dir)
    const first = new MemoryPipeline({
      store,
      provider: fakeProvider(JSON.stringify({ memories: [{ key: 'build.tool', text: 'pnpm builds', evidence: 'pnpm build' }] })) as never,
    })
    assert.deepEqual(await first.run(digest), { applied: 1, skipped: 0 })
    assert.equal(store.list()[0]!.source, 'run-1')
    assert.equal(store.list()[0]!.evidence, 'pnpm build')

    const second = new MemoryPipeline({
      store,
      provider: fakeProvider(JSON.stringify({ memories: [{ key: 'build.tool', text: 'pnpm -r builds' }] })) as never,
    })
    assert.deepEqual(await second.run({ ...digest, runId: 'run-2' }), { applied: 1, skipped: 0 })
    assert.equal(store.list().length, 1, 'the same key replaces the note')
    assert.equal(store.list()[0]!.text, 'pnpm -r builds')
    assert.equal(store.list()[0]!.source, 'run-2')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-20: a full store skips new notes and a provider failure changes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-memory-full-'))
  try {
    const store = MemoryStore.forStateDir(dir)
    for (let i = 0; i < 20; i++) store.save(`k${i}`, `note ${i}`)
    const pipeline = new MemoryPipeline({
      store,
      provider: fakeProvider(JSON.stringify({ memories: [{ key: 'new-note', text: 'x' }] })) as never,
    })
    const result = await pipeline.run(digest)
    assert.equal(result.applied, 0)
    assert.equal(result.skipped, 1)
    assert.match(result.error!, /full/)
    assert.equal(store.list().length, 20)

    const failing = new MemoryPipeline({
      store,
      provider: fakeProvider(() => {
        throw new Error('HTTP 500')
      }) as never,
    })
    const failed = await failing.run(digest)
    assert.equal(failed.applied, 0)
    assert.match(failed.error!, /HTTP 500/)
    assert.equal(store.list().length, 20)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
test('the extraction sends the given effort, and none when none is given', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-mem-effort-'))
  try {
    const seen: Array<string | undefined> = []
    const provider = {
      name: 'fake',
      complete: async (_messages: unknown, options: { effort?: string }) => (seen.push(options.effort), { content: '{"memories":[]}', usage: { inputTokens: 0, outputTokens: 0 } }),
    }
    const digest = { objective: 'o', final: 'f', tools: [], files: [], runId: 'run-e' }
    await new MemoryPipeline({ store: MemoryStore.forStateDir(dir), provider: provider as never, effort: 'none' }).run(digest)
    await new MemoryPipeline({ store: MemoryStore.forStateDir(dir), provider: provider as never }).run(digest)
    assert.deepEqual(seen, ['none', undefined])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
