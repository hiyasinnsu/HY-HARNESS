// WP-41: model discovery per provider (the "fetch the model list" half of the
// catalog), against a local stub — no network in tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { listProviderModels } from './llm.js'

function stub(reply: (path: string) => unknown, status = 200): Promise<{ url: string; paths: string[]; close: () => Promise<void> }> {
  const paths: string[] = []
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? '')
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply(req.url ?? '')))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, paths, close: () => new Promise<void>((done) => server.close(() => done())) })
    })
  })
}

test('an OpenAI-compatible /models list is read', async () => {
  const server = await stub(() => ({ data: [{ id: 'gpt-4.1-mini' }, { id: 'o4-mini' }] }))
  try {
    const models = await listProviderModels({
      provider: 'openai-compatible',
      model: 'gpt-4.1-mini',
      baseUrl: `${server.url}/v1`,
      apiKey: 'k',
      contextWindowTokens: 1,
      maxOutputTokens: 1,
    })
    assert.deepEqual(models, ['gpt-4.1-mini', 'o4-mini'])
    assert.equal(server.paths[0], '/v1/models')
  } finally {
    await server.close()
  }
})

test('an Anthropic /v1/models list is read with its headers', async () => {
  const server = await stub(() => ({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-1' }] }))
  try {
    const models = await listProviderModels({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      baseUrl: server.url,
      apiKey: 'k',
      contextWindowTokens: 1,
      maxOutputTokens: 1,
    })
    assert.deepEqual(models, ['claude-opus-4-1', 'claude-sonnet-4-5'])
    assert.equal(server.paths[0], '/v1/models')
  } finally {
    await server.close()
  }
})

test('an Ollama /api/tags list is read', async () => {
  const server = await stub(() => ({ models: [{ name: 'qwen2.5:3b' }, { name: 'llava:7b' }] }))
  try {
    const models = await listProviderModels({
      provider: 'ollama',
      model: 'qwen2.5:3b',
      baseUrl: server.url,
      contextWindowTokens: 1,
      maxOutputTokens: 1,
    })
    assert.deepEqual(models, ['llava:7b', 'qwen2.5:3b'])
    assert.equal(server.paths[0], '/api/tags')
  } finally {
    await server.close()
  }
})

test('a failed discovery says so instead of returning nothing', async () => {
  const server = await stub(() => ({ error: 'nope' }), 500)
  try {
    await assert.rejects(
      listProviderModels({
        provider: 'openai-compatible',
        model: 'x',
        baseUrl: `${server.url}/v1`,
        apiKey: 'k',
        contextWindowTokens: 1,
        maxOutputTokens: 1,
      }),
      /could not list models|500/,
    )
  } finally {
    await server.close()
  }
})

test('the mock provider has no discovery endpoint', async () => {
  await assert.rejects(
    listProviderModels({ provider: 'mock', model: 'mock', contextWindowTokens: 1, maxOutputTokens: 1 }),
    /the mock provider has no model list/,
  )
})
