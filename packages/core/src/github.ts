import { spawnSync } from 'node:child_process'
import type { HarnessConfig } from './config.js'

export interface GitHubRepoRef {
  owner: string
  repo: string
}

let cachedWindowsToken: string | undefined
let cachedWindowsTokenAt = 0

/**
 * Attempts to retrieve a stored GitHub token from the Windows Git Credential Manager
 * by calling `git credential fill`. Results are cached for 5 minutes.
 */
export function detectWindowsGitToken(): string | undefined {
  const now = Date.now()
  if (now - cachedWindowsTokenAt < 5 * 60_000) {
    return cachedWindowsToken
  }
  cachedWindowsTokenAt = now
  cachedWindowsToken = undefined
  try {
    const input = 'protocol=https\nhost=github.com\n\n'
    const res = spawnSync('git', ['credential', 'fill'], {
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      env: { ...withoutGitHubCredentials(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    })
    if (res.status === 0 && res.stdout) {
      const match = /^password=(.+)$/m.exec(res.stdout)
      if (match && match[1]?.trim()) {
        const token = match[1].trim()
        cachedWindowsToken = token
        return token
      }
    }
  } catch {
    // Git credential helper unavailable
  }
  return undefined
}

/**
 * Resolves the GitHub token from config, environment variables, or the Windows credential manager.
 */
export function resolveGitHubToken(config?: HarnessConfig): string | undefined {
  const configured = config?.automation?.github?.token?.trim()
  if (configured) return configured
  const env = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()
  if (env) return env
  return detectWindowsGitToken()
}

/** Keep GitHub auth out of subprocesses whose commands are supplied by a model. */
export function withoutGitHubCredentials(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GITHUB_PAT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_(?:KEY|VALUE)_\d+)$/i.test(key),
  ))
}

export function redactGitHubSecrets(text: string, token?: string): string {
  if (token) {
    for (const value of [Buffer.from(`x-access-token:${token}`).toString('base64'), Buffer.from(token).toString('base64'), token]) {
      text = text.replaceAll(value, '[redacted]')
    }
  }
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, '[redacted]')
    .replace(/(authorization["']?\s*[:=]\s*["']?\s*(?:basic|bearer)\s+)[A-Za-z0-9_+\/=-]{16,}/gi, '$1[redacted]')
}

/**
 * Parses GitHub owner and repository name from a git remote URL or standard GitHub URL.
 */
export function parseGitHubRepo(url: string): GitHubRepoRef | undefined {
  const value = url.trim()
  const scp = /^git@github\.com:(.+)$/i.exec(value)
  let pathname = scp?.[1]
  if (!pathname) {
    try {
      const remote = new URL(value)
      if (remote.hostname !== 'github.com' || remote.port || remote.search || remote.hash ||
          !['https:', 'http:', 'ssh:'].includes(remote.protocol)) return undefined
      pathname = remote.pathname.slice(1)
    } catch {
      return undefined
    }
  }
  const match = /^([a-z\d][a-z\d-]*)\/([a-z\d_.-]+)\/?$/i.exec(pathname)
  const repo = match?.[2]?.replace(/\.git$/i, '')
  return match?.[1] && repo && repo !== '.' && repo !== '..' ? { owner: match[1], repo } : undefined
}

/**
 * Detects the GitHub repo from the current git repository at `cwd`.
 */
export function detectLocalGitHubRepo(cwd: string): GitHubRepoRef | undefined {
  try {
    const res = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    })
    if (res.status === 0 && res.stdout.trim()) {
      return parseGitHubRepo(res.stdout.trim())
    }
  } catch {
    // not a git repo or no remote origin
  }
  return undefined
}

/**
 * Generic GitHub API request helper using standard fetch.
 */
export async function githubApiRequest<T>(
  endpoint: string,
  options: {
    method?: string | undefined
    body?: unknown
    token?: string | undefined
  } = {},
): Promise<T> {
  const token = options.token?.trim()
  const url = endpoint.startsWith('https://') ? endpoint : `https://api.github.com${endpoint.startsWith('/') ? '' : '/'}${endpoint}`
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'HY-HARNESS',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  const init: RequestInit = {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers,
  }
  if (options.body !== undefined) {
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(url, init)
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { text }
  }

  if (!res.ok) {
    const msg = (data as { message?: string })?.message ?? `GitHub API error: ${res.status} ${res.statusText}`
    const error = new Error(msg)
    ;(error as { status?: number }).status = res.status
    ;(error as { data?: unknown }).data = data
    throw error
  }

  return data as T
}

