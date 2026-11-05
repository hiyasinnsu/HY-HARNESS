// CP-25: approval requests over the protocol.
//
// A turn that needs permission sends an `approval/request` notification and
// waits for `approval/respond`. The bridge keeps the pending map, times out to
// a denial, and denies everything on shutdown.

import { ERROR, ProtocolRpcError } from './protocol.js'

export interface ApprovalQuestion {
  command: string
  sandbox?: string
  justification?: string
}

export interface ApprovalBridgeOptions {
  send: (method: string, params: unknown) => void
  /** Default 5 minutes; a timeout is a denial. */
  timeoutMs?: number
}

export class ApprovalBridge {
  private next = 1
  private readonly pending = new Map<string, { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }>()

  constructor(private readonly options: ApprovalBridgeOptions) {}

  ask(question: ApprovalQuestion): Promise<boolean> {
    const id = `approval-${this.next++}`
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.options.send('approval/expired', { id })
        resolve(false)
      }, this.options.timeoutMs ?? 300_000)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      this.options.send('approval/request', {
        id,
        command: question.command,
        ...(question.sandbox !== undefined ? { sandbox: question.sandbox } : {}),
        ...(question.justification !== undefined ? { justification: question.justification } : {}),
      })
    })
  }

  /** `approval/respond` params: `{ id: string, approved: boolean }`. */
  respond(params: unknown): { id: string; approved: boolean } {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      throw new ProtocolRpcError(ERROR.invalidParams, 'params must be an object')
    }
    const record = params as { id?: unknown; approved?: unknown }
    if (typeof record.id !== 'string' || record.id.length === 0) {
      throw new ProtocolRpcError(ERROR.invalidParams, 'id is required')
    }
    if (typeof record.approved !== 'boolean') {
      throw new ProtocolRpcError(ERROR.invalidParams, 'approved must be a boolean')
    }
    const entry = this.pending.get(record.id)
    if (!entry) throw new ProtocolRpcError(ERROR.invalidParams, `unknown approval ${record.id}`)
    clearTimeout(entry.timer)
    this.pending.delete(record.id)
    entry.resolve(record.approved)
    return { id: record.id, approved: record.approved }
  }

  pendingCount(): number {
    return this.pending.size
  }

  /** Resolves every waiting turn with a denial (server shutdown). */
  denyAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve(false)
      this.pending.delete(id)
    }
  }
}