// The benchmark project: a small ES-module statistics library with one
// planted bug (formatTable pads labels on the wrong side, so a test fails).
// `node stats-fixture.mjs <dir>` writes it into an empty directory.
import fs from 'node:fs'
import path from 'node:path'

export function writeFixture(dir) {
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  w('package.json', `${JSON.stringify({ name: 'mini-stats', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`)
  w('AGENTS.md', '# Rules\n\n- Plain ES modules, no dependencies.\n- Every exported function has a test in test/.\n- Throw a TypeError for an empty array.\n')
  w('README.md', '# mini-stats\n\nSmall statistics helpers.\n\n## Functions\n\n- `sum(values)`\n- `mean(values)`\n')
  w('src/stats.js', `/** Sum of an array of numbers. */
export function sum(values) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError('values must be a non-empty array')
  return values.reduce((total, value) => total + value, 0)
}

/** Arithmetic mean. */
export function mean(values) {
  return sum(values) / values.length
}
`)
  // The planted bug: padStart instead of padEnd.
  w('src/format.js', `/** Formats a number with a fixed number of decimals. */
export function formatNumber(value, digits = 2) {
  return Number(value).toFixed(digits)
}

/** Formats a table of label/value rows as aligned text (labels left-aligned). */
export function formatTable(rows) {
  const width = Math.max(...rows.map(([label]) => String(label).length))
  return rows.map(([label, value]) => \`\${String(label).padStart(width)}  \${formatNumber(value)}\`).join('\\n')
}
`)
  w('src/index.js', "export * from './stats.js'\nexport * from './format.js'\n")
  w('test/stats.test.js', `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sum, mean } from '../src/stats.js'

test('sum adds numbers', () => {
  assert.equal(sum([1, 2, 3]), 6)
  assert.throws(() => sum([]), TypeError)
})

test('mean averages numbers', () => {
  assert.equal(mean([2, 4]), 3)
})
`)
  w('test/format.test.js', `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatNumber, formatTable } from '../src/format.js'

test('formatNumber pads decimals', () => {
  assert.equal(formatNumber(1), '1.00')
})

test('formatTable left-aligns labels', () => {
  assert.equal(formatTable([['a', 1], ['bbb', 2]]), 'a    1.00\\nbbb  2.00')
})
`)
  // Design notes the agent may consult; they make the context realistic.
  const topics = ['sum', 'mean', 'median', 'mode', 'variance', 'format', 'cli', 'errors']
  for (const [i, topic] of topics.entries()) {
    const lines = [`# Design note ${i + 1}: ${topic}`, '']
    for (let j = 0; j < 30; j++) {
      lines.push(`${j + 1}. ${topic}: accept plain arrays of finite numbers; case ${i}-${j} covers length ${j + 1}, rejects NaN and Infinity with a TypeError, leaves the input unchanged, rounding ${(j * 0.37).toFixed(2)}.`)
    }
    w(`docs/note-${String(i + 1).padStart(2, '0')}-${topic}.md`, `${lines.join('\n')}\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  writeFixture(process.argv[2])
}
