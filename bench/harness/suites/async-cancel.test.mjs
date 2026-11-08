import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSuite } from './async-cancel.mjs'

test('adapted cancellation verifier rejects no solution and checks a working solution', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-async-bench-'))
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
  const ws = path.join(dir, 'work')
  fs.mkdirSync(ws)
  try {
    const suite = createSuite()
    assert.ok(Object.values(await suite.check(ws)).every((v) => !v))
    fs.writeFileSync(path.join(ws, 'run.py'), `import asyncio\nasync def run_tasks(tasks, max_concurrent):\n    pending = iter(tasks)\n    async def worker():\n        while True:\n            try:\n                fn = next(pending)\n            except StopIteration:\n                return\n            await fn()\n    await asyncio.gather(*(worker() for _ in range(min(len(tasks), max_concurrent))))\n`)
    assert.deepEqual(await suite.check(ws), { file_loads: true, concurrent: true, bounded: true, cancel_active: true, cancel_queued: true })
    fs.writeFileSync(path.join(ws, 'run.py'), `async def run_tasks(tasks, max_concurrent):\n    for fn in tasks:\n        await fn()\n`)
    // Clear the bytecode cache: the two source files can share a timestamp.
    const cache = path.resolve(ws, '__pycache__')
    assert.ok(cache.startsWith(path.resolve(ws) + path.sep))
    fs.rmSync(cache, { recursive: true, force: true })
    const sequential = await suite.check(ws)
    assert.equal(sequential.concurrent, false)
    assert.equal(sequential.cancel_queued, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
