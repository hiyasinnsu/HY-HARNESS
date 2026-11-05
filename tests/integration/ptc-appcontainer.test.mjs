// Phase 5 exit (design §2, Rev 3.1 decision F): `run_code` runs in the daemon's
// AppContainer worker. Sub-calls work and pass the same guards; the worker
// itself cannot read or write the workspace, open connections or create
// processes; a hung script is killed by the job timeout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { skipReason } from './capability.mjs'

const core = await import(new URL('../../packages/core/dist/index.js', import.meta.url).href)
const { AbortRunError, ExecRpcClient, ToolRuntime, resolveServerPath } = core

const skip = process.platform !== 'win32' ? 'Windows only' : false

async function setup(approve) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-ptc-'))
  fs.writeFileSync(path.join(ws, 'secret.txt'), 'workspace secret\n')
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(ws, `f${i}.txt`), `file ${i}\n`)
  const client = await ExecRpcClient.start(resolveServerPath(), {
    protocolVersion: 1,
    workspaceRoot: fs.realpathSync.native(ws),
    stateDir: path.join(ws, '..', `${path.basename(ws)}-state`),
    sandbox: 'unconfined',
    extraWritableRoots: [],
    envPassthrough: [],
    projectTrusted: false,
    protectedPaths: [],
  })
  const tools = new ToolRuntime(client, fs.realpathSync.native(ws), approve)
  const done = async () => {
    await client.stop()
    fs.rmSync(ws, { recursive: true, force: true })
    fs.rmSync(path.join(ws, '..', `${path.basename(ws)}-state`), { recursive: true, force: true })
  }
  return { ws, client, tools, done }
}

test('the worker itself cannot reach the workspace, temp, network or processes', { skip: skip || skipReason('pipe') }, async () => {
  const s = await setup()
  process.env.HY_PTC_SECRET_TOKEN = 'do-not-leak'
  try {
    const target = path.join(s.ws, 'secret.txt')
    const code = `
      const fs = await import('node:fs'); const os = await import('node:os'); const net = await import('node:net')
      const cp = await import('node:child_process')
      const out = {}
      const t = (k, f) => { try { out[k] = 'OK ' + String(f()).slice(0, 20) } catch (e) { out[k] = e.code || e.message } }
      t('readWorkspace', () => fs.readFileSync(${JSON.stringify(target)}, 'utf8'))
      t('writeWorkspace', () => fs.writeFileSync(${JSON.stringify(path.join(s.ws, 'w.txt'))}, 'x'))
      t('writeTemp', () => fs.writeFileSync(os.tmpdir() + '\\\\ptc.txt', 'x'))
      t('spawn', () => { const r = cp.spawnSync('cmd', ['/d', '/c', 'echo hi'], { stdio: 'ignore', timeout: 3000 }); if (r.error) throw r.error; return r.status })
      out.network = await new Promise((res) => {
        const sock = net.connect({ host: '1.1.1.1', port: 80 })
        sock.on('connect', () => { sock.destroy(); res('CONNECTED') })
        sock.on('error', (e) => res(e.code))
        setTimeout(() => { sock.destroy(); res('TIMEOUT') }, 4000)
      })
      out.env = Object.keys(process.env).sort()
      return out
    `
    const r = await s.tools.execute('run_code', { code, timeoutMs: 30_000 })
    const v = r.value
    for (const k of ['readWorkspace', 'writeWorkspace', 'writeTemp', 'spawn']) {
      assert.ok(!String(v[k]).startsWith('OK'), `${k} must fail, got ${v[k]}`)
    }
    assert.notEqual(v.network, 'CONNECTED')
    assert.ok(!fs.existsSync(path.join(s.ws, 'w.txt')))
    assert.ok(!v.env.some((k) => k.startsWith('HY_')), `env leaked: ${v.env.join(',')}`)
  } finally {
    delete process.env.HY_PTC_SECRET_TOKEN
    await s.done()
  }
})

