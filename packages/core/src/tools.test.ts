import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { MemoryStore } from './memory.js'
import { READ_ONLY_TOOLS, TOOLS_BY_NAME, renderToolPrompt } from './tool-registry.js'
import {
  FILE_TOOL_ALIASES,
  ToolRuntime,
  cleanPowerShellOutput,
  countOccurrences,
  imageMimeType,
  imageSize,
  nearbyLines,
  normalizeShellCwd,
  normalizeToolArgs,
  replaceIgnoringEol,
  sandboxPipeFailure,
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
  assert.equal(cleanPowerShellOutput('\x1b[32;1mName\x1b[0m\r\nreport.pdf'), 'Name\r\nreport.pdf')
  assert.equal(cleanPowerShellOutput('#< CLIXML\n<Objs><S S="Error">_x001B_[31;1mParserError_x001B_[0m_x000A_ß</S></Objs>'), 'ParserError\nß')
  assert.equal(cleanPowerShellOutput('#< CLIXML\n<Objs><S S="Error">literal _x005F_x001B_</S></Objs>'), 'literal _x001B_')
})

test('shell stdout and stderr lose terminal decoration without changing their contents', async () => {
  const exec = { exec: async () => ({ status: 'completed', exitCode: 1, stdout: '\x1b[32mreport.pdf\x1b[0m\n', stderr: '\x1b[31mfailed\x1b[0m\n' }) }
  const tools = new ToolRuntime(exec as never, process.cwd())
  const result = await tools.execute('shell', { command: 'Get-ChildItem' })
  assert.equal(result.stdout, 'report.pdf\n')
  assert.equal(result.stderr, 'failed\n')
  assert.equal(result.exitCode, 1)
})

/** A ToolRuntime whose exec client only records patches. */
function patchRecorder(root: string) {
  const patches: Array<{ patch: string } & Record<string, unknown>> = []
  const exec = {
    patch: async (params: { patch: string } & Record<string, unknown>) => {
      patches.push(params)
      return { appliedFiles: ['x'], created: [], deleted: [], hashes: {} }
    },
  }
  return { tools: new ToolRuntime(exec as never, root), patches }
}

