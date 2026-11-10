import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { withoutGitHubCredentials } from './github.js'
import type {
  CheckpointCreateResult,
  CheckpointDiffResult,
  CheckpointPruneResult,
  CheckpointRollbackResult,
  ExecCommandParams,
  ExecResult,
  InitializeParams,
  InitializeResult,
  JobInfo,
  JobOutputResult,
  PatchApplyParams,
  PatchApplyResult,
  PolicyEval,
  PtcRunParams,
  PtcRunResult,
  SandboxGrantResult,
  SandboxRevokeResult,
  JobWriteResult,
  SandboxRootsResult,
  SandboxStatusResult,
  ShellCloseResult,
  ShellOpenParams,
  ShellOpenResult,
  ShellReadResult,
  ShellWriteResult,
} from './protocol.js'

/** Walking a very large workspace for the ACL grant can take minutes. */
const GRANT_TIMEOUT_MS = 30 * 60_000

/**
 * How far the client deadline stays past the daemon's own. The daemon enforces
 * `hardTimeoutMs` itself (it kills the job and answers with `timedOut`), so the
 * client must not give up first: that would cancel a job the server was about
 * to finish, and report a timeout instead of the real result.
 */
const EXEC_TIMEOUT_MARGIN_MS = 30_000

/** The daemon kills a gate job after this long when `hardTimeoutMs` is absent. */
const GATE_HARD_TIMEOUT_MS = 600_000

/** Client-side deadline for `exec/command`; always past every daemon deadline. */
function execTimeoutMs(params: ExecCommandParams): number {
  const hard = params.hardTimeoutMs ?? (params.mode === 'gate' ? GATE_HARD_TIMEOUT_MS : undefined)
  const deadlines = [(params.foregroundWaitMs ?? 5_000) + EXEC_TIMEOUT_MARGIN_MS]
  if (hard !== undefined) deadlines.push(hard + EXEC_TIMEOUT_MARGIN_MS)
  return Math.max(120_000, ...deadlines)
}

export class ExecRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message)
    this.name = 'ExecRpcError'
  }
}

/** Handles one `ptc/toolCall` sub-call of a pending `ptc/run`. */
export type PtcToolCallHandler = (name: string, args: unknown) => Promise<unknown>

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, 'Cargo.toml')) && fs.existsSync(path.join(dir, 'packages'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(start)
    dir = parent
  }
}

/** Where the exec server binary is, and whether any file was actually found. */
export interface ServerPathResolution {
  /** The path to spawn. */
  path: string
  /**
   * False when nothing exists at `path`: `path` is then only the name the
   * caller asked for (`ExecRpcClient.start` refuses to spawn it).
   */
  resolved: boolean
}

/** Looks a bare command name up on `PATH` (plus `PATHEXT` on Windows). */
function findOnPath(name: string): string | undefined {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')
      : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * T-2: resolves the exec server binary without failing when it is absent, so
 * `start` can say what to do instead of spawning a name that cannot be found.
 * An explicit path is used as given, even when it does not exist.
 */
export function resolveServerPathInfo(explicit?: string): ServerPathResolution {
  // An empty `--exec-server ""` means "not given", as before.
  const given = explicit || process.env.HY_EXEC_SERVER
  if (given) {
    const resolvedPath = path.resolve(given)
    return { path: resolvedPath, resolved: fs.existsSync(resolvedPath) }
  }
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))
  for (const candidate of [
    path.join(root, 'target', 'debug', 'hy-exec-server.exe'),
    path.join(root, 'target', 'release', 'hy-exec-server.exe'),
    path.join(root, 'target', 'debug', 'hy-exec-server'),
    path.join(root, 'target', 'release', 'hy-exec-server'),
  ]) {
    if (fs.existsSync(candidate)) return { path: candidate, resolved: true }
  }
  // A binary installed elsewhere is still reachable through PATH; keep it
  // usable, but report the plain name when nothing exists (T-2).
  const onPath = findOnPath('hy-exec-server')
  return onPath !== undefined ? { path: onPath, resolved: true } : { path: 'hy-exec-server', resolved: false }
}

export function resolveServerPath(explicit?: string): string {
  return resolveServerPathInfo(explicit).path
}