export interface GitHubRepoInfo {
  name: string
  fullName: string
  owner: string
  private: boolean
  htmlUrl: string
  defaultBranch: string
  hasPages: boolean
  description: string | null
}

export async function githubGetRepo(owner: string, repo: string, token?: string): Promise<GitHubRepoInfo> {
  const data = await githubApiRequest<{
    name: string
    full_name: string
    owner: { login: string }
    private: boolean
    html_url: string
    default_branch: string
    has_pages: boolean
    description: string | null
  }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token })

  return {
    name: data.name,
    fullName: data.full_name,
    owner: data.owner.login,
    private: data.private,
    htmlUrl: data.html_url,
    defaultBranch: data.default_branch,
    hasPages: data.has_pages,
    description: data.description,
  }
}

export interface GitHubPagesInfo {
  url: string
  htmlUrl: string
  status: string | null
  buildType: string
  httpsEnforced: boolean
}

export async function githubEnablePages(
  owner: string,
  repo: string,
  buildType: 'workflow' | 'legacy' = 'workflow',
  token?: string,
): Promise<GitHubPagesInfo> {
  const data = await githubApiRequest<{
    url: string
    html_url: string
    status: string | null
    build_type: string
    https_enforced: boolean
  }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pages`, {
    method: 'POST',
    body: { build_type: buildType },
    token,
  })

  return {
    url: data.url,
    htmlUrl: data.html_url,
    status: data.status,
    buildType: data.build_type,
    httpsEnforced: data.https_enforced,
  }
}

export async function githubGetPages(owner: string, repo: string, token?: string): Promise<GitHubPagesInfo | null> {
  try {
    const data = await githubApiRequest<{
      url: string
      html_url: string
      status: string | null
      build_type: string
      https_enforced: boolean
    }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pages`, { token })

    return {
      url: data.url,
      htmlUrl: data.html_url,
      status: data.status,
      buildType: data.build_type,
      httpsEnforced: data.https_enforced,
    }
  } catch (error) {
    if ((error as { status?: number })?.status === 404) return null
    throw error
  }
}

export interface GitHubWorkflowRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  htmlUrl: string
  headBranch: string
  createdAt: string
  updatedAt: string
}

export async function githubListWorkflowRuns(owner: string, repo: string, token?: string, limit = 5): Promise<GitHubWorkflowRun[]> {
  const data = await githubApiRequest<{
    total_count: number
    workflow_runs: Array<{
      id: number
      name: string
      status: string
      conclusion: string | null
      html_url: string
      head_branch: string
      created_at: string
      updated_at: string
    }>
  }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?per_page=${limit}`, { token })

  return (data.workflow_runs ?? []).slice(0, limit).map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    htmlUrl: r.html_url,
    headBranch: r.head_branch,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export interface GitHubPullRequest {
  id: number
  number: number
  title: string
  htmlUrl: string
  state: string
  head: string
  base: string
}

export async function githubCreatePullRequest(
  owner: string,
  repo: string,
  params: {
    title: string
    head: string
    base: string
    body?: string | undefined
  },
  token?: string,
): Promise<GitHubPullRequest> {
  const data = await githubApiRequest<{
    id: number
    number: number
    title: string
    html_url: string
    state: string
    head: { ref: string }
    base: { ref: string }
  }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
    method: 'POST',
    body: params,
    token,
  })

  return {
    id: data.id,
    number: data.number,
    title: data.title,
    htmlUrl: data.html_url,
    state: data.state,
    head: data.head.ref,
    base: data.base.ref,
  }
}

/**
 * Builds environment variables to inject into sandbox shells for authenticated Git & GitHub access.
 * Supplies a GitHub HTTP header to a dedicated Git subprocess.
 * authorization header rather than spawning external credential helpers (avoiding `spawn EPERM`).
 */
export function buildGitAuthEnv(token?: string): Record<string, string> {
  if (!token?.trim()) return {}
  const clean = token.trim()
  const basicAuth = Buffer.from(`x-access-token:${clean}`).toString('base64')
  return {
    GIT_TERMINAL_PROMPT: '0',
    // Injects git config parameters to override credential helper and supply direct authorization header for github.com
    GIT_CONFIG_PARAMETERS: `'credential.helper=' 'http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicAuth}'`,
  }
}
