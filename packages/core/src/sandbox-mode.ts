// WP-12: a session's sandbox mode is durable session state.
//
// The mode can be switched by the user mid-conversation; the switch is appended
// to the session log as `sandbox/mode` so a resume replays the latest one. The
// daemon applies it per call (see `crates/hy-exec-server`), and every new tool
// call reads the current value — never a value captured at session creation.

import { parseSandboxMode } from './config.js'
import type { SandboxMode } from './protocol.js'
import type { SessionEvent } from './session-log.js'

/** The mode recorded for `runId`, or `fallback` when it never switched. */
export function resolveSandboxMode(
  events: readonly SessionEvent[],
  runId: string,
  fallback: SandboxMode,
): SandboxMode {
  let mode = fallback
  for (const event of events) {
    if (event.runId !== runId || event.type !== 'sandbox/mode') continue
    const payload = event.payload as { mode?: unknown } | null | undefined
    const value = payload?.mode
    if (typeof value !== 'string') continue
    try {
      mode = parseSandboxMode(value)
    } catch {
      // A malformed switch is ignored: the next well-formed event still wins.
    }
  }
  return mode
}

/** Modes a session may switch to. `low-integrity` stays a user-policy choice. */
export function switchableSandboxModes(): readonly SandboxMode[] {
  return ['read-only', 'workspace-write', 'unconfined']
}
