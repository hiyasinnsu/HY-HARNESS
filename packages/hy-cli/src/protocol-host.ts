/**
 * CP-27 / CP-29: the protocol host behind every transport.
 *
 * One host per process owns the exec server, the conversations (threads) and
 * the services (MCP, plugins). Each connection (stdio, a named-pipe client, a
 * WebSocket client) gets its own method table bound to it, so:
 *
 * - `turn/event` and `approval/request` go to the connection that started the
 *   turn, never to the others;
 * - two connections may run turns on different threads at the same time, but
 *   not on the same thread (`-32002 thread busy`), so their edits cannot
 *   interleave;
 * - a connection that goes away has its pending approvals denied and its
 *   running turns cancelled.
 *
 * CP-29 adds runtime configuration: `config/get`, `config/set`, `model/set`,
 * `mcpServer/reload` and `plugin/reload` take effect without a restart.
 */
import {
  type AgentEvent,
  type CliOverrides,
  type ExecRpcClient,
  type HarnessConfig,
  type ImageInput,
  loadConfig,
  sessionLogPath,
} from '../../core/dist/index.js'
import { Conversation, closeServices, newRunId, pluginSpecs, reloadPlugins, sessionMcp, startServices } from './session-app.js'
import { ApprovalBridge } from './protocol-approvals.js'
import { ERROR, ProtocolRpcError, initializeHandler, type ProtocolMethod } from './protocol.js'
import { listThreads, readThread } from './protocol-threads.js'
import { turnCancelMethod, turnStartMethod, turnStatusMethod, turnSteerMethod, type TurnHost } from './protocol-turn.js'

/** JSON-RPC server error for a thread another connection is driving. */
export const THREAD_BUSY = -32002

export interface ProtocolHostOptions {
  config: HarnessConfig
  /** Starts the exec server on first use (a turn); tests pass a fake. */
  openClient: () => Promise<{ config: HarnessConfig; client: ExecRpcClient }>
  /** Re-reads the configuration for `mcpServer/reload` (default: loadConfig(overrides)). */
  reloadConfig?: () => HarnessConfig
  overrides?: CliOverrides
  log?: (line: string) => void
}

export interface HostConnection {
  /** Sends a notification to this connection. */
  send(method: string, params: unknown): void
}

interface Running {
  controller: AbortController
  owner: HostConnection
}

const RUNTIME_KEYS = ['model', 'approvalPolicy', 'autoApprove', 'fullAuto'] as const
type RuntimeKey = (typeof RUNTIME_KEYS)[number]

function objectParams(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) throw new ProtocolRpcError(ERROR.invalidParams, 'params must be an object')
  return params as Record<string, unknown>
}

export class ProtocolHost {
  readonly config: HarnessConfig
  private opened: { config: HarnessConfig; client: ExecRpcClient } | undefined
  private opening: Promise<{ config: HarnessConfig; client: ExecRpcClient }> | undefined
  private readonly conversations = new Map<string, Conversation>()
  private readonly running = new Map<string, Running>()
  private readonly bridges = new Map<HostConnection, ApprovalBridge>()
  private readonly logFile: string

  constructor(private readonly options: ProtocolHostOptions) {
    this.config = options.config
    this.logFile = sessionLogPath(options.config.stateDir)
  }

  private async client(): Promise<{ config: HarnessConfig; client: ExecRpcClient }> {
    if (this.opened) return this.opened
    this.opening ??= this.options.openClient().then((opened) => {
      this.opened = opened
      return opened
    })
    return this.opening
  }

  /** Whether a thread exists (in this process or in the session log). */
  private known(threadId: string): boolean {
    return this.conversations.has(threadId) || listThreads(this.logFile).some((t) => t.threadId === threadId)
  }

