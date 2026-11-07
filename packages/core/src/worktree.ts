// CP-16: git worktree isolation.
//
// A worktree is a second checkout of the same repository, tied to a branch, so
// a long task can edit files without colliding with the primary checkout. The
// model changes files there; `apply` moves the changes back as a patch, and
// conflicts are reported instead of being resolved silently.
//
// The worktrees live under the workspace's state directory (never inside the
// repository) so they never show up in `git status` of the main checkout.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface WorktreeInfo {
  path: string
  head?: string
  branch?: string
  detached: boolean
  bare: boolean
}

/** Parses `git worktree list --porcelain` output. */
export function parseWorktreeList(text: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = []
  let current: Partial<WorktreeInfo> = {}
  const flush = () => {
    if (typeof current.path === 'string' && current.path.length > 0) {
      out.push({
        path: current.path,
        ...(current.head !== undefined ? { head: current.head } : {}),
        ...(current.branch !== undefined ? { branch: current.branch } : {}),
        detached: current.detached === true,
        bare: current.bare === true,
      })
    }
    current = {}
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line === '') {
      flush()
      continue
    }
    const space = line.indexOf(' ')
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? '' : line.slice(space + 1)
    switch (key) {
      case 'worktree':
        current.path = value
        break
      case 'HEAD':
        current.head = value
        break
      case 'branch':
        current.branch = value.replace(/^refs\/heads\//, '')
        break
      case 'detached':
        current.detached = true
        break
      case 'bare':
        current.bare = true
        break
      default:
        break
    }
  }
  flush()
  return out
}

/** A branch/directory-safe worktree name (`feature-x`). */
export function sanitizeWorktreeName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48)
  if (cleaned.length === 0) throw new Error(`invalid worktree name: ${JSON.stringify(name)}`)
  return cleaned
}

export function worktreesDir(stateDir: string): string {
  return path.join(stateDir, 'worktrees')
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

/** Runs git in `cwd` with a timeout and no interactive prompts. */
/** Records the last commit of a worktree that was applied to the checkout. */
function appliedRef(name: string): string {
  return `refs/hy/worktree-applied/${name}`
}

/**
 * The commit the next apply diffs from: the last applied one, else (worktrees
 * made before the ref existed) where the branch forked from the checkout's HEAD.
 */
function applyBase(repo: string, target: string, name: string): string {
  const recorded = git(repo, ['rev-parse', '--verify', '-q', appliedRef(name)])
  if (recorded.ok && recorded.stdout.trim()) return recorded.stdout.trim()
  const head = git(repo, ['rev-parse', 'HEAD']).stdout.trim()
  const base = git(target, ['merge-base', 'HEAD', head])
  return base.ok && base.stdout.trim() ? base.stdout.trim() : 'HEAD'
}

function git(cwd: string, args: string[], timeoutMs = 120_000): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '') || (result.error ? result.error.message : ''),
  }
}

export class WorktreeManager {
  constructor(
    readonly repo: string,
    readonly stateDir: string,
  ) {}

  private dir(name: string): string {
    return path.join(worktreesDir(this.stateDir), sanitizeWorktreeName(name))
  }

  isRepo(): boolean {
    return git(this.repo, ['rev-parse', '--git-dir']).ok
  }

  list(): WorktreeInfo[] {
    const result = git(this.repo, ['worktree', 'list', '--porcelain'])
    if (!result.ok) throw new Error(`git worktree list: ${result.stderr.trim()}`)
    return parseWorktreeList(result.stdout)
  }

  /** Creates `<stateDir>/worktrees/<name>` on branch `hy/<name>`; returns its path. */
  create(name: string, options: { base?: string } = {}): { path: string; branch: string } {
    const clean = sanitizeWorktreeName(name)
    const target = this.dir(clean)
    if (fs.existsSync(target)) throw new Error(`a worktree named ${clean} already exists at ${target}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const branch = `hy/${clean}`
    const args = ['worktree', 'add', '-b', branch, target, options.base ?? 'HEAD']
    const result = git(this.repo, args)
    if (!result.ok) throw new Error(`git worktree add: ${result.stderr.trim()}`)
    // Where the next apply starts: the commit the worktree branched from.
    git(this.repo, ['update-ref', appliedRef(clean), branch])
    return { path: target, branch }
  }

  remove(name: string, options: { force?: boolean } = {}): void {
    const target = this.dir(name)
    const result = git(this.repo, ['worktree', 'remove', target, ...(options.force ? ['--force'] : [])])
    if (!result.ok) throw new Error(`git worktree remove: ${result.stderr.trim()}`)
    git(this.repo, ['worktree', 'prune'])
    git(this.repo, ['update-ref', '-d', appliedRef(sanitizeWorktreeName(name))])
  }

  /**
   * Moves the worktree's changes into the primary checkout as a binary patch.
   * Returns the files that applied and any that conflicted (the patch is left
   * unapplied for those).
   */
  apply(
    name: string,
    options: { threeWay?: boolean } = {},
  ): { applied: string[]; conflicts: string[]; empty: boolean; committed?: boolean } {
    const target = this.dir(name)
    if (!fs.existsSync(target)) throw new Error(`no worktree named ${sanitizeWorktreeName(name)} at ${target}`)
    const staged = git(target, ['add', '-A'])
    if (!staged.ok) throw new Error(`git add -A: ${staged.stderr.trim()}`)
    // Everything since the last apply (or since the worktree branched): the
    // commits the agent made there and what is still uncommitted. Diffing the
    // index against HEAD alone missed committed work.
    const from = applyBase(this.repo, target, sanitizeWorktreeName(name))
    const names = git(target, ['diff', '--cached', '--name-only', from])
    const files = names.stdout.split(/\r?\n/).filter(Boolean)
    const patch = git(target, ['diff', '--cached', '--binary', from])
    if (!patch.ok) throw new Error(`git diff: ${patch.stderr.trim()}`)
    if (!patch.stdout.trim()) return { applied: [], conflicts: [], empty: true }
    const patchFile = path.join(this.stateDir, 'worktrees', `${sanitizeWorktreeName(name)}.patch`)
    fs.mkdirSync(path.dirname(patchFile), { recursive: true })
    fs.writeFileSync(patchFile, patch.stdout, 'utf8')
    const applied = git(this.repo, [
      'apply',
      ...(options.threeWay === false ? [] : ['--3way']),
      '--whitespace=nowarn',
      patchFile,
    ])
    fs.rmSync(patchFile, { force: true })
    if (!applied.ok) {
      const conflicts = files.filter((file) => applied.stderr.includes(file))
      return { applied: [], conflicts: conflicts.length > 0 ? conflicts : files, empty: false }
    }
    // Record the applied work on the worktree's branch: the worktree is clean
    // again (so `remove` needs no --force) and `hy/<name>` keeps the change for
    // inspection after the worktree is gone. Hooks run as usual; when one
    // refuses, the apply still stands and `committed` reports it.
    const identity = git(target, ['config', 'user.email']).stdout.trim()
      ? []
      : ['-c', 'user.name=hy-harness', '-c', 'user.email=hy-harness@localhost']
    const commit = git(target, [...identity, 'commit', '-q', '-m', `hy worktree apply: ${sanitizeWorktreeName(name)}`])
    // The next apply starts here, so applied work is never applied twice.
    if (commit.ok) git(this.repo, ['update-ref', appliedRef(sanitizeWorktreeName(name)), `hy/${sanitizeWorktreeName(name)}`])
    return { applied: files, conflicts: [], empty: false, committed: commit.ok }
  }
}