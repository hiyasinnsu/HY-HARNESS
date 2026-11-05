// CP-36: code highlighting is escaped and marks the main token kinds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { highlightCode, languageFamily } from '../dist/highlight.js'

test('CP-36: languages map to families', () => {
  assert.equal(languageFamily('TS'), 'c')
  assert.equal(languageFamily('python'), 'python')
  assert.equal(languageFamily('powershell'), 'shell')
  assert.equal(languageFamily('brainfuck'), 'none')
  assert.equal(languageFamily(undefined), 'none')
})

test('CP-36: keywords, strings, numbers and comments; everything escaped', () => {
  const html = highlightCode('const a = "<b>" // note & more\nreturn 42', 'ts')
  assert.match(html, /<span class="tok-kw">const<\/span>/)
  assert.match(html, /<span class="tok-str">&quot;&lt;b&gt;&quot;<\/span>/)
  assert.match(html, /<span class="tok-com">\/\/ note &amp; more<\/span>/)
  assert.match(html, /<span class="tok-num">42<\/span>/)
  assert.doesNotMatch(html.replace(/<\/?span[^>]*>/g, ''), /<b>/)
  // Identifiers that contain a keyword are not split.
  assert.doesNotMatch(highlightCode('constant', 'js'), /tok-kw/)
})

test('CP-36: python, json, shell and diff', () => {
  assert.match(highlightCode('def f():  # hi', 'py'), /<span class="tok-kw">def<\/span>[\s\S]*<span class="tok-com"># hi<\/span>/)
  assert.match(
    highlightCode('{"a": 1, "b": true}', 'json'),
    /<span class="tok-key">&quot;a&quot;<\/span>[\s\S]*<span class="tok-num">1<\/span>[\s\S]*<span class="tok-kw">true<\/span>/,
  )
  assert.match(highlightCode('echo $HOME', 'bash'), /<span class="tok-kw">echo<\/span> <span class="tok-var">\$HOME<\/span>/)
  assert.equal(highlightCode('+a\n-b\n c', 'diff'), '<span class="tok-add">+a</span>\n<span class="tok-del">-b</span>\n c')
  assert.equal(highlightCode('<x> & y', 'unknown'), '&lt;x&gt; &amp; y')
})
