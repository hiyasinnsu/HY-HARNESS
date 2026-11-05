import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_ERRORS, PROTOCOL_METHODS } from './protocol-methods.js'
import { ProtocolHost, THREAD_BUSY } from './protocol-host.js'
import { UNAUTHORIZED } from './protocol-transport.js'

const here = path.dirname(fileURLToPath(import.meta.url))

test('CP-30: the host answers exactly the documented requests', () => {
  const host = new ProtocolHost({
    config: { stateDir: path.join(here, 'no-state'), role: { provider: 'mock', model: 'mock' } } as never,
    openClient: () => Promise.reject(new Error('not used')),
  })
  const served = Object.keys(host.methods({ send: () => undefined })).sort()
  const documented = PROTOCOL_METHODS.filter((m) => m.kind === 'request').map((m) => m.method).sort()
  assert.deepEqual(served, documented)
  assert.equal(PROTOCOL_ERRORS.threadBusy, THREAD_BUSY)
  assert.equal(PROTOCOL_ERRORS.unauthorized, UNAUTHORIZED)
})

test('CP-30: the TypeScript SDK has a call for every request', () => {
  const sdk = fs.readFileSync(path.join(here, '..', '..', 'sdk', 'src', 'protocol-client.ts'), 'utf8')
  for (const m of PROTOCOL_METHODS.filter((x) => x.kind === 'request')) {
    assert.ok(m.sdk, `${m.method} names its SDK call`)
    assert.ok(sdk.includes(`'${m.method}'`), `the SDK sends ${m.method}`)
    assert.match(sdk, new RegExp(`\\b${m.sdk}\\b`), `the SDK exposes ${m.sdk}`)
  }
})

test('CP-30: the Python client covers the same requests', () => {
  const py = fs.readFileSync(path.join(here, '..', '..', '..', 'python', 'hy_harness', '__init__.py'), 'utf8')
  for (const m of PROTOCOL_METHODS.filter((x) => x.kind === 'request')) {
    assert.ok(py.includes(`"${m.method}"`), `python sends ${m.method}`)
  }
})
