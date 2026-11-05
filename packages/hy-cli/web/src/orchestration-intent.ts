/**
 * Decides what the orchestration chip does, independent of the DOM and of the
 * mutable app state so the behaviour can be tested without booting the UI.
 *
 * A blank chat has no `state.current`, so an inline check could not tell "the
 * user just opened a new chat" from "the user is looking at another chat".
 * Without this input the click jumped back into the active orchestrator the
 * user had just left.
 */
export interface OrchestrationIntentInput {
  /** True while the composer shows the blank chat opened by newSession(). */
  freshChat: boolean
  /**
   * Run id of the orchestrator that is currently active, if any. Declared as
   * required-but-nullable instead of optional because `exactOptionalPropertyTypes`
   * rejects passing an explicit `undefined` to an optional property.
   */
  activeRunId: string | undefined
  /** Run id of the session shown in the composer, if any. */
  currentRunId: string | undefined
}

/**
 * `noop` is reserved for callers that decide to do nothing after asking this
 * function; the inputs below can never produce it, because every state the
 * chip can observe maps to a real action.
 */
export type OrchestrationIntent = 'start' | 'stop' | 'open-active' | 'noop'

export function orchestrationIntent(input: OrchestrationIntentInput): OrchestrationIntent {
  // A blank chat always means "start here". Returning 'open-active' would throw
  // away the chat the user just created and focus an existing orchestrator.
  if (input.freshChat) return 'start'
  if (input.activeRunId === undefined) return 'start'
  if (input.currentRunId === input.activeRunId) return 'stop'
  return 'open-active'
}
