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

/** B9: one package of a workspace (monorepo) and the manifest that declares it. */
export interface WorkspacePackage {
  /** Workspace-relative directory, `/`-separated. */
  dir: string
  kind: 'node' | 'cargo' | 'go'
  /** The package name its tools filter by (npm name, crate name); the dir for Go. */
  name: string
}

/**
 * Expands one workspace member pattern relative to `root`: a literal
 * directory, `dir/*` (one level) or `dir/**` (two levels). Other glob forms
 * are rare in workspace files and are ignored rather than guessed.
 */
function expandMember(root: string, pattern: string): string[] {
  const clean = pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  if (!clean || clean.startsWith('!') || clean.includes('..')) return []
  const listDirs = (rel: string) => {
    try {
      return fs.readdirSync(path.join(root, rel), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
        .map((entry) => (rel ? `${rel}/${entry.name}` : entry.name))
    } catch {
      return []
    }
  }
  if (clean.endsWith('/**')) {
    const base = clean.slice(0, -3)
    const first = listDirs(base)
    return [...first, ...first.flatMap(listDirs)]
  }
  if (clean.endsWith('/*')) return listDirs(clean.slice(0, -2))
  if (/[*?[{]/.test(clean)) return []
  return [clean]
}

function listMembers(text: string, key: RegExp): string[] {
  // `key = [ "a", "b/*" ]` (TOML) — the array may span lines.
  const match = key.exec(text)
  if (!match) return []
  return [...match[1]!.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]!)
}

/** The packages a workspace declares (pnpm, npm/yarn/bun workspaces, Cargo, go.work). */
export function discoverWorkspacePackages(root: string): WorkspacePackage[] {
  const out: WorkspacePackage[] = []
  const seen = new Set<string>()
  const push = (pkg: WorkspacePackage) => {
    const key = `${pkg.kind}:${pkg.dir}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(pkg)
    }
  }

  const nodePatterns: string[] = []
  const pnpm = readText(path.join(root, 'pnpm-workspace.yaml'))
  if (pnpm) {
    const block = /^packages:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(pnpm)?.[1] ?? ''
    for (const line of block.split('\n')) {
      const value = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line)?.[1]
      if (value) nodePatterns.push(value)
    }
  }
  const pkgText = readText(path.join(root, 'package.json'))
  if (pkgText) {
    try {
      const workspaces = (JSON.parse(pkgText) as { workspaces?: unknown }).workspaces
      const list = Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown } | undefined)?.packages
      if (Array.isArray(list)) for (const item of list) if (typeof item === 'string') nodePatterns.push(item)
    } catch {
      // A broken package.json declares no workspaces.
    }
  }
  for (const dir of nodePatterns.flatMap((pattern) => expandMember(root, pattern))) {
    const text = readText(path.join(root, dir, 'package.json'))
    if (!text) continue
    try {
      const name = (JSON.parse(text) as { name?: unknown }).name
      if (typeof name === 'string' && name) push({ dir, kind: 'node', name })
    } catch {
      // Skip a package whose manifest does not parse.
    }
  }

  const cargo = readText(path.join(root, 'Cargo.toml'))
  if (cargo && /^\[workspace\]/m.test(cargo)) {
    for (const dir of listMembers(cargo, /^members\s*=\s*\[([\s\S]*?)\]/m).flatMap((pattern) => expandMember(root, pattern))) {
      const name = /^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m.exec(readText(path.join(root, dir, 'Cargo.toml')) ?? '')?.[1]
      if (name) push({ dir, kind: 'cargo', name })
    }
  }

  const goWork = readText(path.join(root, 'go.work'))
  if (goWork) {
    const block = /^use\s*\(([\s\S]*?)\)/m.exec(goWork)?.[1]
    const dirs = block ? block.split('\n') : [...goWork.matchAll(/^use\s+(\S+)/gm)].map((m) => m[1]!)
    for (const raw of dirs) {
      const dir = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '')
      if (dir && dir !== '.' && !dir.startsWith('//') && readText(path.join(root, dir, 'go.mod')) !== undefined) push({ dir, kind: 'go', name: dir })
    }
  }
  return out
}

/** Workspace-relative `/` path of an edited file, or undefined outside the root. */
function relativeTo(root: string, file: string): string | undefined {
  const plain = file.replace(/^main:/, '')
  const rel = path.relative(root, path.resolve(root, plain)).replace(/\\/g, '/')
  return rel.startsWith('../') || rel === '..' || path.isAbsolute(rel) ? undefined : rel
}

/** The packages that contain any of `files` (the deepest package wins for each file). */
export function packagesOf(root: string, packages: readonly WorkspacePackage[], files: readonly string[]): WorkspacePackage[] {
  const hit: WorkspacePackage[] = []
  for (const file of files) {
    const rel = relativeTo(root, file)
    if (rel === undefined) continue
    const owners = packages.filter((pkg) => rel === pkg.dir || rel.startsWith(`${pkg.dir}/`))
    const deepest = owners.sort((a, b) => b.dir.length - a.dir.length)[0]
    if (deepest && !hit.includes(deepest)) hit.push(deepest)
  }
  return hit
}

/** The checks a package declares, filtered to that package. */
export function scopedChecks(root: string, pkg: WorkspacePackage): ProjectCheck[] {
  const checks: ProjectCheck[] = []
  const source = `${pkg.dir}`
  if (pkg.kind === 'cargo') {
    checks.push({ command: `cargo test -p ${pkg.name}`, kind: 'test', source }, { command: `cargo clippy -p ${pkg.name} --all-targets`, kind: 'lint', source })
  } else if (pkg.kind === 'go') {
    checks.push({ command: `go test ./${pkg.dir}/...`, kind: 'test', source }, { command: `go vet ./${pkg.dir}/...`, kind: 'lint', source })
  } else {
    const text = readText(path.join(root, pkg.dir, 'package.json'))
    let scripts: Record<string, unknown> = {}
    try {
      scripts = (JSON.parse(text ?? '{}') as { scripts?: Record<string, unknown> }).scripts ?? {}
    } catch {
      scripts = {}
    }
    const runner = packageRunner(root)
    for (const name of Object.keys(scripts)) {
      const kind = KIND_OF.find(([pattern]) => pattern.test(name))?.[1]
      if (!kind || typeof scripts[name] !== 'string') continue
      if (name === 'test' && /no test specified/.test(String(scripts[name]))) continue
      const command = runner === 'pnpm' ? `pnpm --filter ${pkg.name} ${name}`
        : runner === 'yarn' ? `yarn workspace ${pkg.name} ${name}`
        : runner === 'bun' ? `bun --filter ${pkg.name} run ${name}`
        : `npm run ${name} -w ${pkg.dir}`
      checks.push({ command, kind, source })
    }
  }
  return checks
}

/**
 * The checks to list for this turn: those of the packages the turn changed,
 * first, then the root's, at most 10. With no workspace or no changed package
 * this is the root list alone.
 */
export function checksFor(root: string, rootChecks: readonly ProjectCheck[], changed: readonly WorkspacePackage[]): ProjectCheck[] {
  const scoped = changed.flatMap((pkg) => scopedChecks(root, pkg))
  const all: ProjectCheck[] = []
  for (const check of [...scoped, ...rootChecks]) if (!all.some((existing) => existing.command === check.command)) all.push(check)
  return all.slice(0, 10)
}

/** The session-context section ('' when the project declares no checks). */
export function renderProjectChecks(checks: readonly ProjectCheck[]): string {
  if (checks.length === 0) return ''
  return [
    'Project checks (declared in the workspace manifests; checks of packages changed this turn come first; run the narrowest one that covers a change):',
    ...checks.map((check) => `- ${check.kind}: ${check.command} (${check.source})`),
  ].join('\n')
}
