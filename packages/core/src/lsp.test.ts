import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LspManager } from './lsp.js'
import { ToolRuntime } from './tools.js'

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'fake-lsp-server.mjs')

test('lsp: definition, references, hover, diagnostics and symbols through the tool', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-lsp-'))
  const lsp = new LspManager(dir, { fake: { command: [process.execPath, server], extensions: ['.rs'], timeoutMs: 5_000 } })
  try {
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src', 'main.rs'), 'fn main() {\n  // TODO: more\n}\n')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    const tools = new ToolRuntime({} as never, dir, undefined, false, { lsp })
    // CP-10: `lsp` is deferred, so it has to be loaded through tool_search first.
    const found = (await tools.execute('tool_search', { query: 'lsp' })) as { activated: string[] }
    assert.ok(found.activated.includes('lsp'))
    const q = (args: Record<string, unknown>) => tools.execute('lsp', args)

    assert.deepEqual(await q({ op: 'definition', path: 'src/main.rs', line: 1, column: 4 }), {
      locations: [{ path: 'src/main.rs', line: 1, column: 4 }],
    })
    assert.deepEqual(await q({ op: 'references', path: 'src/main.rs', line: 2, column: 6 }), {
      locations: [
        { path: 'src/main.rs', line: 1, column: 4 },
        { path: 'src/main.rs', line: 2, column: 6 },
      ],
      total: 2,
    })
    assert.deepEqual(await q({ op: 'hover', path: 'src/main.rs', line: 1, column: 4 }), { text: 'fn main()' })
    assert.deepEqual(await q({ op: 'diagnostics', path: 'src/main.rs' }), {
      diagnostics: [{ line: 2, column: 6, severity: 'warning', message: 'unfinished work', source: 'fake' }],
    })
    // An edited file is re-synced: the diagnostic goes away.
    fs.writeFileSync(path.join(dir, 'src', 'main.rs'), 'fn main() {}\n')
    assert.deepEqual(await q({ op: 'diagnostics', path: 'src/main.rs' }), { diagnostics: [] })
    assert.deepEqual(await q({ op: 'symbols', path: 'src/main.rs' }), {
      symbols: [
        { name: 'main', kind: 12, line: 1 },
        { name: 'main.inner', kind: 13, line: 2 },
      ],
    })
    await assert.rejects(q({ op: 'hover', path: 'notes.txt' }), /no language server is configured for \.txt/)
    await assert.rejects(q({ op: 'hover', path: '../outside.rs' }), /escapes the workspace|no such file|ENOENT/)
    await assert.rejects(
      new ToolRuntime({} as never, dir).execute('lsp', { op: 'hover', path: 'src/main.rs' }),
      /no language server is configured \(lsp in the user config\)/,
    )
  } finally {
    await lsp.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
