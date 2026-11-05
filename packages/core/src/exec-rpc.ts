import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
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

export function resolveServerPath(explicit?: string): string {
  if (explicit) return path.resolve(explicit)
  if (process.env.HY_EXEC_SERVER) return path.resolve(process.env.HY_EXEC_SERVER)
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))
  for (const candidate of [
    path.join(root, 'target', 'debug', 'hy-exec-server.exe'),
    path.join(root, 'target', 'release', 'hy-exec-server.exe'),
    path.join(root, 'target', 'debug', 'hy-exec-server'),
    path.join(root, 'target', 'release', 'hy-exec-server'),
  ]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return 'hy-exec-server'
}

export class ExecRpcClient {
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  /** `ptc/run` request id → its sub-call handler. */
  private readonly ptcHandlers = new Map<string, PtcToolCallHandler>()
  private closed = false

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => this.onLine(line))
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd()
      if (text) process.stderr.write(`[exec] ${text}\n`)
    })
    child.on('exit', (code, signal) => {
      this.closed = true
      const error = new Error(`hy-exec-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(error)
        this.pending.delete(id)
      }
    })
  }

  static async start(serverPath: string, initParams: InitializeParams): Promise<ExecRpcClient> {
    // The daemon copies the worker into an AppContainer-readable runtime
    // directory and runs it with this Node (design §2).
    const params: InitializeParams = {
      ptcWorkerPath: fileURLToPath(new URL('./ptc-worker.mjs', import.meta.url)),
      ptcNodePath: process.execPath,
      ...initParams,
    }
    const child = spawn(serverPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    })
    const client = new ExecRpcClient(child)
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
      if (!this.closed) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n')
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
        if (!this.closed) {
          this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }) + '\n')
        }
        reject(new ExecRpcError(-32005, 'request cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(id)
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
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  exec(params: ExecCommandParams, signal?: AbortSignal, timeoutMs = 120_000): Promise<ExecResult> {
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
    this.child.stdin.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill()
        resolve()
      }, 2_000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
