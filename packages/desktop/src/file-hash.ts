import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

async function fingerprint(file: string): Promise<string> {
  const s = await fs.promises.stat(file, { bigint: true })
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
}

/** UI checks may reuse an unchanged file; applying an update always reads it afresh. */
export class FileHashCache {
  private readonly entries = new Map<string, { fingerprint: string; hash: Promise<string> }>()

  async hash(file: string, fresh = false): Promise<string> {
    const key = path.resolve(file)
    const before = await fingerprint(key)
    const cached = this.entries.get(key)
    if (!fresh && cached?.fingerprint === before) return cached.hash
    const hash = (async () => {
      const digest = createHash('sha256')
      // Small asynchronous reads yield between chunks instead of freezing Electron.
      for await (const chunk of fs.createReadStream(key, { highWaterMark: 256 * 1024 })) digest.update(chunk)
      if (await fingerprint(key) !== before) throw new Error(`file changed while hashing: ${key}`)
      return digest.digest('hex')
    })()
    this.entries.set(key, { fingerprint: before, hash })
    if (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value!)
    try {
      return await hash
    } catch (error) {
      if (this.entries.get(key)?.hash === hash) this.entries.delete(key)
      throw error
    }
  }
}
