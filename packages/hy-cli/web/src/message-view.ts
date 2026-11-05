/**
 * WP-64 (handover 3-2): the user/assistant message markup, extracted from
 * `app.ts` so it can be tested without a DOM.
 *
 * Tool cards, plan cards and notices stay in `app.ts`: they need the live
 * session state. Messages only need the entry plus two display switches.
 */
import { escapeHtml, renderMarkdown } from './markdown.js'
import { icon } from './icons.js'
import { maskSecrets } from './secret-mask.js'
import { messageTimeHtml } from './time-format.js'
import { translate } from './i18n.js'

export interface MessageContext {
  locale: string
  /** Hide API-key-like strings; the stored text is untouched. */
  mask: boolean
  /** Fixed clock for tests; defaults to the real one. */
  now?: number
  /** CP-33: show the message source instead of rendered Markdown. */
  raw?: boolean
}

export interface UserMessageEntry {
  id: string
  text: string
  ts: number
  steering?: boolean | undefined
  /** How many images the turn carried (the log stores the count). */
  images?: number | undefined
}

export interface AssistantMessageEntry {
  id: string
  text: string
  ts: number
}

function displayText(text: string, context: MessageContext): string {
  return context.mask ? maskSecrets(text).text : text
}

function messageBody(text: string, context: MessageContext): string {
  const shown = displayText(text, context)
  return context.raw ? `<pre class="raw-message">${escapeHtml(shown)}</pre>` : renderMarkdown(shown)
}

/** A user turn: optional steering badge, image count, the text and its time. */
export function renderUserMessage(entry: UserMessageEntry, context: MessageContext): string {
  const steering = entry.steering
    ? `<div class="steer-badge" title="${escapeHtml(translate(context.locale, 'steerTitle'))}">${icon('bolt', 12)} ${escapeHtml(translate(context.locale, 'steerBadge'))}</div>`
    : ''
  const images = entry.images && entry.images > 0
    ? `<div class="message-attachments">${icon('paperclip', 14)} ${entry.images} image${entry.images === 1 ? '' : 's'}</div>`
    : ''
  return `<article class="message user${entry.steering ? ' steering' : ''}" data-entry-id="${escapeHtml(entry.id)}">${steering}<div class="message-body">${images}${messageBody(entry.text, context)}${messageTimeHtml(entry.ts, context.locale, context.now)}</div></article>`
}

/** An assistant turn: the answer, its time and the copy/feedback actions. */
export function renderAssistantMessage(entry: AssistantMessageEntry, context: MessageContext): string {
  return `<article class="message assistant" data-entry-id="${escapeHtml(entry.id)}"><div class="message-body">${messageBody(entry.text, context)}${messageTimeHtml(entry.ts, context.locale, context.now)}</div><div class="message-actions"><button class="link-btn" data-action="copy-entry" data-entry-id="${escapeHtml(entry.id)}">${icon('copy', 12)} ${escapeHtml(translate(context.locale, 'copyAnswer'))}</button><button class="link-btn" data-action="feedback-up" data-entry-id="${escapeHtml(entry.id)}" title="${escapeHtml(translate(context.locale, 'feedbackUp'))}">${icon('check', 12)}</button><button class="link-btn" data-action="feedback-down" data-entry-id="${escapeHtml(entry.id)}" title="${escapeHtml(translate(context.locale, 'feedbackDown'))}">${icon('x', 12)}</button></div></article>`
}
