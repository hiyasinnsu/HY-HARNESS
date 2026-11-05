// CP-08: DPAPI-backed secrets.
//
// A role's `apiKey` (or `apiKeySecret` -> `secrets.<name>`) may hold a
// `dpapi:<base64>` reference produced by `hy secret set`. Decryption happens
// through the `hy-secret` helper (crates/hy-sandbox-windows/src/bin), which
// binds the ciphertext to the current Windows user. Nothing here ever writes a
// plaintext key to disk or logs it.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Prefix that marks a value as a DPAPI reference. */
export const SECRET_PREFIX = 'dpapi:'

export interface SecretCodec {
  protect(value: string): string
  unprotect(reference: string): string
}

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return path.resolve(dir)
    dir = up
  }
}

/** Locates `hy-secret.exe`: env override, packaged resources, then cargo target. */
export function resolveSecretBin(explicit?: string): string | undefined {
  const candidates: string[] = []
  if (explicit) candidates.push(path.resolve(explicit))
  if (process.env.HY_SECRET_BIN) candidates.push(path.resolve(process.env.HY_SECRET_BIN))
  const root = repoRoot()
  candidates.push(path.join(root, 'target', 'debug', 'hy-secret.exe'))
  candidates.push(path.join(root, 'target', 'release', 'hy-secret.exe'))
  // Packaged app: next to hy-exec-server.exe under resources/ (Electron only).
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resources) candidates.push(path.join(resources, 'hy-secret.exe'))
  candidates.push(path.join(path.dirname(process.execPath), 'hy-secret.exe'))
  return candidates.find((candidate) => fs.existsSync(candidate))
}

function runSecretBin(bin: string, mode: 'protect' | 'unprotect', input: string): string {
  const result = spawnSync(bin, [mode], {
    input,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  })
  if (result.error) {
    throw new Error(
      `hy-secret ${mode} could not start: ${result.error.message} (build it with: cargo build -p hy-sandbox-windows --bin hy-secret)`,
    )
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || `exit ${result.status}`
    throw new Error(`hy-secret ${mode} failed: ${detail}`)
  }
  return (result.stdout ?? '').trim()
}

/** The real DPAPI codec (spawns `hy-secret`). */
export const defaultSecretCodec: SecretCodec = {
  protect(value: string): string {
    const bin = resolveSecretBin()
    if (!bin) throw new Error('hy-secret.exe was not found (build it: cargo build -p hy-sandbox-windows --bin hy-secret)')
    return runSecretBin(bin, 'protect', value)
  },
  unprotect(reference: string): string {
    const bin = resolveSecretBin()
    if (!bin) throw new Error('hy-secret.exe was not found (build it: cargo build -p hy-sandbox-windows --bin hy-secret)')
    return runSecretBin(bin, 'unprotect', reference)
  },
}

/** True for a `dpapi:` reference (a plaintext key is returned unchanged). */
export function isSecretRef(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX)
}

/**
 * Returns the plaintext value (unchanged when it is not a reference). The
 * ciphertext is never included in the error message.
 */
export function resolveSecretRef(
  value: string,
  codec: SecretCodec = defaultSecretCodec,
  label = 'secret',
): string {
  if (!isSecretRef(value)) return value
  try {
    return codec.unprotect(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${label}: cannot decrypt the stored ${SECRET_PREFIX} reference (${message})`)
  }
}

/** Encrypts a new value for `hy secret set`. */
export function protectSecret(value: string, codec: SecretCodec = defaultSecretCodec): string {
  if (!value.trim()) throw new Error('the secret is empty')
  return codec.protect(value)
}