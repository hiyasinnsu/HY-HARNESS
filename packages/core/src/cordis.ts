// Thin typed wrapper around `cordis` (design §1, pinned at 4.0.0-rc.12).
//
// Keeps all direct `cordis` imports in one module so an upstream RC change
// touches only this file. Every subsystem registers its service with
// `ctx.provide(name, value)` and its cleanup with `ctx.effect(...)`; calling
// `ctx.stop()` runs all disposers in reverse order and stops the root fiber.
import { Context as RawCordisContext } from 'cordis'
import type { ContextManager } from './agent.js'
import type { ExecRpcClient } from './exec-rpc.js'
import type { Ledger } from './ledger.js'
import type { LlmProvider } from './llm.js'
import type { SessionLog } from './session-log.js'
import type { ToolRuntime } from './tools.js'

/** Pinned `cordis` package version (design §1 `[V:W-5]`). */
export const CORDIS_VERSION = '4.0.0-rc.12'

/**
 * The seven control-plane services named in design §1 (`ctx.execRpc`,
 * `ctx.llm`, `ctx.sessionLog`, `ctx.tools`, `ctx.spillStore`, `ctx.guardian`,
 * `ctx.ledger`). `guardian` is typed structurally so `@hy/core` does not
 * depend on `@hy/seams`.
 */
export interface HarnessServices {
  execRpc: ExecRpcClient
  llm: LlmProvider
  sessionLog: SessionLog
  tools: ToolRuntime
  spillStore: ContextManager
  guardian: { review(req: unknown): Promise<unknown> }
  ledger: Ledger
}

export type Disposer = () => void | Promise<void>
export type HarnessPlugin<C = void> = (ctx: HarnessContext, config: C) => void | Disposer | Promise<void | Disposer>

interface RawRoot {
  provide(name: string, value?: unknown): () => void
  get(name: string): unknown
  set(name: string, value: unknown): boolean
  effect(fn: () => () => void, label?: string): () => Promise<void>
  fiber: { dispose(): Promise<void> }
}

export class HarnessContext {
  private readonly raw: RawRoot
  private readonly disposers: Disposer[] = []
  private stopped = false

  constructor() {
    this.raw = new RawCordisContext() as unknown as RawRoot
  }

  /**
   * Registers a service on the underlying `cordis` context (`ctx.provide`
   * followed by `ctx.set` when re-providing) and returns a disposer.
   */
  provide<K extends keyof HarnessServices>(name: K, value: HarnessServices[K]): () => void {
    const existing = this.raw.get(name)
    if (existing !== undefined) {
      this.raw.set(name, value)
      return () => {
        this.raw.set(name, undefined)
      }
    }
    return this.raw.provide(name, value)
  }

  /** Reads a registered service, or `undefined` if not yet provided. */
  get<K extends keyof HarnessServices>(name: K): HarnessServices[K] | undefined {
    return this.raw.get(name) as HarnessServices[K] | undefined
  }

  /** Reads a registered service, throwing when missing. */
  require<K extends keyof HarnessServices>(name: K): HarnessServices[K] {
    const v = this.get(name)
    if (v === undefined) throw new Error(`service "${name}" is not registered on HarnessContext`)
    return v
  }

  get execRpc(): ExecRpcClient | undefined {
    return this.get('execRpc')
  }
  get llm(): LlmProvider | undefined {
    return this.get('llm')
  }
  get sessionLog(): SessionLog | undefined {
    return this.get('sessionLog')
  }
  get tools(): ToolRuntime | undefined {
    return this.get('tools')
  }
  get spillStore(): ContextManager | undefined {
    return this.get('spillStore')
  }
  get guardian(): HarnessServices['guardian'] | undefined {
    return this.get('guardian')
  }
  get ledger(): Ledger | undefined {
    return this.get('ledger')
  }

  /**
   * Registers a lifecycle effect on the `cordis` fiber and tracks async
   * disposers for `stop()`.
   */
  effect(setup: () => Disposer, label?: string): Disposer {
    let userDispose: Disposer | undefined
    const removeCordis = this.raw.effect(() => {
      userDispose = setup()
      return () => {}
    }, label)
    const once: Disposer = async () => {
      const fn = userDispose
      userDispose = undefined
      if (fn) await fn()
      await removeCordis()
    }
    this.disposers.push(once)
    return once
  }

  /** Runs a plugin and registers any returned disposer as an effect. */
  async use<C = void>(plugin: HarnessPlugin<C>, config: C): Promise<void> {
    const out = await plugin(this, config)
    if (typeof out === 'function') {
      this.effect(() => out, plugin.name || 'plugin')
    }
  }

  /** Disposes all registered effects in LIFO order and stops the root fiber. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const list = this.disposers.splice(0).reverse()
    for (const d of list) {
      await d()
    }
    await this.raw.fiber.dispose()
  }
}

/** Creates a `HarnessContext` pre-populated with any initial services. */
export function createHarnessContext(initial: Partial<HarnessServices> = {}): HarnessContext {
  const ctx = new HarnessContext()
  for (const [k, v] of Object.entries(initial) as Array<[keyof HarnessServices, HarnessServices[keyof HarnessServices]]>) {
    if (v !== undefined) ctx.provide(k, v)
  }
  return ctx
}