test('20 parallel reads and one patch go through the bridge', { skip: skip || skipReason('pipe') }, async () => {
  const s = await setup()
  try {
    const code = `
      const reads = await Promise.all(Array.from({ length: 20 }, (_, i) => tools.readFile({ path: 'f' + i + '.txt' })))
      await tools.applyPatch({ patch: '--- /dev/null\\n+++ b/out.txt\\n@@ -0,0 +1 @@\\n+' + reads.length + ' files\\n' })
      console.log('done')
      return reads.map((r) => r.content.trim())
    `
    const r = await s.tools.execute('run_code', { code, timeoutMs: 60_000 })
    assert.equal(r.value.length, 20)
    assert.equal(r.value[7], 'file 7')
    assert.equal(r.subCalls, 21)
    assert.deepEqual(r.logs, ['done'])
    assert.equal(fs.readFileSync(path.join(s.ws, 'out.txt'), 'utf8').trim(), '20 files')
  } finally {
    await s.done()
  }
})

test('a hung or busy script is killed by the job timeout', { skip: skip || skipReason('pipe') }, async () => {
  const s = await setup()
  try {
    for (const code of ['await new Promise(() => {})', 'for (;;) {}']) {
      const t0 = Date.now()
      await assert.rejects(s.tools.execute('run_code', { code, timeoutMs: 2_000 }), /timed out after 2000 ms/)
      assert.ok(Date.now() - t0 < 15_000)
    }
  } finally {
    await s.done()
  }
})

test('sub-call limit, no nesting, and the same guards as direct calls', { skip: skip || skipReason('pipe') }, async () => {
  const s = await setup()
  try {
    const limited = await s.tools.execute('run_code', {
      code: `const out = []; for (let i = 0; i < 4; i++) { try { await tools.readFile({ path: 'f0.txt' }); out.push('ok') } catch (e) { out.push(e.message) } } return out`,
      maxSubCalls: 2,
    })
    assert.deepEqual(limited.value.slice(0, 2), ['ok', 'ok'])
    assert.match(limited.value[2], /too many sub-calls/)
    const nested = await s.tools.execute('run_code', {
      code: `try { await tools.runCode({ code: 'return 1' }); return 'nested' } catch (e) { return e.message }`,
    })
    assert.match(nested.value, /cannot nest/)
    // ReadBeforeEdit: editing an existing file that was not read is refused.
    const guarded = await s.tools.execute('run_code', {
      code: `try { await tools.applyPatch({ patch: '--- a/secret.txt\\n+++ b/secret.txt\\n@@ -1 +1 @@\\n-workspace secret\\n+changed\\n' }); return 'patched' } catch (e) { return e.message }`,
    })
    assert.notEqual(guarded.value, 'patched')
    assert.equal(fs.readFileSync(path.join(s.ws, 'secret.txt'), 'utf8'), 'workspace secret\n')
    // A command needing approval without an approver is refused.
    const shell = await s.tools.execute('run_code', {
      code: `try { await tools.shell({ command: 'cmd /d /c echo x> y.txt' }); return 'ran' } catch (e) { return e.message }`,
    })
    assert.notEqual(shell.value, 'ran')
    assert.ok(!fs.existsSync(path.join(s.ws, 'y.txt')))
  } finally {
    await s.done()
  }
})

test('a run-ending approval error escapes run_code', { skip: skip || skipReason('pipe') }, async () => {
  const s = await setup(async () => {
    throw new AbortRunError('breaker tripped')
  })
  try {
    await assert.rejects(
      s.tools.execute('run_code', {
        code: `try { await tools.shell({ command: 'cmd /d /c echo x> z.txt' }) } catch (e) {} return 'swallowed'`,
      }),
      (e) => e instanceof AbortRunError,
    )
  } finally {
    await s.done()
  }
})

