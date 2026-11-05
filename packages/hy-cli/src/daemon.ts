/**
 * CP-27: the resident protocol server (`hy serve`).
 *
 * One daemon per state directory (one per workspace). `<stateDir>/daemon.json`
 * is the lock and the address book: pid, pipe path, optional WebSocket URL and
 * the token clients present in `initialize`. It is created with `wx`, so two
 * daemons racing to start cannot both win; a lock whose process is gone or
 * whose pipe does not answer is stale and is replaced.
 *
 * Clients (the SDK's `connectDaemon`, `hy serve start --daemon`) read the lock,
 * connect to the pipe and, when that fails, start a daemon and retry with
 * exponential backoff.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

export interface DaemonInfo {
  pid: number
  pipe: string
  ws?: string
  token: string
  startedAt: number
  version: string
  workspace: string
}

export const daemonInfoPath = (stateDir: string) => path.join(stateDir, 'daemon.json')

/** A short stable key for a state directory (pipe names are global on Windows). */
export function stateKey(stateDir: string): string {
  return createHash('sha256').update(path.resolve(stateDir).toLowerCase()).digest('hex').slice(0, 16)
}

export function newToken(): string {
  return randomBytes(24).toString('hex')
}

export function readDaemonInfo(stateDir: string): DaemonInfo | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(daemonInfoPath(stateDir), 'utf8')) as Partial<DaemonInfo>
    if (typeof value.pid !== 'number' || typeof value.pipe !== 'string' || typeof value.token !== 'string') return undefined
    return value as DaemonInfo
  } catch {
    return undefined
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether something accepts connections on the pipe. */
export function pipeAnswers(pipe: string, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(pipe)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/** The running daemon for a state directory, if its process and pipe are alive. */
export async function liveDaemon(stateDir: string): Promise<DaemonInfo | undefined> {
  const info = readDaemonInfo(stateDir)
  if (!info) return undefined
  if (!processAlive(info.pid)) return undefined
  return (await pipeAnswers(info.pipe)) ? info : undefined
}

export class DaemonRunningError extends Error {
  constructor(readonly info: DaemonInfo) {
    super(`a daemon is already running for this workspace (pid ${info.pid}, ${info.pipe})`)
    this.name = 'DaemonRunningError'
  }
}

/**
 * Claims the lock for this process. Throws DaemonRunningError when a live
 * daemon holds it; a stale lock is removed and the claim retried once.
 */
export async function claimLock(stateDir: string, info: DaemonInfo): Promise<() => void> {
  const file = daemonInfoPath(stateDir)
  fs.mkdirSync(stateDir, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeSync(fd, `${JSON.stringify(info, null, 2)}\n`)
      fs.closeSync(fd)
      let released = false
      return () => {
        if (released) return
        released = true
        // Only remove our own lock (a newer daemon may have replaced a stale one).
        if (readDaemonInfo(stateDir)?.pid === info.pid) fs.rmSync(file, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const live = await liveDaemon(stateDir)
      if (live) throw new DaemonRunningError(live)
      fs.rmSync(file, { force: true })
    }
  }
  throw new Error(`could not claim ${file}`)
}

/** Delays for reconnect attempts: 100, 200, 400 … ms, capped. */
export function backoff(attempt: number, baseMs = 100, capMs = 3_200): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt))
}

/** Waits until the daemon for `stateDir` answers (after a detached start). */
export async function waitForDaemon(stateDir: string, timeoutMs = 15_000): Promise<DaemonInfo> {
  const started = Date.now()
  for (let attempt = 0; Date.now() - started < timeoutMs; attempt++) {
    const live = await liveDaemon(stateDir)
    if (live) return live
    await new Promise((resolve) => setTimeout(resolve, backoff(attempt, 50, 800)))
  }
  throw new Error(`the daemon did not start within ${timeoutMs} ms`)
}
