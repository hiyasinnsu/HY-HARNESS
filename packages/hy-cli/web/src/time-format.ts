/**
 * WP-64 (handover 3-1/3-2): time formatting as pure functions.
 *
 * The sidebar wants "5 min ago", the trace, the outline and a message want a
 * clock time. Everything here takes `now` explicitly so the tests are stable,
 * and the locale is a string rather than a global.
 */
import { translate } from './i18n.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

function usable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Two-digit clock time in the user's locale, e.g. `10:33` (24-hour). */
export function formatClock(ts: number, locale = 'en'): string {
  if (!usable(ts)) return ''
  return new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Short date, used when a timestamp is older than a week. */
export function formatDay(ts: number, locale = 'en'): string {
  if (!usable(ts)) return ''
  return new Date(ts).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

/** `10:33` today, `Nov 5 10:33` otherwise. */
export function formatTimestamp(ts: number, locale = 'en', now = Date.now()): string {
  if (!usable(ts)) return ''
  const sameDay = new Date(ts).toDateString() === new Date(now).toDateString()
  return sameDay ? formatClock(ts, locale) : `${formatDay(ts, locale)} ${formatClock(ts, locale)}`
}

/**
 * `just now` / `5 min ago` / `3 h ago` / `2 d ago`, then a date.
 *
 * A timestamp slightly in the future (clock skew, a server in another zone)
 * reads as "just now" instead of "in -1 min".
 */
export function formatRelative(now: number, ts: number, locale = 'en'): string {
  if (!usable(now) || !usable(ts)) return ''
  const delta = now - ts
  if (delta < MINUTE) return translate(locale, 'timeJustNow')
  if (delta < HOUR) return translate(locale, 'timeMinutesAgo', { count: Math.floor(delta / MINUTE) })
  if (delta < DAY) return translate(locale, 'timeHoursAgo', { count: Math.floor(delta / HOUR) })
  if (delta < WEEK) return translate(locale, 'timeDaysAgo', { count: Math.floor(delta / DAY) })
  return formatDay(ts, locale)
}

/** The ISO value and the tooltip for a `<time>` element. */
export function timeAttributes(ts: number): { iso: string; title: string } {
  if (!usable(ts)) return { iso: '', title: '' }
  const date = new Date(ts)
  return {
    iso: Number.isNaN(date.getTime()) ? '' : date.toISOString(),
    title: date.toLocaleString(),
  }
}

/** The `<time>` markup for a message (absolute, with the ISO value). */
export function messageTimeHtml(ts: number, locale = 'en', now = Date.now()): string {
  const label = formatTimestamp(ts, locale, now)
  if (!label) return ''
  const { iso, title } = timeAttributes(ts)
  return `<time class="msg-time" datetime="${iso}" title="${title}">${label}</time>`
}