/** A `start` argument: an existing file, a bare name on `PATH`, or unresolved. */
function resolveSpawnTarget(given: string): ServerPathResolution {
  if (fs.existsSync(given)) return { path: given, resolved: true }
  if (/[\\/]/.test(given)) return { path: path.resolve(given), resolved: false }
  const onPath = findOnPath(given)
  return onPath !== undefined ? { path: onPath, resolved: true } : { path: given, resolved: false }
}

/**
 * CP-28: how the client reaches the exec server: the child's stdio (the
 * default, `ExecRpcClient.start`) or a WebSocket to a server started with
 * `--listen` (`ExecRpcClient.connect`).
 */
interface ExecTransport {
  write(line: string): void
  end(): void
  kill(): void
  /** Resolves when the transport is gone. */
  exited(): Promise<void>
}

function childTransport(child: ChildProcessWithoutNullStreams, onLine: (line: string) => void, onExit: (reason: string) => void): ExecTransport {
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', onLine)
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trimEnd()
    if (text) process.stderr.write(`[exec] ${text}\n`)
  })
  const done = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    // A spawn that fails emits 'error' and may never emit 'exit'.
    child.once('error', () => resolve())
  })
  child.on('exit', (code, signal) => onExit(`hy-exec-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
  // T-2: without a listener a failed spawn (ENOENT, EACCES) is an unhandled
  // exception. It takes the exit path instead, so the pending `initialize`
  // rejects and the caller can report what to build.
  child.on('error', (error) => onExit(`could not start hy-exec-server: ${error.message}`))
  // A failed spawn leaves stdin unusable or absent; the 'error' listener reports it.
  const stdin = child.stdin as typeof child.stdin | null
  return {
    write: (line) => {
      if (stdin !== null && stdin.writable) stdin.write(`${line}\n`)
    },
    end: () => stdin?.end(),
    kill: () => child.kill(),
    exited: () => done,
  }
}

interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void, options?: { once?: boolean }): void
}

export class ExecRpcClient {
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  /** `ptc/run` request id → its sub-call handler. */
  private readonly ptcHandlers = new Map<string, PtcToolCallHandler>()
  private closed = false

  private transport!: ExecTransport

  private constructor() {}

  private onExit(reason: string): void {
    this.closed = true
    const error = new Error(reason)
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private static withChild(child: ChildProcessWithoutNullStreams): ExecRpcClient {
    const client = new ExecRpcClient()
    client.transport = childTransport(child, (line) => client.onLine(line), (reason) => client.onExit(reason))
    return client
  }

  /**
   * CP-28: connects to an exec server started elsewhere with
   * `hy-exec-server --listen ws://IP:PORT --token T` and initializes it.
   * Without the right token the server refuses the upgrade.
   */
  static async connect(url: string, token: string, initParams: InitializeParams): Promise<ExecRpcClient> {
    const WS = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
    if (!WS) throw new Error('this Node has no global WebSocket (Node 22+)')
    const target = new URL(url)
    target.searchParams.set('token', token)
    const socket = new WS(target.toString())
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error(`could not connect to the exec server at ${url} (wrong token or not listening)`)), { once: true })
    })
    const client = new ExecRpcClient()
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => (resolveClosed = resolve))
    socket.addEventListener('message', (event) => client.onLine(String(event.data)))
    socket.addEventListener('close', () => {
      client.onExit(`the exec server at ${url} closed the connection`)
      resolveClosed()
    })
    client.transport = {
      write: (line) => socket.send(line),
      end: () => socket.close(),
      kill: () => socket.close(),
      exited: () => closed,
    }
    await client.request<InitializeResult>('initialize', { ptcNodePath: process.execPath, ...initParams }, GRANT_TIMEOUT_MS)
    return client
  }

  /**
   * Starts the daemon. A `string` is resolved like `resolveServerPath`; a
   * `ServerPathResolution` is used as given. A binary that does not exist is
   * reported in one line (T-2), not as a spawn failure.
   */
  static async start(serverPath: string | ServerPathResolution, initParams: InitializeParams): Promise<ExecRpcClient> {
    const server = typeof serverPath === 'string' ? resolveSpawnTarget(serverPath) : serverPath
    if (!server.resolved) {
      throw new Error(
        `hy-exec-server not found (${server.path}): run \`cargo build -p hy-exec-server\` or pass \`--exec-server <path>\``,
      )
    }
    // The daemon copies the worker into an AppContainer-readable runtime
    // directory and runs it with this Node (design §2).
    const params: InitializeParams = {
      ptcWorkerPath: fileURLToPath(new URL('./ptc-worker.mjs', import.meta.url)),
      ptcNodePath: process.execPath,
      ...initParams,
    }
    let client: ExecRpcClient
    try {
      const child = spawn(server.path, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: withoutGitHubCredentials(),
      })
      client = ExecRpcClient.withChild(child)
    } catch (error) {
      // Some spawn failures are reported synchronously (Windows refuses a file
      // that is not an image, or the stdio pipes cannot be created); the
      // asynchronous ones arrive as 'error' in `childTransport`.
      throw new Error(`could not start hy-exec-server: ${error instanceof Error ? error.message : String(error)}`)
    }
    // A confined session grants the workspace here: one walk of the tree (ADR 0001 S-1).
    await client.request<InitializeResult>('initialize', params, GRANT_TIMEOUT_MS)
    return client
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      process.stderr.write(`[exec] non-JSON output: ${line.slice(0, 200)}\n`)
      return
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.error) {
        const err = msg.error as { code?: number; message?: string; data?: unknown }
        pending.reject(new ExecRpcError(err.code ?? -32603, err.message ?? 'unknown RPC error', err.data))
      } else {
        pending.resolve(msg.result)
      }
      return
    }
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      void this.onServerRequest(msg.id, msg.method, msg.params)
    }
  }

  /** Server-initiated requests: only `ptc/toolCall` (design §3). */
  private async onServerRequest(id: unknown, method: string, params: unknown): Promise<void> {
    const reply = (body: Record<string, unknown>) => {
      if (!this.closed) this.transport.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }))
    }
    if (method !== 'ptc/toolCall') {
      reply({ error: { code: -32601, message: `client does not implement ${method}` } })
      return
    }
    const p = (params ?? {}) as { runRequestId?: unknown; name?: unknown; args?: unknown }
    const handler = this.ptcHandlers.get(String(p.runRequestId))
    if (!handler) {
      reply({ error: { code: -32602, message: `no pending ptc/run ${String(p.runRequestId)}` } })
      return
    }
    try {
      reply({ result: (await handler(String(p.name ?? ''), p.args)) ?? null })
    } catch (error) {
      reply({ error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
    }
  }

  /**
   * Runs a `run_code` script in the daemon's AppContainer worker; each
   * sub-call comes back through `onToolCall`.
   */
  async ptcRun(params: PtcRunParams, onToolCall: PtcToolCallHandler, signal?: AbortSignal): Promise<PtcRunResult> {
    // `request` takes the next id synchronously, so the handler is registered first.
    const id = String(this.nextId + 1)
    this.ptcHandlers.set(id, onToolCall)
    try {
      return await this.request<PtcRunResult>('ptc/run', params, params.timeoutMs + 60_000, signal)
    } finally {
      this.ptcHandlers.delete(id)
    }
  }

  /**
   * Tells the daemon to stop working on `id`. A client that gave up (abort or
   * timeout) will not read the answer, and an `exec/command` left running keeps
   * its job — and the session's shell lock — for nothing.
   */
  private notifyCancel(id: number): void {
    if (this.closed) return
    this.transport.write(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }))
  }

  request<T>(method: string, params: unknown, timeoutMs = 120_000, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('hy-exec-server is closed'))
    if (signal?.aborted) {
      return Promise.reject(new ExecRpcError(-32005, 'request cancelled'))
    }
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        clearTimeout(timer)
        this.notifyCancel(id)
        reject(new ExecRpcError(-32005, 'request cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        // The daemon may still be running this (a request without its own
        // deadline); stopping it keeps `push`/`exec` from outliving the caller.
        this.notifyCancel(id)
        reject(new Error(`RPC timeout after ${timeoutMs}ms: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value: unknown) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value as T)
        },
        reject: (err: Error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        },
        timer,
      })
      this.transport.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  exec(params: ExecCommandParams, signal?: AbortSignal, timeoutMs = execTimeoutMs(params)): Promise<ExecResult> {
    return this.request<ExecResult>('exec/command', params, timeoutMs, signal)
  }

  patch(params: PatchApplyParams): Promise<PatchApplyResult> {
    return this.request<PatchApplyResult>('patch/apply', params)
  }

  policyEvaluate(command: string): Promise<PolicyEval> {
    return this.request<PolicyEval>('policy/evaluate', { command })
  }

  /** WP-31: opens the session's persistent shell (or reports why it cannot). */
  shellOpen(params: ShellOpenParams): Promise<ShellOpenResult> {
    return this.request<ShellOpenResult>('shell/open', params)
  }

  shellWrite(shellId: string, data: string): Promise<ShellWriteResult> {
    return this.request<ShellWriteResult>('shell/write', { shellId, data })
  }

  shellRead(shellId: string, timeoutMs?: number, maxBytes?: number): Promise<ShellReadResult> {
    return this.request<ShellReadResult>(
      'shell/read',
      { shellId, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(maxBytes === undefined ? {} : { maxBytes }) },
      (timeoutMs ?? 30_000) + 30_000,
    )
  }

  shellClose(shellId: string): Promise<ShellCloseResult> {
    return this.request<ShellCloseResult>('shell/close', { shellId })
  }

  checkpointCreate(runId: string, label: string): Promise<CheckpointCreateResult> {
    return this.request<CheckpointCreateResult>('checkpoint/create', { runId, label })
  }

  checkpointRollback(runId: string, label: string): Promise<CheckpointRollbackResult> {
    return this.request<CheckpointRollbackResult>('checkpoint/rollback', { runId, label })
  }

  checkpointDiff(runId: string, fromLabel: string, maxBytes = 64 * 1024): Promise<CheckpointDiffResult> {
    return this.request<CheckpointDiffResult>('checkpoint/diff', { runId, fromLabel, maxBytes })
  }

  checkpointPrune(runId: string, keep: string[]): Promise<CheckpointPruneResult> {
    return this.request<CheckpointPruneResult>('checkpoint/prune', { runId, keep })
  }

  /** CP-09: writes bytes to a job started with `stdinPipe`. */
  jobWrite(jobId: string, data: string): Promise<JobWriteResult> {
    return this.request<JobWriteResult>('job/write', { jobId, data })
  }

  sandboxStatus(): Promise<SandboxStatusResult> {
    return this.request<SandboxStatusResult>('sandbox/status', {})
  }

  sandboxGrant(): Promise<SandboxGrantResult> {
    return this.request<SandboxGrantResult>('sandbox/grant', {}, GRANT_TIMEOUT_MS)
  }

  sandboxRevoke(): Promise<SandboxRevokeResult> {
    return this.request<SandboxRevokeResult>('sandbox/revoke', {}, GRANT_TIMEOUT_MS)
  }

  sandboxAddRoot(root: string): Promise<SandboxRootsResult> {
    return this.request<SandboxRootsResult>('sandbox/add-root', { root }, GRANT_TIMEOUT_MS)
  }

  sandboxRemoveRoot(root: string): Promise<SandboxRootsResult> {
    return this.request<SandboxRootsResult>('sandbox/remove-root', { root }, GRANT_TIMEOUT_MS)
  }

  jobStatus(jobId: string): Promise<JobInfo> {
    return this.request<JobInfo>('job/status', { jobId })
  }

  jobOutput(jobId: string, offset = 0, maxBytes?: number): Promise<JobOutputResult> {
    return this.request<JobOutputResult>('job/output', { jobId, offset, ...(maxBytes !== undefined ? { maxBytes } : {}) })
  }

  jobWait(jobId: string, timeoutMs?: number, signal?: AbortSignal): Promise<JobInfo> {
    return this.request<JobInfo>(
      'job/wait',
      { jobId, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
      (timeoutMs ?? 0) + 30_000,
      signal,
    )
  }

  jobKill(jobId: string): Promise<JobInfo> {
    return this.request<JobInfo>('job/kill', { jobId })
  }

  async stop(): Promise<void> {
    if (this.closed) return
    try {
      await this.request('shutdown', {}, 5_000)
    } catch {
      // The process may already be gone.
    }
    this.transport.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.transport.kill()
        resolve()
      }, 2_000)
      void this.transport.exited().then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
