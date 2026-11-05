/**
 * CP-30: the hy-protocol/1 method table, the single description clients are
 * generated and checked against (`docs/protocol-methods.json`,
 * `pnpm check:protocol-methods`).
 *
 * protocol-methods.test.ts checks that the host answers exactly these requests
 * and that the TypeScript SDK has a call for each of them.
 */

export interface ProtocolField {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown'
  required?: boolean
  description?: string
}

export interface ProtocolMethodSpec {
  method: string
  /** request: client → server with a response; notification: server → client. */
  kind: 'request' | 'notification'
  summary: string
  params?: Record<string, ProtocolField>
  result?: string
  /** The SDK (`ProtocolClient`) call that sends it. */
  sdk?: string
}

export const PROTOCOL_METHODS: readonly ProtocolMethodSpec[] = [
  { method: 'initialize', kind: 'request', summary: 'Version and capability negotiation; carries the daemon token.', params: { protocolVersion: { type: 'string' }, token: { type: 'string', description: 'required by a daemon (pipe / WebSocket)' } }, result: '{ protocolVersion, serverInfo, capabilities }', sdk: 'initialize' },
  { method: 'thread/list', kind: 'request', summary: 'Threads (runs) of the workspace, newest first.', params: { limit: { type: 'number' } }, result: '{ threads: ThreadSummary[] }', sdk: 'threads' },
  { method: 'thread/read', kind: 'request', summary: 'A thread transcript, paged.', params: { threadId: { type: 'string', required: true }, offset: { type: 'number' }, limit: { type: 'number' } }, result: '{ threadId, title, items, total }', sdk: 'readThread' },
  { method: 'turn/start', kind: 'request', summary: 'Runs one turn; resolves with the final answer. -32002 when another client runs that thread.', params: { message: { type: 'string', required: true }, threadId: { type: 'string' }, images: { type: 'array' }, tag: { type: 'string', description: 'echoed in turn/started and turn/event' } }, result: '{ threadId, final }', sdk: 'turn' },
  { method: 'turn/cancel', kind: 'request', summary: 'Aborts the running turn of a thread.', params: { threadId: { type: 'string', required: true } }, result: '{ threadId, cancelled }', sdk: 'cancel' },
  { method: 'turn/steer', kind: 'request', summary: 'Adds a message to the running turn.', params: { threadId: { type: 'string', required: true }, message: { type: 'string', required: true } }, result: '{ threadId, steered }', sdk: 'steer' },
  { method: 'turn/status', kind: 'request', summary: 'Whether a thread has a turn in flight.', params: { threadId: { type: 'string', required: true } }, result: '{ threadId, running }', sdk: 'status' },
  { method: 'approval/respond', kind: 'request', summary: 'Answers an approval/request.', params: { id: { type: 'string', required: true }, approved: { type: 'boolean', required: true } }, result: '{ id, approved }', sdk: 'onApproval' },
  { method: 'config/get', kind: 'request', summary: 'The effective configuration (model, sandbox, approval policy, features, MCP servers, plugins).', result: 'ConfigView', sdk: 'configGet' },
  { method: 'config/set', kind: 'request', summary: 'Changes a runtime key: model, approvalPolicy, autoApprove or fullAuto.', params: { key: { type: 'string', required: true }, value: { type: 'unknown', required: true } }, result: '{ ok, note, config }', sdk: 'configSet' },
  { method: 'model/set', kind: 'request', summary: 'Switches the worker model for new threads and the loaded ones (or one thread).', params: { model: { type: 'string', required: true }, threadId: { type: 'string' } }, result: '{ model, threads }', sdk: 'setModel' },
  { method: 'mcpServer/reload', kind: 'request', summary: 'Re-reads mcpServers from the configuration and restarts them.', result: '{ servers, tools }', sdk: 'reloadMcp' },
  { method: 'plugin/reload', kind: 'request', summary: 'Reloads plugin tools.', result: '{ tools, errors }', sdk: 'reloadPlugins' },
  { method: 'turn/started', kind: 'notification', summary: 'A turn began; names its thread (and the caller tag).', params: { threadId: { type: 'string', required: true }, tag: { type: 'string' } } },
  { method: 'turn/event', kind: 'notification', summary: 'One agent event of a running turn.', params: { threadId: { type: 'string', required: true }, tag: { type: 'string' }, event: { type: 'object', required: true } } },
  { method: 'approval/request', kind: 'notification', summary: 'A command needs the client\'s decision (answer with approval/respond).', params: { id: { type: 'string', required: true }, command: { type: 'string', required: true }, sandbox: { type: 'string' }, justification: { type: 'string' } } },
  { method: 'approval/expired', kind: 'notification', summary: 'An approval was not answered in time and was denied.', params: { id: { type: 'string', required: true } } },
]

/** Error codes beyond JSON-RPC's own. */
export const PROTOCOL_ERRORS = {
  unauthorized: -32001,
  threadBusy: -32002,
} as const

export function renderProtocolMethods(): string {
  return `${JSON.stringify({ protocol: 'hy-protocol/1', errors: PROTOCOL_ERRORS, methods: PROTOCOL_METHODS }, null, 2)}\n`
}
