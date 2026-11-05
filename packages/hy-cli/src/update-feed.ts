/**
 * WP-53: the release feed and its Ed25519 signature check.
 *
 * A feed is JSON published over HTTPS (or read from a file for air-gapped
 * installs). Every release carries a signature over a canonical, line-based
 * payload, so the signed bytes never depend on JSON key order or whitespace:
 *
 *     hy-release/v1
 *     <version>
 *     <sha256 lowercase hex>
 *     <url>
 *     <channel or empty>
 *     <mandatory: true|false>
 *
 * Nothing here downloads by itself unless asked: `hy update` never runs on its
 * own, and the web server only answers `/api/update` for an explicit request.
 */
import { createHash, createPublicKey, sign as signBytes, verify as verifyBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const FEED_SCHEMA = 1
export const SIGNATURE_PREFIX = 'hy-release/v1'
export const DEFAULT_CHANNEL = 'stable'
/** An installer is a few hundred MiB at most; anything larger is not ours. */
export const MAX_RELEASE_BYTES = 512 * 1024 * 1024

export interface ReleaseEntry {
  version: string
  url: string
  /** The lowercase hex SHA-256 of the file at `url`. */
  sha256: string
  size?: number
  /** Defaults to the feed's channel. */
  channel?: string
  publishedAt?: string
  notes?: string
  /** A mandatory release must be installed before the app is usable again. */
  mandatory?: boolean
  /** Base64 Ed25519 signature over `canonicalReleasePayload`. */
  signature: string
}

export interface ReleaseFeed {
  schema: number
  channel?: string
  releases: ReleaseEntry[]
}

/** What a fetch-like function has to provide (the global `fetch` fits). */
export interface FetchLike {
  (url: string): Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>
}

export class UpdateFeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdateFeedError'
  }
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

/** The exact bytes that are signed for one release. */
export function canonicalReleasePayload(
  entry: Pick<ReleaseEntry, 'version' | 'url' | 'sha256'> & { channel?: string; mandatory?: boolean },
): string {
  return [
    SIGNATURE_PREFIX,
    entry.version,
    entry.sha256.trim().toLowerCase(),
    entry.url,
    entry.channel ?? '',
    entry.mandatory === true ? 'true' : 'false',
  ].join('\n')
}

