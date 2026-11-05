import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { MemoryStore, readEvents, sessionLogPath } from '../../core/dist/index.js'
import { projectChat } from './chat-projection.js'
import { applyImport, claudeProjectKey, convertClaudeHooks, planClaudeImport, planDshImport, renderImportPlan, shellArgv } from './import.js'

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-import-'))
  const ctx = {
    workspaceRoot: path.join(base, 'ws'),
    stateDir: path.join(base, 'state'),
    userConfigDir: path.join(base, 'hy-user'),
    home: path.join(base, 'home'),
  }
  for (const dir of [ctx.workspaceRoot, ctx.stateDir, ctx.userConfigDir, ctx.home]) fs.mkdirSync(dir, { recursive: true })
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  return { base, ctx, write, done: () => fs.rmSync(base, { recursive: true, force: true }) }
}

test('CP-31 (1): CLAUDE.md becomes AGENTS.md, or is appended once to an existing one', () => {
  const f = fixture()
  try {
    f.write(path.join(f.ctx.workspaceRoot, 'CLAUDE.md'), '# Rules\n\nUse pnpm.\n')
    f.write(path.join(f.ctx.home, '.claude', 'CLAUDE.md'), 'Answer in Japanese.\n')
    const plan = planClaudeImport(f.ctx)
    const agents = plan.filter((i) => i.kind === 'agents')
    assert.deepEqual(agents.map((i) => [i.action, path.basename(path.dirname(i.target))]), [
      ['create', 'ws'],
      ['create', 'hy-user'],
    ])
    assert.match(agents[0]!.diff, /^\+ # Rules/m)
    // Nothing is written by planning.
    assert.equal(fs.existsSync(path.join(f.ctx.workspaceRoot, 'AGENTS.md')), false)
    applyImport(plan)
    assert.equal(fs.readFileSync(path.join(f.ctx.workspaceRoot, 'AGENTS.md'), 'utf8'), '# Rules\n\nUse pnpm.\n')
    assert.equal(fs.readFileSync(path.join(f.ctx.userConfigDir, 'AGENTS.md'), 'utf8'), 'Answer in Japanese.\n')
    // Idempotent.
    assert.ok(planClaudeImport(f.ctx).every((i) => i.action === 'skip'))

    // An existing AGENTS.md gets a marked section, once.
    fs.writeFileSync(path.join(f.ctx.workspaceRoot, 'AGENTS.md'), '# Existing\n')
    const again = planClaudeImport(f.ctx).find((i) => i.kind === 'agents' && i.target.endsWith(path.join('ws', 'AGENTS.md')))!
    assert.equal(again.action, 'update')
    applyImport([again])
    const text = fs.readFileSync(path.join(f.ctx.workspaceRoot, 'AGENTS.md'), 'utf8')
    assert.match(text, /^# Existing\n\n<!-- imported from CLAUDE\.md by hy import -->\n## Imported from CLAUDE\.md\n\n# Rules/)
    assert.equal(planClaudeImport(f.ctx).find((i) => i.kind === 'agents' && i.target.endsWith(path.join('ws', 'AGENTS.md')))!.action, 'skip')
  } finally {
    f.done()
  }
})

test('CP-31 (2): MCP servers merge into the project and user configs without overwriting', () => {
  const f = fixture()
  try {
    f.write(path.join(f.ctx.workspaceRoot, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['docs-mcp'] }, web: { type: 'http', url: 'https://mcp.example/x' } } }))
    f.write(
      path.join(f.ctx.home, '.claude.json'),
      JSON.stringify({ oauthAccount: { secret: 'not read' }, mcpServers: { files: { command: 'files-mcp', env: { TOKEN: 't' } } }, projects: { [f.ctx.workspaceRoot]: { mcpServers: { proj: { command: 'proj-mcp' } } } } }),
    )
    // An existing user server keeps its definition.
    f.write(path.join(f.ctx.userConfigDir, 'config.json'), JSON.stringify({ mcpServers: { files: { command: 'mine' } }, sandbox: { mode: 'workspace-write' } }))
    const plan = planClaudeImport(f.ctx).filter((i) => i.kind === 'mcp')
    assert.equal(plan.length, 2)
    assert.match(plan[0]!.summary, /project MCP servers docs, web; they start only in a trusted project/)
    assert.match(plan[1]!.summary, /user MCP servers proj/)
    applyImport(plan)
    const project = JSON.parse(fs.readFileSync(path.join(f.ctx.workspaceRoot, '.hy-harness', 'config.json'), 'utf8'))
    assert.deepEqual(project.mcpServers, { docs: { command: 'npx', args: ['docs-mcp'] }, web: { url: 'https://mcp.example/x' } })
    const user = JSON.parse(fs.readFileSync(path.join(f.ctx.userConfigDir, 'config.json'), 'utf8'))
    assert.deepEqual(user.mcpServers, { files: { command: 'mine' }, proj: { command: 'proj-mcp' } })
    assert.deepEqual(user.sandbox, { mode: 'workspace-write' }, 'other settings are kept')
    assert.equal(JSON.stringify(user).includes('not read'), false)
  } finally {
    f.done()
  }
})

