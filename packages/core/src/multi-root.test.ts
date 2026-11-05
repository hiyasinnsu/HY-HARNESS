import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workspaceRootsFor } from './config.js'
import { ToolRuntime } from './tools.js'

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-roots-'))
  const main = path.join(dir, 'main')
  const extra = path.join(dir, 'extra')
  const ro = path.join(dir, 'ro')
  fs.mkdirSync(main)
  fs.mkdirSync(extra)
  fs.mkdirSync(ro)
  fs.writeFileSync(path.join(main, 'same.txt'), 'from main\n')
  fs.writeFileSync(path.join(extra, 'same.txt'), 'from extra\n')
  fs.writeFileSync(path.join(ro, 'same.txt'), 'read only\n')
  return { dir, main, extra, ro, spill: path.join(dir, 'spill') }
}

test('multi-root reads use root-qualified paths and keep same-name files separate', async () => {
  const f = fixture()
  try {
    const roots = workspaceRootsFor(f.main, [{ id: 'docs', path: f.extra, writable: true }])
    const tools = new ToolRuntime({} as never, f.main, undefined, false, { roots, spillDir: f.spill })
    const main = await tools.execute('read_file', { path: 'same.txt' })
    const extra = await tools.execute('read_file', { path: 'docs:same.txt' })
    assert.equal((main as { content: string }).content, 'from main')
    assert.equal((extra as { content: string }).content, 'from extra')
    assert.equal((extra as { path: string }).path, 'docs:same.txt')
    const qualified = await tools.execute('read_file', { path: 'docs:same.txt', root: 'docs' })
    assert.equal((qualified as { content: string }).content, 'from extra')
    await assert.rejects(tools.execute('read_file', { path: 'docs:missing.txt' }), /search_glob/)
    const absolute = await tools.execute('read_file', { path: path.join(f.extra, 'same.txt') })
    assert.equal((absolute as { path: string }).path, 'docs:same.txt')
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('multi-root search, edit and read-only protection', async () => {
  const f = fixture()
  try {
    const roots = workspaceRootsFor(f.main, [
      { id: 'docs', path: f.extra, writable: true },
      { id: 'readonly', path: f.ro },
    ])
    const tools = new ToolRuntime({} as never, f.main, undefined, false, { roots, spillDir: f.spill })
    const searched = await tools.execute('search_glob', { pattern: 'same.txt', root: '*' }, true)
    assert.deepEqual((searched as { files: string[] }).files.sort(), ['docs:same.txt', 'readonly:same.txt', 'same.txt'])
    await assert.rejects(tools.execute('read_file', { path: 'docs:../escape.txt' }), /relative to docs|escapes/)
    await assert.rejects(tools.execute('apply_patch', { root: 'readonly', file: 'same.txt', content: 'nope' }), /read-only/)
    await tools.execute('read_file', { path: 'docs:same.txt' })
    await tools.execute('apply_patch', { root: 'docs', file: 'same.txt', content: 'changed\n' })
    assert.equal(fs.readFileSync(path.join(f.extra, 'same.txt'), 'utf8'), 'changed\n')
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('a file scope allows exactly one file and rejects siblings', async () => {
  const f = fixture()
  try {
    fs.writeFileSync(path.join(f.main, 'project.md'), '# P\n')
    fs.writeFileSync(path.join(f.main, 'README.md'), '# R\n')
    const exec = {
      patch: async () => ({ patch: '', applied: true, hashes: {}, deleted: [], restored: [] }),
    }
    const tools = new ToolRuntime(exec as never, f.main, undefined, false, {
      spillDir: f.spill,
      writeScope: ['file:project.md'],
    })
    await tools.execute('read_file', { path: 'project.md' })
    await tools.execute('apply_patch', { file: 'project.md', content: '# P2\n' })
    await tools.execute('read_file', { path: 'README.md' })
    await assert.rejects(tools.execute('apply_patch', { file: 'README.md', content: '# R2\n' }), /outside its scope/)

    const roots = workspaceRootsFor(f.main, [{ id: 'docs', path: f.extra, writable: true }])
    const extraTools = new ToolRuntime({} as never, f.main, undefined, false, {
      roots,
      spillDir: f.spill,
      writeScope: ['file:docs:same.txt'],
    })
    await extraTools.execute('read_file', { path: 'docs:same.txt' })
    await extraTools.execute('apply_patch', { root: 'docs', file: 'same.txt', content: 'file scope\n' })
    assert.equal(fs.readFileSync(path.join(f.extra, 'same.txt'), 'utf8'), 'file scope\n')
    await assert.rejects(
      extraTools.execute('apply_patch', { root: 'docs', file: 'other.txt', content: 'nope\n' }),
      /outside its scope/,
    )
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('shell runs in writable added roots and normalizes its cwd', async () => {
  const f = fixture()
  try {
    const roots = workspaceRootsFor(f.main, [
      { id: 'docs', path: f.extra, writable: true },
      { id: 'readonly', path: f.ro },
    ])
    const calls: Array<Record<string, unknown>> = []
    const exec = {
      exec: async (params: Record<string, unknown>) => {
        calls.push(params)
        return { status: 'completed', exitCode: 0, stdout: 'ok\n', stderr: '', jobId: null }
      },
    } as never
    const tools = new ToolRuntime(exec, f.main, undefined, false, { roots, spillDir: f.spill })

    await tools.execute('shell', { command: 'echo hi', root: 'docs' })
    assert.equal(calls[0]!.cwd, path.resolve(f.extra))

    await tools.execute('shell', { command: 'echo hi', root: 'docs', cwd: 'sub' })
    assert.equal(calls[1]!.cwd, path.resolve(f.extra, 'sub'))

    await tools.execute('shell', { command: 'echo hi', root: 'docs', cwd: path.join(f.extra, 'sub') })
    assert.equal(calls[2]!.cwd, path.resolve(f.extra, 'sub'))

    await assert.rejects(
      tools.execute('shell', { command: 'echo hi', root: 'readonly' }),
      /read-only root "readonly"/,
    )
    await assert.rejects(
      tools.execute('shell', { command: 'echo hi', root: 'docs', cwd: 'docs:sub' }),
      /path relative to root "docs"/,
    )
    await assert.rejects(
      tools.execute('shell', { command: 'echo hi', cwd: 'docs:sub' }),
      /cwd must be a path, not a root-qualified path/,
    )
    await assert.rejects(
      tools.execute('shell', { command: 'echo hi', cwd: path.join(f.extra, 'sub') }),
      /cwd must be inside the primary workspace/,
    )

    // The primary root keeps the existing relative-cwd contract.
    await tools.execute('shell', { command: 'echo hi', root: 'main', cwd: 'packages' })
    assert.equal(calls[3]!.cwd, 'packages')
    await tools.execute('shell', { command: 'echo hi', cwd: f.main })
    assert.equal(calls[4]!.cwd, '.')
    assert.equal(calls.length, 5)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})
