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

type ListItem = { indent: number; type: 'ul' | 'ol'; text: string }

function indentOf(value: string): number {
  let width = 0
  for (const ch of value) {
    if (ch === ' ') width += 1
    else if (ch === '\t') width += 4
    else break
  }
  return width
}

/** Builds nested <ul>/<ol> from items whose indentation marks the depth. */
function renderList(items: ListItem[]): string {
  let i = 0
  const build = (minIndent: number): string => {
    let html = ''
    while (i < items.length && items[i]!.indent >= minIndent) {
      const { type, indent } = items[i]!
      html += `<${type}>`
      while (i < items.length && items[i]!.indent === indent && items[i]!.type === type) {
        const text = items[i]!.text
        i += 1
        const child = i < items.length && items[i]!.indent > indent ? build(items[i]!.indent) : ''
        html += `<li>${inline(text)}${child}</li>`
      }
      html += `</${type}>`
    }
    return html
  }
  return build(0)
}

/** Splits a table row on `|`, ignoring pipes inside code spans or escaped as `\|`. */
function tableCells(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let k = 0; k < row.length; k++) {
    const ch = row[k]!
    if (ch === '\\' && row[k + 1] === '|') {
      cell += '|'
      k += 1
    } else if (ch === '`') {
      inCode = !inCode
      cell += ch
    } else if (ch === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
    } else cell += ch
  }
  cells.push(cell.trim())
  return cells
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function tableAlign(cell: string): string {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return ' style="text-align:center"'
  if (right) return ' style="text-align:right"'
  if (left) return ' style="text-align:left"'
  return ''
}

/** Small, safe Markdown renderer for chat messages (no raw HTML is accepted). */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let paragraph: string[] = []
  let list: ListItem[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`)
    paragraph = []
  }
  const flushList = (): void => {
    if (list.length === 0) return
    out.push(renderList(list))
    list = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^\s*```([a-zA-Z0-9_+-]*)\s*$/.exec(line)
    if (fence) {
      flushParagraph()
      flushList()
      const code: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
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
    // GFM table: a header row with pipes, then a delimiter row such as |---|:---:|.
    const next = lines[i + 1]
    if (line.includes('|') && next !== undefined && next.includes('-') && TABLE_DELIMITER.test(next)) {
      const header = tableCells(line)
      const aligns = tableCells(next).map(tableAlign)
      if (aligns.length === header.length) {
        flushParagraph()
        flushList()
        const row = (tag: 'th' | 'td', cells: string[]): string =>
          header.map((_, c) => `<${tag}${aligns[c] ?? ''}>${inline(cells[c] ?? '')}</${tag}>`).join('')
        const body: string[] = []
        i += 2
        while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) {
          body.push(`<tr>${row('td', tableCells(lines[i]!))}</tr>`)
          i += 1
        }
        i -= 1
        out.push(
          `<div class="md-table"><table><thead><tr>${row('th', header)}</tr></thead>` +
            `${body.length ? `<tbody>${body.join('')}</tbody>` : ''}</table></div>`,
        )
        continue
      }
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
    const item = /^(\s*)(?:([-*+])|\d+[.)])\s+(.+)$/.exec(line)
    if (item) {
      flushParagraph()
      list.push({ indent: indentOf(item[1]!), type: item[2] ? 'ul' : 'ol', text: item[3]! })
      continue
    }
    // An indented line right after a list item continues that item.
    if (list.length > 0 && /^\s+\S/.test(line)) {
      list[list.length - 1]!.text += ` ${line.trim()}`
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