test('CP-31 (3): Claude hooks map events and tools; unknown ones are reported', () => {
  const converted = convertClaudeHooks(
    {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 5 }] },
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'fmt' }] },
        { matcher: 'mcp__x__y', hooks: [{ type: 'command', command: 'never' }] },
      ],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'log-prompt' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'beep' }] }],
    },
    'linux',
  )
  assert.deepEqual(converted.hooks, {
    preToolUse: [
      { command: ['sh', '-c', 'guard.sh'], tools: ['shell'], timeoutMs: 5000 },
      { command: ['sh', '-c', 'fmt'], tools: ['apply_patch'] },
    ],
    userPromptSubmit: [{ command: ['sh', '-c', 'log-prompt'] }],
  })
  assert.deepEqual(converted.skipped, ['PreToolUse matcher "mcp__x__y" (no HY tool)', 'Notification (no HY event)'])
  assert.deepEqual(shellArgv('a b', 'win32'), ['cmd', '/d', '/s', '/c', 'a b'])

  const f = fixture()
  try {
    f.write(path.join(f.ctx.workspaceRoot, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-done' }] }] } }))
    const plan = planClaudeImport(f.ctx).filter((i) => i.kind === 'hooks')
    applyImport(plan)
    const project = JSON.parse(fs.readFileSync(path.join(f.ctx.workspaceRoot, '.hy-harness', 'config.json'), 'utf8'))
    assert.equal(project.hooks.stop.length, 1)
    // Importing again adds nothing.
    assert.ok(planClaudeImport(f.ctx).filter((i) => i.kind === 'hooks').every((i) => i.action === 'skip'))
  } finally {
    f.done()
  }
})

test('CP-31 (4): skills, commands (as prompts) and the project memory are copied', () => {
  const f = fixture()
  try {
    f.write(path.join(f.ctx.workspaceRoot, '.claude', 'skills', 'release', 'SKILL.md'), '---\nname: release\n---\nSteps.\n')
    f.write(path.join(f.ctx.workspaceRoot, '.claude', 'skills', 'release', 'scripts', 'bump.mjs'), 'export {}\n')
    f.write(path.join(f.ctx.workspaceRoot, '.claude', 'skills', 'not-a-skill', 'README.md'), 'x\n')
    f.write(path.join(f.ctx.workspaceRoot, '.claude', 'commands', 'Review.md'), 'Review $ARGUMENTS\n')
    const memoryDir = path.join(f.ctx.home, '.claude', 'projects', claudeProjectKey(f.ctx.workspaceRoot), 'memory')
    f.write(path.join(memoryDir, 'MEMORY.md'), '- index\n')
    f.write(path.join(memoryDir, 'build-tips.md'), '---\nname: build-tips\n---\nRun pnpm build before tests.\n')
    const plan = planClaudeImport(f.ctx)
    assert.deepEqual(plan.filter((i) => i.action !== 'skip').map((i) => i.kind).sort(), ['memory', 'prompts', 'skills'])
    assert.match(renderImportPlan(plan), /\[create\] skills: copy project skill release/)
    const result = applyImport(plan)
    assert.deepEqual(result.failed, [])
    assert.ok(fs.existsSync(path.join(f.ctx.workspaceRoot, '.hy-harness', 'skills', 'release', 'scripts', 'bump.mjs')))
    assert.equal(fs.readFileSync(path.join(f.ctx.workspaceRoot, '.hy-harness', 'prompts', 'review.md'), 'utf8'), 'Review $ARGUMENTS\n')
    assert.deepEqual(
      MemoryStore.forStateDir(f.ctx.stateDir).list().map((e) => [e.key, e.text]),
      [['claude.build-tips', 'Run pnpm build before tests.']],
    )
    assert.ok(planClaudeImport(f.ctx).every((i) => i.action === 'skip'))
  } finally {
    f.done()
  }
})

