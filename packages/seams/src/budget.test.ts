import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, Completion, CompleteOptions, LlmProvider } from '../../core/dist/index.js'
import { Budget4D, BudgetExhaustedError, RoundAbortedError } from './budget.js'
import { Guardian } from './guardian.js'

const free = { inputPerMTokUsd: 0, outputPerMTokUsd: 0 }

class Recorder implements LlmProvider {
  readonly name = 'rec'
  readonly options: CompleteOptions[] = []
  constructor(private readonly usage: Completion['usage'] = { inputTokens: 100, outputTokens: 50 }) {}
  async complete(_m: ChatMessage[], options: CompleteOptions): Promise<Completion> {
    this.options.push(options)
    return { content: '{}', usage: this.usage }
  }
}

const msg = (n: number): ChatMessage[] => [{ role: 'user', content: 'x'.repeat(n) }]

test('a USD cap needs pricing for every role in use', () => {
  assert.throws(
    () => new Budget4D({ maxRounds: 1, maxTotalTokens: 1_000, maxCostUsd: 1, maxWallClockMs: 1_000 }, { worker: free, grader: undefined }),
    /no pricing: grader/,
  )
  assert.doesNotThrow(() => new Budget4D({ maxRounds: 1, maxTotalTokens: 1_000, maxWallClockMs: 1_000 }, { grader: undefined }))
})

test('rounds and wall-clock are enforced', async () => {
  let now = 0
  const b = new Budget4D({ maxRounds: 2, maxTotalTokens: 1e6, maxWallClockMs: 1_000 }, { worker: free }, () => now)
  assert.equal(b.startRound(), 1)
  assert.equal(b.startRound(), 2)
  assert.throws(() => b.startRound(), (e: unknown) => e instanceof BudgetExhaustedError && e.dimension === 'rounds')
  now = 1_000
  await assert.rejects(b.meter(new Recorder(), 'worker').complete(msg(10), { maxTokens: 100, temperature: 0 }), (e: unknown) =>
    e instanceof BudgetExhaustedError && e.dimension === 'wall-clock',
  )
})

test('tokens: max_tokens is clamped to what is left and usage of every role counts', async () => {
  const b = new Budget4D({ maxRounds: 1, maxTotalTokens: 400, maxWallClockMs: 60_000 }, { worker: free, grader: free })
  const worker = new Recorder()
  const grader = new Recorder()
  await b.meter(worker, 'worker').complete(msg(100), { maxTokens: 4_096, temperature: 0 })
  assert.equal(worker.options[0]!.maxTokens, 400 - 30, 'clamped to tokens left minus the input estimate')
  await b.meter(grader, 'grader').complete(msg(100), { maxTokens: 4_096, temperature: 0 })
  assert.equal(b.tokensUsed, 300)
  await assert.rejects(b.meter(worker, 'worker').complete(msg(400), { maxTokens: 10, temperature: 0 }), (e: unknown) =>
    e instanceof BudgetExhaustedError && e.dimension === 'tokens',
  )
})

test('usd: the worst-case cost clamps or refuses a call', async () => {
  const pricing = { inputPerMTokUsd: 1_000, outputPerMTokUsd: 10_000 }
  const b = new Budget4D({ maxRounds: 1, maxTotalTokens: 1e9, maxCostUsd: 1, maxWallClockMs: 60_000 }, { worker: pricing })
  const p = new Recorder({ inputTokens: 300, outputTokens: 50 })
  // 30 input tokens ≈ $0.03, so at most (1 - 0.03) / 0.01 = 97 output tokens.
  await b.meter(p, 'worker').complete(msg(100), { maxTokens: 4_096, temperature: 0 })
  assert.equal(p.options[0]!.maxTokens, 97)
  assert.equal(b.costUsd.toFixed(2), '0.80')
  await assert.rejects(b.meter(p, 'worker').complete(msg(1_000), { maxTokens: 100, temperature: 0 }), (e: unknown) =>
    e instanceof BudgetExhaustedError && e.dimension === 'usd',
  )
})

test('an aborted round stops the next call; Guardian does not swallow budget errors', async () => {
  const b = new Budget4D({ maxRounds: 1, maxTotalTokens: 1e6, maxWallClockMs: 60_000 }, { worker: free, guardian: free })
  const c = new AbortController()
  b.setRoundSignal(c.signal)
  c.abort(new Error('round timeout after 5 ms'))
  await assert.rejects(b.meter(new Recorder(), 'worker').complete(msg(1), { maxTokens: 1, temperature: 0 }), (e: unknown) =>
    e instanceof RoundAbortedError && /round timeout/.test(e.message),
  )
  b.setRoundSignal(undefined)
  const spent = new Budget4D({ maxRounds: 1, maxTotalTokens: 1, maxWallClockMs: 60_000 }, { guardian: free })
  const g = new Guardian({ provider: spent.meter(new Recorder(), 'guardian'), objective: 'o' })
  await assert.rejects(g.review({ command: 'npm test' }), BudgetExhaustedError)
})

test('B6: a request in flight is reserved, so a parallel one cannot overrun the cap', async () => {
  const budget = new Budget4D({ maxRounds: 1, maxTotalTokens: 1e9, maxWallClockMs: 60_000, maxCostUsd: 1 }, { worker: { inputPerMTokUsd: 0, outputPerMTokUsd: 1_000_000 } })
  let release!: () => void
  const slow = budget.meter({
    name: 'slow',
    complete: () => new Promise((resolve) => { release = () => resolve({ content: 'ok', usage: { inputTokens: 1, outputTokens: 0 } }) }),
  }, 'worker')
  // $1 at $1 per output token: the first request may use the whole budget.
  const first = slow.complete([{ role: 'user', content: 'a' }], { maxTokens: 1 })
  await assert.rejects(slow.complete([{ role: 'user', content: 'b' }], { maxTokens: 1 }), /could exceed it/)
  release()
  await first
  // Released and recorded at its real (zero) cost: the next request is admitted.
  const next = slow.complete([{ role: 'user', content: 'c' }], { maxTokens: 1 })
  release()
  await next
})

test('B6: tool definitions count toward the request estimate', async () => {
  const budget = new Budget4D({ maxRounds: 1, maxTotalTokens: 200, maxWallClockMs: 60_000 }, { worker: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } })
  const provider = budget.meter({ name: 'p', complete: async () => ({ content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }) }, 'worker')
  const tools = [{ name: 'big', description: 'x'.repeat(2_000), parameters: {} }]
  await assert.rejects(provider.complete([{ role: 'user', content: 'hi' }], { maxTokens: 10, tools }), /tokens/)
  await provider.complete([{ role: 'user', content: 'hi' }], { maxTokens: 10 })
})
