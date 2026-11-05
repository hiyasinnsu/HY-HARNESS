/**
 * `@hy/sdk`: a small client for `hy serve --sdk` (WP-51).
 *
 * The protocol is JSON-RPC 2.0 over newline-delimited JSON on stdio, so the
 * client is just request/response correlation plus the notification stream. It
 * has no dependencies and works from Node 20+.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface SdkEvent {
  type: string
  [key: string]: unknown
}

export interface SdkSessionEvent {
  sessionId: string
  event: SdkEvent
}

export interface SdkOptions {
  /** An installed `hy` executable, or a path to `packages/hy-cli/dist/main.js`. */
  cli?: string
  /** Workspace the server runs in. */
  cwd?: string
  /** Extra CLI flags (`--yes`, `--mock`, `--sandbox`, ...). */
  args?: string[]
  env?: Record<string, string | undefined>
  /** Node binary used when `cli` is a `.js` file. */
  node?: string
}

interface RpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

export class SdkError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
    this.name = 'SdkError'
  }
}

export interface ServerInfo {
  protocolVersion: number
  name: string
  version: string
  cwd: string
  capabilities: Record<string, unknown>
}

export class HarnessClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private nextId = 1
  private buffer = ''
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private readonly listeners = new Set<(event: SdkSessionEvent) => void>()
  private readonly statusListeners = new Set<(status: { sessionId: string; busy: boolean; turns: number }) => void>()
  private stderr = ''

  constructor(private readonly options: SdkOptions = {}) {}

  /** Starts the server process and waits for it to accept requests. */
  async start(): Promise<ServerInfo> {
    const cli = this.options.cli ?? process.env.HY_HARNESS_CLI ?? 'hy'
    const args = [...(cli.endsWith('.js') ? [cli] : []), 'serve', '--sdk', ...(this.options.args ?? [])]
    const command = cli.endsWith('.js') ? (this.options.node ?? process.execPath) : cli
    const child = spawn(command, args, {
      ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4_000)
    })
    child.on('exit', (code) => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new SdkError(`the server exited (${code ?? 'signal'}); ${this.stderr.slice(-500)}`))
        this.pending.delete(id)
      }
    })
    return this.initialize()
  }

  async initialize(): Promise<ServerInfo> {
    const result = (await this.request('initialize')) as {
      protocolVersion: number
      serverInfo: { name: string; version: string }
      cwd: string
      capabilities: Record<string, unknown>
    }
    return {
      protocolVersion: result.protocolVersion,
      name: result.serverInfo.name,
      version: result.serverInfo.version,
      cwd: result.cwd,
      capabilities: result.capabilities,
    }
  }

  async createSession(cwd?: string): Promise<string> {
    const result = (await this.request('session.create', cwd === undefined ? {} : { cwd })) as { sessionId: string }
    return result.sessionId
  }

  async resumeSession(sessionId: string): Promise<{ sessionId: string; turns: number }> {
    return (await this.request('session.resume', { sessionId })) as { sessionId: string; turns: number }
  }

  /** Runs one turn; `onEvent` receives the same events the CLI prints. */
  async prompt(sessionId: string, message: string, options: { images?: Array<{ mimeType: string; data: string }>; onEvent?: (event: SdkEvent) => void; timeoutMs?: number } = {}): Promise<{ final: string; turns: number }> {
    const listener = (entry: SdkSessionEvent): void => {
      if (entry.sessionId === sessionId) options.onEvent?.(entry.event)
    }
    if (options.onEvent) this.listeners.add(listener)
    try {
      const result = (await this.request(
        'session.prompt',
        { sessionId, message, ...(options.images ? { images: options.images } : {}) },
        options.timeoutMs ?? 600_000,
      )) as { final: string; turns: number }
      return result
    } finally {
      if (options.onEvent) this.listeners.delete(listener)
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request('session.cancel', { sessionId })
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request('session.close', { sessionId })
  }

  /** Stops the server: shutdown, close stdin, wait for the exit. */
  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = undefined
    try {
      await this.request('shutdown', {}, 2_000)
    } catch {
      // The server may already be gone.
    }
    child.stdin.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 10_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  onEvent(listener: (event: SdkSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStatus(listener: (status: { sessionId: string; busy: boolean; turns: number }) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private request(method: string, params: unknown = {}, timeoutMs = 600_000): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new SdkError('the client is not started'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SdkError(`${method}: no answer in ${timeoutMs}ms; ${this.stderr.slice(-500)}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const at = this.buffer.indexOf('\n')
      if (at < 0) break
      const line = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + 1)
      if (!line) continue
      let message: RpcMessage
      try {
        message = JSON.parse(line) as RpcMessage
      } catch {
        continue
      }
      if (message.id !== undefined && message.method === undefined) {
        const pending = this.pending.get(Number(message.id))
        if (!pending) continue
        clearTimeout(pending.timer)
        this.pending.delete(Number(message.id))
        if (message.error) pending.reject(new SdkError(message.error.message, message.error.code))
        else pending.resolve(message.result)
        continue
      }
      if (message.method === 'session/event') {
        const params = message.params as SdkSessionEvent
        for (const listener of this.listeners) listener(params)
      } else if (message.method === 'session/status') {
        const params = message.params as { sessionId: string; busy: boolean; turns: number }
        for (const listener of this.statusListeners) listener(params)
      }
    }
  }
}

/** Convenience: start a client, run one prompt, close everything. */
export async function runOnce(message: string, options: SdkOptions & { onEvent?: (event: SdkEvent) => void } = {}): Promise<string> {
  const client = new HarnessClient(options)
  await client.start()
  const session = await client.createSession()
  try {
    const result = await client.prompt(session, message, options.onEvent ? { onEvent: options.onEvent } : {})
    return result.final
  } finally {
    await client.closeSession(session).catch(() => undefined)
    await client.close()
  }
}
