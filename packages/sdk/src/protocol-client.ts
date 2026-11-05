/**
 * CP-30: a typed client for hy-protocol/1 (the surface the CLI, the GUI's
 * daemon and ACP share).
 *
 * Transports:
 * - `stdio`: spawns `hy protocol serve` (one private server);
 * - `pipe`:  a named pipe / Unix socket of a running `hy serve` daemon;
 * - `ws`:    a daemon's WebSocket listener (`hy serve start --ws <port>`).
 *
 * `connectDaemon()` finds or starts the workspace daemon (`hy serve start
 * --daemon --json`) and reconnects with exponential backoff when it goes away,
 * starting it again if needed. Dependency-free; Node 20+ (WebSocket needs the
 * global `WebSocket`, Node 22+).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

export interface ProtocolEvent {
  type: string
  [key: string]: unknown
}

export interface ApprovalRequestParams {
  id: string
  command: string
  sandbox?: string
  justification?: string
}

export type ApprovalHandler = (request: ApprovalRequestParams) => boolean | Promise<boolean>

export interface InitializeResult {
  protocolVersion: string
  serverInfo: { name: string; version: string; apiVersion?: string }
  capabilities: Record<string, unknown>
}

export interface ThreadSummary {
  threadId: string
  title?: string
  turns?: number
  [key: string]: unknown
}

export interface CliLaunch {
  /** An installed `hy` executable, or `packages/hy-cli/dist/main.js`. */
  cli?: string
  cwd?: string
  /** Extra CLI flags (`--mock`, `--sandbox`, …). */
  args?: string[]
  env?: Record<string, string | undefined>
  /** Node binary when `cli` is a `.js` file. */
  node?: string
}

export type Transport =
  | ({ kind: 'stdio' } & CliLaunch)
  | { kind: 'pipe'; path: string; token?: string }
  | { kind: 'ws'; url: string; token?: string }

export interface ClientOptions {
  /** Answers `approval/request`; without it every request is denied. */
  onApproval?: ApprovalHandler
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}

/** A line-oriented duplex: what the client needs from any transport. */
interface Wire {
  send(line: string): void
  onLine(listener: (line: string) => void): void
  onClose(listener: () => void): void
  /** Resolves when the transport is gone (the child process has exited). */
  close(): Promise<void>
}

function launch(options: CliLaunch, args: string[]): ChildProcess {
  const cli = options.cli ?? 'hy'
  const js = /\.[cm]?js$/i.test(cli)
  return spawn(js ? (options.node ?? process.execPath) : cli, js ? [cli, ...args] : args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: !js && process.platform === 'win32',
  })
}

function lineSplitter(listener: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = ''
  return (chunk) => {
    buffer += String(chunk)
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) listener(line)
    }
  }
}

async function openWire(transport: Transport): Promise<Wire> {
  if (transport.kind === 'stdio') {
    const child = launch(transport, ['protocol', 'serve', ...(transport.args ?? [])])
    const lineListeners: Array<(line: string) => void> = []
    const closeListeners: Array<() => void> = []
    child.stdout!.on('data', lineSplitter((line) => lineListeners.forEach((l) => l(line))))
    child.stderr!.on('data', () => undefined)
    child.on('exit', () => closeListeners.forEach((l) => l()))
    return {
      send: (line) => child.stdin!.write(`${line}\n`),
      onLine: (l) => lineListeners.push(l),
      onClose: (l) => closeListeners.push(l),
      close: () =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve()
          child.once('exit', () => resolve())
          child.stdin!.end()
          setTimeout(() => child.kill(), 2_000).unref()
        }),
    }
  }
  if (transport.kind === 'pipe') {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(transport.path)
      s.once('connect', () => resolve(s))
      s.once('error', reject)
    })
    const lineListeners: Array<(line: string) => void> = []
    const closeListeners: Array<() => void> = []
    socket.on('data', lineSplitter((line) => lineListeners.forEach((l) => l(line))))
    socket.on('error', () => undefined)
    socket.on('close', () => closeListeners.forEach((l) => l()))
    return {
      send: (line) => socket.write(`${line}\n`),
      onLine: (l) => lineListeners.push(l),
      onClose: (l) => closeListeners.push(l),
      close: () =>
        new Promise<void>((resolve) => {
          if (socket.destroyed) return resolve()
          socket.once('close', () => resolve())
          socket.end()
        }),
    }
  }
  const WS = (globalThis as unknown as { WebSocket?: new (url: string, protocols?: string | string[]) => WebSocketLike }).WebSocket
  if (!WS) throw new ProtocolError('this Node has no global WebSocket (Node 22+); use the pipe transport')
  const url = new URL(transport.url)
  if (transport.token) url.searchParams.set('token', transport.token)
  const ws = new WS(url.toString(), 'hy-protocol')
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new ProtocolError(`could not connect to ${transport.url}`)), { once: true })
  })
  return {
    send: (line) => ws.send(line),
    onLine: (l) => ws.addEventListener('message', (e: { data: unknown }) => l(String(e.data))),
    onClose: (l) => ws.addEventListener('close', () => l()),
    close: async () => ws.close(),
  }
}

