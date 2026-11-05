// web_fetch: read a web page (DSH `packages/web` fetch provider). Opt-in
// (`--web` or `web.enabled`), because the request leaves the machine and may
// reach local services: every fetch needs approval unless its host is in the
// user's `web.allowDomains` (a domain also allows its subdomains).

export interface WebConfig {
  enabled?: boolean
  /** Hosts fetched without approval, e.g. ["docs.python.org", "developer.mozilla.org"]. */
  allowDomains?: string[]
  /** Response bytes read at most (default 1 MiB). */
  maxBytes?: number
  timeoutMs?: number
  /**
   * A search endpoint answering `GET <searchUrl>?q=<query>&format=json` with
   * `{ results: [{ url, title, content }] }` (SearXNG's JSON format), e.g. a
   * self-hosted SearXNG. Enables web_search; the user chose the endpoint, so
   * queries need no approval.
   */
  searchUrl?: string
}

export async function webSearch(query: string, config: WebConfig, maxResults = 8) {
  if (!config.searchUrl) throw new Error('web_search needs web.searchUrl in the user config')
  const url = new URL(config.searchUrl)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  const response = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs ?? 30_000), headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`search endpoint HTTP ${response.status}`)
  const body = (await response.json()) as { results?: Array<{ url?: string; title?: string; content?: string }> }
  return {
    results: (body.results ?? [])
      .filter((r) => typeof r.url === 'string')
      .slice(0, Math.max(1, Math.min(20, maxResults)))
      .map((r) => ({ url: r.url!, title: (r.title ?? '').trim(), snippet: (r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) })),
  }
}

const DEFAULT_MAX_BYTES = 1024 * 1024
/** Characters of text returned to the model; the rest is reported as truncated. */
const MAX_TEXT = 40_000

export function hostAllowed(url: URL, allow: readonly string[] = []): boolean {
  const host = url.hostname.toLowerCase()
  return allow.some((d) => {
    const domain = d.toLowerCase().replace(/^\*\./, '')
    return host === domain || host.endsWith(`.${domain}`)
  })
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    /^#x/i.test(e) ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
  )
}

/** Readable text from HTML: scripts, styles and tags removed, block elements on their own lines. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim()
  const text = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head|title)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/pre|\/section|\/article|\/table)[^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}

export async function webFetch(rawUrl: string, config: WebConfig = {}) {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`only http and https URLs can be fetched: ${rawUrl}`)
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
    headers: { 'user-agent': 'hy-harness web_fetch', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
  })
  const max = config.maxBytes ?? DEFAULT_MAX_BYTES
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let cut = false
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (bytes + value.byteLength > max) {
        chunks.push(value.subarray(0, max - bytes))
        bytes = max
        cut = true
        await reader.cancel()
        break
      }
      chunks.push(value)
      bytes += value.byteLength
    }
  }
  const body = Buffer.concat(chunks).toString('utf8')
  const type = response.headers.get('content-type') ?? ''
  const { title, text } = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body) : { title: '', text: body }
  const truncated = cut || text.length > MAX_TEXT
  return {
    url: response.url,
    status: response.status,
    contentType: type,
    ...(title ? { title } : {}),
    text: text.slice(0, MAX_TEXT),
    truncated,
  }
}
