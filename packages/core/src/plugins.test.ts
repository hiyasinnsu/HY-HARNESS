import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlugins } from './plugins.js'
import { ToolRuntime } from './tools.js'
import { buildSystemPrompt, nativeToolDefs } from './prompt.js'

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'plugin-sample.mjs')

test('plugins: valid tools load, invalid ones are reported, tools run and are offered', async () => {
  const loaded = await loadPlugins([fixture, path.join(os.tmpdir(), 'no-such-plugin.mjs')])
  assert.deepEqual([...loaded.tools.keys()], ['word_count'])
  assert.equal(loaded.errors.length, 4)
  assert.match(loaded.errors.join('\n'), /tool read_file already exists/)
  assert.match(loaded.errors.join('\n'), /invalid tool name "Bad Name"/)
  assert.match(loaded.errors.join('\n'), /tool no_run has no run function/)
  assert.match(loaded.errors.join('\n'), /no-such-plugin\.mjs/)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-plugin-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one two  three\nfour')
    const tools = new ToolRuntime({} as never, dir, undefined, false, { plugins: loaded.tools })
    assert.deepEqual(await tools.execute('word_count', { path: 'a.txt' }), { words: 4 })
    await assert.rejects(tools.execute('word_count', {}), (error: Error) => {
      assert.match(error.message, /invalid arguments for word_count: args\.path is required/)
      assert.match(error.message, /Expected arguments: \{ path: string \}/)
      assert.match(error.message, /inside "args", not beside "tool"/)
      return true
    })
    assert.equal(tools.isReadOnly('word_count'), true)

    const extraTools = [...loaded.tools.values()].map((t) => t.spec)
    assert.match(buildSystemPrompt(dir, false, false, { extraTools }), /- word_count\(args: \{ path: string \}\)/)
    assert.match(buildSystemPrompt(dir, true, false, { extraTools }), /tools\.plugins\.word_count = word_count/)
    assert.ok(nativeToolDefs(false, false, { extraTools }).some((t) => t.name === 'word_count'))
    assert.doesNotMatch(buildSystemPrompt(dir), /word_count/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
