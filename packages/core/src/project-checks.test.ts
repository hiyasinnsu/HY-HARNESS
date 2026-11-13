import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverProjectChecks, renderProjectChecks } from './project-checks.js'

function workspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-checks-'))
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
  return dir
}

test('A7: package scripts use the lockfile runner; the npm placeholder test is skipped', () => {
  const pnpm = workspace({
    'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'tsc', dev: 'vite' } }),
    'pnpm-lock.yaml': '',
  })
  const npm = workspace({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'x' } }) })
  try {
    assert.deepEqual(discoverProjectChecks(pnpm).map((c) => c.command), ['pnpm test', 'pnpm typecheck', 'pnpm lint', 'pnpm build'])
    assert.deepEqual(discoverProjectChecks(npm).map((c) => c.command), ['npm run lint'])
  } finally {
    fs.rmSync(pnpm, { recursive: true, force: true })
    fs.rmSync(npm, { recursive: true, force: true })
  }
})

test('A7: Cargo, Go, pytest/ruff/mypy and Makefile targets are listed; nothing is guessed from source files', () => {
  const dir = workspace({
    'Cargo.toml': '[package]\nname = "x"\n',
    'go.mod': 'module x\n',
    'pyproject.toml': '[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n',
    'Makefile': 'test:\n\techo\nlint: deps\n\techo\nVAR := 1\n',
  })
  const bare = workspace({ 'main.py': 'print(1)\n' })
  try {
    const commands = discoverProjectChecks(dir).map((c) => c.command)
    for (const expected of ['cargo test', 'go test ./...', 'python -m pytest', 'ruff check .', 'mypy .', 'make test', 'make lint']) {
      assert.ok(commands.includes(expected), `${expected} in ${commands.join(', ')}`)
    }
    assert.ok(commands.length <= 10)
    assert.deepEqual(discoverProjectChecks(bare), [])
    assert.equal(renderProjectChecks([]), '')
    assert.match(renderProjectChecks(discoverProjectChecks(dir)), /^Project checks \(declared in the workspace manifests;[^\n]*\n- test: cargo test \(Cargo\.toml\)/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(bare, { recursive: true, force: true })
  }
})

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-ws-'))
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text)
  }
  return dir
}

test('B9: workspace packages are found from pnpm, npm workspaces, Cargo and go.work', async () => {
  const { discoverWorkspacePackages } = await import('./project-checks.js')
  const dir = tree({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - apps/web # the site\n",
    'pnpm-lock.yaml': '',
    'packages/core/package.json': JSON.stringify({ name: '@x/core', scripts: { test: 'node --test', build: 'tsc' } }),
    'packages/cli/package.json': JSON.stringify({ name: '@x/cli' }),
    'apps/web/package.json': JSON.stringify({ name: 'web' }),
    'Cargo.toml': '[workspace]\nmembers = [\n  "crates/*",\n]\n',
    'crates/server/Cargo.toml': '[package]\nname = "hy-server"\nversion = "0.1.0"\n',
    'go.work': 'go 1.22\n\nuse (\n\t./svc/api\n)\n',
    'svc/api/go.mod': 'module x/api\n',
  })
  const npm = tree({
    'package.json': JSON.stringify({ workspaces: { packages: ['libs/**'] } }),
    'libs/a/package.json': JSON.stringify({ name: 'a' }),
    'libs/group/b/package.json': JSON.stringify({ name: 'b' }),
  })
  try {
    const found = discoverWorkspacePackages(dir).map((pkg) => `${pkg.kind}:${pkg.dir}:${pkg.name}`).sort()
    assert.deepEqual(found, ['cargo:crates/server:hy-server', 'go:svc/api:svc/api', 'node:apps/web:web', 'node:packages/cli:@x/cli', 'node:packages/core:@x/core'])
    assert.deepEqual(discoverWorkspacePackages(npm).map((pkg) => pkg.name).sort(), ['a', 'b'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(npm, { recursive: true, force: true })
  }
})

test('B9: the changed packages\' own checks come first, scoped to them; the deepest package owns a file', async () => {
  const { checksFor, discoverWorkspacePackages, packagesOf, discoverProjectChecks } = await import('./project-checks.js')
  const dir = tree({
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'pnpm-lock.yaml': '',
    'package.json': JSON.stringify({ scripts: { test: 'pnpm -r test' } }),
    'packages/core/package.json': JSON.stringify({ name: '@x/core', scripts: { test: 'node --test', typecheck: 'tsc --noEmit', dev: 'x' } }),
    'packages/cli/package.json': JSON.stringify({ name: '@x/cli', scripts: { test: 'node --test' } }),
    'Cargo.toml': '[workspace]\nmembers = ["crates/a"]\n',
    'crates/a/Cargo.toml': '[package]\nname = "a-crate"\n',
  })
  try {
    const packages = discoverWorkspacePackages(dir)
    const changed = packagesOf(dir, packages, ['packages/core/src/x.ts', 'main:crates/a/src/lib.rs', 'README.md', '../outside.ts'])
    assert.deepEqual(changed.map((pkg) => pkg.dir), ['packages/core', 'crates/a'])
    const commands = checksFor(dir, discoverProjectChecks(dir), changed).map((check) => check.command)
    assert.deepEqual(commands.slice(0, 4), ['pnpm --filter @x/core test', 'pnpm --filter @x/core typecheck', 'cargo test -p a-crate', 'cargo clippy -p a-crate --all-targets'])
    assert.ok(commands.includes('pnpm test'), 'the root checks follow')
    assert.ok(!commands.some((command) => command.includes('@x/cli')), 'unchanged packages are not listed')
    assert.ok(commands.length <= 10)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('B9: after an edit in a package, the next request lists that package\'s checks first', async () => {
  const { Agent } = await import('./agent.js')
  const { SessionLog } = await import('./session-log.js')
  const { ToolRuntime } = await import('./tools.js')
  const dir = tree({
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'pnpm-lock.yaml': '',
    'package.json': JSON.stringify({ scripts: { test: 'pnpm -r test' } }),
    'packages/core/package.json': JSON.stringify({ name: '@x/core', scripts: { test: 'node --test' } }),
  })
  try {
    const requests: string[] = []
    const replies = [
      { toolCalls: [{ name: 'apply_patch', args: { file: 'packages/core/a.ts', content: 'x' } }] },
      { toolCalls: [{ name: 'shell', args: { command: 'pnpm --filter @x/core test' } }] },
      { content: 'Done; the core tests pass.' },
    ]
    const provider = {
      name: 'scripted',
      complete: async (messages: Array<{ content: string }>) => {
        requests.push(messages.map((m) => m.content).join('\n'))
        const next = replies.shift()!
        return { content: next.content ?? '', ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}), usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const tools = new ToolRuntime({} as never, dir)
    ;(tools as unknown as { execute: unknown }).execute = async (tool: string) =>
      tool === 'shell' ? { exitCode: 0, stdout: 'ok', stderr: '' } : { appliedFiles: ['packages/core/a.ts'], created: [], deleted: [], warnings: [] }
    const log = new SessionLog(path.join(dir, 'log.jsonl'))
    log.setRun('run-b9')
    await new Agent({ provider, tools, sessionLog: log, workspaceRoot: dir, nativeTools: true }).run('change core')
    assert.doesNotMatch(requests[0]!, /--filter @x\/core/)
    assert.match(requests[1]!, /- test: pnpm --filter @x\/core test \(packages\/core\)\n- test: pnpm test \(package\.json\)/)
    // One context update for the change, not one per step.
    assert.equal(log.events().filter((e) => e.type === 'context/update').length, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
