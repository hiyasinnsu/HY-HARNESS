// Phase 5 exit (design Goal 2): tool + SDK overhead ≤ 12,000 tokens per request
// (was 1,200; raised tenfold on 2026-11-06 at the user's request — the old
// budget left ~5 tokens of headroom and failed on run-to-run noise),
// measured with the provider's reported usage. Each available provider is
// measured as (prompt tokens with the tool section) − (without it). A random
// nonce at the very start of each prompt keeps a provider's prefix cache from
// shrinking the second count. Providers that are not reachable are skipped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

const core = await import(new URL('../../packages/core/dist/index.js', import.meta.url).href)
const { createProvider, renderToolPrompt } = core

const BUDGET = 12_000
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
const MODEL = process.env.HY_OVERHEAD_MODEL ?? 'qwen2.5:3b'

async function ollamaHasModel() {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2_000) })
    const tags = await r.json()
    return tags.models?.some((m) => m.name === MODEL) ?? false
  } catch {
    return false
  }
}

async function promptTokens(provider, toolSection) {
  const nonce = randomBytes(8).toString('hex')
  const system = `Session ${nonce}.\nYou are a coding agent.\n${toolSection}\nReply with one JSON object.`
  const r = await provider.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: 'Reply with {"final":"ok"}.' },
    ],
    { maxTokens: 1, temperature: 0 },
  )
  return r.usage.inputTokens
}

test(`tool + SDK overhead stays within ${BUDGET} tokens (Ollama ${MODEL})`, async (t) => {
  if (!(await ollamaHasModel())) return t.skip(`Ollama with ${MODEL} is not available`)
  const provider = createProvider(
    { provider: 'ollama', model: MODEL, baseUrl: OLLAMA, contextWindowTokens: 32_768, maxOutputTokens: 1 },
    process.cwd(),
  )
  const base = await promptTokens(provider, '')
  // What hy run / hy chat send by default: delegate on; skills and MCP only when configured.
  const features = new Set(['delegate'])
  const wire = (await promptTokens(provider, renderToolPrompt(false, undefined, false, features))) - base
  const ptc = (await promptTokens(provider, renderToolPrompt(true, undefined, false, features))) - base
  t.diagnostic(`overhead: wire tools ${wire} tokens, wire + run_code SDK ${ptc} tokens (budget ${BUDGET})`)
  assert.ok(wire > 0 && ptc > wire, `implausible counts: base=${base} wire=${wire} ptc=${ptc}`)
  assert.ok(ptc <= BUDGET, `tool + SDK overhead ${ptc} tokens exceeds ${BUDGET}`)
})
