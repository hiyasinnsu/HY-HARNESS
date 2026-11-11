/**
 * CP-36: the composer's statusline, built from the items the user picked
 * (server: packages/hy-cli/src/ui-prefs.ts keeps the list).
 *
 * Pure module (no DOM): web/test/statusline.test.mjs.
 */
import { escapeHtml } from './markdown.js'

export const STATUS_ITEMS = ['model', 'sandbox', 'tokens', 'cache', 'cost', 'last', 'context', 'turns'] as const
export type StatusItem = (typeof STATUS_ITEMS)[number]

export interface StatusData {
  provider?: string
  model?: string
  sandbox?: string
  inputTokens?: number
  outputTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  cacheUsageComplete?: boolean
  lastInputTokens?: number
  lastOutputTokens?: number
  contextWindowTokens?: number
  turns?: number
  /** B1: USD at the model's registered price (absent when none is registered). */
  costUsd?: number
  /** The provider did not report the cache split: the cost is an upper bound. */
  costApproximate?: boolean
}

const n = (v: number | undefined) => Math.max(0, Number(v ?? 0)).toLocaleString('en-US')

/** One item's text, or '' when there is nothing to show yet. */
export function statusText(item: StatusItem, d: StatusData): string {
  switch (item) {
    case 'model':
      return d.model ? `${d.provider ? `${d.provider}/` : ''}${d.model}` : ''
    case 'sandbox':
      return d.sandbox ?? ''
    case 'tokens':
      return `in ${n(d.inputTokens)} / out ${n(d.outputTokens)}`
    case 'cache': {
      if (d.cacheUsageComplete === false) return 'cache —'
      const hit = Math.max(0, d.cacheHitTokens ?? 0)
      const total = hit + Math.max(0, d.cacheMissTokens ?? Math.max(0, (d.inputTokens ?? 0) - hit))
      return `cache ${n(hit)} (${total > 0 ? ((hit / total) * 100).toFixed(2) : '0.00'}%)`
    }
    case 'cost': {
      if (d.costUsd === undefined || !Number.isFinite(d.costUsd)) return ''
      const usd = d.costUsd < 1 ? d.costUsd.toFixed(4) : d.costUsd.toFixed(2)
      return `${d.costApproximate ? '\u2264 ' : '\u2248 '}$${usd}`
    }
    case 'last':
      return d.lastInputTokens === undefined ? '' : `last ${n(d.lastInputTokens)}/${n(d.lastOutputTokens)}`
    case 'context': {
      if (!d.contextWindowTokens || d.lastInputTokens === undefined) return ''
      const pct = Math.min(100, (100 * d.lastInputTokens) / d.contextWindowTokens)
      return `ctx ${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
    }
    case 'turns':
      return d.turns === undefined ? '' : `${d.turns} turn${d.turns === 1 ? '' : 's'}`
  }
}

export function renderStatusline(items: readonly StatusItem[], data: StatusData): string {
  return items
    .map((item) => [item, statusText(item, data)] as const)
    .filter(([, text]) => text)
    .map(([item, text]) => `<span class="status-item status-${item}">${escapeHtml(text)}</span>`)
    .join('<span class="status-sep">·</span>')
}
