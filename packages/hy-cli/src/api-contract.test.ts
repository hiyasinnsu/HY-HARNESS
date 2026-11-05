import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_ROUTES, matchContract, pathMatches, validateRequest } from './api-contract.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const webServer = fs.readFileSync(path.resolve(here, '..', 'src', 'web-server.ts'), 'utf8')

/** Literal route pairs as the server matches them. */
function literalRoutes(): string[] {
  const out: string[] = []
  for (const line of webServer.split('\n')) {
    const top = /pathname === '([^']+)' && method === '([A-Z]+)'/.exec(line)
    if (top) out.push(`${top[2]} ${top[1]}`)
    const sub = /sub === '([^']*)' && method === '([A-Z]+)'/.exec(line)
    if (sub) out.push(`${sub[2]} /api/sessions/:id${sub[1] === '' ? '' : `/${sub[1]}`}`)
  }
  return [...new Set(out)].sort()
}

test('every literal route in web-server.ts is declared in the contract', () => {
  const routes = literalRoutes()
  assert.ok(routes.length > 40, `expected the whole API surface, got ${routes.length}`)
  const missing: string[] = []
  for (const route of routes) {
    const [method, pathname] = route.split(' ')
    if (!matchContract(method!, pathname!)) missing.push(route)
  }
  assert.deepEqual(missing, [], `undeclared routes: ${missing.join(', ')}`)
})

test('every declared route without parameters exists in the server', () => {
  const routes = new Set(literalRoutes())
  const stale = API_ROUTES.filter((route) => !route.path.includes(':') && !routes.has(`${route.method} ${route.path}`))
  assert.deepEqual(stale.map((route) => `${route.method} ${route.path}`), [], 'declared routes the server does not answer')
})

test('path matching handles parameters', () => {
  assert.equal(pathMatches('/api/sessions/:id/turn', '/api/sessions/run-1/turn'), true)
  assert.equal(pathMatches('/api/sessions/:id/turn', '/api/sessions/run-1/turns'), false)
  assert.equal(pathMatches('/api/sessions', '/api/sessions/'), true)
  assert.equal(pathMatches('/api/sessions/:id', '/api/sessions'), false)
  assert.equal(matchContract('POST', '/api/sessions/abc/agents/sub1/message')?.path, '/api/sessions/:id/agents/:agent/message')
  assert.equal(matchContract('GET', '/api/nope'), undefined)
})

test('a wrong body type is a 400 problem, a missing one is left to the route', () => {
  const turn = matchContract('POST', '/api/sessions/abc/turn')
  assert.ok(turn)
  // Missing message: the route answers with its own message.
  assert.deepEqual(validateRequest(turn!, {}), [])
  assert.deepEqual(validateRequest(turn!, { message: 'hi', images: [] }), [])
  assert.deepEqual(validateRequest(turn!, { message: 42 }), ['message must be a string'])
  assert.deepEqual(validateRequest(turn!, { message: 'hi', images: 'nope' }), ['images must be an array of images'])
  assert.deepEqual(validateRequest(turn!, { message: 'hi', queue: 'yes' }), ['queue must be a boolean'])
  // A body that is not an object at all.
  const settings = matchContract('PUT', '/api/settings')
  assert.ok(settings)
  assert.deepEqual(validateRequest(settings!, []), ['request body must be a JSON object'])
  assert.deepEqual(validateRequest(settings!, { roles: {} }), [])
  assert.deepEqual(validateRequest(settings!, { roles: [] }), ['roles must be an object'])
})

test('the contract is coherent', () => {
  const seen = new Set<string>()
  for (const route of API_ROUTES) {
    const key = `${route.method} ${route.path}`
    assert.equal(seen.has(key), false, `duplicate route ${key}`)
    seen.add(key)
    assert.ok(route.summary.length > 0, `summary for ${key}`)
    assert.ok(route.path.startsWith('/api/'), `api path for ${key}`)
    for (const [field, spec] of Object.entries(route.request ?? {})) {
      assert.ok(['string', 'number', 'boolean', 'object', 'array', 'images'].includes(spec.type), `${key}.${field}`)
    }
  }
})
