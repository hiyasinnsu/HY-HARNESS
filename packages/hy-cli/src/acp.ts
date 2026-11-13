import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import type { HarnessConfig } from '../../core/dist/index.js'
import type { AgentEvent, ExecRpcClient } from '../../core/dist/index.js'
import type { ProtocolHost } from './protocol-host.js'
import { Conversation } from './session-app.js'

/**
 * WP-50: an ACP (Agent Client Protocol) v1 server over stdio NDJSON, so an
 * editor that speaks ACP can drive this harness. The surface is the part that
 * matters for an editor: initialize, new/load/prompt/cancel/close, streamed
 * message and tool updates, and permission requests that fall back to the
 * session's own approval default.
 */
export interface AcpMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface AcpSession {
  id: string
  /** Absent when the session runs on a shared ProtocolHost (CP-30). */
  conv?: Conversation | undefined
  controller: AbortController | undefined
}

export interface AcpServerOptions {
  config: HarnessConfig
  /** Used when no host is given (each session owns a Conversation). */
  client?: ExecRpcClient
  /**
   * CP-30: run prompts on the hy-protocol/1 host, so ACP sessions are protocol
   * threads with the same turn engine, busy rules and runtime configuration.
   */
  host?: ProtocolHost
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  /** ACP protocol version the server announces. */
  protocolVersion?: number
  version?: string
}

export interface AcpServer {
  /** Runs until stdin closes. */
  run(): Promise<void>
  readonly sessions: Map<string, AcpSession>
}

const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
const CANCELLED = -32800

/** Extracts the text (and images) from an ACP prompt. */
export function promptText(prompt: unknown): { text: string; images: Array<{ mimeType: string; data: string }> } {
  const blocks = Array.isArray(prompt) ? prompt : []
  const texts: string[] = []
  const images: Array<{ mimeType: string; data: string }> = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') texts.push(record.text)
    else if (record.type === 'image' && typeof record.mimeType === 'string' && typeof record.data === 'string') {
      images.push({ mimeType: record.mimeType, data: record.data })
    } else if (record.type === 'resource_link' && typeof record.uri === 'string') {
      texts.push(`[resource] ${record.uri}`)
    }
  }
  return { text: texts.join('\n').trim(), images }
}

