/**
 * WP-61: "Open In" (DSH's `dsh-host-open-in-app`).
 *
 * The host detects the editors and shells it may launch, and the GUI offers
 * them for a file. Launching is an explicit action with an allowlist: the only
 * commands reachable through the API are the ones `detectOpenIn` found, and the
 * path must resolve inside a workspace root.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type OpenInKind = 'editor' | 'folder' | 'terminal' | 'git'

export interface OpenInTarget {
  id: string
  label: string
  kind: OpenInKind
  /** The executable that was found (shown for transparency). */
  command: string
}

export class OpenInError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenInError'
  }
}

interface Candidate extends OpenInTarget {
  /** Extra argv placed before the path. */
  prefix?: string[]
}

/** Windows-first detection; a missing executable simply is not offered. */
function candidates(env: NodeJS.ProcessEnv = process.env): Candidate[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA ?? ''
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const list: Array<Candidate & { exists: () => boolean }> = [
    {
      id: 'vscode',
      label: 'Visual Studio Code',
      kind: 'editor',
      command: path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      exists: () => fs.existsSync(path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe')),
    },
    {
      id: 'vscode-system',
      label: 'Visual Studio Code',
      kind: 'editor',
      command: path.join(programFiles, 'Microsoft VS Code', 'Code.exe'),
      exists: () => fs.existsSync(path.join(programFiles, 'Microsoft VS Code', 'Code.exe')),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      kind: 'editor',
      command: path.join(localAppData, 'Programs', 'cursor', 'Cursor.exe'),
      exists: () => fs.existsSync(path.join(localAppData, 'Programs', 'cursor', 'Cursor.exe')),
    },
    {
      id: 'sublime',
      label: 'Sublime Text',
      kind: 'editor',
      command: path.join(programFiles, 'Sublime Text', 'sublime_text.exe'),
      exists: () => fs.existsSync(path.join(programFiles, 'Sublime Text', 'sublime_text.exe')),
    },
    {
      id: 'notepadpp',
      label: 'Notepad++',
      kind: 'editor',
      command: path.join(programFiles, 'Notepad++', 'notepad++.exe'),
      exists: () => fs.existsSync(path.join(programFiles, 'Notepad++', 'notepad++.exe')),
    },
    {
      id: 'explorer',
      label: 'Explorer',
      kind: 'folder',
      command: path.join(systemRoot, 'explorer.exe'),
      exists: () => fs.existsSync(path.join(systemRoot, 'explorer.exe')),
    },
    {
      id: 'windows-terminal',
      label: 'Windows Terminal',
      kind: 'terminal',
      command: path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe'),
      prefix: ['-d'],
      exists: () => fs.existsSync(path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe')),
    },
    {
      id: 'powershell',
      label: 'PowerShell',
      kind: 'terminal',
      command: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      exists: () => fs.existsSync(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')),
    },
    {
      id: 'git-bash',
      label: 'Git Bash',
      kind: 'terminal',
      command: path.join(programFiles, 'Git', 'git-bash.exe'),
      exists: () => fs.existsSync(path.join(programFiles, 'Git', 'git-bash.exe')),
    },
  ]
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const candidate of list) {
    if (!candidate.exists()) continue
    // VS Code installed both per-user and system-wide is one target.
    const key = `${candidate.label}:${candidate.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    const { exists, ...rest } = candidate
    void exists
    out.push(rest)
  }
  return out
}

export function detectOpenIn(env: NodeJS.ProcessEnv = process.env): OpenInTarget[] {
  return candidates(env).map(({ prefix, ...target }) => {
    void prefix
    return target
  })
}

/** The argv for one launch; only a detected target is accepted. */
export function openInArgv(targetId: string, file: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const target = candidates(env).find((candidate) => candidate.id === targetId)
  if (!target) throw new OpenInError(`unknown target ${targetId}`)
  if (!path.isAbsolute(file)) throw new OpenInError('path must be absolute')
  const stat = fs.statSync(file)
  // A folder target opens the containing directory of a file.
  const value = target.kind === 'folder' && !stat.isDirectory() ? path.dirname(file) : file
  const args = [...(target.prefix ?? []), value]
  if (target.kind === 'terminal') {
    return {
      command: target.command,
      args: target.id === 'powershell' ? ['-NoExit', '-Command', `Set-Location -LiteralPath '${value.replace(/'/g, "''")}'`] : args,
    }
  }
  return { command: target.command, args }
}

/** Whether the caller is on this machine: only then may apps be launched. */
export function isLocalAddress(address: string | undefined): boolean {
  if (!address) return false
  const value = address.replace(/^::ffff:/, '')
  if (value === '::1' || value === 'localhost') return true
  const interfaces = Object.values(os.networkInterfaces()).flat()
  if (interfaces.some((entry) => entry && !entry.internal && entry.address === value)) return false
  return value === '127.0.0.1' || value.startsWith('127.')
}
