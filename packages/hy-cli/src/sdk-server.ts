import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { HarnessConfig } from '../../core/dist/index.js'
import type { AgentEvent, ExecRpcClient, ImageInput } from '../../core/dist/index.js'
import { Conversation } from './session-app.js'

/**
 * WP-51: the SDK server (`hy serve --sdk`). A small JSON-RPC 2.0 over stdio
 * (newline-delimited JSON) that lets another program drive the harness:
 *
 *   initialize                      → server info + capabilities
 *   session.create {cwd?}           → { sessionId }
 *   session.resume {sessionId}      → { sessionId, turns }
 *   session.prompt {sessionId, message, images?} → { final, turns }
 *   session.cancel {sessionId}      → {}
 *   session.close  {sessionId}      → {}
 *   shutdown                        → {}
 *
 * Notifications (no id): `session/event` for every agent event and
 * `session/status` on busy/turn changes. Requests are dispatched without being
 * awaited, so `session/cancel` can be read while a prompt runs.
 */
export interface SdkMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface SdkSession {
  id: string
  conv: Conversation
  controller: AbortController | undefined
}

export interface SdkServerOptions {
  config: HarnessConfig
  client: ExecRpcClient
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  version?: string
}

export interface SdkServer {
  readonly sessions: Map<string, SdkSession>
  run(): Promise<void>
}

const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

