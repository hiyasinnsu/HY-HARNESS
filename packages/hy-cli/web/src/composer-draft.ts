/**
 * Composer draft bookkeeping.
 *
 * The composer is rebuilt with `innerHTML` whenever session state changes, so
 * the text being typed has to live outside the DOM. Drafts are keyed by chat:
 * switching chats shows that chat's own text, and a new chat starts empty
 * instead of inheriting the text of the chat the user just left.
 *
 * Everything here is pure so the rules can be tested without a DOM.
 */

/**
 * Key for the blank chat opened by newSession(). It has no run id until the
 * first message is sent, so it needs a key no run id can collide with.
 */
export const BLANK_CHAT_DRAFT_KEY = ''

/** Draft text per chat key. */
export type ComposerDrafts = ReadonlyMap<string, string>

/** What the textarea held when it was replaced, so the caret can be put back. */
export interface ComposerSnapshot {
  readonly value: string
  readonly selectionStart: number
  readonly selectionEnd: number
}

/** The inputs of the focus handler that decides whether a chat must be started. */
export interface ComposerFocusInput {
  readonly hasCurrentSession: boolean
  readonly freshChat: boolean
  readonly startingSession: boolean
}

/** Key a chat's draft is stored under; the blank chat has no run id yet. */
export function composerDraftKey(runId: string | undefined): string {
  return runId ?? BLANK_CHAT_DRAFT_KEY
}

/**
 * Draft for a chat. A chat that was never typed into reads as an empty string;
 * `hasComposerDraft` tells "never typed into" apart from "typed into and then
 * cleared".
 */
export function readComposerDraft(drafts: ComposerDrafts, key: string): string {
  return drafts.get(key) ?? ''
}

/** True when the chat has a draft entry, including an empty one. */
export function hasComposerDraft(drafts: ComposerDrafts, key: string): boolean {
  return drafts.has(key)
}

/** Returns a new draft map with one chat's text replaced. */
export function writeComposerDraft(drafts: ComposerDrafts, key: string, value: string): Map<string, string> {
  const next = new Map<string, string>(drafts)
  next.set(key, value)
  return next
}

/**
 * Whether the composer may be rebuilt from scratch. A rebuild replaces the
 * textarea under the caret, which drops an in-flight IME composition and sends
 * the caret back to the start, so background refreshes skip it and only the
 * cheap per-turn state (send/stop/queue) is refreshed instead.
 */
export function shouldRebuildComposer(inputFocused: boolean): boolean {
  return !inputFocused
}

/**
 * Whether focusing the composer should start a chat.
 *
 * The blank chat is already open and focused when the user starts typing, so
 * treating that focus as "open a new chat" replaced the textarea under the
 * caret on every keystroke: the text vanished and the composer flickered.
 * Only a chat-less, not-yet-blank composer may start one.
 */
export function shouldStartSessionOnFocus(input: ComposerFocusInput): boolean {
  if (input.startingSession) return false
  if (input.hasCurrentSession) return false
  return !input.freshChat
}

/**
 * Caret to restore after a rebuild. When the text changed in the meantime the
 * old offsets no longer mean anything, so the caret goes to the end, which is
 * where typing resumes.
 */
export function caretAfterRender(snapshot: ComposerSnapshot | undefined, value: string): { start: number; end: number } {
  if (!snapshot || snapshot.value !== value) return { start: value.length, end: value.length }
  return {
    start: Math.min(snapshot.selectionStart, value.length),
    end: Math.min(snapshot.selectionEnd, value.length),
  }
}