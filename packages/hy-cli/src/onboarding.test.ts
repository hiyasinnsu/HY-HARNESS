import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type HarnessConfig } from '../../core/dist/index.js'
import {
  ONBOARDING_SANDBOXES,
  OnboardingError,
  applyOnboardingDefaults,
  onboardingFile,
  onboardingView,
  readOnboarding,
  writeOnboarding,
} from './onboarding.js'

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-onboarding-'))
  fs.mkdirSync(path.join(dir, 'repo'))
  return path.join(dir, 'repo')
}

function configFor(root: string): HarnessConfig {
  return loadConfig({ cwd: root, stateDir: path.join(root, '.state'), mock: true })
}

test('a fresh install has no onboarding state and nothing is applied', () => {
  const root = workspace()
  try {
    const config = configFor(root)
    assert.deepEqual(readOnboarding(config.stateDir), { complete: false })
    const before = { sandbox: config.sandbox, provider: config.role.provider, model: config.role.model }
    const { applied } = applyOnboardingDefaults(config)
    assert.deepEqual(applied, [])
    assert.deepEqual({ sandbox: config.sandbox, provider: config.role.provider, model: config.role.model }, before)
    const view = onboardingView(config, readOnboarding(config.stateDir))
    assert.equal(view.complete, false)
    assert.equal(view.steps.length, 3)
    assert.deepEqual(view.choices.sandboxes, ONBOARDING_SANDBOXES)
    assert.equal(view.workspace.root, config.workspaceRoot)
  } finally {
    fs.rmSync(path.dirname(root), { recursive: true, force: true })
  }
})

test('the three choices are validated, saved and applied to the next start', () => {
  const root = workspace()
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-onboarding-cfg-'))
  const savedConfigDir = process.env.HY_CONFIG_DIR
  process.env.HY_CONFIG_DIR = configDir
  // Model facts are user data: register the model the way a user would.
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ models: [{ id: 'mini', name: 'Gateway mini', provider: 'openai-compatible', model: 'gpt-4.1-mini', contextWindowTokens: 128_000, maxOutputTokens: 8_192 }] }),
  )
  try {
    const config = configFor(root)
    const state = writeOnboarding(config.stateDir, {
      sandbox: 'read-only',
      provider: 'openai-compatible',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://gateway.example/v1/',
      complete: true,
    })
    assert.equal(state.complete, true)
    assert.equal(state.baseUrl, 'https://gateway.example/v1')
    assert.equal(typeof state.completedAt, 'number')
    assert.ok(fs.existsSync(onboardingFile(config.stateDir)))

    const next = configFor(root)
    const applied = applyOnboardingDefaults(next).applied
    assert.deepEqual(applied, ['sandbox=read-only', 'model=openai-compatible:gpt-4.1-mini'])
    assert.equal(next.sandbox, 'read-only')
    assert.equal(next.role.provider, 'openai-compatible')
    assert.equal(next.role.model, 'gpt-4.1-mini')
    assert.equal(next.role.baseUrl, 'https://gateway.example/v1')
    assert.equal(next.role.apiKeyEnv, 'OPENAI_API_KEY')
    // A registered model brings its own limits with it.
    assert.equal(next.role.contextWindowTokens, 128_000)
    assert.equal(next.role.maxOutputTokens, 8_192)
  } finally {
    if (savedConfigDir === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = savedConfigDir
    fs.rmSync(configDir, { recursive: true, force: true })
    fs.rmSync(path.dirname(root), { recursive: true, force: true })
  }
})

test('explicit flags win over the saved wizard', () => {
  const root = workspace()
  try {
    const config = configFor(root)
    writeOnboarding(config.stateDir, { sandbox: 'read-only', provider: 'anthropic', model: 'claude-sonnet-4-5', complete: true })
    const flagged = loadConfig({
      cwd: root,
      stateDir: config.stateDir,
      sandbox: 'unconfined',
      provider: 'ollama',
      model: 'qwen2.5:3b',
    })
    assert.deepEqual(applyOnboardingDefaults(flagged, { sandbox: 'unconfined', provider: 'ollama', model: 'qwen2.5:3b' }).applied, [])
    assert.equal(flagged.sandbox, 'unconfined')
    assert.equal(flagged.role.provider, 'ollama')
    assert.equal(flagged.role.model, 'qwen2.5:3b')
  } finally {
    fs.rmSync(path.dirname(root), { recursive: true, force: true })
  }
})

test('a skipped wizard never changes anything, and bad values are refused', () => {
  const root = workspace()
  try {
    const config = configFor(root)
    const state = writeOnboarding(config.stateDir, { skip: true })
    assert.equal(state.complete, true)
    assert.equal(state.skipped, true)
    assert.deepEqual(applyOnboardingDefaults(configFor(root)).applied, [])

    assert.throws(() => writeOnboarding(config.stateDir, { sandbox: 'low-integrity' }), (error: unknown) => {
      assert.ok(error instanceof OnboardingError)
      assert.match(error.message, /sandbox must be one of/)
      return true
    })
    assert.throws(() => writeOnboarding(config.stateDir, { provider: 'nope' }), /provider must be one of/)
    assert.throws(() => writeOnboarding(config.stateDir, { model: '   ' }), /model must not be empty/)
    assert.throws(() => writeOnboarding(config.stateDir, { baseUrl: 'file:///etc/passwd' }), /http\(s\) URL/)
    // A corrupt file reads as "not onboarded" instead of failing the start.
    fs.writeFileSync(onboardingFile(config.stateDir), 'not json', 'utf8')
    assert.deepEqual(readOnboarding(config.stateDir), { complete: false })
  } finally {
    fs.rmSync(path.dirname(root), { recursive: true, force: true })
  }
})
