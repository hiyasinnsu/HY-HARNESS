// CP-26: a machine-readable description of the HTTP API.
//
// `API_ROUTES` is the single source of truth. This module turns it into a JSON
// Schema document (checked in at `docs/api.schema.json`) so third-party clients
// can validate requests without reading the TypeScript, and exposes the API
// version that changes when a breaking change lands.

import { API_ROUTES, type FieldSpec, type RouteContract } from './api-contract.js'

/** Bumped on a breaking change to a route or a request field. */
export const API_VERSION = 'hy-api/1'

type JsonSchema = Record<string, unknown>

/** JSON Schema for one `FieldSpec` (request fields only; responses are named types). */
export function fieldSchema(spec: FieldSpec): JsonSchema {
  const base: JsonSchema = {}
  switch (spec.type) {
    case 'string':
      base.type = 'string'
      break
    case 'number':
      base.type = 'number'
      break
    case 'boolean':
      base.type = 'boolean'
      break
    case 'object':
      base.type = 'object'
      break
    case 'array':
      base.type = 'array'
      base.items = {}
      break
    case 'images':
      // Base64 payloads with a mime type; the server enforces the size limits.
      base.type = 'array'
      base.items = {
        type: 'object',
        required: ['mimeType', 'data'],
        properties: { mimeType: { type: 'string' }, data: { type: 'string' } },
        additionalProperties: false,
      }
      break
    default: {
      const never: never = spec.type
      throw new Error(`unknown field type: ${String(never)}`)
    }
  }
  if (spec.description) base.description = spec.description
  return base
}

function routeSchema(route: RouteContract): JsonSchema {
  const schema: JsonSchema = {
    method: route.method,
    path: route.path,
    summary: route.summary,
  }
  if (route.response) schema.response = route.response
  if (route.errors?.length) schema.errors = [...route.errors]
  if (route.request) {
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    for (const [name, spec] of Object.entries(route.request)) {
      properties[name] = fieldSchema(spec)
      if (spec.required) required.push(name)
    }
    schema.request = { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
  }
  return schema
}

/** The whole document, stable for byte-for-byte comparison. */
export function buildApiSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://hy-harness.local/api.schema.json',
    title: 'HY-HARNESS HTTP API',
    version: API_VERSION,
    routes: API_ROUTES.map(routeSchema),
  }
}

/** Serialized form written by `scripts/gen-api-schema.mjs` (2-space JSON). */
export function renderApiSchema(): string {
  return `${JSON.stringify(buildApiSchema(), null, 2)}\n`
}