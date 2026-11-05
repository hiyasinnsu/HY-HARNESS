/**
 * CP-27: a small RFC 6455 WebSocket server endpoint (text frames only).
 *
 * Enough for JSON-RPC: the opening handshake, masked client frames,
 * fragmentation, ping/pong and close. No extensions, no binary messages (they
 * are answered with close 1003). Dependency-free so the CLI stays a plain
 * Node program.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** Messages above this are refused (close 1009). */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** Encodes one unmasked server frame. */
export function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const length = payload.length
  const head = length < 126 ? 2 : length < 65_536 ? 4 : 10
  const frame = Buffer.alloc(head + length)
  frame[0] = (fin ? 0x80 : 0) | (opcode & 0x0f)
  if (length < 126) frame[1] = length
  else if (length < 65_536) {
    frame[1] = 126
    frame.writeUInt16BE(length, 2)
  } else {
    frame[1] = 127
    frame.writeBigUInt64BE(BigInt(length), 2)
  }
  payload.copy(frame, head)
  return frame
}

export interface DecodedFrame {
  fin: boolean
  opcode: number
  masked: boolean
  payload: Buffer
  /** Bytes consumed from the buffer. */
  size: number
}

/** Decodes one frame from the front of `buffer`; undefined when incomplete. */
export function decodeFrame(buffer: Buffer): DecodedFrame | undefined {
  if (buffer.length < 2) return undefined
  const fin = (buffer[0]! & 0x80) !== 0
  const opcode = buffer[0]! & 0x0f
  const masked = (buffer[1]! & 0x80) !== 0
  let length = buffer[1]! & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(MAX_MESSAGE_BYTES)) return { fin, opcode, masked, payload: Buffer.alloc(0), size: -1 }
    length = Number(big)
    offset = 10
  }
  const maskBytes = masked ? 4 : 0
  if (buffer.length < offset + maskBytes + length) return undefined
  const payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + length))
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4)
    for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!
  }
  return { fin, opcode, masked, payload, size: offset + maskBytes + length }
}

export interface WsConnection {
  send(text: string): void
  close(code?: number, reason?: string): void
  readonly closed: boolean
}

export interface WsHandlers {
  message(text: string): void
  close(): void
}

/**
 * Completes the upgrade on `socket` and starts reading frames. Returns false
 * (and answers 400) when the request is not a WebSocket upgrade.
 */
export function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, handlers: (connection: WsConnection) => WsHandlers): boolean {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    return false
  }
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const chosen = protocols.find((p) => p === 'hy-protocol') ?? protocols.find((p) => p.startsWith('hy-protocol'))
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      ...(chosen ? [`Sec-WebSocket-Protocol: ${chosen}`] : []),
      '',
      '',
    ].join('\r\n'),
  )
  let closed = false
  const connection: WsConnection = {
    send(text) {
      if (!closed) socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')))
    },
    close(code = 1000, reason = '') {
      if (closed) return
      closed = true
      const body = Buffer.alloc(2 + Buffer.byteLength(reason))
      body.writeUInt16BE(code, 0)
      body.write(reason, 2)
      socket.end(encodeFrame(0x8, body))
    },
    get closed() {
      return closed
    },
  }
  const on = handlers(connection)
  let buffer: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0)
  let fragments: Buffer[] = []
  let fragmentBytes = 0
  const pump = () => {
    for (;;) {
      const frame = decodeFrame(buffer)
      if (!frame) return
      if (frame.size < 0) return connection.close(1009, 'message too big')
      buffer = buffer.subarray(frame.size)
      // Client frames must be masked (RFC 6455 §5.1).
      if (!frame.masked) return connection.close(1002, 'unmasked client frame')
      switch (frame.opcode) {
        case 0x0:
        case 0x1: {
          if (frame.opcode === 0x1 && fragments.length > 0) return connection.close(1002, 'interleaved message')
          fragments.push(frame.payload)
          fragmentBytes += frame.payload.length
          if (fragmentBytes > MAX_MESSAGE_BYTES) return connection.close(1009, 'message too big')
          if (frame.fin) {
            const text = Buffer.concat(fragments).toString('utf8')
            fragments = []
            fragmentBytes = 0
            on.message(text)
          }
          break
        }
        case 0x2:
          return connection.close(1003, 'text frames only')
        case 0x8:
          if (!closed) {
            closed = true
            socket.end(encodeFrame(0x8, frame.payload.subarray(0, 2)))
          }
          return
        case 0x9:
          socket.write(encodeFrame(0xa, frame.payload))
          break
        case 0xa:
          break
        default:
          return connection.close(1002, 'unknown opcode')
      }
    }
  }
  socket.on('data', (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    pump()
  })
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    closed = true
    on.close()
  }
  socket.on('close', end)
  socket.on('error', end)
  pump()
  return true
}
