import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { findSecrets } from './secret-scan.js'
import { buildGitAuthEnv, parseGitHubRepo, redactGitHubSecrets, withoutGitHubCredentials, type GitHubRepoRef } from './github.js'

const exec = promisify(execFile)

function gitExecutable(): string {
  const name = process.platform === 'win32' ? 'git.exe' : 'git'
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const dir = entry.replace(/^"|"$/g, '')
    if (!path.isAbsolute(dir)) continue
    const file = path.join(dir, name)
    if (fs.existsSync(file)) return file
  }
  throw new Error('Git executable not found. Install Git and make it available on PATH.')
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = withoutGitHubCredentials()
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key)) delete env[key]
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', LC_ALL: 'C' }
}

class GitFailure extends Error {
  constructor(readonly code: number | string | undefined, detail: string) {
    super(detail)
  }
}

async function git(cwd: string, args: string[], signal?: AbortSignal, env = cleanEnv(), token?: string) {
  try {
    const result = await exec(gitExecutable(), [
      '-c', `safe.directory=${cwd.replace(/\\/g, '/')}`,
      '-c', `core.hooksPath=${os.devNull}`,
      '-c', 'core.fsmonitor=false',
      ...args,
    ], { cwd, env, signal, windowsHide: true, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })
    return result.stdout
  } catch (error) {
    if (signal?.aborted) throw error
    const failure = error as { code?: number | string; stderr?: string; stdout?: string; message?: string }
    const detail = failure.code === 'ENOENT' ? 'Git executable not found. Install Git and make it available on PATH.'
      : redactGitHubSecrets((failure.stderr || failure.stdout || failure.message || 'Git failed').trim(), token)
    throw new GitFailure(failure.code, detail.slice(0, 2_000))
  }
}

function remoteUrl(ref: GitHubRepoRef): string {
  if (!/^[a-z\d][a-z\d-]*$/i.test(ref.owner) || !/^(?!\.{1,2}$)[a-z\d_.-]+$/i.test(ref.repo)) {
    throw new Error('Use a GitHub owner and repository name without a URL or credentials.')
  }
  return `https://github.com/${ref.owner}/${ref.repo}.git`
}

async function existingRepo(cwd: string, signal?: AbortSignal) {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'], signal)).trim()
    return path.relative(fs.realpathSync.native(cwd), fs.realpathSync.native(root)) === ''
  } catch (error) {
    if (error instanceof GitFailure && error.code === 128 && /not a git repository/i.test(error.message)) return false
    throw error
  }
}

async function requireRepo(cwd: string, signal?: AbortSignal) {
  if (!await existingRepo(cwd, signal)) throw new Error('This workspace is not a Git repository. Use git_prepare with the requested GitHub repository.')
}

async function origin(cwd: string, signal?: AbortSignal) {
  try {
    const url = (await git(cwd, ['remote', 'get-url', 'origin'], signal)).trim()
    return parseGitHubRepo(url) ?? null
  } catch (error) {
    if (error instanceof GitFailure && error.code === 2) return null
    throw error
  }
}

async function branchRef(cwd: string, branch: string, signal?: AbortSignal) {
  if (!branch || branch.startsWith('-') || branch === 'HEAD') throw new Error('Supply a branch name such as main.')
  const ref = `refs/heads/${branch}`
  await git(cwd, ['check-ref-format', ref], signal)
  return ref
}