interface WebSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: { data: unknown }) => void, options?: { once?: boolean }): void
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/** Methods safe to resend after a dropped connection. */
const IDEMPOTENT = new Set(['thread/list', 'thread/read', 'turn/status', 'config/get'])

export class ProtocolClient {
  private wire: Wire | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>()
  /** Per-turn listeners, keyed by the `tag` sent with turn/start. */
  private readonly turnListeners = new Map<string, (event: ProtocolEvent, threadId: string) => void>()
  private readonly turnThreads = new Map<string, string>()
  private closed = false
  /** Set by connectDaemon: reopens the connection after a drop. */
  reconnect?: () => Promise<Wire>
  private reconnecting: Promise<void> | undefined
  private initializeParams: Record<string, unknown> = {}

  private constructor(private readonly options: ClientOptions) {}

  /** Connects and runs `initialize`. */
  static async connect(transport: Transport, options: ClientOptions = {}): Promise<ProtocolClient> {
    const client = new ProtocolClient(options)
    await client.attach(await openWire(transport))
    await client.initialize('token' in transport && transport.token ? { token: transport.token } : {})
    return client
  }

  /** @internal */
  static async withWire(wire: () => Promise<Wire>, token: () => string | undefined, options: ClientOptions): Promise<ProtocolClient> {
    const client = new ProtocolClient(options)
    client.reconnect = wire
    await client.attach(await wire())
    const t = token()
    await client.initialize(t ? { token: t } : {})
    client.tokenSource = token
    return client
  }

  private tokenSource: (() => string | undefined) | undefined

  private async attach(wire: Wire): Promise<void> {
    this.wire = wire
    wire.onLine((line) => this.receive(line))
    wire.onClose(() => {
      if (this.wire !== wire) return
      this.wire = undefined
      for (const p of this.pending.values()) p.reject(new ProtocolError('the connection to the server was lost'))
      this.pending.clear()
    })
  }

  private receive(line: string): void {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method !== undefined) {
      if (message.method === 'approval/request') void this.answerApproval(message.params as ApprovalRequestParams)
      if (message.method === 'turn/event' || message.method === 'turn/started') {
        const params = message.params as { threadId?: string; tag?: string; event?: ProtocolEvent }
        if (params.tag && params.threadId) {
          this.turnThreads.set(params.tag, params.threadId)
          if (params.event) this.turnListeners.get(params.tag)?.(params.event, params.threadId)
        }
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
      for (const listener of this.listeners.get('*') ?? []) listener({ method: message.method, params: message.params })
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new ProtocolError(message.error.message, message.error.code, message.error.data))
    else pending.resolve(message.result)
  }

  private async answerApproval(request: ApprovalRequestParams): Promise<void> {
    let approved = false
    try {
      approved = this.options.onApproval ? await this.options.onApproval(request) : false
    } catch {
      approved = false
    }
    await this.request('approval/respond', { id: request.id, approved }).catch(() => undefined)
  }

  private async ensureConnected(): Promise<Wire> {
    if (this.wire) return this.wire
    if (this.closed) throw new ProtocolError('the client is closed')
    if (!this.reconnect) throw new ProtocolError('the connection to the server was lost')
    this.reconnecting ??= (async () => {
      await this.attach(await this.reconnect!())
      const token = this.tokenSource?.()
      await this.sendRequest('initialize', { ...this.initializeParams, ...(token ? { token } : {}) })
    })().finally(() => {
      this.reconnecting = undefined
    })
    await this.reconnecting
    return this.wire!
  }

