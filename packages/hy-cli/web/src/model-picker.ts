/**
 * CP-35: the model picker's rows: the catalog with what each model can do.
 *
 * A model switch keeps the session's provider (the API key and endpoint belong
 * to it), so models of other providers are listed for reference but cannot be
 * picked here; Settings changes the provider.
 *
 * Pure module (no DOM): web/test/model-picker.test.mjs.
 */
import { escapeHtml } from './markdown.js'

export interface CatalogModel {
  id: string
  provider: string
  model: string
  label: string
  contextWindowTokens: number
  maxOutputTokens: number
  capabilities: { tools: boolean; vision: boolean; reasoning: boolean; cache: boolean }
}

export interface PickerLabels {
  tools: string
  vision: string
  reasoning: string
  cache: string
  current: string
  otherProvider: string
  context: string
}

/** 32768 → "32K", 128000 → "128K", 1048576 → "1M", 1000000 → "1M". */
export function formatTokens(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`
  if (tokens % 1_024 === 0) return `${tokens / 1_024}K`
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1_000)}K`
}

export function capabilityTags(model: CatalogModel): Array<'tools' | 'vision' | 'reasoning' | 'cache'> {
  return (['tools', 'vision', 'reasoning', 'cache'] as const).filter((c) => model.capabilities[c])
}

/** Same-provider models first, then the rest; each group by label. Filters on label/model/provider. */
export function pickerModels(models: readonly CatalogModel[], provider: string, query = ''): CatalogModel[] {
  const q = query.trim().toLowerCase()
  const hit = (m: CatalogModel) => !q || `${m.label} ${m.model} ${m.provider}`.toLowerCase().includes(q)
  const byLabel = (a: CatalogModel, b: CatalogModel) => a.label.localeCompare(b.label)
  return [...models.filter((m) => m.provider === provider && hit(m)).sort(byLabel), ...models.filter((m) => m.provider !== provider && hit(m)).sort(byLabel)]
}

export function renderModelRows(models: readonly CatalogModel[], current: { provider: string; model: string }, labels: PickerLabels): string {
  return models
    .map((m) => {
      const same = m.provider === current.provider
      const active = same && m.model === current.model
      const tags = capabilityTags(m)
        .map((t) => `<span class="tag cap-${t}">${escapeHtml(labels[t])}</span>`)
        .join('')
      const note = active ? `<span class="session-badge">${escapeHtml(labels.current)}</span>` : same ? '' : `<span class="muted small">${escapeHtml(labels.otherProvider)}</span>`
      return `<button type="button" class="model-row${active ? ' active' : ''}" data-action="pick-model" data-model="${escapeHtml(m.model)}" ${same ? '' : 'disabled'}>
  <span class="model-main"><strong>${escapeHtml(m.label)}</strong><code>${escapeHtml(m.provider)}/${escapeHtml(m.model)}</code></span>
  <span class="model-caps">${tags}<span class="muted small">${escapeHtml(labels.context)} ${formatTokens(m.contextWindowTokens)}</span>${note}</span>
</button>`
    })
    .join('')
}
