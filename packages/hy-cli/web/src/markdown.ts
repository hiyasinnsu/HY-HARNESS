import { highlightCode } from './highlight.js'
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function inline(value: string): string {
  const codes: string[] = []
  let text = value.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  text = escapeHtml(text)
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  )
  text = text.replace(/\u0000(\d+)\u0000/g, (_, id: string) => codes[Number(id)] ?? '')
  return text
}

/** Small, safe Markdown renderer for chat messages (no raw HTML is accepted). */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let paragraph: string[] = []
  let list: { type: 'ul' | 'ol'; items: string[] } | undefined

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`)
    paragraph = []
  }
  const flushList = (): void => {
    if (!list) return
    out.push(`<${list.type}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.type}>`)
    list = undefined
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(line)
    if (fence) {
      flushParagraph()
      flushList()
      const code: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        code.push(lines[i]!)
        i += 1
      }
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : ''
      // CP-36: comments, strings, numbers and keywords get theme colours.
      out.push(`<pre class="code-block"><code${language}>${highlightCode(code.join('\n'), fence[1])}</code></pre>`)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1]!.length
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph()
      flushList()
      out.push('<hr>')
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flushParagraph()
      flushList()
      out.push(`<blockquote>${inline(quote[1]!)}</blockquote>`)
      continue
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (unordered) {
      flushParagraph()
      if (!list || list.type !== 'ul') {
        flushList()
        list = { type: 'ul', items: [] }
      }
      list.items.push(unordered[1]!)
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (ordered) {
      flushParagraph()
      if (!list || list.type !== 'ol') {
        flushList()
        list = { type: 'ol', items: [] }
      }
      list.items.push(ordered[1]!)
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  return out.join('\n')
}

export function oneLine(value: string, max = 120): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
