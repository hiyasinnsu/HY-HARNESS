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
