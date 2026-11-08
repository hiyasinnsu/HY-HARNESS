import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workspaceRootsFor } from './config.js'
import { ToolRuntime, searchBudget } from './tools.js'

// Regression: the walker used to yield paths relative to the directory being
// listed, so nested files came back as bare basenames. `docs/*.md` matched
// nothing, `**/*.md` lost the directories, and grep read `<root>/<basename>`
// once per same-named file (the root package.json, over and over).
function nested() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-walk-'))
  fs.mkdirSync(path.join(dir, 'docs', 'adr'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'packages', 'a'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"root"}\n')
  fs.writeFileSync(path.join(dir, 'packages', 'a', 'package.json'), '{"name":"@hy/a"}\n')
  fs.writeFileSync(path.join(dir, 'docs', 'intro.md'), '# Intro\n')
  fs.writeFileSync(path.join(dir, 'docs', 'adr', '0001.md'), '# ADR\n')
  const tools = new ToolRuntime({} as never, dir, undefined, false, { roots: workspaceRootsFor(dir, []), spillDir: path.join(dir, '.spill') })
  return { dir, tools }
}

test('search_glob returns root-relative paths and matches directory patterns', async () => {
  const { dir, tools } = nested()
  try {
    const glob = async (pattern: string) => ((await tools.execute('search_glob', { pattern }, true)) as { files: string[] }).files
    assert.deepEqual(await glob('**/*.md'), ['docs/adr/0001.md', 'docs/intro.md'])
    assert.deepEqual(await glob('docs/*.md'), ['docs/intro.md'])
    assert.deepEqual(await glob('packages/*/package.json'), ['packages/a/package.json'])
    assert.deepEqual(await glob('*.json'), ['package.json'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('search skips what .gitignore excludes and says so when a pattern targets it', async () => {
  const { dir, tools } = nested()
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '/.refs/\ndist/\n*.log\n')
    fs.mkdirSync(path.join(dir, '.refs', 'codex', 'docs'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.refs', 'codex', 'docs', 'vendored.md'), '# Vendored\n')
    fs.mkdirSync(path.join(dir, 'packages', 'a', 'dist'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'packages', 'a', 'dist', 'index.md'), '# built\n')
    fs.writeFileSync(path.join(dir, 'run.log'), 'log\n')
    fs.writeFileSync(path.join(dir, 'packages', 'a', '.gitignore'), 'secret.md\n')
    fs.writeFileSync(path.join(dir, 'packages', 'a', 'secret.md'), '# Secret\n')
    const glob = async (pattern: string) => (await tools.execute('search_glob', { pattern }, true)) as { files: string[]; note?: string }

    const all = await glob('**/*')
    assert.deepEqual(all.files, ['.gitignore', 'docs/adr/0001.md', 'docs/intro.md', 'package.json', 'packages/a/.gitignore', 'packages/a/package.json'])
    assert.equal(all.note, undefined)

    const vendored = await glob('.refs/**/*.md')
    assert.deepEqual(vendored.files, [])
    assert.match(vendored.note ?? '', /^\.refs\/ is not searched .*read_file/)

    const grep = (await tools.execute('search_grep', { pattern: '^#', glob: '.refs/**/*.md' }, true)) as { matches: unknown[]; note?: string }
    assert.deepEqual(grep.matches, [])
    assert.match(grep.note ?? '', /^\.refs\//)

    // read_file is not a search: an ignored file is still readable by path.
    const read = (await tools.execute('read_file', { path: '.refs/codex/docs/vendored.md' })) as { content: string }
    assert.equal(read.content, '# Vendored')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('search_grep reads each nested file once, under its own path', async () => {
  const { dir, tools } = nested()
  try {
    const grep = async (args: Record<string, unknown>) =>
      (await tools.execute('search_grep', args, true)) as { matches: Array<{ path: string; text: string }>; filesSearched: number }
    const names = await grep({ pattern: '"name"', glob: '**/package.json' })
    assert.deepEqual(
      names.matches.map((m) => [m.path, m.text]),
      [
        ['package.json', '{"name":"root"}'],
        ['packages/a/package.json', '{"name":"@hy/a"}'],
      ],
    )
    const headings = await grep({ pattern: '^#', glob: 'docs/**/*.md' })
    assert.equal(headings.filesSearched, 2)
    assert.deepEqual(headings.matches.map((m) => m.path), ['docs/adr/0001.md', 'docs/intro.md'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Regression: the search ran synchronously in the process that also serves the
// GUI, so an unfiltered grep over a large workspace froze the desktop window.
function manyFiles(count: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-walk-many-'))
  for (let d = 0; d < 20; d++) {
    const sub = path.join(dir, 'scratch', `run${d}`)
    fs.mkdirSync(sub, { recursive: true })
    for (let i = 0; i < count / 20; i++) fs.writeFileSync(path.join(sub, `out${i}.json`), `{"step": ${i}, "loss": 1.${i}}\n`.repeat(40))
  }
  fs.writeFileSync(path.join(dir, 'README.md'), '## A. target\n')
  const tools = new ToolRuntime({} as never, dir, undefined, false, { roots: workspaceRootsFor(dir, []), spillDir: path.join(dir, '.spill') })
  return { dir, tools }
}

test('an unfiltered grep over many files leaves the event loop free', async () => {
  const { dir, tools } = manyFiles(2_000)
  try {
    let ticks = 0
    const timer = setInterval(() => (ticks += 1), 5)
    const started = Date.now()
    const result = (await tools.execute('search_grep', { pattern: '^## A\.' }, true)) as { matches: Array<{ path: string }>; filesSearched: number }
    const elapsed = Date.now() - started
    clearInterval(timer)
    assert.deepEqual(result.matches.map((m) => m.path), ['README.md'])
    assert.equal(result.filesSearched, 2_001)
    // A synchronous walk lets no timer run until it returns; here the timer
    // keeps firing throughout (at least a few times per 100 ms of search).
    assert.ok(ticks >= Math.min(10, Math.floor(elapsed / 100)), `${ticks} ticks in ${elapsed} ms`)
    assert.ok(ticks > 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a search over its budget returns partial results with a note to narrow it', async () => {
  const { dir, tools } = manyFiles(400)
  const saved = { ...searchBudget }
  try {
    Object.assign(searchBudget, { maxBytes: 20_000 })
    const grep = (await tools.execute('search_grep', { pattern: 'loss' , maxResults: 100_000 }, true)) as { truncated: boolean; stoppedEarly?: string; note?: string; filesSearched: number }
    assert.equal(grep.truncated, true)
    assert.equal(grep.stoppedEarly, 'bytes')
    assert.match(grep.note!, /stopped early.*partial.*glob/s)
    assert.ok(grep.filesSearched >= 1 && grep.filesSearched < 400, `${grep.filesSearched}`)
    Object.assign(searchBudget, { maxBytes: saved.maxBytes, maxMs: 0 })
    const glob = (await tools.execute('search_glob', { pattern: '**/*.md' }, true)) as { truncated: boolean; stoppedEarly?: string }
    assert.equal(glob.stoppedEarly, 'time')
    assert.equal(glob.truncated, true)
    // Within budget nothing changes: a glob-narrowed grep is complete.
    Object.assign(searchBudget, saved)
    const narrow = (await tools.execute('search_grep', { pattern: '^## A', glob: '*.md' }, true)) as { truncated: boolean; stoppedEarly?: string; matches: unknown[] }
    assert.deepEqual([narrow.truncated, narrow.stoppedEarly, narrow.matches.length], [false, undefined, 1])
  } finally {
    Object.assign(searchBudget, saved)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
