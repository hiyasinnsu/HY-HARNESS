import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from './memory.js'
import {
  ToolRuntime,
  cleanPowerShellOutput,
  countOccurrences,
  imageMimeType,
  imageSize,
  nearbyLines,
  normalizeShellCwd,
} from './tools.js'

/** A PNG whose only pixel is transparent (67 bytes). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

test('absolute cwd inside the primary workspace is made relative', () => {
  const root = path.resolve('workspace-root')
  assert.equal(normalizeShellCwd(root, 'src'), 'src')
  assert.equal(normalizeShellCwd(root, path.join(root, 'src')), 'src')
  assert.equal(normalizeShellCwd(root, root), '.')
  assert.equal(normalizeShellCwd(root, ''), '.')
  assert.throws(() => normalizeShellCwd(root, path.dirname(root)), /inside the primary workspace/)
  assert.throws(() => normalizeShellCwd(root, 'docs:sub'), /root-qualified path/)
})

test('todo_write replaces the list and needs a reason to run several in progress', () => {
  const tools = new ToolRuntime({} as never, process.cwd())
  const written = tools.todoWrite({
    todos: [
      { content: 'read the code', status: 'completed' },
      { content: 'fix the bug', status: 'in_progress' },
      { content: 'write the test', status: 'pending' },
    ],
  })
  assert.deepEqual(written, { ok: true, remaining: 2, inProgress: 1 })
  assert.deepEqual(tools.currentPlan(), [
    { step: 'read the code', status: 'completed' },
    { step: 'fix the bug', status: 'in_progress' },
    { step: 'write the test', status: 'pending' },
  ])
  // The whole list is replaced, not merged.
  tools.todoWrite({ plan: [{ step: 'only one left', status: 'in_progress' }] })
  assert.deepEqual(tools.currentPlan(), [{ step: 'only one left', status: 'in_progress' }])
  assert.throws(
    () =>
      tools.todoWrite({
        todos: [
          { content: 'a', status: 'in_progress' },
          { content: 'b', status: 'in_progress' },
        ],
      }),
    /allowParallelInProgress/,
  )
  const parallel = tools.todoWrite({
    todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'in_progress' },
    ],
    allowParallelInProgress: true,
  })
  assert.equal(parallel.inProgress, 2)
  assert.throws(() => tools.todoWrite({ todos: [] }), /at least one todo/)
  // A resume restores the list the model last set.
  tools.restorePlan([{ step: 'restored', status: 'pending' }])
  assert.deepEqual(tools.currentPlan(), [{ step: 'restored', status: 'pending' }])
})

test('PowerShell CLIXML stderr is reduced to readable error lines', () => {
  const clixml =
    '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
    '<S S="Error">Get-ChildItem : not found_x000D__x000A_</S>' +
    '<S S="Error">line 1_x000A_</S></Objs>'
  assert.equal(cleanPowerShellOutput(clixml), 'Get-ChildItem : not found\nline 1')
  assert.equal(cleanPowerShellOutput('plain stderr'), 'plain stderr')
})

/** A ToolRuntime whose exec client only records patches. */
function patchRecorder(root: string) {
  const patches: Array<{ patch: string }> = []
  const exec = {
    patch: async (params: { patch: string }) => {
      patches.push({ patch: params.patch })
      return { appliedFiles: ['x'], created: [], deleted: [], hashes: {} }
    },
  }
  return { tools: new ToolRuntime(exec as never, root), patches }
}