export function createSdkServer(options: SdkServerOptions): SdkServer {
  const sessions = new Map<string, SdkSession>()
  let nextId = 1
  let closed = false

  const send = (message: SdkMessage): void => {
    if (closed) return
    options.output.write(`${JSON.stringify(message)}\n`)
  }
  const notify = (method: string, params: unknown): void => {
    send({ jsonrpc: '2.0', method, params })
  }

  const open = (runId: string): SdkSession => {
    const existing = sessions.get(runId)
    if (existing) return existing
    const conv = Conversation.create(
      options.config,
      options.client,
      runId,
      false,
      async () => options.config.autoApprove || options.config.fullAuto,
      (question) => Promise.resolve(question),
      (event) => notify('session/event', { sessionId: runId, event }),
      { checkpoints: false },
    )
    const session: SdkSession = { id: runId, conv, controller: undefined }
    sessions.set(runId, session)
    notify('session/status', { sessionId: runId, busy: false, turns: conv.turns })
    return session
  }

  const handle = async (message: SdkMessage): Promise<void> => {
    if (message.method === undefined) return
    const id = message.id
    const params = (message.params ?? {}) as Record<string, unknown>
    const reply = (result: unknown): void => {
      if (id === undefined) return
      send({ jsonrpc: '2.0', id, result })
    }
    const fail = (code: number, text: string): void => {
      if (id === undefined) return
      send({ jsonrpc: '2.0', id, error: { code, message: text } })
    }
    try {
      switch (message.method) {
        case 'initialize':
          reply({
            protocolVersion: 1,
            serverInfo: { name: 'HY-HARNESS', version: options.version ?? '0.2.0' },
            capabilities: { streaming: true, images: true, cancel: true, resume: true },
            cwd: options.config.workspaceRoot,
          })
          return
        case 'session.create': {
          const cwd = typeof params.cwd === 'string' ? params.cwd : undefined
          if (cwd && cwd !== options.config.workspaceRoot) {
            // One server drives one workspace; a different cwd is a client bug.
            fail(INVALID_PARAMS, `this server is bound to ${options.config.workspaceRoot}; start hy serve there`)
            return
          }
          const session = open(`sdk-${randomUUID().slice(0, 8)}`)
          reply({ sessionId: session.id })
          return
        }
        case 'session.resume': {
          const runId = typeof params.sessionId === 'string' ? params.sessionId : ''
          if (!runId) return fail(INVALID_PARAMS, 'sessionId is required')
          const session = open(runId)
          reply({ sessionId: session.id, turns: session.conv.turns })
          return
        }
        case 'session.prompt': {
          const runId = typeof params.sessionId === 'string' ? params.sessionId : ''
          const session = sessions.get(runId)
          if (!session) return fail(INVALID_PARAMS, `unknown session ${runId}`)
          if (session.controller !== undefined) return fail(INTERNAL_ERROR, 'a prompt is already running for this session')
          const text = typeof params.message === 'string' ? params.message : ''
          const images = Array.isArray(params.images)
            ? (params.images as Array<{ mimeType?: unknown; data?: unknown }>)
                .filter((image) => typeof image?.mimeType === 'string' && typeof image?.data === 'string')
                .map((image) => ({ mimeType: String(image.mimeType), data: String(image.data) }) as ImageInput)
            : []
          if (!text.trim() && images.length === 0) return fail(INVALID_PARAMS, 'message is required')
          const controller = new AbortController()
          session.controller = controller
          notify('session/status', { sessionId: runId, busy: true, turns: session.conv.turns + 1 })
          try {
            const final = await session.conv.turn(text, images, controller.signal)
            session.controller = undefined
            // The idle notification goes out before the reply, so a client that
            // awaits the reply has already seen the status change.
            notify('session/status', { sessionId: runId, busy: false, turns: session.conv.turns })
            reply({ final, turns: session.conv.turns })
          } catch (error) {
            const cancelled = controller.signal.aborted
            session.controller = undefined
            notify('session/status', { sessionId: runId, busy: false, turns: session.conv.turns })
            if (cancelled) fail(-32800, 'cancelled')
            else fail(INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
            return
          }
          return
        }
        case 'session.cancel': {
          const runId = typeof params.sessionId === 'string' ? params.sessionId : ''
          sessions.get(runId)?.controller?.abort()
          reply({})
          return
        }
        case 'session.close': {
          const runId = typeof params.sessionId === 'string' ? params.sessionId : ''
          sessions.get(runId)?.controller?.abort()
          sessions.delete(runId)
          reply({})
          return
        }
        case 'shutdown': {
          for (const session of sessions.values()) session.controller?.abort()
          sessions.clear()
          reply({})
          return
        }
        default:
          fail(METHOD_NOT_FOUND, `unknown method ${message.method}`)
      }
    } catch (error) {
      fail(INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
    }
  }

  return {
    sessions,
    async run(): Promise<void> {
      const lines = readline.createInterface({ input: options.input, crlfDelay: Infinity })
      const pending: Array<Promise<void>> = []
      for await (const line of lines) {
        if (!line.trim()) continue
        let message: SdkMessage
        try {
          message = JSON.parse(line) as SdkMessage
        } catch {
          send({ jsonrpc: '2.0', error: { code: -32700, message: 'invalid JSON' } })
          continue
        }
        // Prompts run for a while; keep reading so cancel/shutdown get through.
        const task = handle(message)
        pending.push(task)
        void task.finally(() => {
          const at = pending.indexOf(task)
          if (at >= 0) pending.splice(at, 1)
        })
      }
      // stdin closed: let in-flight prompts settle before the process exits.
      await Promise.allSettled(pending)
      closed = true
    },
  }
}

/** A tiny synchronous client over the SDK protocol (used by the tests). */
export class SdkClient {
  private buffer = ''
  private nextId = 1
  private readonly responses = new Map<number | string, SdkMessage>()
  private readonly waiters = new Set<() => void>()
  private readonly events: Array<{ sessionId: string; event: AgentEvent }> = []

  constructor(private readonly child: {
    stdin: NodeJS.WritableStream
    stdout: NodeJS.ReadableStream
  }) {
    child.stdout.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString()
      for (;;) {
        const at = this.buffer.indexOf('\n')
        if (at < 0) break
        const line = this.buffer.slice(0, at).trim()
        this.buffer = this.buffer.slice(at + 1)
        if (!line) continue
        const message = JSON.parse(line) as SdkMessage
        if (message.id !== undefined && message.method === undefined) this.responses.set(message.id, message)
        else if (message.method === 'session/event') {
          this.events.push(message.params as { sessionId: string; event: AgentEvent })
        }
        for (const waiter of this.waiters) waiter()
        this.waiters.clear()
      }
    })
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60_000)
      const check = (): void => {
        const response = this.responses.get(id)
        if (!response) return
        this.responses.delete(id)
        clearTimeout(timer)
        if (response.error) reject(new Error(`${method}: ${response.error.message}`))
        else resolve(response.result as T)
      }
      this.waiters.add(check)
      check()
    })
  }

  takeEvents(): Array<{ sessionId: string; event: AgentEvent }> {
    return this.events.splice(0, this.events.length)
  }
}
