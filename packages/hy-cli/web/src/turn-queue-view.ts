import { translate } from './i18n.js'
import { escapeHtml, oneLine } from './markdown.js'
import type { TurnQueueView } from './types.js'

/**
 * Renders the queued-messages panel that sits above the composer. Pure: no DOM
 * and no mutable state, so the markup the click delegation depends on (the
 * `data-queue-*` attributes) can be tested without booting the UI.
 *
 * An empty queue renders nothing at all: every chat would otherwise grow a
 * blank box even when nothing is waiting.
 */
export function renderTurnQueueHtml(view: TurnQueueView, locale: string): string {
  if (view.queued.length === 0 && view.uncertain.length === 0) return ''
  const parts: string[] = []
  if (view.queued.length > 0) {
    const rows = view.queued.map((turn) => {
      const images =
        turn.images > 0
          ? `<span class="tq-images">${escapeHtml(translate(locale, 'turnQueueImages', { count: turn.images }))}</span>`
          : ''
      return `<li class="tq-item"><span class="tq-text">${escapeHtml(oneLine(turn.message))}</span>${images}<button type="button" class="tq-action" data-queue-action="cancel" data-queue-id="${escapeHtml(turn.id)}">${escapeHtml(translate(locale, 'turnQueueCancel'))}</button></li>`
    })
    parts.push(
      `<div class="tq-head"><span class="tq-count">${escapeHtml(translate(locale, 'turnQueueHeader', { count: view.queued.length }))}</span><button type="button" class="tq-action" data-queue-action="cancel-all">${escapeHtml(translate(locale, 'turnQueueCancelAll'))}</button></div>`,
      `<ul class="tq-list">${rows.join('')}</ul>`,
    )
  }
  if (view.paused) {
    parts.push(
      `<div class="tq-paused"><span class="tq-tag">${escapeHtml(translate(locale, 'turnQueuePaused'))}</span><button type="button" class="tq-action" data-queue-action="resume">${escapeHtml(translate(locale, 'turnQueueResume'))}</button></div>`,
    )
  }
  if (view.uncertain.length > 0) {
    // The process cannot know whether a turn interrupted by a crash already
    // had its side effects, so it is never resent automatically: both buttons
    // are explicit user decisions.
    const rows = view.uncertain.map(
      (id) => `<li class="tq-item tq-uncertain"><span class="tq-tag">${escapeHtml(translate(locale, 'turnQueueUncertain'))}</span><code class="tq-id">${escapeHtml(id)}</code><button type="button" class="tq-action" data-queue-action="resolve" data-queue-decision="resend" data-queue-id="${escapeHtml(id)}">${escapeHtml(translate(locale, 'turnQueueResend'))}</button><button type="button" class="tq-action danger" data-queue-action="resolve" data-queue-decision="discard" data-queue-id="${escapeHtml(id)}">${escapeHtml(translate(locale, 'turnQueueDiscard'))}</button></li>`,
    )
    parts.push(`<ul class="tq-list tq-uncertain-list">${rows.join('')}</ul>`)
  }
  return `<div class="tq-root">${parts.join('')}</div>`
}