export function createAcpServer(options: AcpServerOptions): AcpServer {
  const sessions = new Map<string, AcpSession>()
  /** Permission requests waiting for the client's answer. */
  const pendingPermissions = new Map<number | string, (approved: boolean) => void>()
  let nextId = 1
  let closed = false

  const send = (message: AcpMessage): void => {
    if (closed) return
    options.output.write(`${JSON.stringify(message)}\n`)
  }
  const notify = (method: string, params: unknown): void => {
    send({ jsonrpc: '2.0', method, params })
  }
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pendingPermissions.delete(id)
        reject(new Error(`${method} timed out`))
      }, 60_000)
      pendingPermissions.set(id, (approved) => {
        clearTimeout(timer)
        resolve(approved)
      })
      send({ jsonrpc: '2.0', id, method, params })
    })

  /** ACP `session/update` for one agent event. */
  const stream = (sessionId: string, event: AgentEvent): void => {
    switch (event.type) {
      case 'assistant': {
        // The text protocol carries tool calls and the final answer as JSON; only
        // prose is streamed here, and the final text is sent once at the end.
        const text = typeof event.content === 'string' ? event.content : ''
        if (text.length === 0 || /^\s*\{/.test(text)) break
        streamed.add(sessionId)
        notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
        break
      }
      case 'thinking':
        if (typeof event.content === 'string' && event.content.length > 0) {
          notify('session/update', { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.content } } })
        }
        break
      case 'tool-start':
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: String(event.callId ?? ''),
            title: String(event.name ?? 'tool'),
            kind: 'other',
            status: 'in_progress',
            ...(event.args !== undefined ? { rawInput: event.args } : {}),
          },
        })
        break
      case 'tool':
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: String(event.callId ?? ''),
            status: 'completed',
            ...(event.result !== undefined ? { rawOutput: event.result } : {}),
          },
        })
        break
      case 'tool-error':
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: String(event.callId ?? ''),
            status: 'failed',
            ...(typeof event.message === 'string' ? { rawOutput: event.message } : {}),
          },
        })
        break
      default:
        break
    }
  }

  // An editor may offer its own permission UI; when it does not, the
  // session's approval default decides (--yes, full-auto, policy).
  const askPermission = async (runId: string, command: string, justification?: string): Promise<boolean> => {
    if (options.config.autoApprove || options.config.fullAuto) return true
    try {
      const answer = await request('session/request_permission', {
        sessionId: runId,
        toolCall: { title: command, ...(justification ? { content: justification } : {}) },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      })
      return answer === 'allow' || (typeof answer === 'object' && answer !== null && (answer as { optionId?: unknown }).optionId === 'allow')
    } catch {
      return false
    }
  }

  const openSession = (runId: string): AcpSession => {
    const existing = sessions.get(runId)
    if (existing) return existing
    if (options.host) {
      const session: AcpSession = { id: runId, controller: undefined }
      sessions.set(runId, session)
      return session
    }
    if (!options.client) throw new Error('an ACP server needs a host or an exec client')
    const conv = Conversation.create(
      options.config,
      options.client,
      runId,
      false,
      (approval) => askPermission(runId, approval.command, approval.justification),
      // B17: no question channel to the client yet, so ask_user is not offered.
      // An echo answer here returned the model's own question as the user's reply.
      undefined,
      (event) => stream(runId, event),
      { checkpoints: false },
    )
    const session: AcpSession = { id: runId, conv, controller: undefined }
    sessions.set(runId, session)
    return session
  }

  const handle = async (message: AcpMessage): Promise<AcpMessage | undefined> => {
    // A response to one of our requests (permission): resolve and stay quiet.
    if (message.method === undefined) {
      const resolve = message.id !== undefined ? pendingPermissions.get(message.id) : undefined
      if (resolve) {
        pendingPermissions.delete(message.id!)
        const result = message.result as { outcome?: { optionId?: string }; optionId?: string } | undefined
        resolve(result?.optionId === 'allow' || result?.outcome?.optionId === 'allow')
      }
      return undefined
    }
    const id = message.id
    const params = (message.params ?? {}) as Record<string, unknown>
    // A notification has no id and must not get a response.
    const reply = (result: unknown): AcpMessage | undefined => (id === undefined ? undefined : { jsonrpc: '2.0', id, result })
    const fail = (code: number, message: string): AcpMessage | undefined => (id === undefined ? undefined : { jsonrpc: '2.0', id, error: { code, message } })
    try {
      switch (message.method) {
        case 'initialize':
          return reply({
            protocolVersion: options.protocolVersion ?? 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
            agentInfo: { name: 'HY-HARNESS', version: options.version ?? '0.2.0' },
          })
        case 'authenticate':
          return reply({})
        case 'session/new': {
          const runId = `acp-${randomUUID().slice(0, 8)}`
          openSession(runId)
          return reply({ sessionId: runId })
        }
        case 'session/load': {
          const runId = typeof params.sessionId === 'string' ? params.sessionId : ''
          if (!runId) return fail(INVALID_PARAMS, 'sessionId is required')
          openSession(runId)
          return reply({})
        }
        case 'session/prompt': {
          const runId = typeof params.sessionId === 'string' ? params.sessionId : ''
          const session = sessions.get(runId)
          if (!session) return fail(INVALID_PARAMS, `unknown session ${runId}`)
          const { text, images } = promptText(params.prompt)
          if (!text && images.length === 0) return fail(INVALID_PARAMS, 'prompt is empty')
          if (session.controller !== undefined) return fail(INTERNAL_ERROR, 'a turn is already running for this session')
          const controller = new AbortController()
          session.controller = controller
          try {
            const final = options.host
              ? await options.host.runTurn(runId, text, images, (event) => stream(runId, event), (command, justification) => askPermission(runId, command, justification), controller.signal)
              : await session.conv!.turn(text, images, controller.signal)
            // The turn's answer is streamed in chunks; a non-streaming provider
            // still has to deliver its final text.
            if (final && !streamed.has(runId)) {
              notify('session/update', { sessionId: runId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: final } } })
            }
            streamed.delete(runId)
            session.controller = undefined
            return reply({ stopReason: 'end_turn' })
          } catch (error) {
            const cancelled = controller.signal.aborted
            session.controller = undefined
            if (cancelled) return reply({ stopReason: 'cancelled' })
            return fail(INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
          }
        }
        case 'session/cancel': {
          const runId = typeof params.sessionId === 'string' ? params.sessionId : ''
          sessions.get(runId)?.controller?.abort()
          return reply({})
        }
        case 'session/close': {
          const runId = typeof params.sessionId === 'string' ? params.sessionId : ''
          sessions.get(runId)?.controller?.abort()
          sessions.delete(runId)
          return reply({})
        }
        default:
          return fail(METHOD_NOT_FOUND, `unknown method ${message.method}`)
      }
    } catch (error) {
      return fail(INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
    }
  }

  /** Session ids whose turn already streamed an answer. */
  const streamed = new Set<string>()

  return {
    sessions,
    async run(): Promise<void> {
      const lines = readline.createInterface({ input: options.input, crlfDelay: Infinity })
      for await (const line of lines) {
        if (!line.trim()) continue
        let message: AcpMessage
        try {
          message = JSON.parse(line) as AcpMessage
        } catch {
          send({ jsonrpc: '2.0', error: { code: -32700, message: 'invalid JSON' } })
          continue
        }
        // A prompt runs for a while, and session/cancel (or a permission
        // answer) must be read while it does: dispatch without awaiting.
        void handle(message).then((response) => {
          if (response) send(response)
        })
      }
      closed = true
    },
  }
}
