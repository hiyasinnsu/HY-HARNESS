// CP-25: HY Protocol v1 — the JSON-RPC 2.0 message layer.
//
// The transport (stdio, WebSocket) and the thread/turn implementation are
// separate; this module owns framing, ids, errors and method dispatch so both
// surfaces behave the same. Responses are returned as strings so a transport
// can write them without knowing the protocol.

import { API_VERSION } from './api-schema.js'

export const PROTOCOL_VERSION = 'hy-protocol/1'

export type JsonRpcId = number | string | null

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

export interface ProtocolMethod {
  /** Handles a request (one with an id); a throw is sent as an error. */
  request?: (params: unknown) => Promise<unknown> | unknown
  /** Handles a notification (no id); a throw is logged, not sent. */
  notification?: (params: unknown) => Promise<unknown> | unknown
}

export interface ProtocolOptions {
  /** Handlers by method name (`thread/list`, `turn/start`, …). */
  methods: Record<string, ProtocolMethod>
  /** Sends a server-initiated notification. */
  notify?: (method: string, params: unknown) => void
  /** Diagnostics for failed notifications. */
  log?: (line: string) => void
}

export interface ProtocolResult {
  response?: string
  /** A notification was handled (no response). */
  handled: boolean
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): string {
  const error: JsonRpcErrorObject = { code, message, ...(data !== undefined ? { data } : {}) }
  return JSON.stringify({ jsonrpc: '2.0', id, error })
}

/** Validates the envelope; returns a request or an error string. */
export function parseRequest(line: string): { request?: JsonRpcRequest; error?: string } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { error: errorResponse(null, ERROR.parse, 'parse error') }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: errorResponse(null, ERROR.invalidRequest, 'a request must be an object') }
  }
  const record = value as Record<string, unknown>
  if (record.jsonrpc !== '2.0') return { error: errorResponse(null, ERROR.invalidRequest, 'jsonrpc must be "2.0"') }
  if (typeof record.method !== 'string' || record.method.length === 0) {
    return { error: errorResponse(record.id === undefined ? null : (record.id as JsonRpcId), ERROR.invalidRequest, 'method is required') }
  }
  return { request: value as unknown as JsonRpcRequest }
}

export class ProtocolServer {
  private readonly options: ProtocolOptions
  /** opt-in features a client asked for; `initialize` reports the version. */
  private initialized = false

  constructor(options: ProtocolOptions) {
    this.options = options
  }

  /** One line in, at most one line out. */
  async handle(line: string): Promise<ProtocolResult> {
    const parsed = parseRequest(line)
    if (!parsed.request) return { ...(parsed.error !== undefined ? { response: parsed.error } : {}), handled: true }
    const request = parsed.request
    const method = this.options.methods[request.method]
    const id = request.id
    if (method === undefined) {
      if (id === undefined) return { handled: false }
      return { response: errorResponse(id, ERROR.methodNotFound, `unknown method ${request.method}`), handled: true }
    }
    if (id === undefined) {
      const handler = method.notification ?? method.request
      if (handler === undefined) return { handled: false }
      try {
        await handler(request.params)
      } catch (error) {
        this.options.log?.(`notification ${request.method} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return { handled: true }
    }
    try {
      if (method.request === undefined) {
        throw new ProtocolRpcError(ERROR.methodNotFound, `method ${request.method} does not handle requests`)
      }
      const result = await method.request(request.params)
      if (request.method === 'initialize') this.initialized = true
      return { response: JSON.stringify({ jsonrpc: '2.0', id, result }), handled: true }
    } catch (error) {
      if (error instanceof ProtocolRpcError) {
        return { response: errorResponse(id, error.code, error.message, error.data), handled: true }
      }
      const message = error instanceof Error ? error.message : String(error)
      this.options.log?.(`${request.method} failed: ${message}`)
      return { response: errorResponse(id, ERROR.internal, message), handled: true }
    }
  }

  /** True after a successful `initialize`. */
  isInitialized(): boolean {
    return this.initialized
  }

  /** Sends a server notification through the configured transport. */
  send(method: string, params: unknown): void {
    this.options.notify?.(method, params)
  }
}

/** A method error with a protocol code (params/thread-not-found, …). */
export class ProtocolRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'ProtocolRpcError'
  }
}

/** The standard `initialize` handler: version + capability negotiation (CP-25). */
export function initializeHandler(capabilities: Record<string, unknown> = { threads: true, turns: true, approvals: true }): ProtocolMethod {
  return {
    request: (params) => {
      const requested =
        params !== null && typeof params === 'object' && typeof (params as { protocolVersion?: unknown }).protocolVersion === 'string'
          ? (params as { protocolVersion: string }).protocolVersion
          : PROTOCOL_VERSION
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestedVersion: requested,
        serverInfo: { name: 'hy-harness', version: '0.4.0', apiVersion: API_VERSION },
        capabilities,
      }
    },
  }
}