test('CP-31 (5): a DSH session (zstd frames of JSON lines) becomes a thread for this workspace only', () => {
  const zstd = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync
  if (!zstd) return
  const f = fixture()
  try {
    const records = (cwd: string, id: string) => [
      { type: 'session', version: 4, id, createdAt: 1_000, cwd },
      { type: 'turn/start', seq: 1, time: 1_001, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 1_002, data: { content: [{ type: 'text', text: 'List the files' }], source: { kind: 'user' }, role: 'user' } },
      { type: 'tool/call', seq: 3, time: 1_003, data: { turn: 1, step: 1, callId: 'c1', name: 'ls', arguments: '{"path":"."}' } },
      { type: 'tool/result', seq: 4, time: 1_004, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'README.md' }], isError: false } } },
      { type: 'assistant/message', seq: 5, time: 1_005, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'There is a README.' }] } } },
      { type: 'turn/end', seq: 6, time: 1_006, data: { turn: 1 } },
      { type: 'session/title', seq: 7, time: 1_007, data: { title: 'Files' } },
    ]
    const frames = (rs: object[]) =>
      Buffer.concat([zstd(Buffer.from(`${rs.slice(0, 3).map((r) => JSON.stringify(r)).join('\n')}\n`)), zstd(Buffer.from(`${rs.slice(3).map((r) => JSON.stringify(r)).join('\n')}\n`))])
    const mine = path.join(f.ctx.home, '.dsh', 'sessions', '--ws--', 'aaaa1111-2222', 'session.v4.jsonl.zstd')
    const other = path.join(f.ctx.home, '.dsh', 'sessions', '--other--', 'bbbb', 'session.v4.jsonl.zstd')
    fs.mkdirSync(path.dirname(mine), { recursive: true })
    fs.mkdirSync(path.dirname(other), { recursive: true })
    fs.writeFileSync(mine, frames(records(f.ctx.workspaceRoot, 'aaaa1111-2222')))
    fs.writeFileSync(other, frames(records(path.join(f.base, 'elsewhere'), 'bbbb')))

    const plan = planDshImport(f.ctx)
    assert.equal(plan.length, 1, renderImportPlan(plan))
    assert.match(plan[0]!.summary, /DSH session aaaa1111 \(1 turn\) → thread dsh-aaaa11112222/)
    applyImport(plan)
    const events = readEvents(sessionLogPath(f.ctx.stateDir))
    const entries = projectChat(events, 'dsh-aaaa11112222')
    assert.deepEqual(
      entries.map((e) => (e.kind === 'user' || e.kind === 'assistant' ? [e.kind, e.text] : [e.kind, e.kind === 'tool' ? e.output : ''])),
      [
        ['user', 'List the files'],
        ['tool', 'README.md'],
        ['assistant', 'There is a README.'],
      ],
    )
    assert.equal(events.find((e) => e.type === 'user/message')!.ts, 1_002, 'original times are kept')
    assert.equal(planDshImport(f.ctx)[0]!.action, 'skip', 'a second import is a no-op')
  } finally {
    f.done()
  }
})