test('20 parallel greps and one patch (design exit) with the search SDK', { skip: skip || skipReason('pipe') }, async () => {
  const s = await setup()
  try {
    const code = `
      const hits = await Promise.all(Array.from({ length: 20 }, (_, i) => tools.search.grep({ pattern: '^file ' + i + '$', glob: '*.txt' })))
      const md = await tools.search.glob({ pattern: 'f1*.txt' })
      await tools.applyPatch({ file: 'hits.txt', content: String(hits.filter((h) => h.matches.length === 1).length) })
      return { first: hits[3].matches[0], glob: md.files }
    `
    const r = await s.tools.execute('run_code', { code, timeoutMs: 60_000 })
    assert.deepEqual(r.value.first, { path: 'f3.txt', line: 1, text: 'file 3' })
    assert.deepEqual(r.value.glob, ['f1.txt', 'f10.txt', 'f11.txt', 'f12.txt', 'f13.txt', 'f14.txt', 'f15.txt', 'f16.txt', 'f17.txt', 'f18.txt', 'f19.txt'])
    assert.equal(r.subCalls, 22)
    assert.equal(fs.readFileSync(path.join(s.ws, 'hits.txt'), 'utf8').trim(), '20')
  } finally {
    await s.done()
  }
})

test('tools.jobs drives a background command from a script', { skip: skip || skipReason('pipe') }, async () => {
  const s = await setup(async () => true)
  try {
    const code = `
      // Compound commands run through the session shell (PowerShell here).
      const started = await tools.shell({ command: 'Start-Sleep -Seconds 2; Write-Output job-done', foregroundWaitMs: 0 })
      const done = await tools.jobs.wait({ jobId: started.jobId, timeoutMs: 30000 })
      const out = await tools.jobs.output({ jobId: started.jobId })
      return { status: started.status, state: done.state, out: out.data }
    `
    const r = await s.tools.execute('run_code', { code, timeoutMs: 60_000 })
    assert.equal(r.value.status, 'backgrounded')
    assert.equal(r.value.state, 'exited')
    assert.match(r.value.out, /job-done/)
    assert.doesNotMatch(r.value.out, /CLIXML/, 'PowerShell progress records must not leak into output')
  } finally {
    await s.done()
  }
})

test('schemas are enforced and SDK-only tools stay inside run_code', { skip: skip || skipReason('pipe') }, async () => {
  const s = await setup()
  try {
    // CP-14 exposes search_grep directly; tools without a wire name stay SDK-only.
    await s.tools.execute('search_grep', { pattern: 'x' })
    await assert.rejects(s.tools.execute('rationale_upsert', { key: 'k', rule: 'r' }), /only available inside run_code as tools\.rationale\.upsert/)
    await assert.rejects(s.tools.execute('read_file', {}), /invalid arguments for read_file: args\.path is required/)
    const r = await s.tools.execute('run_code', {
      code: `const out = []
        for (const f of [() => tools.readFile({}), () => tools.search.grep({ pattern: 1 }), () => tools.nope({})]) {
          try { await f(); out.push('ok') } catch (e) { out.push(e.message) }
        }
        return out`,
    })
    assert.match(r.value[0], /args\.path is required/)
    assert.match(r.value[1], /args\.pattern must be string/)
    assert.match(r.value[2], /tools\.nope does not exist/)
  } finally {
    await s.done()
  }
})

test('tools.rationale records notes from a script; the cap error reaches the script', { skip: skip || skipReason('pipe') }, async () => {
  const s = await setup()
  try {
    const { Ledger } = core
    const ledger = new Ledger([], [], { maxEntries: 2, maxTokens: 1_500 })
    const tools = new ToolRuntime(s.client, fs.realpathSync.native(s.ws), undefined, false, { ledger })
    const r = await tools.execute('run_code', {
      code: `await tools.rationale.upsert({ key: 'legacy-cjs', rule: 'keep CommonJS', rationale: 'loader' })
        await tools.rationale.upsert({ key: 'no-vendor', rule: 'never edit vendor/' })
        try { await tools.rationale.upsert({ key: 'third', rule: 'x' }); return 'accepted' } catch (e) { return e.message }`,
    })
    assert.match(r.value, /full \(2 entries\).*Current keys: legacy-cjs, no-vendor/)
    assert.deepEqual(ledger.list().map((n) => n.key), ['legacy-cjs', 'no-vendor'])
    await assert.rejects(s.tools.execute('rationale_upsert', { key: 'k', rule: 'r' }), /only available inside run_code/)
  } finally {
    await s.done()
  }
})
