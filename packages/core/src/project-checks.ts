// A7: the checks a project defines for itself (test, lint, type check, build),
// read from its manifests at the workspace root. The list goes into the session
// context, so the model does not spend steps rediscovering how to verify a
// change, and the verification gate has something concrete to point at.
//
// Only what the manifests declare is listed: no command is guessed from the
// language alone, and nothing here runs a command.

import fs from 'node:fs'
import path from 'node:path'

export interface ProjectCheck {
  /** The command to run from the workspace root. */
  command: string
  kind: 'test' | 'lint' | 'typecheck' | 'build' | 'check'
  /** The manifest it came from. */
  source: string
}

const KIND_OF: Array<[RegExp, ProjectCheck['kind']]> = [
  [/^test(:unit)?$/, 'test'],
  [/^(type-?check|tsc|check:types|types)$/, 'typecheck'],
  [/^lint$/, 'lint'],
  [/^(check|verify|validate)$/, 'check'],
  [/^build$/, 'build'],
]

function readText(file: string): string | undefined {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 1_000_000) return undefined
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function packageRunner(root: string): string {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn'
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun'
  return 'npm'
}

export function discoverProjectChecks(root: string): ProjectCheck[] {
  const checks: ProjectCheck[] = []
  const add = (check: ProjectCheck) => {
    if (!checks.some((existing) => existing.command === check.command)) checks.push(check)
  }

  const pkgText = readText(path.join(root, 'package.json'))
  if (pkgText) {
    try {
      const scripts = (JSON.parse(pkgText) as { scripts?: Record<string, unknown> }).scripts ?? {}
      const runner = packageRunner(root)
      for (const name of Object.keys(scripts)) {
        const kind = KIND_OF.find(([pattern]) => pattern.test(name))?.[1]
        if (!kind || typeof scripts[name] !== 'string') continue
        // npm's placeholder test script fails by design.
        if (name === 'test' && /no test specified/.test(String(scripts[name]))) continue
        const command = name === 'test' && runner !== 'yarn' ? `${runner} test` : runner === 'npm' ? `npm run ${name}` : `${runner} ${name}`
        add({ command, kind, source: 'package.json' })
      }
    } catch {
      // A broken package.json declares nothing.
    }
  }

  if (readText(path.join(root, 'Cargo.toml')) !== undefined) {
    add({ command: 'cargo test', kind: 'test', source: 'Cargo.toml' })
    add({ command: 'cargo clippy --all-targets', kind: 'lint', source: 'Cargo.toml' })
  }

  if (readText(path.join(root, 'go.mod')) !== undefined) {
    add({ command: 'go test ./...', kind: 'test', source: 'go.mod' })
    add({ command: 'go vet ./...', kind: 'lint', source: 'go.mod' })
  }

  const pyproject = readText(path.join(root, 'pyproject.toml')) ?? ''
  const pytestDeclared = /\[tool\.pytest/.test(pyproject) || fs.existsSync(path.join(root, 'pytest.ini')) ||
    /\[tool:pytest\]/.test(readText(path.join(root, 'setup.cfg')) ?? '') || /\[pytest\]/.test(readText(path.join(root, 'tox.ini')) ?? '')
  if (pytestDeclared) add({ command: 'python -m pytest', kind: 'test', source: pyproject && /\[tool\.pytest/.test(pyproject) ? 'pyproject.toml' : 'pytest config' })
  if (/\[tool\.ruff/.test(pyproject)) add({ command: 'ruff check .', kind: 'lint', source: 'pyproject.toml' })
  if (/\[tool\.mypy/.test(pyproject)) add({ command: 'mypy .', kind: 'typecheck', source: 'pyproject.toml' })

  const makefile = readText(path.join(root, 'Makefile')) ?? readText(path.join(root, 'makefile'))
  if (makefile) {
    for (const match of makefile.matchAll(/^(test|lint|check|typecheck|build)\s*:(?!=)/gm)) {
      const kind = KIND_OF.find(([pattern]) => pattern.test(match[1]!))?.[1] ?? 'check'
      add({ command: `make ${match[1]}`, kind, source: 'Makefile' })
    }
  }

  const deno = readText(path.join(root, 'deno.json')) ?? readText(path.join(root, 'deno.jsonc'))
  if (deno) {
    try {
      const tasks = (JSON.parse(deno.replace(/^\s*\/\/.*$/gm, '')) as { tasks?: Record<string, unknown> }).tasks ?? {}
      for (const name of Object.keys(tasks)) {
        const kind = KIND_OF.find(([pattern]) => pattern.test(name))?.[1]
        if (kind) add({ command: `deno task ${name}`, kind, source: 'deno.json' })
      }
    } catch {
      // Ignore an unreadable deno.json.
    }
  }

  const order: ProjectCheck['kind'][] = ['test', 'typecheck', 'lint', 'check', 'build']
  return checks.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, 10)
}

/** The session-context section ('' when the project declares no checks). */
export function renderProjectChecks(checks: readonly ProjectCheck[]): string {
  if (checks.length === 0) return ''
  return [
    'Project checks (declared in the workspace manifests; run the narrowest one that covers a change, and a scoped variant when one exists):',
    ...checks.map((check) => `- ${check.kind}: ${check.command} (${check.source})`),
  ].join('\n')
}
