import { translate } from './i18n.js'

/**
 * What the composer does with a submit, decided without touching the DOM so the
 * branch can be tested without booting the UI.
 *
 * The previous behaviour rejected a message sent during a run ("press Stop
 * first"), which threw the text away. A running turn now takes the message
 * either way: `steer` joins the turn at its next step boundary (DSH's steering
 * inbox), `queue` waits for the turn to finish in the durable queue.
 */
export type SendIntent = 'send-now' | 'steer' | 'queue'

/** `mode` is the composer toggle; the default while busy is to steer. */
export function sendIntent(busy: boolean, mode: 'steer' | 'queue' = 'steer'): SendIntent {
  if (!busy) return 'send-now'
  return mode === 'queue' ? 'queue' : 'steer'
}

/** Label of the badge next to the composer; an empty queue shows no badge. */
export function queueBadgeLabel(count: number, locale: string): string {
  if (count <= 0) return ''
  return translate(locale, 'turnQueueBadge', { count })
}

/** Label of the busy-only toggle: what a submit does with the running turn. */
export function steerToggleLabel(mode: 'steer' | 'queue', locale: string): string {
  return mode === 'queue' ? translate(locale, 'steerAfterTurn') : translate(locale, 'steerNow')
}
