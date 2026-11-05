// CP-25: the `turn/start` method.
//
// The protocol layer stays transport- and session-agnostic: a host starts one
// turn and forwards agent events, which become `turn/event` notifications. The
// CLI wires the host to `Conversation`; tests use a fake host.

import type { AgentEvent, ImageInput } from '../../core/dist/index.js'
import { ERROR, ProtocolRpcError, type ProtocolMethod } from './protocol.js'

export interface TurnResult {
  threadId: string
  final: string
}

export interface TurnHost {
  /** 	hreadId resumes that run; absent starts a new one. */
  start(message: string, images: ImageInput[], onEvent: (event: AgentEvent) => void, threadId?: string): Promise<TurnResult>
  /** Aborts a running turn; false when that thread has no turn in flight. */
  cancel?(threadId: string): boolean
  /** Queues a steering message; false when that thread is not running a turn. */
  steer?(threadId: string, message: string): boolean
  /** Whether a turn is in flight for the thread. */
  running?(threadId: string): boolean
}

/**
 * Builds the `turn/start` handler. Params: `{ message: string, images?: ImageInput[] }`.
 * Resuming an existing thread is not supported yet (a second `threadId` field
 * would need the conversation store), so it is rejected explicitly.
 */
export function turnStartMethod(host: TurnHost, notify?: (method: string, params: unknown) => void): ProtocolMethod {
  return {
    request: async (params) => {
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        throw new ProtocolRpcError(ERROR.invalidParams, 'params must be an object')
      }
      const record = params as { message?: unknown; images?: unknown; threadId?: unknown }
      const message = typeof record.message === 'string' ? record.message.trim() : ''
      if (message.length === 0) throw new ProtocolRpcError(ERROR.invalidParams, 'message is required')
      if (record.threadId !== undefined && (typeof record.threadId !== 'string' || record.threadId.length === 0)) {
        throw new ProtocolRpcError(ERROR.invalidParams, 'threadId must be a non-empty string')
      }
      const threadId = typeof record.threadId === 'string' ? record.threadId : undefined
      const images = Array.isArray(record.images) ? (record.images as ImageInput[]) : []
      const result = await host.start(message, images, (event) => notify?.('turn/event', { event }), threadId)
      return { threadId: result.threadId, final: result.final }
    },
  }
}
/** Builds the `turn/cancel` handler: `{ threadId }`. */
export function turnCancelMethod(host: TurnHost): ProtocolMethod {
  return {
    request: (params) => {
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        throw new ProtocolRpcError(ERROR.invalidParams, 'params must be an object')
      }
      const threadId = (params as { threadId?: unknown }).threadId
      if (typeof threadId !== 'string' || threadId.length === 0) {
        throw new ProtocolRpcError(ERROR.invalidParams, 'threadId is required')
      }
      if (!host.cancel) throw new ProtocolRpcError(ERROR.internal, 'turn/cancel is not supported')
      if (!host.cancel(threadId)) throw new ProtocolRpcError(ERROR.invalidParams, `no running turn for thread ${threadId}`)
      return { threadId, cancelled: true }
    },
  }
}
/** Builds the `turn/steer` handler: `{ threadId, message }`. */
export function turnSteerMethod(host: TurnHost): ProtocolMethod {
  return {
    request: (params) => {
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        throw new ProtocolRpcError(ERROR.invalidParams, 'params must be an object')
      }
      const record = params as { threadId?: unknown; message?: unknown }
      const threadId = typeof record.threadId === 'string' ? record.threadId : ''
      const message = typeof record.message === 'string' ? record.message.trim() : ''
      if (threadId.length === 0) throw new ProtocolRpcError(ERROR.invalidParams, 'threadId is required')
      if (message.length === 0) throw new ProtocolRpcError(ERROR.invalidParams, 'message is required')
      if (!host.steer) throw new ProtocolRpcError(ERROR.internal, 'turn/steer is not supported')
      if (!host.steer(threadId, message)) throw new ProtocolRpcError(ERROR.invalidParams, `no running turn for thread ${threadId}`)
      return { threadId, steered: true }
    },
  }
}
/** Builds the `turn/status` handler: `{ threadId }` → `{ running }`. */
export function turnStatusMethod(host: TurnHost): ProtocolMethod {
  return {
    request: (params) => {
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        throw new ProtocolRpcError(ERROR.invalidParams, 'params must be an object')
      }
      const threadId = (params as { threadId?: unknown }).threadId
      if (typeof threadId !== 'string' || threadId.length === 0) {
        throw new ProtocolRpcError(ERROR.invalidParams, 'threadId is required')
      }
      return { threadId, running: host.running?.(threadId) === true }
    },
  }
}