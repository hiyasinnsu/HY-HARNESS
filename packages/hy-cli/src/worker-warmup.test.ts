import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WarmupChain } from './worker-warmup.js'

test('B4: each new worker starts after the previous one\'s first response, or after the cap', async () => {
  const chain = new WarmupChain(200)
  const order: string[] = []
  const a = chain.hold('a').then(() => order.push('a'))
  const b = chain.hold('b').then(() => order.push('b'))
  const c = chain.hold('c').then(() => order.push('c'))
  await a
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(order, ['a'], 'b waits for a')
  chain.release('a')
  await b
  assert.deepEqual(order, ['a', 'b'])
  // b never answers: c starts after the cap anyway.
  const started = Date.now()
  await c
  assert.ok(Date.now() - started >= 150)
  chain.release('a')
  chain.release('missing')
})
