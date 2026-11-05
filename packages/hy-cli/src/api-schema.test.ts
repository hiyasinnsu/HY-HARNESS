import { test } from 'node:test'
import assert from 'node:assert/strict'
import { API_ROUTES } from './api-contract.js'
import { API_VERSION, buildApiSchema, fieldSchema, renderApiSchema } from './api-schema.js'

test('CP-26: the API schema covers every route exactly once', () => {
  const schema = buildApiSchema()
  const routes = schema.routes as Array<{ method: string; path: string; summary: string }>
  assert.equal(routes.length, API_ROUTES.length)
  const keys = routes.map((route) => `${route.method} ${route.path}`)
  assert.equal(new Set(keys).size, keys.length, 'no duplicate method+path')
  for (const route of routes) assert.ok(route.summary.length > 0, `${route.path} has a summary`)
  assert.match(API_VERSION, /^hy-api\/\d+$/)
  assert.equal(schema.version, API_VERSION)
})

test('CP-26: request fields become JSON Schema, including images', () => {
  const schema = buildApiSchema()
  const withBody = (schema.routes as Array<{ method: string; path: string; request?: { properties: Record<string, unknown>; required?: string[] } }>).find(
    (route) => route.request !== undefined,
  )
  assert.ok(withBody, 'at least one route takes a body')
  assert.equal(withBody!.request!.properties !== undefined, true)
  assert.deepEqual(fieldSchema({ type: 'string', required: true }), { type: 'string' })
  assert.deepEqual(fieldSchema({ type: 'images' }).items, {
    type: 'object',
    required: ['mimeType', 'data'],
    properties: { mimeType: { type: 'string' }, data: { type: 'string' } },
    additionalProperties: false,
  })
})

test('CP-26: the rendered document is stable JSON', () => {
  const text = renderApiSchema()
  assert.ok(text.endsWith('\n'))
  assert.equal(JSON.stringify(JSON.parse(text), null, 2) + '\n', text)
})