/** Only this isolated bare repository receives auth. It has no workspace config or hooks. */
async function withTransport<T>(token: string | undefined, signal: AbortSignal | undefined, run: (
  dir: string, remote: (args: string[]) => Promise<string>,
) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-git-transport-'))
  try {
    const config = path.join(dir, 'empty-global-config')
    fs.writeFileSync(config, '')
    const env = { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config }
    await git(dir, ['init', '--bare', '--quiet'], signal, env)
    const tls: string[] = []
    if (process.platform === 'win32') {
      const execPath = (await git(dir, ['--exec-path'], signal, env)).trim()
      const ca = path.resolve(execPath, '..', '..', 'etc', 'ssl', 'certs', 'ca-bundle.crt')
      if (fs.existsSync(ca)) tls.push('-c', 'http.sslBackend=openssl', '-c', `http.sslCAInfo=${ca}`)
    }
    const remote = (args: string[]) => git(dir, [
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      '-c', 'http.followRedirects=false', ...tls, ...args,
    ], signal, { ...env, ...buildGitAuthEnv(token) }, token)
    return await run(dir, remote)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export async function gitStatus(cwd: string, signal?: AbortSignal) {
  if (!await existingRepo(cwd, signal)) return { initialized: false, next: 'Use git_prepare to attach the requested GitHub repository.' }
  const [branch, raw, repo] = await Promise.all([
    git(cwd, ['branch', '--show-current'], signal),
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal),
    origin(cwd, signal),
  ])
  const rows = raw.split('\0').filter(Boolean)
  const changes: { status: string; path: string; from?: string }[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const status = row.slice(0, 2)
    const from = /[RC]/.test(status) ? rows[++i] : undefined
    changes.push({ status, path: row.slice(3), ...(from ? { from } : {}) })
  }
  return { initialized: true, branch: branch.trim() || null, origin: repo, changes }
}

export async function gitPrepare(cwd: string, repo: GitHubRepoRef, branch: string, token?: string, signal?: AbortSignal) {
  const url = remoteUrl(repo)
  const ref = await branchRef(cwd, branch, signal)
  const initialized = await existingRepo(cwd, signal)
  if (initialized) {
    const remoteNames = (await git(cwd, ['remote'], signal)).trim().split(/\r?\n/)
    if (remoteNames.includes('origin')) {
      const current = await origin(cwd, signal)
      if (!current || remoteUrl(current).toLowerCase() !== url.toLowerCase()) throw new Error('The current origin points elsewhere. Use the workspace for the requested repository.')
    } else {
      await git(cwd, ['remote', 'add', 'origin', url], signal)
    }
    try {
      await git(cwd, ['rev-parse', '--verify', 'HEAD'], signal)
      return gitStatus(cwd, signal)
    } catch (error) {
      if (!(error instanceof GitFailure) || error.code !== 128) throw error
    }
  }
  return withTransport(token, signal, async (dir, remote) => {
    let remoteHasBranch = true
    try {
      await remote(['ls-remote', '--exit-code', '--heads', url, ref])
    } catch (error) {
      if (!(error instanceof GitFailure) || error.code !== 2) throw error
      remoteHasBranch = false
    }
    if (remoteHasBranch) await remote(['fetch', '--no-tags', url, `${ref}:refs/heads/hy-fetch`])
    if (!initialized) {
      await git(cwd, ['init', '--quiet', '-b', branch], signal)
      await git(cwd, ['remote', 'add', 'origin', url], signal)
    }
    if (remoteHasBranch) {
      await git(cwd, ['-c', `safe.directory=${dir.replace(/\\/g, '/')}`, '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', dir, `refs/heads/hy-fetch:refs/remotes/origin/${branch}`], signal)
      await git(cwd, ['switch', '--track', '-C', branch, `origin/${branch}`], signal)
    }
    return gitStatus(cwd, signal)
  })
}

export async function gitCommit(cwd: string, paths: string[], message: string, token?: string, signal?: AbortSignal) {
  await requireRepo(cwd, signal)
  if (!paths.length || !message.trim()) throw new Error('Provide the commit message and exact repository-relative paths from git_status.')
  const root = fs.realpathSync.native(cwd)
  if (redactGitHubSecrets(message, token) !== message) throw new Error('The commit message contains a GitHub credential.')
  const inMessage = findSecrets(message)
  if (inMessage.length) throw new Error(`The commit message contains a credential (${inMessage.join(', ')}).`)
  for (const file of paths) {
    if (!file || file.startsWith(':') || path.isAbsolute(file) ||
        file.split(/[\\/]/).some((part) => !part || ['.', '..', '.git', '.hy-harness'].includes(part.toLowerCase()))) {
      throw new Error('Commit paths must name individual files inside this workspace.')
    }
    const full = path.resolve(cwd, file)
    if (!fs.existsSync(full)) continue
    const real = fs.realpathSync.native(full)
    const resolved = path.relative(root, real)
    if (resolved.startsWith(`..${path.sep}`) || resolved === '..' || path.isAbsolute(resolved) || !fs.statSync(real).isFile()) {
      throw new Error('Commit paths must point to individual files inside this workspace.')
    }
    const text = await fs.promises.readFile(real, 'utf8')
    if (redactGitHubSecrets(text, token) !== text) throw new Error(`Remove the GitHub credential from ${file} before committing it.`)
    // E2: any other credential the harness recognizes blocks the commit too;
    // the model is told the kind, never the value.
    const found = findSecrets(text)
    if (found.length) throw new Error(`Remove the credential (${found.join(', ')}) from ${file} before committing it, or commit it yourself if it is intentional.`)
  }
  // Literal pathspecs preserve the selected set and leave other staged work alone.
  await git(cwd, ['--literal-pathspecs', 'add', '--', ...paths], signal)
  await git(cwd, ['--literal-pathspecs', 'commit', '--only', '--no-gpg-sign', '-m', message.trim(), '--', ...paths], signal)
  const commit = (await git(cwd, ['rev-parse', 'HEAD'], signal)).trim()
  return { commit, paths }
}

export async function gitPush(cwd: string, repo: GitHubRepoRef, branch: string, token: string, signal?: AbortSignal) {
  await requireRepo(cwd, signal)
  const url = remoteUrl(repo)
  const ref = await branchRef(cwd, branch, signal)
  const commit = (await git(cwd, ['rev-parse', '--verify', 'HEAD'], signal)).trim()
  return withTransport(token, signal, async (dir, remote) => {
    await git(dir, ['-c', `safe.directory=${cwd.replace(/\\/g, '/')}`, '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', cwd, `${commit}:refs/heads/hy-push`], signal)
    await remote(['push', '--porcelain', url, `refs/heads/hy-push:${ref}`])
    return { commit, branch, repo: `${repo.owner}/${repo.repo}` }
  })
}