/** `hy update keygen` produces these; `HY_UPDATE_PUBLIC_KEY` may name one. */
export function readPublicKey(source: string): string {
  let text = source
  if (!source.includes('BEGIN PUBLIC KEY')) {
    try {
      text = fs.readFileSync(path.resolve(source), 'utf8')
    } catch (error) {
      throw new UpdateFeedError(
        `could not read the public key ${source}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  try {
    const key = createPublicKey(text)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`it is ${key.asymmetricKeyType ?? 'not an asymmetric key'}`)
  } catch (error) {
    throw new UpdateFeedError(
      `not an Ed25519 public key: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return text
}

/** A short, stable fingerprint so a user can compare keys out of band. */
export function publicKeyFingerprint(publicKey: string): string {
  const der = createPublicKey(publicKey).export({ type: 'spki', format: 'der' })
  const hex = createHash('sha256').update(der).digest('hex')
  return hex.match(/.{1,4}/g)!.slice(0, 8).join(':')
}

/** Signs one release entry (used by tests and by release tooling). */
export function signRelease(
  entry: Pick<ReleaseEntry, 'version' | 'url' | 'sha256'> & { channel?: string; mandatory?: boolean },
  privateKey: string,
): string {
  return signBytes(null, Buffer.from(canonicalReleasePayload(entry), 'utf8'), privateKey).toString('base64')
}

export function verifyReleaseSignature(entry: ReleaseEntry, publicKey: string): boolean {
  try {
    return verifyBytes(
      null,
      Buffer.from(canonicalReleasePayload(entry), 'utf8'),
      createPublicKey(publicKey),
      Buffer.from(entry.signature, 'base64'),
    )
  } catch {
    return false
  }
}

function asRelease(raw: unknown, index: number): ReleaseEntry {
  const where = `releases[${index}]`
  if (!raw || typeof raw !== 'object') throw new UpdateFeedError(`${where} must be an object`)
  const entry = raw as Record<string, unknown>
  const version = typeof entry.version === 'string' ? entry.version.trim() : ''
  if (!VERSION_PATTERN.test(version)) throw new UpdateFeedError(`${where}.version must look like 1.2.3`)
  const url = typeof entry.url === 'string' ? entry.url.trim() : ''
  if (!url) throw new UpdateFeedError(`${where}.url is required`)
  const sha256 = typeof entry.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : ''
  if (!SHA256_PATTERN.test(sha256)) throw new UpdateFeedError(`${where}.sha256 must be 64 lowercase hex characters`)
  const signature = typeof entry.signature === 'string' ? entry.signature.trim() : ''
  if (!signature) throw new UpdateFeedError(`${where}.signature is required`)
  if (entry.size !== undefined && (typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size <= 0)) {
    throw new UpdateFeedError(`${where}.size must be a positive number`)
  }
  // The channel is *not* inherited from the feed: the signed payload carries
  // the entry's own channel, so a feed cannot change what a publisher signed.
  const channel = typeof entry.channel === 'string' && entry.channel ? entry.channel : undefined
  return {
    version,
    url,
    sha256,
    signature,
    ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
    ...(channel ? { channel } : {}),
    ...(typeof entry.publishedAt === 'string' ? { publishedAt: entry.publishedAt } : {}),
    ...(typeof entry.notes === 'string' ? { notes: entry.notes } : {}),
    ...(entry.mandatory === true ? { mandatory: true } : {}),
  }
}

/**
 * Parses and verifies a feed. A feed with any bad release is rejected as a
 * whole: a partially signed feed is a feed that should not be trusted.
 */
export function parseReleaseFeed(raw: string | unknown, publicKey: string): ReleaseFeed {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      // A feed written by a Windows editor may start with a BOM.
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    } catch (error) {
      throw new UpdateFeedError(`the release feed is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UpdateFeedError('the release feed must be a JSON object')
  }
  const feed = parsed as Record<string, unknown>
  const schema = feed.schema === undefined ? FEED_SCHEMA : feed.schema
  if (schema !== FEED_SCHEMA) throw new UpdateFeedError(`unsupported feed schema ${JSON.stringify(schema)}; expected ${FEED_SCHEMA}`)
  const channel = typeof feed.channel === 'string' && feed.channel ? feed.channel : undefined
  if (!Array.isArray(feed.releases)) throw new UpdateFeedError('releases must be an array')
  const releases = feed.releases.map((entry, index) => asRelease(entry, index))
  const seen = new Set<string>()
  for (const release of releases) {
    if (seen.has(release.version)) throw new UpdateFeedError(`duplicate release ${release.version} in the feed`)
    seen.add(release.version)
  }
  const rejected = releases.filter((release) => !verifyReleaseSignature(release, publicKey))
  if (rejected.length > 0) {
    throw new UpdateFeedError(
      `signature verification failed for ${rejected.map((release) => release.version).join(', ')}; the feed is not from the release key`,
    )
  }
  return { schema: FEED_SCHEMA, ...(channel ? { channel } : {}), releases }
}

function parseVersion(version: string): { core: number[]; pre: string[] } {
  const trimmed = version.trim()
  if (!VERSION_PATTERN.test(trimmed)) throw new UpdateFeedError(`not a version: ${JSON.stringify(version)}`)
  const dash = trimmed.indexOf('-')
  const core = (dash < 0 ? trimmed : trimmed.slice(0, dash)).split('.').map(Number)
  const pre = dash < 0 ? [] : trimmed.slice(dash + 1).split('.')
  return { core, pre }
}

/** Semver precedence for the shapes a feed may contain: 1.2.3 and 1.2.3-beta.1. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  // A release outranks any prerelease of the same core version.
  if (left.pre.length === 0 || right.pre.length === 0) {
    if (left.pre.length === right.pre.length) return 0
    return left.pre.length === 0 ? 1 : -1
  }
  const length = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < length; i++) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const ln = /^\d+$/.test(l)
    const rn = /^\d+$/.test(r)
    if (ln && rn) return Number(l) > Number(r) ? 1 : -1
    if (ln !== rn) return ln ? -1 : 1
    return l > r ? 1 : -1
  }
  return 0
}

export interface UpdateSelection {
  /** The release to install, when the feed has something newer. */
  release?: ReleaseEntry
  /** Why there is nothing to install (for the UI text). */
  reason?: 'up-to-date' | 'no-release-for-channel' | 'older-only'
  /** The newest release the channel offers, even when it is not newer. */
  newest?: ReleaseEntry
}

/**
 * Picks the newest release for `channel` that is newer than `currentVersion`.
 * Entries without a channel belong to the feed's default channel.
 */
export function pickRelease(
  feed: ReleaseFeed,
  currentVersion: string,
  options: { channel?: string } = {},
): UpdateSelection {
  const channel = options.channel ?? feed.channel ?? DEFAULT_CHANNEL
  const candidates = feed.releases.filter((release) => (release.channel ?? feed.channel ?? DEFAULT_CHANNEL) === channel)
  if (candidates.length === 0) return { reason: 'no-release-for-channel' }
  const newest = candidates.reduce((best, release) => (compareVersions(release.version, best.version) > 0 ? release : best))
  if (compareVersions(newest.version, currentVersion) > 0) return { release: newest, newest }
  return {
    reason: compareVersions(newest.version, currentVersion) < 0 ? 'older-only' : 'up-to-date',
    newest,
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** Reads a feed from a URL or a local path (an air-gapped install can ship one). */
export async function loadFeed(
  location: string,
  publicKey: string,
  options: { fetchImpl?: FetchLike; allowInsecure?: boolean } = {},
): Promise<ReleaseFeed> {
  if (isHttpUrl(location)) {
    if (!isHttpsUrl(location) && options.allowInsecure !== true) {
      throw new UpdateFeedError('the release feed must use https (pass --allow-insecure for a local test server)')
    }
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await fetchImpl(location)
    } catch (error) {
      throw new UpdateFeedError(`could not reach the release feed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new UpdateFeedError(`the release feed answered HTTP ${response.status}`)
    return parseReleaseFeed(await response.text(), publicKey)
  }
  let text: string
  try {
    text = fs.readFileSync(path.resolve(location), 'utf8')
  } catch (error) {
    throw new UpdateFeedError(`could not read the release feed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseReleaseFeed(text, publicKey)
}

export function releaseFileName(release: ReleaseEntry): string {
  let base = `HY-HARNESS-${release.version}-portable.exe`
  try {
    const name = path.basename(new URL(release.url).pathname)
    if (name.toLowerCase().endsWith('.exe')) base = name
  } catch {
    // A relative url keeps the generated name.
  }
  return base.replace(/[^A-Za-z0-9._-]+/g, '-')
}

export interface DownloadResult {
  file: string
  sha256: string
  bytes: number
  /** `<file>.sha256`, read by the desktop host before it swaps the exe. */
  sidecar: string
}

function sha256File(file: string): string {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/**
 * Downloads a release to `directory`, verifying the SHA-256 before it is
 * visible under its final name. A mismatch leaves nothing behind.
 */
export async function downloadRelease(
  release: ReleaseEntry,
  directory: string,
  options: { fetchImpl?: FetchLike; allowInsecure?: boolean; maxBytes?: number } = {},
): Promise<DownloadResult> {
  if (!isHttpUrl(release.url)) throw new UpdateFeedError(`the release url must be http(s): ${release.url}`)
  if (!isHttpsUrl(release.url) && options.allowInsecure !== true) {
    throw new UpdateFeedError('the release url must use https (pass --allow-insecure for a local test server)')
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const maxBytes = options.maxBytes ?? MAX_RELEASE_BYTES
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(release.url)
  } catch (error) {
    throw new UpdateFeedError(`could not download ${release.version}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new UpdateFeedError(`could not download ${release.version}: HTTP ${response.status}`)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > maxBytes) throw new UpdateFeedError(`the release is larger than ${maxBytes} bytes`)
  if (release.size !== undefined && body.length !== release.size) {
    throw new UpdateFeedError(`size mismatch for ${release.version}: expected ${release.size} bytes, got ${body.length}`)
  }
  const actual = createHash('sha256').update(body).digest('hex')
  if (actual !== release.sha256) {
    throw new UpdateFeedError(`checksum mismatch for ${release.version}: expected ${release.sha256}, got ${actual}`)
  }
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, releaseFileName(release))
  const part = `${file}.part`
  fs.writeFileSync(part, body)
  fs.renameSync(part, file)
  // The desktop host reads this sidecar and refuses a staged exe without it.
  const sidecar = `${file}.sha256`
  fs.writeFileSync(sidecar, `${actual}\n`, 'utf8')
  return { file, sha256: sha256File(file), bytes: body.length, sidecar }
}

/** `<stateDir>/update/download`: where fetched installers wait for the swap. */
export function updateDownloadDir(stateDir: string): string {
  return path.join(stateDir, 'update', 'download')
}

export function updateKeyPath(stateDir: string): string {
  return path.join(stateDir, 'update', 'public-key.pem')
}
