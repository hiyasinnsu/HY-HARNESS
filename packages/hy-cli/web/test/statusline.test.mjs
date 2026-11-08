// CP-36: the statusline shows the picked items, in order, skipping empty ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderStatusline, statusText } from '../dist/statusline.js'

const data = {
  provider: 'ollama',
  model: 'qwen2.5:3b',
  sandbox: 'workspace-write',
  inputTokens: 12000,
  outputTokens: 340,
  cacheHitTokens: 3000,
  cacheMissTokens: 9000,
  lastInputTokens: 6553,
  lastOutputTokens: 120,
  contextWindowTokens: 32768,
  turns: 1,
}

test('CP-36: item texts', () => {
  assert.equal(statusText('model', data), 'ollama/qwen2.5:3b')
  assert.equal(statusText('tokens', data), 'in 12,000 / out 340')
  assert.equal(statusText('cache', data), 'cache 3,000 (25.00%)')
  assert.equal(statusText('cache', { ...data, cacheUsageComplete: false }), 'cache —')
  assert.equal(statusText('last', data), 'last 6,553/120')
  assert.equal(statusText('context', data), 'ctx 20%')
  assert.equal(statusText('turns', data), '1 turn')
  assert.equal(statusText('context', { ...data, lastInputTokens: undefined }), '')
})

test('CP-36: order follows the preference and empty items disappear', () => {
  const html = renderStatusline(['turns', 'model', 'last'], { ...data, lastInputTokens: undefined })
  assert.equal(
    html,
    '<span class="status-item status-turns">1 turn</span><span class="status-sep">·</span><span class="status-item status-model">ollama/qwen2.5:3b</span>',
  )
  assert.equal(renderStatusline([], data), '')
  assert.match(renderStatusline(['model'], { model: '<x>' }), /&lt;x&gt;/)
})
