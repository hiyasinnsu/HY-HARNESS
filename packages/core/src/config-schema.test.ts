// WP-11: the generated JSON Schema stays a faithful description of the config
// the loader accepts. A tiny validator keeps this test dependency-free.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exampleUserConfig, userConfigJsonSchema } from './config-schema.js'

type Json = unknown

function typeOf(value: Json): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function validate(schema: Record<string, unknown>, value: Json, path = '$'): string[] {
  const errors: string[] = []
  const type = schema.type as string | undefined
  if (type !== undefined) {
    const actual = typeOf(value)
    const ok = type === actual || (type === 'number' && actual === 'integer')
    if (!ok) return [`${path}: expected ${type}, got ${actual}`]
  }
  const enumValues = schema.enum as unknown[] | undefined
  if (enumValues !== undefined && !enumValues.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${enumValues.join(', ')}`)
  }
  if (Array.isArray(value) && typeof schema.items === 'object' && schema.items !== null) {
    value.forEach((item, index) => {
      errors.push(...validate(schema.items as Record<string, unknown>, item, `${path}[${index}]`))
    })
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, Json>
    const required = (schema.required as string[] | undefined) ?? []
    for (const key of required) {
      if (!(key in record)) errors.push(`${path}.${key}: required`)
    }
    const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {}
    for (const [key, entry] of Object.entries(record)) {
      if (properties[key] !== undefined) {
        errors.push(...validate(properties[key], entry, `${path}.${key}`))
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: unknown property`)
      }
    }
  }
  return errors
}

test('the example config satisfies the generated schema', () => {
  assert.deepEqual(validate(userConfigJsonSchema as unknown as Record<string, unknown>, exampleUserConfig), [])
})

test('the schema rejects a bad sandbox mode and a malformed role', () => {
  const bad = {
    sandboxMode: 'yolo',
    roles: { worker: { provider: 'ollama' } },
  }
  const errors = validate(userConfigJsonSchema as unknown as Record<string, unknown>, bad)
  assert.ok(errors.some((error) => error.includes('sandboxMode')), errors.join('\n'))
  assert.ok(errors.some((error) => error.includes('roles.worker.model')), errors.join('\n'))
})

test('the schema documents every top-level key the loader reads', () => {
  const documented = Object.keys((userConfigJsonSchema as unknown as { properties: object }).properties)
  for (const key of [
    'profiles',
    'workspaceRoots',
    'roles',
    'guardian',
    'sandbox',
    'sandboxMode',
    'userPolicyPath',
    'trustedProjects',
    'mcpServers',
    'hooks',
    'notify',
    'web',
    'lsp',
    'plugins',
    'memory',
    'automation',
    'autoApprove',
    'fullAuto',
    'models',
  ]) {
    assert.ok(documented.includes(key), `missing ${key}`)
  }
})
