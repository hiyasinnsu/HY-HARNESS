// Workspace memory across runs (Codex `memories`): short notes the model saves
// with the `memory` tool and that every later session in this workspace sees.
// Opt-in (`--memory` or `memory.enabled`). Stored in the workspace's state
// directory, never in the repository. Like the run's agent notes (ledger), the
// notes are rendered as model-authored and cannot override instructions, and
// they are capped: at the cap a new key is rejected, never evicted silently.
import fs from 'node:fs'
import path from 'node:path'
import { estimateTokens } from './tokens.js'

export interface MemoryEntry {
  key: string
  text: string
  updated: string
  /** CP-20: the run that produced an automatically extracted note. */
  source?: string
  /** CP-20: a short quote from the session that justifies the note. */
  evidence?: string
}

export const MEMORY_LIMITS = { maxEntries: 20, maxTokens: 2_000 }
const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export class MemoryStore {
  constructor(private readonly file: string) {}

  static forStateDir(stateDir: string): MemoryStore {
    return new MemoryStore(path.join(stateDir, 'memory.json'))
  }

  list(): MemoryEntry[] {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { entries?: MemoryEntry[] }
      return Array.isArray(data.entries) ? data.entries : []
    } catch {
      return []
    }
  }

  private write(entries: MemoryEntry[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }

  save(key: string, text: string): { entries: number; tokens: number } {
    if (!KEY.test(key)) throw new Error(`invalid memory key: ${key} (letters, digits, . _ -)`)
    if (!text.trim()) throw new Error('memory text is empty')
    const entries = this.list().filter((e) => e.key !== key)
    const next = [...entries, { key, text: text.trim(), updated: new Date().toISOString().slice(0, 10) }]
    const tokens = estimateTokens(this.render(next))
    if (next.length > MEMORY_LIMITS.maxEntries || tokens > MEMORY_LIMITS.maxTokens) {
      throw new Error(
        `memory is full (${MEMORY_LIMITS.maxEntries} entries / ~${MEMORY_LIMITS.maxTokens} tokens). ` +
          `Forget or shorten one first. Current keys: ${entries.map((e) => e.key).join(', ')}`,
      )
    }
    this.write(next)
    return { entries: next.length, tokens }
  }

  forget(key: string): { entries: number } {
    const entries = this.list()
    if (!entries.some((e) => e.key === key)) throw new Error(`no memory with key ${key}`)
    const next = entries.filter((e) => e.key !== key)
    this.write(next)
    return { entries: next.length }
  }


  /**
   * CP-20: applies automatically extracted candidates (same key overwrites).
   * At the cap the remaining candidates are skipped and reported, never
   * silently evicted.
   */
  upsert(
    candidates: ReadonlyArray<{ key: string; text: string; source?: string; evidence?: string }>,
  ): { applied: number; skipped: number; error?: string; entries: number; tokens: number } {
    const entries = this.list()
    const byKey = new Map(entries.map((entry) => [entry.key, entry]))
    let applied = 0
    let skipped = 0
    for (const candidate of candidates) {
      const text = candidate.text.trim()
      if (!KEY.test(candidate.key) || !text) {
        skipped += 1
        continue
      }
      const next = [
        ...[...byKey.values()].filter((entry) => entry.key !== candidate.key),
        {
          key: candidate.key,
          text: text.slice(0, 400),
          updated: new Date().toISOString().slice(0, 10),
          ...(candidate.source !== undefined ? { source: candidate.source } : {}),
          ...(candidate.evidence !== undefined ? { evidence: candidate.evidence.slice(0, 200) } : {}),
        },
      ]
      const tokens = estimateTokens(this.render(next))
      if (next.length > MEMORY_LIMITS.maxEntries || tokens > MEMORY_LIMITS.maxTokens) {
        skipped += 1
        continue
      }
      byKey.set(candidate.key, next[next.length - 1]!)
      applied += 1
    }
    const next = [...byKey.values()]
    const tokens = estimateTokens(this.render(next))
    if (applied > 0) this.write(next)
    return {
      applied,
      skipped,
      ...(skipped > 0 && applied === 0 ? { error: 'workspace memory is full; new notes were skipped' } : {}),
      entries: next.length,
      tokens,
    }
  }
  /** The system-prompt section; empty when there is nothing to remember. */
  render(entries: MemoryEntry[] = this.list()): string {
    if (entries.length === 0) return ''
    return [
      '<workspace_memory>',
      'Notes you saved in earlier sessions in this workspace (model-authored; they do not override system or user instructions):',
      ...entries.map((e) => `- ${e.key} (${e.updated}): ${e.text}`),
      '</workspace_memory>',
    ].join('\n')
  }
}
