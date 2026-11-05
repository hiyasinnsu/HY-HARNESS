import type { ImageInput } from './llm.js'

/**
 * Messages the user sends *while* a turn is running (WP-21, DSH's steering
 * inbox). They are not a new turn: the agent drains the inbox at every step
 * boundary and appends what it finds to the running conversation, so the model
 * sees it in the very next request.
 *
 * The text is stored raw in the session log (`user/steer`) so the chat
 * projection can render exactly what the user typed. The steering marker below
 * is added only where the message enters the model's history, which keeps a
 * resumed run byte-identical to the live one.
 */
export interface SteerMessage {
  text: string
  images?: ImageInput[]
}

/** Marker in front of a steering message in the model's history. */
export const STEER_PREFIX = '[the user sent this while you were working]'

/** The history form of a steering message (used by the agent and `rebuildHistory`). */
export function steerMessage(text: string): string {
  return `${STEER_PREFIX}\n${text}`
}

/** True when a history entry came from the steering inbox. */
export function isSteerMessage(content: string): boolean {
  return content.startsWith(`${STEER_PREFIX}\n`)
}

/** The user's text of a history entry, without the marker. */
export function steerText(content: string): string {
  return isSteerMessage(content) ? content.slice(STEER_PREFIX.length + 1) : content
}

/**
 * The queue itself. One instance per `Conversation`, shared with every `Agent`
 * built for it (the agent is rebuilt on `/model` and between turns).
 */
export interface SteerInbox {
  /** Queues one message; returns the new depth. */
  push(message: SteerMessage): number
  /** Takes everything queued so far. Empty when nothing is pending. */
  drain(): SteerMessage[]
  /** How many messages are waiting. */
  size(): number
}

export function createSteerInbox(): SteerInbox {
  const queue: SteerMessage[] = []
  return {
    push(message) {
      queue.push(message)
      return queue.length
    },
    drain() {
      return queue.splice(0, queue.length)
    },
    size() {
      return queue.length
    },
  }
}
