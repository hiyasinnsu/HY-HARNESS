import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  parseGitHubRepo,
  buildGitAuthEnv,
  detectWindowsGitToken,
  resolveGitHubToken,
  withoutGitHubCredentials,
  redactGitHubSecrets,
} from './github.js'
import { gitCommit, gitStatus } from './git.js'
import { ToolRuntime } from './tools.js'
import { TOOL_SPECS, READ_ONLY_TOOLS } from './tool-registry.js'
import type { HarnessConfig } from './config.js'

test('parseGitHubRepo extracts owner and repo from various GitHub URLs', () => {
  assert.deepEqual(parseGitHubRepo('https://github.com/hiyasinnsu/HY_test_DS.git'), {
    owner: 'hiyasinnsu',
    repo: 'HY_test_DS',
  })
  assert.deepEqual(parseGitHubRepo('https://github.com/owner/my-repo'), {
    owner: 'owner',
    repo: 'my-repo',
  })
  assert.deepEqual(parseGitHubRepo('git@github.com:someone/awesome-project.git'), {
    owner: 'someone',
    repo: 'awesome-project',
  })
  assert.equal(parseGitHubRepo('https://gitlab.com/user/project.git'), undefined)
  assert.equal(parseGitHubRepo('https://notgithub.com/user/project.git'), undefined)
  assert.equal(parseGitHubRepo('https://github.com:444/user/project.git'), undefined)
  assert.equal(parseGitHubRepo(''), undefined)
})

test('buildGitAuthEnv produces correct Git authorization environment variables', () => {
  assert.deepEqual(buildGitAuthEnv(undefined), {})
  assert.deepEqual(buildGitAuthEnv(''), {})
  assert.deepEqual(buildGitAuthEnv('   '), {})

  const token = 'ghp_sampleSecretToken12345'
  const env = buildGitAuthEnv(token)

  assert.equal(env.GH_TOKEN, undefined)
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.ok(env.GIT_CONFIG_PARAMETERS)
  assert.ok(env.GIT_CONFIG_PARAMETERS.includes('credential.helper='))
  assert.ok(env.GIT_CONFIG_PARAMETERS.includes('extraheader=AUTHORIZATION: basic '))

  // Verify that the basic authorization header decodes to x-access-token:<token>
  const match = /basic\s+([A-Za-z0-9+/=]+)/.exec(env.GIT_CONFIG_PARAMETERS)
  assert.ok(match, 'basic auth header found')
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8')
  assert.equal(decoded, `x-access-token:${token}`)
  assert.deepEqual(withoutGitHubCredentials({ ...env, gh_token: token, GIT_CONFIG_VALUE_1: token, PATH: '/bin' }), { GIT_TERMINAL_PROMPT: '0', PATH: '/bin' })
  assert.doesNotMatch(redactGitHubSecrets(`${token}\nAUTHORIZATION: Basic ${match[1]}`, token), /sampleSecretToken|[A-Za-z0-9+/]{20,}/)
})

test('native Git status and commit use exact paths, preserve unrelated staged work and reject credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-native-git-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  try {
    assert.equal((await gitStatus(dir)).initialized, false)
    git('init', '-b', 'main')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.test')
    fs.writeFileSync(path.join(dir, 'selected file.md'), 'ship this')
    fs.writeFileSync(path.join(dir, 'keep.md'), 'already staged')
    git('add', '--', 'keep.md')
    assert.deepEqual((await gitStatus(dir)).changes?.map((change) => change.path), ['keep.md', 'selected file.md'])
    await gitCommit(dir, ['selected file.md'], 'Ship selected file')
    assert.equal(git('show', '--format=', '--name-only', 'HEAD'), 'selected file.md')
    assert.equal(git('diff', '--cached', '--name-only'), 'keep.md')
    const token = 'fixture-token-that-must-not-leak'
    fs.writeFileSync(path.join(dir, 'secret.txt'), Buffer.from(`x-access-token:${token}`).toString('base64'))
    await assert.rejects(gitCommit(dir, ['secret.txt'], 'Do not publish', token), /Remove the GitHub credential/)
    const worker = new ToolRuntime({} as never, dir, async () => true, false, { gitReadOnly: true, githubToken: token })
    assert.ok(!worker.toolFeatures().has('git-write') && !worker.toolFeatures().has('github-write'))
    assert.equal((await worker.execute('git_status', {})).initialized, true)
    await assert.rejects(worker.execute('git_commit', { paths: ['keep.md'], message: 'No' }), /belong to the orchestrator/)
    const reader = new ToolRuntime({} as never, dir, undefined, false, { githubToken: token })
    assert.doesNotMatch(JSON.stringify(await reader.execute('read_file', { path: 'secret.txt' })), /eC1hY2Nlc3MtdG9rZW4/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('detectWindowsGitToken safely runs without throwing exceptions', () => {
  const result = detectWindowsGitToken()
  assert.ok(result === undefined || typeof result === 'string')
})

test('resolveGitHubToken prioritizes config over env and credential manager', () => {
  const dummyConfig = {
    automation: {
      github: {
        token: 'token-from-config',
      },
    },
  } as unknown as HarnessConfig

  assert.equal(resolveGitHubToken(dummyConfig), 'token-from-config')

  const prevGh = process.env.GH_TOKEN
  try {
    process.env.GH_TOKEN = 'token-from-env'
    assert.equal(resolveGitHubToken({} as HarnessConfig), 'token-from-env')
  } finally {
    if (prevGh === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = prevGh
  }
})

test('GitHub native tools are properly registered in TOOL_SPECS and READ_ONLY_TOOLS', () => {
  const names = TOOL_SPECS.map((t) => t.name)
  assert.ok(names.includes('github_repo_info'))
  assert.ok(names.includes('github_pages_enable'))
  assert.ok(names.includes('github_actions_status'))
  assert.ok(names.includes('github_create_pr'))

  assert.ok(READ_ONLY_TOOLS.has('github_repo_info'))
  assert.ok(READ_ONLY_TOOLS.has('github_actions_status'))
  assert.ok(!READ_ONLY_TOOLS.has('github_pages_enable'))
  assert.ok(!READ_ONLY_TOOLS.has('github_create_pr'))
})
