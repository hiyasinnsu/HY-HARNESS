/**
 * Scroll-position bookkeeping for the transcript.
 *
 * The transcript is re-rendered in full on every live event, and the whole DOM
 * is rebuilt when another chat is opened. Both used to drop the reader back at
 * the oldest entry. The arithmetic lives here, away from the DOM, so the rules
 * can be tested without booting the UI.
 */

/**
 * Distance from the bottom, in pixels, within which the view still counts as
 * following the conversation. Some slack is needed because a streaming entry
 * grows as it renders: a reader who is essentially at the bottom must keep
 * being carried along with it.
 */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 48

export interface ScrollAnchor {
  /** `scrollTop` of the transcript container when the anchor was taken. */
  top: number
  /** True when the view followed the newest entry instead of a fixed offset. */
  stick: boolean
}

/**
 * Anchor for a chat this client has never displayed. Opening at the top would
 * mean scrolling through the entire history to reach the newest turn, so an
 * unseen chat starts pinned to the bottom instead.
 */
export const SCROLL_ANCHOR_AT_BOTTOM: ScrollAnchor = { top: 0, stick: true }

/**
 * True when the container is scrolled close enough to the bottom that new
 * content should stay in view. Content that fits without scrolling always
 * counts as being at the bottom.
 */
export function shouldStickToBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= STICK_TO_BOTTOM_THRESHOLD_PX
}

/**
 * The `scrollTop` to apply after the transcript has been re-rendered.
 *
 * `Number.POSITIVE_INFINITY` means "the bottom": the height of the new content
 * is unknown until the DOM has been replaced, so the caller assigns the
 * container's `scrollHeight` when the result is not finite. A missing anchor
 * yields 0 so the function stays total; the "a chat never opened before starts
 * at the bottom" rule is expressed by passing `SCROLL_ANCHOR_AT_BOTTOM`.
 */
export function anchorAfterRender(previous: ScrollAnchor | undefined): number {
  if (!previous) return 0
  return previous.stick ? Number.POSITIVE_INFINITY : previous.top
}

/** Anchor describing the container as it is scrolled right now. */
export function captureAnchor(scrollTop: number, scrollHeight: number, clientHeight: number): ScrollAnchor {
  return { top: scrollTop, stick: shouldStickToBottom(scrollTop, scrollHeight, clientHeight) }
}