  /** The method table for one connection. */
  methods(connection: HostConnection): Record<string, ProtocolMethod> {
    const bridge = new ApprovalBridge({ send: (method, params) => connection.send(method, params) })
    this.bridges.set(connection, bridge)
    const host: TurnHost = {
      start: (message, images, onEvent, threadId) => this.startTurn(connection, (q) => bridge.ask(q), message, images, onEvent, threadId),
      running: (threadId) => this.running.has(threadId),
      steer: (threadId, message) => {
        const conv = this.conversations.get(threadId)
        if (!conv || !this.running.has(threadId)) return false
        conv.steer(message)
        return true
      },
      cancel: (threadId) => {
        const run = this.running.get(threadId)
        if (!run) return false
        run.controller.abort()
        return true
      },
    }
    const notify = (method: string, params: unknown) => connection.send(method, params)
    return {
      initialize: initializeHandler({ threads: true, turns: true, approvals: true, config: true, multiClient: true }),
      'turn/start': turnStartMethod(host, notify),
      'turn/cancel': turnCancelMethod(host),
      'turn/steer': turnSteerMethod(host),
      'turn/status': turnStatusMethod(host),
      'approval/respond': { request: (params) => bridge.respond(params) },
      'thread/list': {
        request: (params) => {
          const { limit } = objectParams(params)
          if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)) {
            throw new ProtocolRpcError(ERROR.invalidParams, 'limit must be a non-negative number')
          }
          return { threads: listThreads(this.logFile, limit === undefined ? {} : { limit }) }
        },
      },
      'thread/read': {
        request: (params) => {
          const record = objectParams(params)
          const threadId = record.threadId
          if (typeof threadId !== 'string' || threadId.length === 0) throw new ProtocolRpcError(ERROR.invalidParams, 'threadId is required')
          for (const [name, value] of [['offset', record.offset], ['limit', record.limit]] as const) {
            if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
              throw new ProtocolRpcError(ERROR.invalidParams, `${name} must be a non-negative number`)
            }
          }
          return readThread(this.logFile, threadId, {
            ...(typeof record.offset === 'number' ? { offset: record.offset } : {}),
            ...(typeof record.limit === 'number' ? { limit: record.limit } : {}),
          })
        },
      },
      // ----- CP-29: runtime configuration -----
      'config/get': { request: () => this.configView() },
      'config/set': { request: (params) => this.configSet(params) },
      'model/set': { request: (params) => this.modelSet(params) },
      'mcpServer/reload': { request: () => this.mcpReload() },
      'plugin/reload': { request: () => this.pluginReload() },
    }
  }

  /** A connection closed: deny its approvals and stop the turns it started. */
  disconnect(connection: HostConnection): void {
    this.bridges.get(connection)?.denyAll()
    this.bridges.delete(connection)
    for (const run of this.running.values()) if (run.owner === connection) run.controller.abort()
  }

  private async startTurn(
    connection: HostConnection,
    ask: (question: { command: string; sandbox?: string; justification?: string }) => Promise<boolean>,
    message: string,
    images: ImageInput[],
    onEvent: (event: AgentEvent, threadId?: string) => void,
    threadId?: string,
    options: { create?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ threadId: string; final: string }> {
    const runId = threadId ?? newRunId()
    // Validate before spawning the exec server, so a bad id is a clean -32602.
    if (threadId !== undefined && !options.create && !this.known(threadId)) throw new ProtocolRpcError(ERROR.invalidParams, `unknown thread ${threadId}`)
    const busy = this.running.get(runId)
    if (busy) {
      throw new ProtocolRpcError(THREAD_BUSY, busy.owner === connection ? `thread ${runId} is already running a turn` : `thread ${runId} is busy (another client is running a turn)`)
    }
    const controller = new AbortController()
    // Reserve the thread before the first await, so a racing start sees it busy.
    this.running.set(runId, { controller, owner: connection })
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    // The new thread's id before any event, so a client can steer or cancel it.
    onEvent({ type: 'turn/started' } as unknown as AgentEvent, runId)
    try {
      const opened = await this.client()
      let conv = this.conversations.get(runId)
      if (!conv) {
        conv = Conversation.create(
          opened.config,
          opened.client,
          runId,
          false,
          // Approvals go to whoever runs the current turn, not to the
          // connection that happened to open the thread.
          (request) =>
            (this.askSink.get(runId) ?? (() => Promise.resolve(false)))({
              command: request.command,
              ...(request.sandbox !== undefined ? { sandbox: String(request.sandbox) } : {}),
              ...(request.justification !== undefined ? { justification: request.justification } : {}),
            }),
          undefined,
          (event) => this.eventSink.get(runId)?.(event),
        )
        this.conversations.set(runId, conv)
      }
      this.eventSink.set(runId, (event) => onEvent(event, runId))
      this.askSink.set(runId, ask)
      const final = await conv.turn(message, images, controller.signal)
      return { threadId: runId, final }
    } finally {
      this.running.delete(runId)
      this.eventSink.delete(runId)
      this.askSink.delete(runId)
    }
  }

  /** The current turn's listener per thread (the connection that started it). */
  private readonly eventSink = new Map<string, (event: AgentEvent) => void>()
  /** The current turn's approval prompt per thread. */
  private readonly askSink = new Map<string, (question: { command: string; sandbox?: string; justification?: string }) => Promise<boolean>>()

  /**
   * CP-30: a turn for another surface (ACP) on the same threads, with its own
   * approval prompt and event stream. A new `threadId` is created on first use.
   */
  async runTurn(
    threadId: string,
    message: string,
    images: ImageInput[],
    onEvent: (event: AgentEvent) => void,
    ask: (command: string, justification?: string) => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<string> {
    const owner: HostConnection = { send: () => undefined }
    const result = await this.startTurn(owner, (q) => ask(q.command, q.justification), message, images, onEvent, threadId, {
      create: true,
      ...(signal ? { signal } : {}),
    })
    return result.final
  }

  /** Whether a thread has a turn in flight (any surface). */
  isRunning(threadId: string): boolean {
    return this.running.has(threadId)
  }

  /** Aborts a thread's running turn (any surface). */
  cancel(threadId: string): boolean {
    const run = this.running.get(threadId)
    if (!run) return false
    run.controller.abort()
    return true
  }

  private configView(): Record<string, unknown> {
    const c = this.opened?.config ?? this.config
    return {
      workspaceRoot: c.workspaceRoot,
      model: { provider: c.role.provider, model: c.role.model },
      sandbox: c.sandbox,
      approvalPolicy: c.approvalPolicy ?? 'untrusted',
      autoApprove: c.autoApprove,
      fullAuto: c.fullAuto,
      features: Object.entries(c.features ?? {}).filter(([, on]) => on).map(([name]) => name).sort(),
      mcpServers: Object.keys(c.mcpServers).sort(),
      plugins: pluginSpecs().map((t) => t.name),
      threadsLoaded: this.conversations.size,
      runtimeKeys: [...RUNTIME_KEYS],
    }
  }

  private configSet(params: unknown): Record<string, unknown> {
    const { key, value } = objectParams(params)
    if (typeof key !== 'string' || !(RUNTIME_KEYS as readonly string[]).includes(key)) {
      throw new ProtocolRpcError(ERROR.invalidParams, `key must be one of ${RUNTIME_KEYS.join(', ')}`)
    }
    const configs = [this.config, ...(this.opened ? [this.opened.config] : [])]
    switch (key as RuntimeKey) {
      case 'model':
        return this.modelSet({ model: value })
      case 'approvalPolicy':
        if (value !== 'untrusted' && value !== 'on-request' && value !== 'on-failure' && value !== 'never') {
          throw new ProtocolRpcError(ERROR.invalidParams, 'approvalPolicy must be untrusted, on-request, on-failure or never')
        }
        for (const c of configs) c.approvalPolicy = value
        break
      case 'autoApprove':
      case 'fullAuto':
        if (typeof value !== 'boolean') throw new ProtocolRpcError(ERROR.invalidParams, `${key} must be a boolean`)
        for (const c of configs) c[key as 'autoApprove' | 'fullAuto'] = value
        break
    }
    return { ok: true, note: 'applies to threads opened from now on', config: this.configView() }
  }

  private modelSet(params: unknown): Record<string, unknown> {
    const { model, threadId } = objectParams(params)
    if (typeof model !== 'string' || !model.trim()) throw new ProtocolRpcError(ERROR.invalidParams, 'model is required')
    if (threadId !== undefined && typeof threadId !== 'string') throw new ProtocolRpcError(ERROR.invalidParams, 'threadId must be a string')
    const name = model.trim()
    const switched: string[] = []
    if (threadId !== undefined) {
      const conv = this.conversations.get(threadId)
      if (!conv) throw new ProtocolRpcError(ERROR.invalidParams, `thread ${threadId} is not loaded in this server`)
      conv.setModel(name)
      switched.push(threadId)
    } else {
      // New threads use it; open threads switch at their next step.
      for (const c of [this.config, ...(this.opened ? [this.opened.config] : [])]) c.role = { ...c.role, model: name }
      for (const [id, conv] of this.conversations) {
        conv.setModel(name)
        switched.push(id)
      }
    }
    return { model: { provider: this.config.role.provider, model: name }, threads: switched }
  }

  private async mcpReload(): Promise<Record<string, unknown>> {
    const fresh = this.options.reloadConfig?.() ?? loadConfig(this.options.overrides ?? {})
    for (const c of [this.config, ...(this.opened ? [this.opened.config] : [])]) c.mcpServers = fresh.mcpServers
    await startServices(this.opened?.config ?? this.config)
    const tools = sessionMcp?.tools ?? []
    return { servers: Object.keys(fresh.mcpServers).sort(), tools: tools.map((t) => `${t.server}/${t.name}`) }
  }

  private async pluginReload(): Promise<Record<string, unknown>> {
    const loaded = await reloadPlugins(this.opened?.config ?? this.config)
    return { tools: [...loaded.tools.values()].map((t) => t.spec.name), errors: loaded.errors }
  }

  async close(): Promise<void> {
    for (const bridge of this.bridges.values()) bridge.denyAll()
    for (const run of this.running.values()) run.controller.abort()
    await closeServices()
    await this.opened?.client.stop()
  }
}
