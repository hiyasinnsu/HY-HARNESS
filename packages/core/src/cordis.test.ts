import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CORDIS_VERSION, createHarnessContext } from './cordis.js'
import { Ledger } from './ledger.js'
import { MockProvider } from './llm.js'

test('cordis wrapper: provides services, runs plugins, and disposes effects in LIFO order', async () => {
  assert.equal(CORDIS_VERSION, '4.0.0-rc.12')
  const order: string[] = []
  const llm = new MockProvider('.')
  const ledger = new Ledger([])
  const ctx = createHarnessContext({ llm, ledger })

  assert.equal(ctx.llm, llm)
  assert.equal(ctx.require('ledger'), ledger)
  assert.equal(ctx.execRpc, undefined)
  assert.throws(() => ctx.require('execRpc'), /service "execRpc" is not registered/)

  await ctx.use(async (c, tag: string) => {
    order.push(`init:${tag}`)
    c.effect(() => {
      order.push(`setup:${tag}`)
      return () => {
        order.push(`dispose:${tag}`)
      }
    }, tag)
    return () => {
      order.push(`plugin-return:${tag}`)
    }
  }, 'p1')

  // Re-providing updates the service in place and its disposer clears it.
  const llm2 = new MockProvider('.')
  const clearLlm = ctx.provide('llm', llm2)
  assert.equal(ctx.llm, llm2)
  clearLlm()
  assert.equal(ctx.llm, undefined)

  await ctx.stop()
  await ctx.stop() // idempotent
  assert.deepEqual(order, ['init:p1', 'setup:p1', 'plugin-return:p1', 'dispose:p1'])
})