test('write_file creates a file and refuses to overwrite before a read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-write-'))
  try {
    const { tools, patches } = patchRecorder(dir)
    await tools.writeFile({ file: 'notes.md', content: '# Notes\n' })
    assert.match(patches[0]!.patch, /\+# Notes/)
    await assert.rejects(tools.writeFile({ file: 'a.txt' }), /needs content/)
    await assert.rejects(tools.writeFile({ file: 'a.txt', content: 1 } as never), /needs content/)
    // An existing file must be read first (the same rule as apply_patch).
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old\n')
    await assert.rejects(tools.writeFile({ file: 'a.txt', content: 'new\n' }), /read_file is required before editing a\.txt/)
    const read = (await tools.execute('read_file', { path: 'a.txt' })) as { sha256: string }
    assert.ok(read.sha256)
    await tools.writeFile({ file: 'a.txt', content: 'new\n' })
    assert.match(patches.at(-1)!.patch, /\+new/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('edit_file replaces exactly once and explains a miss', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-edit-'))
  try {
    const { tools, patches } = patchRecorder(dir)
    fs.writeFileSync(path.join(dir, 'app.ts'), 'const answer = 42\nconsole.log(answer)\n')
    await tools.execute('read_file', { path: 'app.ts' })
    await tools.editFile({ file: 'app.ts', old: 'answer = 42', new: 'answer = 43' })
    assert.match(patches.at(-1)!.patch, /\+const answer = 43/)
    // Two matches without count=2 is an error that shows where.
    await assert.rejects(tools.editFile({ file: 'app.ts', old: 'answer', new: 'value' }), /occurs 2 times.*\nLines that look close:/s)
    await assert.rejects(tools.editFile({ file: 'app.ts', old: 'missing text', new: 'x' }), /not found/)
    // A wrong count fails the same way (never a silent partial edit).
    await assert.rejects(tools.editFile({ file: 'app.ts', old: 'answer', new: 'value', count: 1 }), /count=1/)
    // The explicit count replaces every occurrence.
    fs.writeFileSync(path.join(dir, 'b.ts'), 'a a a\n')
    await tools.execute('read_file', { path: 'b.ts' })
    await tools.editFile({ file: 'b.ts', old: 'a', new: 'b', count: 3 })
    assert.match(patches.at(-1)!.patch, /\+b b b/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('read_image hands the bytes over out of band', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-image-'))
  try {
    const { tools } = patchRecorder(dir)
    fs.writeFileSync(path.join(dir, 'pixel.png'), PNG)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an image')
    const meta = tools.readImage({ path: 'pixel.png' }, true)
    assert.deepEqual(meta, { path: 'pixel.png', mimeType: 'image/png', bytes: PNG.length, width: 1, height: 1, attached: true })
    const images = tools.takeImages()
    assert.equal(images.length, 1)
    assert.equal(images[0]!.mimeType, 'image/png')
    assert.equal(images[0]!.label, 'pixel.png')
    assert.deepEqual(tools.takeImages(), [], 'the queue is drained')
    // A model without image input says so instead of failing later.
    assert.throws(() => tools.readImage({ path: 'pixel.png' }, false), /no image input/)
    assert.throws(() => tools.readImage({ path: 'notes.txt' }, true), /not a PNG, JPEG, WebP or GIF/)
    assert.throws(() => tools.readImage({ path: '../escape.png' }, true), /relative to the workspace|escapes/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('working_directory moves the session and prefixes relative tool paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-cwd-'))
  try {
    const { tools } = patchRecorder(dir)
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.writeFileSync(path.join(dir, 'docs', 'report.md'), '# Report\n')
    const before = tools.workingDirectory({})
    assert.equal(before.cwd, '.')
    const moved = tools.workingDirectory({ path: 'docs' })
    assert.equal(moved.cwd, 'docs')
    assert.equal(tools.currentCwd(), 'docs')
    // read_file resolves against the session cwd now.
    const read = (await tools.execute('read_file', { path: 'report.md' })) as { path: string; content: string }
    assert.equal(read.path, 'docs/report.md')
    assert.match(read.content, /# Report/)
    // Explicit root paths and escapes are not rewritten.
    await assert.rejects(tools.execute('read_file', { path: '../outside.txt' }), /relative|escapes/)
    // Back to the root, then refuse a file and a path outside the workspace.
    tools.workingDirectory({ path: '.' })
    assert.equal(tools.currentCwd(), '')
    assert.throws(() => tools.workingDirectory({ path: 'docs/report.md' }), /not a directory/)
    assert.throws(() => tools.workingDirectory({ path: '../..' }), /relative to|escapes/)
    tools.restoreCwd('docs')
    assert.equal(tools.currentCwd(), 'docs')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('image headers and text helpers are honest', () => {
  assert.equal(imageMimeType(PNG), 'image/png')
  assert.deepEqual(imageSize(PNG, 'image/png'), { width: 1, height: 1 })
  assert.equal(imageMimeType(Buffer.from('<html>')), undefined)
  assert.equal(countOccurrences('a a a', 'a'), 3)
  assert.equal(countOccurrences('aaaa', 'aa'), 2, 'occurrences do not overlap')
  assert.match(nearbyLines('const answer = 42\nother\n', 'answer = 43'), /1: const answer = 42/)
  assert.equal(nearbyLines('x\n', 'zzzzzz'), '')
})

test('CP-10: tool_search loads a deferred tool, which then becomes callable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-tool-search-'))
  try {
    const state = path.join(dir, 'state')
    const tools = new ToolRuntime({} as never, dir, undefined, false, {
      memory: MemoryStore.forStateDir(state),
    })
    await assert.rejects(
      tools.execute('memory', { action: 'save', key: 'k', text: 'v' }),
      /is not loaded; call tool_search/,
    )
    const found = (await tools.execute('tool_search', { query: 'workspace memory' })) as {
      tools: Array<{ name: string; signature: string }>
      activated: string[]
      available: number
    }
    assert.ok(found.tools.some((t) => t.name === 'memory'), JSON.stringify(found))
    assert.ok(found.activated.includes('memory'))
    assert.equal(found.available >= 1, true)
    assert.ok(tools.activatedTools().has('memory'))
    const saved = (await tools.execute('memory', { action: 'save', key: 'k', text: 'v' })) as { entries: number; tokens: number }
    assert.equal(saved.entries, 1)
    assert.ok(saved.tokens > 0)
    // A query with no matching words loads nothing.
    const none = (await tools.execute('tool_search', { query: 'zzz-nothing' })) as { activated: string[] }
    assert.deepEqual(none.activated, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-38: with the tool-search flag off, deferred tools are loaded from the start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-tool-search-off-'))
  try {
    const tools = new ToolRuntime({} as never, dir, undefined, false, {
      toolSearch: false,
      memory: MemoryStore.forStateDir(path.join(dir, 'state')),
    })
    assert.ok(tools.activatedTools().has('memory'))
    const saved = (await tools.execute('memory', { action: 'save', key: 'k', text: 'v' })) as { entries: number }
    assert.equal(saved.entries, 1, 'callable without tool_search')
    // The default keeps the deferral.
    const lazy = new ToolRuntime({} as never, dir, undefined, false, { memory: MemoryStore.forStateDir(path.join(dir, 'state2')) })
    assert.equal(lazy.activatedTools().has('memory'), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-12: current_time, sleep and get_context_remaining', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-utility-'))
  try {
    const tools = new ToolRuntime({} as never, dir, undefined, false, { contextWindowTokens: 1_000 })
    const now = (await tools.execute('current_time', {})) as { iso: string; timezone: string; weekday: string }
    assert.ok(!Number.isNaN(Date.parse(now.iso)))
    assert.ok(now.timezone.length > 0)
    assert.ok(now.weekday.length > 0)

    const slept = (await tools.execute('sleep', { ms: 5 })) as { sleptMs: number }
    assert.equal(slept.sleptMs, 5)

    const before = (await tools.execute('get_context_remaining', {})) as { source: string; remaining: number }
    assert.equal(before.source, 'none')
    assert.equal(before.remaining, 1_000)
    tools.setUsage({ inputTokens: 250, outputTokens: 10 })
    const after = (await tools.execute('get_context_remaining', {})) as {
      source: string
      used: number
      remaining: number
      percentUsed: number
    }
    assert.deepEqual(after, { window: 1_000, used: 250, remaining: 750, percentUsed: 25, source: 'provider' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-05: request_permissions asks the user and grants a writable root', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-permissions-'))
  try {
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(outside)
    const roots: string[] = []
    const asked: Array<{ command: string; sandbox?: string }> = []
    const exec = {
      sandboxAddRoot: async (root: string) => {
        roots.push(root)
        return { roots: [root] }
      },
    } as never
    const tools = new ToolRuntime(
      exec,
      dir,
      async (request) => {
        asked.push({ command: request.command, ...(request.sandbox !== undefined ? { sandbox: request.sandbox } : {}) })
        return request.command.includes('outside')
      },
      false,
      {},
    )
    await tools.execute('tool_search', { query: 'write' })
    const result = (await tools.execute('request_permissions', {
      write: [outside, path.join(dir, 'missing')],
      reason: 'test output',
    })) as { granted: string[]; rejected: string[]; note: string }
    assert.deepEqual(result.granted, [outside])
    assert.equal(result.rejected.length, 1)
    assert.match(result.rejected[0]!, /does not exist/)
    assert.deepEqual(roots, [outside])
    assert.equal(asked.length, 1)
    assert.equal(asked[0]!.sandbox, 'unconfined', 'a user-only mode forces the user decision')
    assert.match(asked[0]!.command, /request_permissions: write/)
    assert.match(result.note, /allowed for the rest of this session/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-09: write_stdin feeds a job and returns its new output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-stdin-'))
  try {
    const writes: Array<{ jobId: string; data: string }> = []
    const pages: Array<{ data: string; nextOffset: number; totalBytes: number; eof: boolean }> = [
      { data: 'hello\r\n', nextOffset: 7, totalBytes: 7, eof: true },
    ]
    const exec = {
      jobWrite: async (jobId: string, data: string) => {
        writes.push({ jobId, data })
        return { written: data.length }
      },
      jobOutput: async (_id: string, offset: number) =>
        pages.shift() ?? { data: '', nextOffset: offset, totalBytes: offset, eof: true },
      jobStatus: async () => ({ jobId: 'job-1', command: 'cmd', state: 'exited', exitCode: 0, outputBytes: 7 }),
    } as never
    const tools = new ToolRuntime(exec, dir, undefined, false, {})
    const result = await tools.execute('write_stdin', { jobId: 'job-1', chars: 'hi\r\n', timeoutMs: 100 })
    assert.deepEqual(writes, [{ jobId: 'job-1', data: 'hi\r\n' }])
    assert.deepEqual(result, { output: 'hello\r\n', exited: true, exitCode: 0, timedOut: false })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-15: background subagents can be spawned, listed, waited for and closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-agents-'))
  try {
    const spawned: string[] = []
    const closed: string[] = []
    const tools = new ToolRuntime({} as never, dir, undefined, false, {
      delegate: async () => ({ final: 'sync', steps: 1 }),
      backgroundDelegate: (task: string) => {
        spawned.push(task)
        return 'agent-1'
      },
      waitAgent: async (agentId: string) => ({ final: `done:${agentId}`, status: 'done', timedOut: false }),
      listAgents: () => spawned.map((task, i) => ({ agentId: `agent-${i + 1}`, task, status: 'done' })),
      closeAgent: (agentId: string) => {
        closed.push(agentId)
        return { agentId, status: 'done' }
      },
    })
    await assert.rejects(tools.execute('spawn_agent', { task: 'x' }), /is not loaded; call tool_search/)
    await tools.execute('tool_search', { query: 'agent' })
    assert.deepEqual(await tools.execute('spawn_agent', { task: 'review the diff' }), {
      agentId: 'agent-1',
      status: 'running',
    })
    assert.deepEqual(await tools.execute('wait_agent', { agentId: 'agent-1' }), {
      final: 'done:agent-1',
      status: 'done',
      timedOut: false,
    })
    assert.deepEqual(await tools.execute('list_agents', {}), {
      agents: [{ agentId: 'agent-1', task: 'review the diff', status: 'done' }],
    })
    assert.deepEqual(await tools.execute('close_agent', { agentId: 'agent-1' }), { agentId: 'agent-1', status: 'done' })
    assert.deepEqual(spawned, ['review the diff'])
    assert.deepEqual(closed, ['agent-1'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})