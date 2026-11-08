import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSuite } from './security-holdout.mjs'

const cacheRoot = process.env.HY_SECURITY_BENCH_CACHE
test('security verifier rejects the vulnerable fixture and accepts the pinned original', { skip: !cacheRoot && 'set HY_SECURITY_BENCH_CACHE to the pinned public fixture cache', timeout: 180_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-security-bench-'))
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
  try {
    const suite = createSuite({ cacheRoot })
    const bad = path.join(dir, 'vulnerable')
    fs.mkdirSync(bad)
    await suite.prepare(bad)
    fs.writeFileSync(path.join(bad, 'report.jsonl'), JSON.stringify({ file_path: 'bottle.py', cwe_id: ['cwe-93'] }) + '\n')
    const failed = await suite.check(bad)
    assert.equal(failed.vul_file, true, JSON.stringify(failed))
    assert.equal(failed.hkey_error_cases, false, JSON.stringify(failed))
    assert.equal(failed.reward, false)

    const good = path.join(dir, 'original')
    fs.mkdirSync(good)
    await suite.prepare(good)
    const archive = path.join(cacheRoot, 'security-holdout-2fd12b88aafd', 'bottle-lf.tar')
    const original = spawnSync('tar', ['-xOf', archive, 'bottle.py'], { encoding: 'utf8', maxBuffer: 10_000_000 })
    assert.equal(original.status, 0, original.stderr)
    fs.writeFileSync(path.join(good, 'bottle.py'), original.stdout)
    fs.writeFileSync(path.join(good, 'report.jsonl'), JSON.stringify({ file_path: path.join(good, 'bottle.py'), cwe_id: ['cwe-93'] }) + '\n')
    fs.writeFileSync(path.join(good, 'test', 'test_app.py'), 'raise AssertionError("workspace test must not be used by the grader")\n')
    fs.writeFileSync(path.join(good, 'pytest.ini'), '[pytest]\naddopts = --not-a-real-option\n')
    const passed = await suite.check(good)
    assert.equal(passed.reward, true, `${JSON.stringify(passed)}\n${fs.readFileSync(`${good}.grader/original-repo.log`, 'utf8')}\n${fs.readFileSync(`${good}.grader/official.log`, 'utf8')}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
