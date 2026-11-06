import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Which build is running: written by scripts/write-build-info.mjs after `pnpm build`. */
export interface BuildInfo {
  version?: string
  /** Short commit hash the build was made from. */
  commit?: string
  /** Uncommitted changes to tracked files were present at build time. */
  dirty?: boolean
  /** ISO time of the build. */
  builtAt?: string
}

let cached: BuildInfo | undefined

/**
 * `build-info.json` at the app root (the repository root, or `resources/app`
 * in the packaged exe). Missing or unreadable means an unknown build: `{}`.
 */
export function buildInfo(): BuildInfo {
  if (cached) return cached
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'build-info.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>
    cached = {
      ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
      ...(typeof raw.commit === 'string' && /^[0-9a-f]{4,40}$/i.test(raw.commit) ? { commit: raw.commit } : {}),
      ...(typeof raw.dirty === 'boolean' ? { dirty: raw.dirty } : {}),
      ...(typeof raw.builtAt === 'string' && !Number.isNaN(Date.parse(raw.builtAt)) ? { builtAt: raw.builtAt } : {}),
    }
  } catch {
    cached = {}
  }
  return cached
}
