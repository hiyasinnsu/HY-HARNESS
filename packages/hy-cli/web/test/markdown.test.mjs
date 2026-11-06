import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../dist/markdown.js'

// Runs against the web build (`npx tsc -p packages/hy-cli/tsconfig.web.json`).

test('GFM tables render with header, body, alignment and inline formatting', () => {
  const html = renderMarkdown(['## 直したもの', '| 項目 | 結果 |', '|---|:---:|', '| Stage 1.5 | `error` のまま |', '| RAM | **4,501.2 MiB** |'].join('\n'))
  assert.match(html, /<h2>直したもの<\/h2>/)
  assert.match(html, /<thead><tr><th>項目<\/th><th style="text-align:center">結果<\/th><\/tr><\/thead>/)
  assert.match(html, /<td>Stage 1\.5<\/td><td style="text-align:center"><code>error<\/code> のまま<\/td>/)
  assert.match(html, /<strong>4,501\.2 MiB<\/strong>/)
  assert.doesNotMatch(html, /\|---/)
})

test('table cells keep pipes inside code or escaped, and rows stop at a blank line', () => {
  const html = renderMarkdown('a | b\n--- | ---\n`x|y` | 1 \\| 2\n\nafter')
  assert.match(html, /<td><code>x\|y<\/code><\/td><td>1 \| 2<\/td>/)
  assert.match(html, /<\/table><\/div>\n<p>after<\/p>/)
  assert.doesNotMatch(renderMarkdown('a | b\nplain text'), /<table/, 'no delimiter row, no table')
  assert.doesNotMatch(renderMarkdown('a | b | c\n|---|---|'), /<table/, 'column count must match')
})

test('indented list items nest, and continuation lines join their item', () => {
  const html = renderMarkdown('- one\n  - one.a\n    1. deep\n- two\n  still two\n1. first')
  assert.equal(
    html,
    '<ul><li>one<ul><li>one.a<ol><li>deep</li></ol></li></ul></li><li>two still two</li></ul><ol><li>first</li></ol>',
  )
})

test('raw HTML stays escaped in tables and lists', () => {
  const html = renderMarkdown('| <b>x</b> |\n|---|\n| <img src=x> |\n\n- <script>')
  assert.doesNotMatch(html, /<b>|<img|<script>/)
})