test('unsupported patch syntax explains how to recover without writing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-patch-format-'))
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
  try {
    const { tools, patches } = patchRecorder(dir)
    await assert.rejects(tools.execute('apply_patch', { patch: '*** Begin Patch\n*** Update File: x\n@@\n-a\n+b\n*** End Patch' }), /Unsupported patch format: use a unified diff.*file \+ content/)
    await assert.rejects(tools.execute('apply_patch', { patch: '--- a/x\n+++ b/x\n@@\n-a\n+b' }), /hunks need line numbers.*file \+ content/)
    assert.equal(patches.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

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

test('edit_file matches a CRLF file with the LF text read_file returned (T-4)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-edit-crlf-'))
  try {
    const { tools, patches } = patchRecorder(dir)
    fs.writeFileSync(path.join(dir, 'win.ts'), 'const a = 1\r\nconst b = 2\r\n')
    await tools.execute('read_file', { path: 'win.ts' })
    // read_file hands back LF, so the same text must match the CRLF file.
    await tools.editFile({ file: 'win.ts', old: 'const a = 1\nconst b = 2', new: 'const a = 1\nconst b = 3' })
    const patch = patches.at(-1)!.patch
    assert.match(patch, /\+const a = 1\n\+const b = 3/)
    assert.doesNotMatch(patch, /\r/, 'the daemon re-encodes with the file EOL; no CR is passed in twice')
    // The count check runs on the normalized text too, not on raw CRLF.
    await tools.execute('read_file', { path: 'win.ts' })
    await assert.rejects(tools.editFile({ file: 'win.ts', old: 'const', new: 'let' }), /occurs 2 times/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('replaceIgnoringEol restores the dominant EOL and leaves LF files alone', () => {
  // CRLF file: the LF old text matches, the result stays CRLF.
  assert.deepEqual(replaceIgnoringEol('a\r\nb\r\n', 'a\nb', 'x\ny'), { count: 1, text: 'x\r\ny\r\n' })
  // LF file: unchanged behavior.
  assert.deepEqual(replaceIgnoringEol('a\nb\n', 'a\nb', 'x\ny'), { count: 1, text: 'x\ny\n' })
  // A model that sends CRLF in old still matches an LF file.
  assert.deepEqual(replaceIgnoringEol('a\nb\n', 'a\r\nb', 'x'), { count: 1, text: 'x\n' })
  // CRLF must be the dominant ending to be restored.
  assert.deepEqual(replaceIgnoringEol('a\r\nb\nc\n', 'a', 'x'), { count: 1, text: 'x\nb\nc\n' })
  assert.deepEqual(replaceIgnoringEol('a\r\nb\r\nc\n', 'a', 'x'), { count: 1, text: 'x\r\nb\r\nc\r\n' })
  // Every occurrence is replaced when the caller asked for that count.
  assert.deepEqual(replaceIgnoringEol('a\na\na\n', 'a', 'b'), { count: 3, text: 'b\nb\nb\n' })
  // A miss returns the source untouched, so the caller reports the miss.
  assert.deepEqual(replaceIgnoringEol('a\r\nb\r\n', 'zzz', 'x'), { count: 0, text: 'a\r\nb\r\n' })
})

test('edit_file arguments survive a file with mixed line endings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-edit-mixed-'))
  try {
    const { tools, patches } = patchRecorder(dir)
    fs.writeFileSync(path.join(dir, 'mixed.txt'), 'one\r\ntwo\nthree\n')
    await tools.execute('read_file', { path: 'mixed.txt' })
    await tools.editFile({ file: 'mixed.txt', old: 'two\nthree', new: 'TWO\nTHREE' })
    assert.match(patches.at(-1)!.patch, /\+TWO\n\+THREE/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('edit_file resolves a path from working_directory like read_file (5-3)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-edit-cwd-'))
  try {
    fs.mkdirSync(path.join(dir, 'pkg'))
    fs.writeFileSync(path.join(dir, 'pkg', 'app.ts'), 'const answer = 1\n')
    const { tools, patches } = patchRecorder(dir)
    assert.equal(tools.workingDirectory({ path: 'pkg' }).cwd, 'pkg')
    await tools.execute('read_file', { path: 'app.ts' })
    await tools.editFile({ file: 'app.ts', old: '= 1', new: '= 2' })
    // One prefix only: the patch path is the resolved file under the cwd.
    assert.match(patches.at(-1)!.patch, /\+\+\+ b\/pkg\/app\.ts/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('edit_file keeps a UTF-16LE file and its single BOM (5-3)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-edit-utf16-'))
  try {
    const { tools, patches } = patchRecorder(dir)
    // PowerShell 5.1 `>` / `Out-File`: UTF-16LE with one BOM, CRLF lines.
    const source = 'const answer = 41\r\nconsole.log(answer)\r\n'
    fs.writeFileSync(path.join(dir, 'run.ps1'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')]))
    await tools.execute('read_file', { path: 'run.ps1' })
    await tools.editFile({ file: 'run.ps1', old: 'answer = 41', new: 'answer = 42' })
    const sent = patches.at(-1)!
    // The daemon decodes and re-encodes with the file's own encoding; the BOM
    // belongs to the encoding, so the content must not carry it again.
    assert.equal(sent.encoding, 'utf16le')
    assert.match(sent.patch, /\+const answer = 42/)
    assert.doesNotMatch(sent.patch, /\uFEFF/)
    assert.doesNotMatch(sent.patch, /\u0000/, 'the old side quotes decoded text, not UTF-16 bytes')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('job tools are offered beside shell and reach the exec client (5-2)', async () => {
  const calls: string[] = []
  const exec = {
    jobStatus: async (jobId: string) => {
      calls.push(`status:${jobId}`)
      return { jobId, command: 'build', state: 'running', exitCode: null, outputBytes: 0 }
    },
    jobOutput: async (jobId: string, offset: number) => {
      calls.push(`output:${jobId}:${offset}`)
      return { data: 'ok', nextOffset: 2, totalBytes: 2, eof: true }
    },
    jobWait: async (jobId: string) => {
      calls.push(`wait:${jobId}`)
      return { jobId, command: 'build', state: 'exited', exitCode: 0, outputBytes: 2 }
    },
    jobKill: async (jobId: string) => {
      calls.push(`kill:${jobId}`)
      return { jobId, command: 'build', state: 'killed', exitCode: null, outputBytes: 2 }
    },
  }
  const tools = new ToolRuntime(exec as never, process.cwd())
  // `shell` is offered, so the job family is too (and PTC is not involved).
  assert.ok(tools.toolFeatures().has('shell'))
  assert.match(renderToolPrompt(false, undefined, false, tools.toolFeatures()), /- job_status\(args/)
  await tools.execute('job_status', { jobId: 'j1' })
  await tools.execute('job_output', { jobId: 'j1' })
  await tools.execute('job_wait', { jobId: 'j1' })
  await tools.execute('job_kill', { jobId: 'j1' })
  assert.deepEqual(calls, ['status:j1', 'output:j1:0', 'wait:j1', 'kill:j1'])
  // A read-only session has no shell, so it does not offer them.
  const ro = new ToolRuntime(exec as never, process.cwd(), undefined, false, { allowTools: READ_ONLY_TOOLS })
  assert.ok(!ro.toolFeatures().has('shell'))
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
    assert.throws(() => tools.readImage({ path: 'missing.png' }, true), /path does not exist.*search_glob\/search_grep/)
    assert.throws(() => tools.readImage({ path: '../escape.png' }, true), /relative to the workspace|escapes/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('read_image accepts high-resolution scans while preserving the dimension cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-image-scan-'))
  try {
    const { tools } = patchRecorder(dir)
    for (const height of [6000, 8193]) {
      const header = Buffer.alloc(13)
      header.writeUInt32BE(1, 0)
      header.writeUInt32BE(height, 4)
      header[8] = 8
      header[9] = 6
      const chunks = [['IHDR', header], ['IDAT', deflateSync(Buffer.alloc(height * 5))], ['IEND', Buffer.alloc(0)]] as const
      const png = Buffer.concat([PNG.subarray(0, 8), ...chunks.map(([type, data]) => {
        const body = Buffer.concat([Buffer.from(type), data])
        const length = Buffer.alloc(4)
        length.writeUInt32BE(data.length)
        const checksum = Buffer.alloc(4)
        checksum.writeUInt32BE(crc32(body))
        return Buffer.concat([length, body, checksum])
      })])
      fs.writeFileSync(path.join(dir, 'scan.png'), png)
      if (height <= 8192) assert.equal(tools.readImage({ path: 'scan.png' }, true).height, height)
      else assert.throws(() => tools.readImage({ path: 'scan.png' }, true), /limit is 8192/)
    }
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

/** An exec client with a scripted persistent shell, recording calls. */
function persistentShellStub(read: () => Promise<{ data: string; exitCode?: number; eof?: boolean; timedOut?: boolean }>) {
  const calls: string[] = []
  let next = 0
  const exec = {
    shellOpen: async (p: { sandboxMode: string }) => (calls.push(`open ${p.sandboxMode}`), { shellId: `sh${++next}` }),
    shellWrite: async (id: string, data: string) => (calls.push(`write ${id} ${data}`), {}),
    shellRead: async (id: string) => (calls.push(`read ${id}`), read()),
    shellClose: async (id: string) => (calls.push(`close ${id}`), {}),
    policyEvaluate: async () => ({ decision: 'allow' }),
  }
  return { exec, calls }
}

test('persistent shell: a sandbox mode change closes the old shell and opens one in the new mode', async () => {
  let mode = 'unconfined'
  const { exec, calls } = persistentShellStub(async () => ({ data: 'ok', exitCode: 0 }))
  const tools = new ToolRuntime(exec as never, process.cwd(), undefined, false, { persistentShell: true, sandboxMode: () => mode } as never)
  await tools.execute('shell', { command: 'echo one' })
  mode = 'read-only'
  await tools.execute('shell', { command: 'echo two' })
  assert.deepEqual(calls, ['open unconfined', 'write sh1 echo one', 'read sh1', 'close sh1', 'open read-only', 'write sh2 echo two', 'read sh2'])
})

test('persistent shell: stopping the turn closes the running shell', async () => {
  let release: (v: { data: string; eof: boolean }) => void = () => {}
  const { exec, calls } = persistentShellStub(() => new Promise((resolve) => (release = resolve)))
  const tools = new ToolRuntime(exec as never, process.cwd(), undefined, false, { persistentShell: true, sandboxMode: () => 'unconfined' } as never)
  const controller = new AbortController()
  tools.setSignal(controller.signal)
  const running = tools.execute('shell', { command: 'Start-Sleep 600' })
  await new Promise((r) => setTimeout(r, 20))
  controller.abort()
  release({ data: '', eof: true }) // closing the shell ends the read
  await assert.rejects(running, /cancelled|aborted/)
  assert.ok(calls.includes('close sh1'), calls.join(' | '))
})

test('ask_user: no answer is reported as no answer, not as consent', async () => {
  for (const [reply, expected] of [
    ['use postgres', { answer: 'use postgres' }],
    ['', undefined],
    ['   ', undefined],
  ] as const) {
    const tools = new ToolRuntime({} as never, process.cwd(), undefined, false, { askUser: async () => reply } as never)
    const result = (await tools.execute('ask_user', { question: 'which db?' })) as { answer: string; note?: string }
    if (expected) assert.deepEqual(result, expected)
    else {
      assert.equal(result.answer, '')
      assert.match(result.note!, /This is not approval/)
    }
  }
})

test('a spawn EPERM in shell output points at the plain test-runner command', async () => {
  const { pipeChildGap } = await import('./tools.js')
  assert.match(pipeChildGap({ stderr: 'Error: spawn EPERM\n    at ChildProcess.spawn' })!, /Run the test command on its own/)
  assert.match(pipeChildGap({ stdout: 'Error: spawnSync C:\\node.exe EPERM' })!, /named-pipe-children/)
  assert.equal(pipeChildGap({ stdout: 'ok', stderr: '' }), undefined)
  assert.equal(pipeChildGap({ stdout: 'EPERM: operation not permitted, open x' }), undefined, 'a plain file EPERM is not this gap')
  // A filter hid the EPERM line: a failing piped test runner in workspace-write.
  const filtered = { stdout: 'ℹ pass 0', exitCode: 1, sandbox: 'workspace-write' }
  assert.match(pipeChildGap(filtered, "npm test 2>&1 | Select-String -Pattern 'pass|fail'")!, /on its own/)
  assert.equal(pipeChildGap(filtered, 'npm test'), undefined, 'a plain command already ran in the right sandbox')
  assert.equal(pipeChildGap({ ...filtered, exitCode: 0 }, 'npm test | Select-String pass'), undefined, 'it passed')
  assert.equal(pipeChildGap(filtered, 'cargo test | Select-String ok'), undefined, 'not a Node test runner')
})

test('plan mode refuses changing tools at run time (the prompt keeps the full, cached tool list)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-plan-refuse-'))
  try {
    const { tools, patches } = patchRecorder(dir)
    tools.setAllowTools(new Set(['read_file', 'update_plan']))
    await assert.rejects(tools.execute('apply_patch', { file: 'x.txt', content: 'x' }), /apply_patch is not available while plan mode is on/)
    assert.equal(patches.length, 0)
    tools.setAllowTools(undefined)
    await tools.execute('apply_patch', { file: 'x.txt', content: 'x' })
    assert.equal(patches.length, 1, 'plan mode off: the same call runs')
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
    await assert.rejects(tools.execute('spawn_agent', { task: 'run the checks', requires: ['shell'] }), /read-only/)
    await assert.rejects(tools.execute('delegate', { task: 'edit the file', requires: ['edit'] }), /read-only/)
    assert.deepEqual(spawned, [])
    assert.deepEqual(await tools.execute('spawn_agent', { task: 'review the diff', requires: ['read'] }), {
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

test('update_plan holds several steps in progress only when the session runs work in parallel', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-plan-parallel-'))
  try {
    const plan = [
      { step: 'worker A', status: 'in_progress' },
      { step: 'worker B', status: 'in_progress' },
      { step: 'review', status: 'pending' },
    ]
    const single = new ToolRuntime({} as never, dir)
    await assert.rejects(single.execute('update_plan', { plan }, true), /at most one step may be in_progress/)
    const orchestrator = new ToolRuntime({} as never, dir, undefined, false, { parallelPlan: true })
    assert.deepEqual(await orchestrator.execute('update_plan', { plan }, true), { ok: true, remaining: 3 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an instruction received while waiting for shell ownership prevents execution', async () => {
  let pending = false
  let released = false
  let calls = 0
  const tools = new ToolRuntime({ exec: async () => { calls++; return { status: 'completed', stdout: '' } } } as never, process.cwd(), undefined, false, {
    persistentShell: true,
    shellLock: { acquire: async () => { pending = true; return () => { released = true } } },
    beforeTool: () => { if (pending) throw new Error('new instruction pending') },
  })
  await assert.rejects(tools.execute('shell', { command: 'echo stale' }), /new instruction pending/)
  assert.equal(calls, 0)
  assert.equal(released, true, 'the shared shell lock is released on rejection')
})

test('normalizeToolArgs recovers double-wrapped malformed JSON strings', () => {
  const spec = TOOLS_BY_NAME.get('shell')!
  assert.deepEqual(normalizeToolArgs(spec, { arguments: '{"command":"echo ok"}' }), { command: 'echo ok' })
  assert.deepEqual(normalizeToolArgs({ ...spec, name: 'todo_write' }, { plan: '[{"step":"check","status":"in_progress"}]' }), {
    todos: [{ content: 'check', status: 'in_progress' }],
  })
  // Extra closing brace at the end of a stringified inner args object (session log lines 720, 1719, 2040).
  assert.deepEqual(normalizeToolArgs(spec, { args: '{"command": "echo ok", "foregroundWaitMs": 5000}}' }), {
    command: 'echo ok',
    foregroundWaitMs: 5000,
  })
  // Concatenated second tool call after an accidentally escaped quote (session log line 9052).
  assert.deepEqual(
    normalizeToolArgs(spec, '{"command": "echo hello\\"}},{"tool":"orchestrator_workers"/orchestrator_workers'),
    { command: 'echo hello' },
  )
})

test('an exclusive shell call keeps its lock and uses the requested hard deadline before the RPC deadline', async () => {
  let locked = false
  const tools = new ToolRuntime({
    exec: async (params: { foregroundWaitMs?: number; hardTimeoutMs?: number }, _signal: unknown, rpcTimeout?: number) => {
      assert.equal(locked, true)
      assert.equal(params.hardTimeoutMs, 2_700_000)
      assert.ok(params.foregroundWaitMs! > params.hardTimeoutMs!)
      assert.equal(rpcTimeout, undefined, 'exec derives its deadline from the foreground wait')
      return { status: 'completed', exitCode: 0, stdout: '', stderr: '' }
    },
  } as never, process.cwd(), undefined, false, {
    noBackgroundShell: true,
    shellLock: { acquire: async () => { locked = true; return () => { locked = false } } },
  })
  await tools.execute('shell', { command: 'echo ok', foregroundWaitMs: 45_000, hardTimeoutMs: 2_700_000 })
  assert.equal(locked, false)
})

test('read_file and search_grep decode UTF-16LE and UTF-16BE text files while rejecting binary files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-utf16-'))
  try {
    // UTF-16LE with BOM (PowerShell 5.1 Out-File / > default).
    const utf16leBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('line 1: PowerShell log\r\nline 2: step=50 loss=2.41\r\n', 'utf16le')])
    fs.writeFileSync(path.join(dir, 'ps_log.txt'), utf16leBom)
    // UTF-16BE with BOM.
    const utf16beBody = Buffer.from('alpha beta\ngamma delta\n', 'utf16le')
    utf16beBody.swap16()
    fs.writeFileSync(path.join(dir, 'be_log.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBody]))
    // True binary file containing NUL code units.
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]))

    const tools = new ToolRuntime({} as never, dir)
    const r1 = (await tools.execute('read_file', { path: 'ps_log.txt' })) as { content: string; totalLines: number }
    assert.equal(r1.totalLines, 2)
    assert.match(r1.content, /loss=2\.41/)

    const r2 = (await tools.execute('read_file', { path: 'be_log.txt' })) as { content: string; totalLines: number }
    assert.equal(r2.totalLines, 2)
    assert.match(r2.content, /gamma delta/)

    await assert.rejects(tools.execute('read_file', { path: 'bin.dat' }), /binary file: bin\.dat/)

    const grep = (await tools.execute('search_grep', { pattern: 'loss=2\\.41' })) as {
      matches: Array<{ path: string; line: number; text: string }>
    }
    assert.equal(grep.matches.length, 1)
    assert.equal(grep.matches[0]!.path, 'ps_log.txt')
    assert.equal(grep.matches[0]!.line, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('apply_patch converts Begin Patch and unnumbered @@ hunks when existing files were read first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-patch-convert-'))
  try {
    fs.writeFileSync(path.join(dir, 'app.py'), 'def greet():\n    return "old"\n')
    const patches: string[] = []
    const exec = {
      patch: async (req: { patch: string }) => {
        patches.push(req.patch)
        return { appliedFiles: ['app.py'], created: [], deleted: [], hashes: { 'app.py': 'h2' }, warnings: [] }
      },
    }
    const tools = new ToolRuntime(exec as never, dir)
    // Must still require read_file before editing an existing file.
    await assert.rejects(
      tools.execute('apply_patch', {
        patch: '*** Begin Patch\n*** Update File: app.py\n@@\n def greet():\n-    return "old"\n+    return "new"\n*** End Patch',
      }),
      /read_file is required before editing app\.py/,
    )
    await tools.execute('read_file', { path: 'app.py' })
    await tools.execute('apply_patch', {
      patch: `*** Begin Patch\n*** Update File: ${path.join(dir, 'app.py')}\n@@\n def greet():\n-    return "old"\n+    return "new"\n*** End Patch`,
    })
    assert.equal(patches.length, 1)
    assert.match(patches[0]!, /^--- a\/app\.py\n\+\+\+ b\/app\.py\n@@ -1,2 \+1,2 @@/m)
    assert.match(patches[0]!, /\+    return "new"/)

    // Unnumbered @@ hunk on a read file is also converted.
    fs.writeFileSync(path.join(dir, 'app.py'), 'def greet():\n    return "new"\n')
    await tools.execute('read_file', { path: 'app.py' })
    await tools.execute('apply_patch', {
      patch: '--- a/app.py\n+++ b/app.py\n@@\n def greet():\n-    return "new"\n+    return "final"',
    })
    assert.equal(patches.length, 2)
    assert.match(patches[1]!, /\+    return "final"/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('edit_file, write_file, and read_file normalize common parameter aliases (old_str/old_string, new_str/new_string, path/file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-arg-aliases-'))
  try {
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'alpha\nbeta\n')
    const tools = new ToolRuntime({} as never, dir)
    // read_file with `file` alias instead of `path`
    const readRes = (await tools.execute('read_file', { file: 'hello.txt' })) as { content: string }
    assert.match(readRes.content, /alpha/)
    const editSpec = {
      name: 'edit_file',
      sdk: 'plugins.edit_file',
      wire: true,
      readOnly: false,
      description: 'Edit file',
      input: { type: 'object', properties: { file: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['file', 'old', 'new'] },
      output: {},
    } as const
    assert.deepEqual(normalizeToolArgs(editSpec as never, { path: 'hello.txt', old_str: 'beta', new_str: 'gamma' }), {
      file: 'hello.txt',
      old: 'beta',
      new: 'gamma',
    })
    assert.deepEqual(normalizeToolArgs(editSpec as never, { path: 'hello.txt', old_string: 'beta', new_string: 'gamma' }), {
      file: 'hello.txt',
      old: 'beta',
      new: 'gamma',
    })
    // The host builds these plugin specs; until they carry `aliases`, the
    // exported table is what normalizeToolArgs reads for them.
    assert.deepEqual(FILE_TOOL_ALIASES.edit_file, {
      path: 'file',
      old_str: 'old',
      old_string: 'old',
      new_str: 'new',
      new_string: 'new',
    })
    const writeSpec = { ...editSpec, name: 'write_file', sdk: 'plugins.write_file' }
    assert.deepEqual(normalizeToolArgs(writeSpec as never, { path: 'notes.md', content: 'x' }), { file: 'notes.md', content: 'x' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sandboxPipeFailure: only a finished, confined spawn failure counts', () => {
  const failed = { exitCode: 1, stderr: 'Error: spawn EPERM\n    at ChildProcess.spawn (node:internal/child_process:1)' }
  assert.equal(sandboxPipeFailure(failed, 'pnpm build'), true)
  assert.equal(sandboxPipeFailure({ exitCode: 1, stderr: 'The application was unable to start correctly (0xC0000142)' }, 'bash -c x'), true)
  assert.equal(sandboxPipeFailure({ ...failed, exitCode: 0 }, 'pnpm build'), false)
  assert.equal(sandboxPipeFailure({ exitCode: 1, stderr: 'a normal compiler error' }, 'pnpm build'), false)
  // A program that merely prints such a line is not the sandbox failing unless
  // the command is a known test runner whose output was piped away.
  assert.equal(sandboxPipeFailure({ exitCode: 1, stderr: 'warning: spawn EPERM documented' }, 'pnpm lint'), false)
  assert.equal(sandboxPipeFailure({ exitCode: 1, stdout: '', sandbox: 'workspace-write' }, 'npm test | tail -5'), true)
})

test('a confined pipe failure is offered the low-integrity token once per command shape', async () => {
  const calls: Array<{ sandboxMode?: string; approval?: unknown }> = []
  const exec = {
    exec: async (params: { sandboxMode?: string; approval?: unknown }) => {
      calls.push(params)
      return params.sandboxMode === 'low-integrity'
        ? { status: 'completed', exitCode: 0, stdout: 'ok\n', stderr: '', sandbox: 'low-integrity' }
        : { status: 'completed', exitCode: 1, stdout: '', stderr: 'Error: spawn EPERM\n    at ChildProcess.spawn', sandbox: 'workspace-write' }
    },
  }
  const asked: Array<{ command: string; sandbox?: string }> = []
  const tools = new ToolRuntime(
    exec as never,
    process.cwd(),
    async (request) => {
      asked.push({ command: request.command, ...(request.sandbox ? { sandbox: request.sandbox } : {}) })
      return { approved: true, by: 'user' as const }
    },
    false,
    { sandboxMode: () => 'workspace-write' as const },
  )
  const result = await tools.execute('shell', { command: 'pnpm desktop:package:next' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.sandboxMode, 'low-integrity')
  assert.equal(result.exitCode, 0)
  assert.equal(result.escalated, 'low-integrity')
  assert.equal(result.gap, undefined)
  assert.deepEqual(asked, [{ command: 'pnpm desktop:package:next', sandbox: 'low-integrity' }])
  // The same command shape is not offered again in this session.
  await tools.execute('shell', { command: 'pnpm desktop:package:next --dir' })
  assert.equal(asked.length, 1)
})

test('only the user can grant the low-integrity token', async () => {
  const calls: unknown[] = []
  const exec = {
    exec: async (params: unknown) => {
      calls.push(params)
      return { status: 'completed', exitCode: 1, stdout: '', stderr: 'Error: spawn EPERM', sandbox: 'workspace-write' }
    },
  }
  const tools = new ToolRuntime(exec as never, process.cwd(), async () => ({ approved: true, by: 'guardian' as const }), false, {
    sandboxMode: () => 'workspace-write' as const,
  })
  const result = await tools.execute('shell', { command: 'pnpm desktop:package:next' })
  assert.equal(calls.length, 1, 'a Guardian approval does not re-run the command with a looser token')
  assert.equal(result.exitCode, 1)
})

test('A14: shellAttention flags failures an exit code 0 hides, and nothing else', async () => {
  const { shellAttention } = await import('./tools.js')
  assert.match(shellAttention({ exitCode: 0, stdout: '', stderr: 'Get-Item : not found\n    + CategoryInfo          : ObjectNotFound: (x:String) [Get-Item]\n' })!, /PowerShell error record/)
  assert.match(shellAttention({ exitCode: 0, stdout: 'HTTP/2 403 \ncontent-type: x', stderr: '' })!, /HTTP 403/)
  assert.match(shellAttention({ exitCode: 0, stdout: '', stderr: 'Invoke-WebRequest : The remote server returned an error: (404) Not Found.' })!, /HTTP 404/)
  assert.match(shellAttention({ exitCode: 0, stdout: '', stderr: 'curl: (6) Could not resolve host: x' })!, /curl error/)
  assert.match(shellAttention({ exitCode: 0, stdout: '', stderr: 'Traceback (most recent call last):\n  File "a.py"' })!, /Python traceback/)
  assert.equal(shellAttention({ exitCode: 0, stdout: 'HTTP/1.1 200 OK', stderr: '' }), undefined)
  assert.equal(shellAttention({ exitCode: 1, stdout: '', stderr: 'curl: (6) x' }), undefined, 'a non-zero exit is already a failure')
  assert.equal(shellAttention({ exitCode: 0, stdout: 'see the Traceback (most recent call last): docs', stderr: '' }), undefined)
})

test('A9: an edit_file miss that differs only in whitespace shows the exact lines to copy', async () => {
  const { closestBlock } = await import('./tools.js')
  const source = 'function f() {\n    const a = 1\n    return a\n}\n'
  const hint = closestBlock(source, 'const a = 1\nreturn  a')
  assert.match(hint, /matches lines 2-3 when whitespace is ignored/)
  assert.match(hint, / {2}2: {5}const a = 1\n {2}3: {5}return a/)
  assert.match(closestBlock('x = 1\ny = 2\nz = 3\n', 'x = 1\ny = 9\nz = 3'), /closest block \(2 of 3 lines agree\) is lines 1-3/)
  assert.match(closestBlock('a\nb\na\nb\n', ' a\n b'), /matches 2 places \(from line 1, 3\)/)
  assert.equal(closestBlock('unrelated\n', 'zzz\nyyy'), '')
})