  private sendRequest<T>(method: string, params: unknown): Promise<T> {
    const wire = this.wire
    if (!wire) return Promise.reject(new ProtocolError('not connected'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      wire.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }))
    })
  }

  /**
   * Sends a request, reconnecting first when the daemon went away. A read
   * that loses its connection mid-flight is sent once more after reconnecting;
   * a turn is not (it may have started), the caller decides.
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.ensureConnected()
    try {
      return await this.sendRequest<T>(method, params)
    } catch (error) {
      const lost = error instanceof ProtocolError && error.code === undefined && /connection to the server was lost|not connected/.test(error.message)
      if (!lost || !this.reconnect || this.closed || !IDEMPOTENT.has(method)) throw error
      await this.ensureConnected()
      return this.sendRequest<T>(method, params)
    }
  }

  async initialize(params: Record<string, unknown> = {}): Promise<InitializeResult> {
    const { token: _token, ...rest } = params
    this.initializeParams = rest
    return this.sendRequest<InitializeResult>('initialize', { protocolVersion: 'hy-protocol/1', ...params })
  }

  /** Subscribes to a notification (`turn/started`, `approval/request`, `*` for all). */
  on(method: string, listener: (params: unknown) => void): () => void {
    let set = this.listeners.get(method)
    if (!set) this.listeners.set(method, (set = new Set()))
    set.add(listener)
    return () => set!.delete(listener)
  }

  // ----- threads and turns -----

  async threads(limit?: number): Promise<ThreadSummary[]> {
    return (await this.request<{ threads: ThreadSummary[] }>('thread/list', limit === undefined ? {} : { limit })).threads
  }

  readThread(threadId: string, options: { offset?: number; limit?: number } = {}): Promise<{ threadId: string; items: unknown[]; total: number; title?: string }> {
    return this.request('thread/read', { threadId, ...options })
  }

  /**
   * Runs one turn. `onEvent` receives this thread's events; the new thread's id
   * is known from the first event (and from the result).
   */
  async turn(
    message: string,
    options: { threadId?: string; images?: Array<{ mimeType: string; data: string }>; onEvent?: (event: ProtocolEvent, threadId: string) => void } = {},
  ): Promise<{ threadId: string; final: string }> {
    // A tag ties this call's notifications to it, even with several turns in flight.
    const tag = `t${this.nextId}-${Math.random().toString(36).slice(2, 10)}`
    if (options.onEvent) this.turnListeners.set(tag, options.onEvent)
    try {
      return await this.request('turn/start', {
        message,
        tag,
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(options.images ? { images: options.images } : {}),
      })
    } finally {
      this.turnListeners.delete(tag)
      this.turnThreads.delete(tag)
    }
  }

  /** The thread a running `turn()` started (known once the server says so). */
  threadOf(tag: string): string | undefined {
    return this.turnThreads.get(tag)
  }

  cancel(threadId: string): Promise<{ threadId: string; cancelled: boolean }> {
    return this.request('turn/cancel', { threadId })
  }

  steer(threadId: string, message: string): Promise<{ threadId: string; steered: boolean }> {
    return this.request('turn/steer', { threadId, message })
  }

  status(threadId: string): Promise<{ threadId: string; running: boolean }> {
    return this.request('turn/status', { threadId })
  }

  // ----- CP-29: runtime configuration -----

  configGet(): Promise<Record<string, unknown>> {
    return this.request('config/get')
  }

  configSet(key: 'model' | 'approvalPolicy' | 'autoApprove' | 'fullAuto', value: unknown): Promise<Record<string, unknown>> {
    return this.request('config/set', { key, value })
  }

  setModel(model: string, threadId?: string): Promise<{ model: { provider: string; model: string }; threads: string[] }> {
    return this.request('model/set', { model, ...(threadId ? { threadId } : {}) })
  }

  reloadMcp(): Promise<{ servers: string[]; tools: string[] }> {
    return this.request('mcpServer/reload')
  }

  reloadPlugins(): Promise<{ tools: string[]; errors: string[] }> {
    return this.request('plugin/reload')
  }

  /** Closes the connection; for stdio, waits until the server process exits. */
  async close(): Promise<void> {
    this.closed = true
    const wire = this.wire
    this.wire = undefined
    await wire?.close()
  }
}

export interface DaemonInfo {
  pid: number
  pipe: string
  ws?: string
  token: string
  workspace: string
  version: string
}

/** Runs `hy serve start --daemon --json` (idempotent) and returns the connection info. */
export function startDaemon(options: CliLaunch = {}): Promise<DaemonInfo> {
  return new Promise((resolve, reject) => {
    const child = launch(options, ['serve', 'start', '--daemon', '--json', ...(options.args ?? [])])
    let out = ''
    let err = ''
    child.stdout!.on('data', (c) => (out += String(c)))
    child.stderr!.on('data', (c) => (err += String(c)))
    child.on('error', reject)
    child.on('exit', (code) => {
      const line = out.trim().split('\n').at(-1) ?? ''
      try {
        const info = JSON.parse(line) as DaemonInfo
        if (typeof info.pipe === 'string' && typeof info.token === 'string') return resolve(info)
      } catch {
        // fall through
      }
      reject(new ProtocolError(`hy serve start failed (exit ${code}): ${err.trim() || out.trim()}`))
    })
  })
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Connects to the workspace daemon, starting it when none runs. After a drop,
 * the next request reconnects: the pipe is retried with backoff (100 ms … 3.2
 * s) and, when it stays closed, the daemon is started again.
 */
export async function connectDaemon(options: CliLaunch & ClientOptions & { attempts?: number } = {}): Promise<ProtocolClient> {
  let info = await startDaemon(options)
  const attempts = options.attempts ?? 6
  const wire = async (): Promise<Wire> => {
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await openWire({ kind: 'pipe', path: info.pipe, token: info.token })
      } catch (error) {
        lastError = error
        if (attempt === Math.floor(attempts / 2)) info = await startDaemon(options).catch(() => info)
        await delay(Math.min(3_200, 100 * 2 ** attempt))
      }
    }
    // Last resort: a fresh daemon (new pipe and token).
    info = await startDaemon(options)
    try {
      return await openWire({ kind: 'pipe', path: info.pipe, token: info.token })
    } catch {
      throw lastError instanceof Error ? lastError : new ProtocolError(String(lastError))
    }
  }
  return ProtocolClient.withWire(wire, () => info.token, options)
}
