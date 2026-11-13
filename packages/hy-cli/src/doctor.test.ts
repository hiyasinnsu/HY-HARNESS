import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HarnessConfig } from '../../core/dist/index.js'
import { buildDoctorReport, roleHasCredentials } from './doctor.js'

function config(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const role = { provider: 'ollama', model: 'qwen2.5:3b', contextWindowTokens: 1000, maxOutputTokens: 100 }
  return {
    workspaceRoot: process.cwd(),
    sandbox: 'workspace-write',
    sandboxSource: 'default',
    role,
    orchestratorRole: role,
    subagentRole: role,
    graderRole: role,
    compactorRole: role,
    summarizerRole: role,
    advisorRole: role,
    guardianRole: role,
    summary: role,
    mcpServers: {},
    ...overrides,
  } as unknown as HarnessConfig
}

test('CP-39: a healthy setup reports ok, missing pieces are warnings or failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-doctor-'))
  try {
    const server = path.join(dir, 'hy-exec-server.exe')
    fs.writeFileSync(server, '')
    const healthy = buildDoctorReport({
      version: '0.4.0',
      node: 'v24.0.0',
      platform: 'win32 x64',
      workspace: dir,
      config: config({ workspaceRoot: dir }),
      execServerPath: server,
      sandbox: { enforcement: 'partial', available: true, gaps: ['network-not-confined'], denyRead: ['C:/secret'] },
      mcpServers: ['fs'],
    })
    assert.equal(healthy.ok, true)
    assert.deepEqual(
      healthy.checks.map((check) => check.name),
      ['node', 'workspace', 'config', 'exec-server', 'sandbox', 'denyRead',
        'role:worker', 'role:orchestrator', 'role:subagent', 'role:grader', 'role:compactor',
        'role:summarizer', 'role:advisor', 'role:guardian', 'features', 'mcp'],
    )
    assert.equal(healthy.checks.find((c) => c.name === 'sandbox')!.status, 'ok')

    const broken = buildDoctorReport({
      version: '0.4.0',
      node: 'v24.0.0',
      platform: 'win32 x64',
      workspace: path.join(dir, 'missing'),
      config: config(),
      execServerPath: path.join(dir, 'missing.exe'),
    })
    assert.equal(broken.ok, false)
    assert.equal(broken.checks.find((c) => c.name === 'exec-server')!.status, 'fail')
    assert.equal(broken.checks.find((c) => c.name === 'sandbox')!.status, 'warn', 'the sandbox is unknown without the server')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-39: keyless providers pass and keyed ones need a literal key or env var', () => {
  const saved = process.env.HY_DOCTOR_TEST_KEY
  try {
    assert.equal(roleHasCredentials({ provider: 'ollama', model: 'm', contextWindowTokens: 1, maxOutputTokens: 1 } as never), true)
    assert.equal(roleHasCredentials({ provider: 'deepseek', apiKeyEnv: 'HY_DOCTOR_TEST_KEY' } as never), false)
    process.env.HY_DOCTOR_TEST_KEY = 'sk-test'
    assert.equal(roleHasCredentials({ provider: 'deepseek', apiKeyEnv: 'HY_DOCTOR_TEST_KEY' } as never), true)
    assert.equal(roleHasCredentials({ provider: 'deepseek', apiKey: 'literal' } as never), true)
  } finally {
    if (saved === undefined) delete process.env.HY_DOCTOR_TEST_KEY
    else process.env.HY_DOCTOR_TEST_KEY = saved
  }
})

test('CP-39/G-19: a role without its own apiKeyEnv uses the provider default', () => {
  const saved = process.env.DEEPSEEK_API_KEY
  try {
    delete process.env.DEEPSEEK_API_KEY
    assert.equal(roleHasCredentials({ provider: 'deepseek', model: 'm' } as never), false, 'the provider default is DEEPSEEK_API_KEY')
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    assert.equal(roleHasCredentials({ provider: 'deepseek', model: 'm' } as never), true)
    // Providers that need no key stay keyless without an env var.
    assert.equal(roleHasCredentials({ provider: 'mock', model: 'm' } as never), true)
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = saved
  }
})

test('CP-39/G-19: auxiliary roles are diagnosed too and a missing key only warns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-doctor-roles-'))
  try {
    const server = path.join(dir, 'hy-exec-server.exe')
    fs.writeFileSync(server, '')
    delete process.env.HY_DOCTOR_UNSET_KEY
    const summarizer = {
      provider: 'deepseek',
      model: 'deepseek-flash',
      apiKeyEnv: 'HY_DOCTOR_UNSET_KEY',
      contextWindowTokens: 1,
      maxOutputTokens: 1,
    }
    const report = buildDoctorReport({
      version: '0.4.0',
      node: 'v24.0.0',
      platform: 'win32 x64',
      workspace: dir,
      config: config({ workspaceRoot: dir, summarizerRole: summarizer as never }),
      execServerPath: server,
      sandbox: { enforcement: 'partial', available: true },
    })
    const summarizerCheck = report.checks.find((check) => check.name === 'role:summarizer')!
    assert.equal(summarizerCheck.status, 'warn')
    assert.match(summarizerCheck.detail, /deepseek\/deepseek-flash has no API key/)
    assert.equal(report.ok, true, 'a missing auxiliary key is not a failure')

    // Optional roles that the configuration does not carry are not reported.
    const minimalConfig = config({ workspaceRoot: dir })
    delete (minimalConfig as { advisorRole?: unknown }).advisorRole
    delete (minimalConfig as { guardianRole?: unknown }).guardianRole
    const minimal = buildDoctorReport({
      version: '0.4.0',
      node: 'v24.0.0',
      platform: 'win32 x64',
      workspace: dir,
      config: minimalConfig,
      execServerPath: server,
    })
    assert.ok(!minimal.checks.some((check) => check.name === 'role:advisor'))
    assert.ok(!minimal.checks.some((check) => check.name === 'role:guardian'))
    assert.ok(minimal.checks.some((check) => check.name === 'role:summarizer'), 'the summarizer is always checked')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
test('B11: expected sandbox gaps stay ok; a failed grant or an unknown gap warns', () => {
  const report = (gaps: string[]) => buildDoctorReport({
    version: '0.4.0',
    node: 'v24.0.0',
    platform: 'win32 x64',
    workspace: process.cwd(),
    config: config(),
    execServerPath: process.execPath,
    sandbox: { enforcement: 'partial', available: true, gaps },
  }).checks.find((check) => check.name === 'sandbox')!
  const expected = report([
    'reads-not-confined: x', 'network-not-confined: x', 'named-pipe-grandchildren: x', 'late-hard-links: x', 'low-integrity: x',
    'non-acl-volumes: confined commands can write to F:\\ (no ACLs)',
  ])
  assert.equal(expected.status, 'ok')
  assert.match(expected.detail, /non-acl-volumes/)
  assert.equal(report(['network-not-confined: x', 'deny-read-failed: C:/secret']).status, 'warn')
  assert.equal(report(['read-only-failed: C:/ws/docs']).status, 'warn')
  assert.equal(report(['something-new: x']).status, 'warn')
})
