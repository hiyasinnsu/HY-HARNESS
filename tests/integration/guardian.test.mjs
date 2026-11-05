// Guardian through the real daemon (design §5, Phase 4 exit): the server's
// `-32001` data names the sandbox mode, Guardian approves or denies, approved
// commands run confined, the three-strike breaker ends a headless round, and
// `low-integrity` never reaches Guardian.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { skipReason, tmpRoot } from './capability.mjs'

const core = await import(new URL('../../packages/core/dist/index.js', import.meta.url).href)
const seams = await import(new URL('../../packages/seams/dist/index.js', import.meta.url).href)
const { ExecRpcClient, ToolRuntime, resolveServerPath } = core
const { Guardian, TooManyDenialsError, createApprover } = seams

const skip = process.platform !== 'win32' ? 'Windows only' : false

function provider(decision, riskScore) {
  const calls = []
  return {
    calls,
    name: 'scripted',
    async complete(messages) {
      calls.push(messages)
      return { content: JSON.stringify({ decision, riskScore, reason: `${decision} by script` }), usage: { inputTokens: 0, outputTokens: 0 } }
    },
  }
}

async function setup(extra = {}) {
  const root = tmpRoot()
  const ws = path.join(root, 'ws')
  fs.mkdirSync(ws)
  const client = await ExecRpcClient.start(resolveServerPath(), {
    protocolVersion: 1,
    workspaceRoot: fs.realpathSync.native(ws),
    stateDir: path.join(root, 'state'),
    sandbox: 'workspace-write',
    extraWritableRoots: [],
    envPassthrough: [],
    projectTrusted: false,
    protectedPaths: [],
    ...extra,
  })
  const done = async () => {
    try {
      await client.sandboxRevoke()
    } finally {
      await client.stop()
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    }
  }
  return { root, ws, client, done }
}

test('Guardian approves a prompt command, which then runs confined', { skip: skip || skipReason('pipe') }, async () => {
  const s = await setup()
  try {
    const p = provider('approve', 5)
    const guardian = new Guardian({ provider: p, objective: 'write a file' })
    const tools = new ToolRuntime(s.client, s.ws, createApprover({ autoApprove: false, guardian }))
    const result = await tools.execute('shell', { command: 'cmd /d /c echo hi> g.txt' })
    assert.equal(result.sandbox, 'workspace-write')
    assert.ok(fs.existsSync(path.join(s.ws, 'g.txt')))
    assert.equal(p.calls.length, 1)
    assert.match(p.calls[0][1].content, /Sandbox mode: workspace-write/)
  } finally {
    await s.done()
  }
})

test('three Guardian denials abort a headless round', { skip: skip || skipReason('pipe') }, async () => {
  const s = await setup()
  try {
    const guardian = new Guardian({ provider: provider('deny', 95), objective: 'o' })
    const tools = new ToolRuntime(s.client, s.ws, createApprover({ autoApprove: false, guardian }))
    for (const n of [1, 2]) {
      await assert.rejects(tools.execute('shell', { command: `cmd /d /c echo ${n}> d${n}.txt` }), /not approved.*guardian: deny by script/)
    }
    await assert.rejects(tools.execute('shell', { command: 'cmd /d /c echo 3> d3.txt' }), TooManyDenialsError)
    assert.ok(!fs.existsSync(path.join(s.ws, 'd1.txt')))
  } finally {
    await s.done()
  }
})

test('a low-integrity rule never reaches Guardian', { skip: skip || skipReason('pipe') }, async () => {
  const policy = path.join(os.tmpdir(), `hy-it-guard-policy-${process.pid}.star`)
  fs.writeFileSync(
    policy,
    'prefix_rule(pattern = ["node", "li.js"], decision = "prompt", sandbox = "low-integrity", match = ["node li.js"])\n',
  )
  const s = await setup({ userPolicyPath: policy })
  try {
    fs.writeFileSync(path.join(s.ws, 'li.js'), 'console.log(1)')
    const p = provider('approve', 1)
    const guardian = new Guardian({ provider: p, objective: 'o' })
    const tools = new ToolRuntime(s.client, s.ws, createApprover({ autoApprove: false, guardian }))
    await assert.rejects(tools.execute('shell', { command: 'node li.js' }), /low-integrity needs a user approval/)
    assert.equal(p.calls.length, 0)
  } finally {
    await s.done()
    fs.rmSync(policy, { force: true })
  }
})
