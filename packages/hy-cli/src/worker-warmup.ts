/**
 * B4: new workers share their system prompt and tool list, so a provider can
 * serve the second worker's first request from the first one's prefix cache,
 * but only once that first request has been processed. Workers started in the
 * same instant all missed it (0-49% hits on their first request, project.md
 * 5.66). Each new worker waits for the previous new worker's first response,
 * at most `maxWaitMs`, so a slow or failed start never blocks the rest.
 */
export class WarmupChain {
  private tail: Promise<void> = Promise.resolve()
  private readonly releases = new Map<string, () => void>()

  constructor(private readonly maxWaitMs = 8_000) {}

  /** Registers `id` as the newest starter; resolves when it may send its first request. */
  hold(id: string): Promise<void> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    this.releases.set(id, release)
    let timer: NodeJS.Timeout | undefined
    const capped = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.maxWaitMs) })
    return Promise.race([previous, capped]).finally(() => clearTimeout(timer))
  }

  /** `id` got its first response (or will never send one). Idempotent. */
  release(id: string): void {
    const release = this.releases.get(id)
    if (!release) return
    this.releases.delete(id)
    release()
  }
}
