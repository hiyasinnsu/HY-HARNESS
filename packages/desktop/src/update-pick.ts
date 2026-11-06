// Which staged portable exe the self-update applies, kept free of Electron so
// the rules can be tested.
//
// Candidates used to be ranked by file time only. A staged build carries its
// version (the `<exe>.json` sidecar written by tag-next-artifact.mjs, or the
// `HY-HARNESS-<version>-<stamp>.exe` name), so the pick is by version first and
// a build older than the running one is refused instead of silently installed.
import fs from 'node:fs'
import path from 'node:path'
import { compareVersions } from '../../hy-cli/dist/update-feed.js'

export interface StagedInfo {
  version?: string
  commit?: string
  dirty?: boolean
  builtAt?: string
  sha256?: string
}

export interface UpdateCandidateView {
  file: string
  /** In an explicit staging folder (`next`, `update`, downloads). */
  staged: boolean
  mtime: number
  /** Byte-identical to the running exe. */
  same: boolean
  info: StagedInfo
}

export type PickResult =
  | { ok: true; pick: UpdateCandidateView }
  | { ok: false; reason: 'none' | 'same' | 'downgrade'; newest?: UpdateCandidateView }

const VERSION_IN_NAME = /^HY-HARNESS-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-\d{8}-\d{4}(?:-\d+)?\.exe$/i

/** The sidecar `<exe>.json`, else the version in the file name, else nothing. */
export function readStagedInfo(file: string): StagedInfo {
  try {
    const raw = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>
    const out: StagedInfo = {}
    if (typeof raw.version === 'string') out.version = raw.version
    if (typeof raw.commit === 'string') out.commit = raw.commit
    if (typeof raw.dirty === 'boolean') out.dirty = raw.dirty
    if (typeof raw.builtAt === 'string') out.builtAt = raw.builtAt
    if (typeof raw.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(raw.sha256)) out.sha256 = raw.sha256.toLowerCase()
    if (out.version) return out
  } catch {
    // No or unreadable sidecar.
  }
  const match = VERSION_IN_NAME.exec(path.basename(file))
  return match?.[1] ? { version: match[1] } : {}
}

function safeCompare(a: string, b: string): number | undefined {
  try {
    return compareVersions(a, b)
  } catch {
    return undefined
  }
}

/**
 * Rules, for a running `currentVersion` whose exe was written at `currentMtime`:
 * - a byte-identical build is never applied;
 * - a higher version is applied;
 * - the same version is applied only when it is a staged build newer than the
 *   running exe (a local rebuild without a version bump);
 * - a lower version is refused (reported as `downgrade`);
 * - a build without a known version falls back to the old rule (staged, or
 *   newer than the running exe).
 * Among the eligible, the highest version wins, then the newest file.
 */
export function pickUpdate(currentVersion: string, currentMtime: number, candidates: readonly UpdateCandidateView[]): PickResult {
  const eligible: UpdateCandidateView[] = []
  let downgrade: UpdateCandidateView | undefined
  let sawSame = false
  for (const candidate of candidates) {
    if (candidate.same) {
      sawSame = true
      continue
    }
    const order = candidate.info.version ? safeCompare(candidate.info.version, currentVersion) : undefined
    if (order === undefined) {
      if (candidate.staged || candidate.mtime > currentMtime) eligible.push(candidate)
    } else if (order > 0) {
      eligible.push(candidate)
    } else if (order === 0) {
      if (candidate.staged && candidate.mtime > currentMtime) eligible.push(candidate)
    } else if (!downgrade || candidate.mtime > downgrade.mtime) {
      downgrade = candidate
    }
  }
  if (eligible.length > 0) {
    const sorted = [...eligible].sort((a, b) => {
      const byVersion = a.info.version && b.info.version ? (safeCompare(b.info.version, a.info.version) ?? 0) : 0
      return byVersion !== 0 ? byVersion : b.mtime - a.mtime
    })
    return { ok: true, pick: sorted[0]! }
  }
  if (downgrade) return { ok: false, reason: 'downgrade', newest: downgrade }
  return { ok: false, reason: sawSame ? 'same' : 'none' }
}
