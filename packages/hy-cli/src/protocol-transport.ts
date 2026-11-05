/**
 * CP-27: the three transports for hy-protocol/1.
 *
 * - stdio: one connection (`hy protocol serve`);
 * - a named pipe (`\\.\pipe\…` on Windows, a Unix socket elsewhere): many
 *   local connections, the daemon's main door;
 * - WebSocket (`ws://127.0.0.1:PORT`): many connections, browsers and remote
 *   tools. Loopback only unless `allowRemote`.
 *
 * Every line or message is one JSON-RPC request handled concurrently (a
 * `turn/start` waits for `approval/respond` on the same connection). When the
 * server has a token, a connection must present it in `initialize`
 * (`params.token`) or, for WebSocket, in the upgrade (`?token=`, a
 * `Bearer` header or a `hy-protocol.<token>` subprotocol) before any other
 * method is answered.
 */
import http from 'node:http'
import net from 'node:net'
import type { Readable } from 'node:stream'
import { timingSafeEqual } from 'node:crypto'
import { ProtocolRpcError, ProtocolServer, type ProtocolMethod } from './protocol.js'
import type { HostConnection, ProtocolHost } from './protocol-host.js'
import { upgrade } from './ws.js'

export const UNAUTHORIZED = -32001

function sameToken(a: string | undefined, b: string): boolean {
  if (a === undefined) return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export interface ConnectionOptions {
  /** Required token; absent means the transport itself is trusted (stdio). */
  token?: string
  /** The token already arrived out of band (WebSocket upgrade). */
  preAuthorized?: boolean
  log?: (line: string) => void
}

/** Binds one connection to the host; returns its line handler and a close hook. */
export function bindConnection(host: ProtocolHost, write: (line: string) => void, options: ConnectionOptions = {}) {
  const connection: HostConnection = { send: (method, params) => write(JSON.stringify({ jsonrpc: '2.0', method, params })) }
  const methods = host.methods(connection)
  let authorized = options.token === undefined || options.preAuthorized === true
  const guarded: Record<string, ProtocolMethod> = {}
  for (const [name, method] of Object.entries(methods)) {
    guarded[name] =
      name === 'initialize'
        ? {
            request: (params) => {
              if (!authorized) {
                const token = params !== null && typeof params === 'object' ? (params as { token?: unknown }).token : undefined
                if (typeof token !== 'string' || !sameToken(token, options.token!)) {
                  throw new ProtocolRpcError(UNAUTHORIZED, 'unauthorized: initialize with the server token')
                }
                authorized = true
              }
              return method.request!(params)
            },
          }
        : {
            ...(method.request
              ? {
                  request: (params: unknown) => {
                    if (!authorized) throw new ProtocolRpcError(UNAUTHORIZED, 'unauthorized: call initialize with the token first')
                    return method.request!(params)
                  },
                }
              : {}),
            ...(method.notification ? { notification: (params: unknown) => (authorized ? method.notification!(params) : undefined) } : {}),
          }
  }
  const server = new ProtocolServer({ methods: guarded, notify: (method, params) => connection.send(method, params), ...(options.log ? { log: options.log } : {}) })
  const pending = new Set<Promise<void>>()
  const handleLine = (line: string): void => {
    if (!line.trim()) return
    const task = server
      .handle(line)
      .then((result) => {
        if (result.response !== undefined) write(result.response)
      })
      .catch((error: unknown) => options.log?.(`handler failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => pending.delete(task))
    pending.add(task)
  }
  return {
    handleLine,
    close: () => host.disconnect(connection),
    drain: async () => {
      while (pending.size > 0) await Promise.allSettled([...pending])
    },
  }
}

/** Splits a byte stream into lines and feeds them to the connection. */
export async function serveStream(host: ProtocolHost, input: Readable, write: (line: string) => void, options: ConnectionOptions = {}): Promise<void> {
  const bound = bindConnection(host, write, options)
  let buffer = ''
  input.setEncoding('utf8')
  try {
    for await (const chunk of input) {
      buffer += String(chunk)
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        bound.handleLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
    }
    if (buffer.trim()) bound.handleLine(buffer)
    await bound.drain()
  } finally {
    bound.close()
  }
}

/** The default pipe for a state directory (one daemon per state dir). */
export function defaultPipePath(stateKey: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\hy-harness-${stateKey}` : `/tmp/hy-harness-${stateKey}.sock`
}

export function listenPipe(host: ProtocolHost, pipePath: string, options: ConnectionOptions = {}): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined)
    void serveStream(host, socket, (line) => {
      if (!socket.destroyed) socket.write(`${line}\n`)
    }, options).finally(() => socket.destroy())
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipePath, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

export interface WsListenOptions extends ConnectionOptions {
  host?: string
  port: number
  /** Required to bind anything other than loopback. */
  allowRemote?: boolean
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export function wsTokenFromRequest(req: http.IncomingMessage): string | undefined {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const query = url.searchParams.get('token')
  if (query) return query
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  const proto = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .find((p) => p.startsWith('hy-protocol.'))
  return proto ? proto.slice('hy-protocol.'.length) : undefined
}

export function listenWebSocket(host: ProtocolHost, options: WsListenOptions): Promise<http.Server> {
  const bindHost = options.host ?? '127.0.0.1'
  if (!LOOPBACK.has(bindHost) && !options.allowRemote) {
    return Promise.reject(new Error(`refusing to listen on ${bindHost}: pass --allow-remote to accept connections from other machines`))
  }
  if (!LOOPBACK.has(bindHost) && !options.token) return Promise.reject(new Error('a remote WebSocket listener needs a token'))
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' }).end('hy-protocol/1: connect with a WebSocket\n')
  })
  server.on('upgrade', (req, socket, head) => {
    // A browser page from another site must not drive the local agent.
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin) && !options.allowRemote) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const presented = wsTokenFromRequest(req)
    const preAuthorized = options.token !== undefined && sameToken(presented, options.token)
    if (presented !== undefined && options.token !== undefined && !preAuthorized) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    upgrade(req, socket, head, (ws) => {
      const bound = bindConnection(host, (line) => ws.send(line), { ...options, preAuthorized })
      return { message: (text) => bound.handleLine(text), close: () => bound.close() }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, bindHost, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
