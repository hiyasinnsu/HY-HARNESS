// CP-42: one command that runs every gate the repository claims to keep green.
//
// Steps mirror the acceptance checks in docs/codex-adoption-plan.md:
//   * clean TypeScript build (`tsc -b --force`) so stale dist cannot hide errors
//   * typecheck, generated-artifact checks (API types, API schema, config schema,
//     protocol types)
//   * Rust tests for the sandbox and exec server
//   * `cargo fmt --check` and `cargo clippy -D warnings`, as in CI
//   * the unit tests: `pnpm test` when child processes can be started; inside a
//     sandbox that forbids them, a per-file sweep of packages/*/dist minus the
//     tests that need child processes (CI runs those on a normal Windows host)
//
// The integration suite (`pnpm test:integration`, ~10 minutes) is separate.
//
// `node scripts/verify-all.mjs --list` prints the steps without running them.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Tests that need real child processes / named pipes; CI runs them on Windows. */
const ENVIRONMENT_ONLY = new Set(['mcp.test.js', 'lsp.test.js'])

/**
 * Whether this process may start children with piped stdio. Inside a
 * workspace-write sandbox it may not (EPERM), and `node --test` itself needs
 * it; elsewhere the full `pnpm test` runs, including the tests above.
 */
function canSpawnPiped() {
  try {
    const r = spawnSync(process.execPath, ['-e', '0'], { stdio: 'pipe', timeout: 10_000 })
    return !r.error && r.status === 0
  } catch {
    return false
  }
}

function unitTestFiles() {
  const roots = ['core', 'seams', 'hy-cli'].map((name) => path.join(repo, 'packages', name, 'dist'))
  const files = []
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.test.js')) files.push(full)
    }
  }
  for (const root of roots) walk(root)
  return files.sort()
}

function steps() {
  const list = [
    // There is no root tsconfig.json: name the projects, as `pnpm build` does.
    {
      name: 'build (clean)',
      command: ['pnpm', ['exec', 'tsc', '-b', '--force', 'packages/core', 'packages/seams', 'packages/hy-cli', 'packages/sdk']],
    },
    { name: 'typecheck', command: ['pnpm', ['typecheck']] },
    { name: 'api types', command: ['pnpm', ['check:api']] },
    { name: 'api schema', command: ['pnpm', ['check:api-schema']] },
    { name: 'config schema', command: ['pnpm', ['check:config-schema']] },
    { name: 'protocol types', command: ['node', ['scripts/gen-protocol.mjs', '--check', '--schema', 'target/schema.json']] },
    { name: 'rust: sandbox', command: ['cargo', ['test', '-p', 'hy-sandbox-windows']] },
    { name: 'rust: exec server', command: ['cargo', ['test', '-p', 'hy-exec-server']] },
    { name: 'rust: fmt', command: ['cargo', ['fmt', '--all', '--', '--check']] },
    { name: 'rust: clippy', command: ['cargo', ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']] },
  ]
  if (canSpawnPiped()) {
    // The same sweep as CI, web tests and child-process tests included.
    list.push({ name: 'unit: pnpm test', command: ['pnpm', ['test']] })
    return list
  }
  for (const file of unitTestFiles()) {
    const relative = path.relative(repo, file).replace(/\\/g, '/')
    list.push({
      name: `unit: ${relative}`,
      command: ['node', [file]],
      environmentOnly: ENVIRONMENT_ONLY.has(path.basename(file)),
    })
  }
  return list
}

const listOnly = process.argv.includes('--list')
const all = steps()
if (listOnly) {
  for (const step of all) {
    process.stdout.write(`${step.environmentOnly ? '(ci) ' : ''}${step.name}\n`)
  }
  process.exit(0)
}

let failed = 0
for (const step of all) {
  if (step.environmentOnly) {
    process.stdout.write(`skip ${step.name} (needs child processes; CI runs it)\n`)
    continue
  }
  const [exe, args] = step.command
  const result = spawnSync(exe, args, { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    failed += 1
    process.stderr.write(`FAIL ${step.name}\n`)
  } else {
    process.stdout.write(`ok   ${step.name}\n`)
  }
}
process.stdout.write(`${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}\n`)
process.exit(failed === 0 ? 0 : 1)