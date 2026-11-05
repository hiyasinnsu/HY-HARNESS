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
    graderRole: role,
    compactorRole: role,
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
      ['node', 'workspace', 'config', 'exec-server', 'sandbox', 'denyRead', 'role:worker', 'role:grader', 'role:compactor', 'features', 'mcp'],
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