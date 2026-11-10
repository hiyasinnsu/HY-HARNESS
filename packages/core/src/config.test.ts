import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configPaths, loadConfig, parseApprovalPolicy } from './config.js'

test('orchestrator and subagent roles inherit the worker until overridden', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-special-roles-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user
    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({
        roles: {
          worker: { provider: 'deepseek', model: 'deepseek-flash' },
          orchestrator: { model: 'orchestrator-model' },
          subagent: { model: 'subagent-model', effort: 'low' },
        },
      }),
    )
    const configured = loadConfig({ cwd: ws })
    assert.equal(configured.orchestratorRole.model, 'orchestrator-model')
    assert.equal(configured.orchestratorRole.provider, 'deepseek')
    assert.equal(configured.subagentRole.model, 'subagent-model')
    assert.equal(configured.subagentRole.effort, 'low')

    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ roles: { worker: { provider: 'deepseek', model: 'deepseek-flash' } } }))
    const inherited = loadConfig({ cwd: ws })
    assert.equal(inherited.orchestratorRole.model, 'deepseek-flash')
    assert.equal(inherited.subagentRole.model, 'deepseek-flash')
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the OpenCode default uses the model output cap instead of 8K', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-output-cap-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const userDir = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(userDir)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = userDir
    const config = loadConfig({ cwd: ws, provider: 'opencode' })
    assert.equal(config.role.model, 'deepseek-v4.1-flash')
    assert.equal(config.role.contextWindowTokens, 1_000_000)
    assert.equal(config.role.maxOutputTokens, 131_072, 'thinking must not consume an 8K output budget')

    const gemini = loadConfig({ cwd: ws, provider: 'gemini' })
    assert.equal(gemini.role.maxOutputTokens, 65_536)
    const openai = loadConfig({ cwd: ws, provider: 'openai-compatible' })
    assert.equal(openai.role.contextWindowTokens, 1_047_576)
    assert.equal(openai.role.maxOutputTokens, 32_768)
    const deepseek = loadConfig({ cwd: ws, provider: 'deepseek' })
    assert.equal(deepseek.role.contextWindowTokens, 1_048_576)
    assert.equal(deepseek.role.maxOutputTokens, 262_144, 'stay inside the 25% compaction reserve')
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenCode Go model aliases and the mis-saved Gemini model recover without changing direct providers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-opencode-model-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user
    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({
        roles: {
          worker: {
            provider: 'openai-compatible',
            model: 'deepseek-flash',
            baseUrl: 'https://opencode.ai/inference/go/openai/v1',
            apiKeyEnv: 'OPENCODE_API_KEY',
          },
          grader: {
            provider: 'deepseek',
            model: 'deepseek-flash',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKeyEnv: 'DEEPSEEK_API_KEY',
          },
          compactor: { provider: 'opencode', model: 'gemini-3.8-flash' },
          orchestrator: { provider: 'gemini', model: 'gemini-3.8-flash' },
          subagent: { provider: 'opencode', baseUrl: 'https://example.test/v1', model: 'gemini-3.8-flash' },
        },
      }),
    )
    const config = loadConfig({ cwd: ws })
    assert.equal(config.role.model, 'deepseek-v4.1-flash')
    assert.equal(config.graderRole.model, 'deepseek-flash', 'the DeepSeek API keeps its own model name')
    // A saved model is not rewritten: an unavailable combination is reported when
    // the user picks it (web-server validation), not silently replaced at load.
    assert.equal(config.compactorRole.model, 'gemini-3.8-flash')
    assert.equal(config.orchestratorRole.model, 'gemini-3.8-flash')
    assert.equal(config.subagentRole.model, 'gemini-3.8-flash', 'custom gateways are unaffected')
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('automation presets add opt-in MCP servers; explicit user servers win', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-automation-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    const configPath = path.join(user, 'config.json')
    process.env.HY_CONFIG_DIR = user
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        roles: { grader: { provider: 'ollama', model: 'qwen2.5:3b' } },
        autoApprove: true,
        fullAuto: true,
        automation: {
          browser: { enabled: true, headless: true },
          desktop: { enabled: true },
          search: { enabled: true },
        },
      }),
    )
    const defaults = loadConfig({ cwd: ws })
    assert.equal(defaults.graderRole.provider, 'ollama')
    assert.equal(defaults.autoApprove, true)
    assert.equal(defaults.fullAuto, true)
    const mocked = loadConfig({ cwd: ws, mock: true })
    assert.equal(mocked.graderRole.provider, 'mock', '--mock must not call a real grader')
    const preset = defaults.mcpServers.playwright
    assert.ok(preset)
    assert.equal(preset.command, process.execPath)
    assert.ok(preset.args?.includes('chrome'), 'the default browser is Chrome')
    assert.equal(preset.env?.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(preset.trusted, false)

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        automation: {
          browser: { enabled: true, browser: 'msedge', headless: true },
          desktop: { enabled: true },
        },
        mcpServers: { playwright: { command: 'custom-browser' } },
      }),
    )
    const config = loadConfig({ cwd: ws })
    const playwright = config.mcpServers.playwright
    assert.ok(playwright)
    assert.equal(playwright.command, 'custom-browser', 'the user server overrides the preset')
    const desktop = config.mcpServers['agent-desktop']
    assert.ok(desktop)
    assert.equal(desktop.command, process.execPath)
    assert.equal(desktop.trusted, false)
    assert.match(desktop.args?.[0] ?? '', /agent-desktop-mcp\.mjs$/)
    assert.equal(desktop.env?.ELECTRON_RUN_AS_NODE, '1')
    assert.ok(desktop.env?.AGENT_DESKTOP_BIN?.includes('agent-desktop'))

    // RustXNG is auto-discovered and registered when the binary exists
    const rustxng = defaults.mcpServers.rustxng
    if (rustxng) {
      assert.equal(rustxng.trusted, true)
      assert.deepEqual(rustxng.args, ['mcp'])
    }

    // Opt-out test
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        automation: {
          search: { enabled: false },
        },
      }),
    )
    const disabledConfig = loadConfig({ cwd: ws })
    assert.equal(disabledConfig.mcpServers.rustxng, undefined, 'search: { enabled: false } disables rustxng')
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('profiles overlay the user config; --full-auto implies workspace-write; project MCP/hooks need trust', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-config-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(path.join(ws, '.hy-harness'), { recursive: true })
    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({
        roles: { worker: { provider: 'ollama', model: 'base-model', temperature: 0.2 } },
        mcpServers: { mine: { command: 'node' } },
        profiles: { deep: { roles: { worker: { model: 'deep-model' } }, sandboxMode: 'read-only', web: { enabled: true } } },
      }),
    )
    fs.writeFileSync(
      path.join(ws, '.hy-harness', 'config.json'),
      JSON.stringify({ mcpServers: { project: { command: 'node' } }, hooks: { turnEnd: [{ command: ['node'] }] } }),
    )
    process.env.HY_CONFIG_DIR = user

    const plain = loadConfig({ cwd: ws })
    assert.equal(plain.role.model, 'base-model')
    assert.equal(plain.sandbox, 'workspace-write', 'CP-01: confinement is the default')
    assert.equal(plain.sandboxSource, 'default')
    assert.equal(plain.web, undefined)
    assert.deepEqual(Object.keys(plain.mcpServers), ['mine'], 'an untrusted project adds no MCP servers')
    assert.equal((plain.hooks.turnEnd ?? []).length, 0, 'an untrusted project adds no hooks')

    const deep = loadConfig({ cwd: ws, profile: 'deep' })
    assert.equal(deep.sandboxSource, 'config')
    assert.equal(deep.role.model, 'deep-model')
    assert.equal(deep.role.temperature, 0.2, 'nested objects are merged, not replaced')
    assert.equal(deep.sandbox, 'read-only')
    assert.equal(deep.web?.enabled, true)
    assert.throws(() => loadConfig({ cwd: ws, profile: 'nope' }), /unknown profile nope; defined: deep/)

    const auto = loadConfig({ cwd: ws, fullAuto: true })
    assert.equal(auto.sandbox, 'workspace-write')
    assert.equal(auto.fullAuto, true)

    const trusted = loadConfig({ cwd: ws, projectTrusted: true })
    assert.deepEqual(Object.keys(trusted.mcpServers).sort(), ['mine', 'project'])
    assert.equal(trusted.hooks.turnEnd?.length, 1)
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bundles narrow tools, apply role defaults and stay profile-compatible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-bundles-config-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user
    // A profile that selects bundles keeps working, and `--bundle` adds to it.
    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({
        roles: { worker: { provider: 'deepseek', model: 'deepseek-flash' } },
        profiles: { audit: { bundles: ['minimal'], sandboxMode: 'read-only' } },
      }),
    )
    const viaProfile = loadConfig({ cwd: ws, profile: 'audit' })
    assert.deepEqual(viaProfile.bundles.names, ['core', 'minimal'])
    assert.deepEqual([...viaProfile.bundles.tools!].sort(), ['read_file', 'search_glob', 'search_grep'])
    assert.equal(viaProfile.sandbox, 'read-only')

    const viaFlag = loadConfig({ cwd: ws, bundle: ['minimal'] })
    assert.deepEqual(viaFlag.bundles.names, ['core', 'minimal'])
    // No bundle flags: core adds no restriction at all (nothing widened or narrowed).
    const plain = loadConfig({ cwd: ws })
    assert.deepEqual(plain.bundles.names, ['core'])
    assert.equal(plain.bundles.tools, undefined)

    // A bundle's role default is used only when the role does not set its own.
    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({ roles: { worker: { provider: 'deepseek', model: 'deepseek-flash' } } }),
    )
    const withDefaults = loadConfig({ cwd: ws, bundle: ['ptc'] })
    assert.deepEqual(withDefaults.bundles.names, ['core', 'ptc'])
    assert.equal(withDefaults.bundles.roleDefaults.maxOutputTokens, undefined)

    // An unknown bundle fails loudly instead of silently widening a session.
    assert.throws(() => loadConfig({ cwd: ws, bundle: ['nope'] }), /unknown bundle nope/)
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-01: the sandbox defaults to workspace-write, with explicit opt-outs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-default-sandbox-'))
  const saved = process.env.HY_CONFIG_DIR
  const savedSandbox = process.env.HY_SANDBOX
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user
    delete process.env.HY_SANDBOX

    const fresh = loadConfig({ cwd: ws })
    assert.equal(fresh.sandbox, 'workspace-write')
    assert.equal(fresh.sandboxSource, 'default')
    assert.equal(loadConfig({ cwd: ws, sandbox: 'unconfined' }).sandbox, 'unconfined')
    assert.equal(loadConfig({ cwd: ws, sandbox: 'unconfined' }).sandboxSource, 'cli')

    const legacy = loadConfig({ cwd: ws, sandbox: 'unconfined' })
    assert.equal(legacy.sandbox, 'unconfined')
    assert.equal(legacy.sandboxSource, 'cli', '--unsafe-unconfined is an explicit choice')

    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({ sandbox: { legacyUnconfined: true }, roles: { worker: { provider: 'mock', model: 'mock' } } }),
    )
    const pinned = loadConfig({ cwd: ws })
    assert.equal(pinned.sandbox, 'unconfined')
    assert.equal(pinned.sandboxSource, 'default', 'a user-config opt-out is still the default path')

    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({ sandbox: { legacyUnconfined: true }, sandboxMode: 'workspace-write' }),
    )
    assert.equal(loadConfig({ cwd: ws }).sandbox, 'workspace-write', 'sandboxMode outranks legacyUnconfined')

    process.env.HY_SANDBOX = 'read-only'
    assert.equal(loadConfig({ cwd: ws }).sandbox, 'read-only')
    assert.equal(loadConfig({ cwd: ws }).sandboxSource, 'env')
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    if (savedSandbox === undefined) delete process.env.HY_SANDBOX
    else process.env.HY_SANDBOX = savedSandbox
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-02: permission profiles resolve denyRead paths and reject unknown names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-deny-read-'))
  const saved = process.env.HY_CONFIG_DIR
  const savedSecret = process.env.HY_DENY_TEST_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user
    process.env.HY_DENY_TEST_DIR = path.join(dir, 'secret')

    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({
        defaultPermissions: 'safe',
        permissions: {
          safe: { description: 'no secrets', denyRead: ['~/.ssh', '%HY_DENY_TEST_DIR%', '~/.ssh'] },
          wide: { denyRead: [] },
        },
        sandbox: { denyRead: ['relative/.env'] },
        roles: { worker: { provider: 'mock', model: 'mock' } },
      }),
    )

    const config = loadConfig({ cwd: ws })
    assert.equal(config.permissionProfile, 'safe')
    assert.equal(config.denyRead.length, 3, config.denyRead.join(','))
    assert.equal(config.denyRead[0], path.join(os.homedir(), '.ssh'))
    assert.equal(config.denyRead[1], path.join(dir, 'secret'))
    assert.equal(config.denyRead[2], path.join(ws, 'relative', '.env'))

    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({ defaultPermissions: 'nope', permissions: { safe: { denyRead: [] } }, roles: { worker: { provider: 'mock', model: 'mock' } } }),
    )
    assert.throws(() => loadConfig({ cwd: ws }), /unknown permission profile nope; defined: safe/)

    // A project config cannot introduce profiles of its own.
    fs.mkdirSync(path.join(ws, '.hy-harness'), { recursive: true })
    fs.writeFileSync(
      path.join(ws, '.hy-harness', 'config.json'),
      JSON.stringify({ permissions: { project: { denyRead: ['C:/x'] } } }),
    )
    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ roles: { worker: { provider: 'mock', model: 'mock' } } }))
    assert.deepEqual(loadConfig({ cwd: ws }).denyRead, [])
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    if (savedSecret === undefined) delete process.env.HY_DENY_TEST_DIR
    else process.env.HY_DENY_TEST_DIR = savedSecret
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-02: profile inheritance, read-only carve-outs and cycle rejection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-profile-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user

    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({
        defaultPermissions: 'strict',
        permissions: {
          base: { description: 'base', denyRead: ['~/.aws'], readOnly: ['vendor'] },
          strict: { extends: 'base', denyRead: ['~/.ssh'], readOnly: ['node_modules'] },
        },
        roles: { worker: { provider: 'mock', model: 'mock' } },
      }),
    )
    const config = loadConfig({ cwd: ws })
    assert.equal(config.permissionProfile, 'strict')
    assert.deepEqual(config.denyRead, [path.join(os.homedir(), '.aws'), path.join(os.homedir(), '.ssh')])
    assert.deepEqual(config.readOnlySubpaths, [path.join(ws, 'vendor'), path.join(ws, 'node_modules')])

    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({
        defaultPermissions: 'outside',
        permissions: { outside: { readOnly: [path.join(dir, 'elsewhere')] } },
        roles: { worker: { provider: 'mock', model: 'mock' } },
      }),
    )
    assert.throws(() => loadConfig({ cwd: ws }), /not a subdirectory of the workspace/)

    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({
        defaultPermissions: 'a',
        permissions: { a: { extends: 'b' }, b: { extends: 'a' } },
        roles: { worker: { provider: 'mock', model: 'mock' } },
      }),
    )
    assert.throws(() => loadConfig({ cwd: ws }), /permission profile cycle: a -> b -> a/)
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-08: an unknown apiKeySecret fails closed with the command to fix it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-secret-config-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user
    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({ roles: { worker: { provider: 'deepseek', model: 'deepseek-flash', apiKeySecret: 'missing' } } }),
    )
    assert.throws(() => loadConfig({ cwd: ws }), /worker: unknown secret missing; run: hy secret set missing/)
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-05: the approval policy defaults to untrusted and validates values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-approval-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user
    assert.equal(loadConfig({ cwd: ws }).approvalPolicy, 'untrusted')
    assert.equal(loadConfig({ cwd: ws, approvalPolicy: 'on-request' }).approvalPolicy, 'on-request')
    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ approvalPolicy: 'never' }))
    assert.equal(loadConfig({ cwd: ws }).approvalPolicy, 'never')
    assert.throws(() => parseApprovalPolicy('sometimes'), /unknown approval policy "sometimes"; expected one of/)
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-20: memory.auto is only on when both memory and auto are enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-memory-config-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user
    assert.equal(loadConfig({ cwd: ws }).memoryAuto, false)
    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ memory: { enabled: true, auto: true } }))
    assert.equal(loadConfig({ cwd: ws }).memoryAuto, true)
    assert.equal(loadConfig({ cwd: ws }).memory, true)
    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ memory: { enabled: false, auto: true } }))
    assert.equal(loadConfig({ cwd: ws }).memoryAuto, true, 'auto is independent; the pipeline also requires memory')
    assert.equal(loadConfig({ cwd: ws }).memory, false)
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-38: user feature overrides resolve into the config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-features-config-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user
    assert.equal(loadConfig({ cwd: ws }).features.streaming, true)
    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ features: { streaming: false } }))
    const off = loadConfig({ cwd: ws })
    assert.equal(off.features.streaming, false)
    assert.equal(off.features['tool-search'], false)
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('reasoningHistory defaults to full; the user config can turn it off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-reasoning-config-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user
    assert.equal(loadConfig({ cwd: ws }).reasoningHistory, 'full')
    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ reasoningHistory: 'none' }))
    assert.equal(loadConfig({ cwd: ws }).reasoningHistory, 'none')
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('promptVariant defaults to lean4; the user config can pick lean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-variant-config-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user
    assert.equal(loadConfig({ cwd: ws }).promptVariant, 'lean4')
    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ promptVariant: 'lean' }))
    assert.equal(loadConfig({ cwd: ws }).promptVariant, 'lean')
    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ promptVariant: 'nonsense' }))
    assert.equal(loadConfig({ cwd: ws }).promptVariant, 'lean4')
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-37: profiles override the user layer and unknown profiles fail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-profile-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    process.env.HY_CONFIG_DIR = user
    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({ roles: { worker: { provider: 'ollama', model: 'base-model' } }, profiles: { dev: { roles: { worker: { model: 'dev-model' } } } } }),
    )
    assert.equal(loadConfig({ cwd: ws }).role.model, 'base-model')
    assert.equal(loadConfig({ cwd: ws, profile: 'dev' }).role.model, 'dev-model')
    assert.equal(loadConfig({ cwd: ws, profile: 'dev' }).role.provider, 'ollama', 'the profile is merged, not replaced')
    assert.throws(() => loadConfig({ cwd: ws, profile: 'nope' }), /unknown profile nope; defined: dev/)
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CP-37: config paths report every layer', () => {
  const paths = configPaths('/ws', '/state')
  assert.equal(paths.workspaceRoot, '/ws')
  assert.equal(paths.projectConfig, path.join('/ws', '.hy-harness', 'config.json'))
  assert.equal(paths.stateDir, '/state')
  assert.equal(paths.worktreesDir, path.join('/state', 'worktrees'))
  assert.ok(paths.userConfig.endsWith('config.json'))
})
test('CP-19: every hook event survives loading, user hooks before trusted project hooks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-hook-events-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(path.join(ws, '.hy-harness'), { recursive: true })
    process.env.HY_CONFIG_DIR = user
    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({

        hooks: {
          sessionStart: [{ command: ['user-start'] }],
          userPromptSubmit: [{ command: ['user-prompt'] }],
          permissionRequest: [{ command: ['user-perm'] }],
          stop: [{ command: ['user-stop'] }],
        },
      }),
    )
    fs.writeFileSync(path.join(ws, '.hy-harness', 'config.json'), JSON.stringify({ hooks: { sessionStart: [{ command: ['project-start'] }] } }))
    const config = loadConfig({ cwd: ws, mock: true, projectTrusted: true })
    assert.deepEqual(config.hooks.sessionStart?.map((h) => h.command[0]), ['user-start', 'project-start'])
    assert.equal(config.hooks.userPromptSubmit?.length, 1)
    assert.equal(config.hooks.permissionRequest?.length, 1)
    assert.equal(config.hooks.stop?.length, 1)
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('budget: maxCostUsd defaults to undefined (off) unless explicitly set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-budget-test-'))
  try {
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(path.join(ws, '.hy-harness'), { recursive: true })
    const configDefault = loadConfig({ cwd: ws, mock: true })
    assert.equal(configDefault.budget.maxCostUsd, undefined, 'default budget must not impose a USD cap')

    const configExplicit = loadConfig({ cwd: ws, mock: true, maxCostUsd: 5 })
    assert.equal(configExplicit.budget.maxCostUsd, 5)

    const configOff = loadConfig({ cwd: ws, mock: true, maxCostUsd: 'off' })
    assert.equal(configOff.budget.maxCostUsd, undefined)

    fs.writeFileSync(
      path.join(ws, '.hy-harness', 'config.json'),
      JSON.stringify({ budget4D: { maxCostUsd: 1.5 } }),
    )
    const configProject = loadConfig({ cwd: ws, mock: true, projectTrusted: true })
    assert.equal(configProject.budget.maxCostUsd, 1.5)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('limits: an unregistered model gets conservative limits; set or registered ones win', async () => {
  const { applyModelLimits, UNKNOWN_MODEL_CONTEXT_TOKENS, UNKNOWN_MODEL_OUTPUT_TOKENS } = await import('./config.js')
  const { setModelRegistry } = await import('./model-catalog.js')
  const base = { provider: 'openai-compatible' as const, contextWindowTokens: 1_047_576, maxOutputTokens: 32_768 }
  try {
    setModelRegistry([])
    const unknown = { ...base, model: 'my-local-32k' }
    applyModelLimits(unknown, {})
    assert.equal(unknown.contextWindowTokens, UNKNOWN_MODEL_CONTEXT_TOKENS)
    assert.equal(unknown.maxOutputTokens, UNKNOWN_MODEL_OUTPUT_TOKENS)
    // The provider's own default model keeps the provider default.
    const known = { ...base, model: 'gpt-4.1-mini' }
    applyModelLimits(known, {})
    assert.equal(known.contextWindowTokens, 1_047_576)
    // An explicit setting is never touched.
    const explicit = { ...base, model: 'my-local-32k', contextWindowTokens: 500_000 }
    applyModelLimits(explicit, { contextWindowTokens: 500_000 })
    assert.equal(explicit.contextWindowTokens, 500_000)
    // A registry entry describes the model.
    setModelRegistry([{ id: 'openai-compatible:big', provider: 'openai-compatible', model: 'big', label: 'big', contextWindowTokens: 400_000, maxOutputTokens: 64_000 }])
    const listed = { ...base, model: 'big' }
    applyModelLimits(listed, {})
    assert.deepEqual([listed.contextWindowTokens, listed.maxOutputTokens], [400_000, 64_000])
  } finally {
    setModelRegistry([])
  }
})
