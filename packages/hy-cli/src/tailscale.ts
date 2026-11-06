// What phone access needs from the Tailscale CLI: this node's address and name,
// and an HTTPS certificate for its MagicDNS name (`tailscale cert`). HTTPS is
// what makes the page a secure context, which service workers and Web Push
// require; plain http://100.x.y.z works for the page but cannot notify.
import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type Runner = (args: string[], timeoutMs: number) => { status: number | null; stdout: string; stderr: string }

export const runTailscale: Runner = (args, timeoutMs) => {
  const result = spawnSync('tailscale', args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '', stderr: result.stderr || (result.error ? String(result.error.message) : '') }
}

export interface TailscaleNode {
  ipv4: string
  /** MagicDNS name without the trailing dot, e.g. desktop-1.tail1234.ts.net */
  dnsName?: string
  /** Names `tailscale cert` can issue for (empty when HTTPS is off for the tailnet). */
  certDomains: string[]
}

/** This node, or an error the settings page can show. */
export function tailscaleNode(run: Runner = runTailscale): TailscaleNode | { error: string } {
  const result = run(['status', '--json'], 8_000)
  if (result.status !== 0) {
    return { error: result.status === null ? 'the Tailscale CLI was not found (install Tailscale and log in)' : `tailscale status failed: ${result.stderr.trim() || result.status}` }
  }
  let status: { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] }; CertDomains?: string[] | null }
  try {
    status = JSON.parse(result.stdout)
  } catch {
    return { error: 'tailscale status returned unreadable output' }
  }
  if (status.BackendState !== 'Running') return { error: `Tailscale is not connected (${status.BackendState ?? 'unknown'}); log in and try again` }
  const ipv4 = (status.Self?.TailscaleIPs ?? []).find((ip) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip))
  if (!ipv4) return { error: 'this node has no Tailscale IPv4 address' }
  const dnsName = status.Self?.DNSName?.replace(/\.$/, '') || undefined
  return { ipv4, ...(dnsName ? { dnsName } : {}), certDomains: (status.CertDomains ?? []).map((d) => d.replace(/\.$/, '')) }
}

const RENEW_BEFORE_MS = 7 * 24 * 3600_000

/**
 * A certificate for `domain` in `dir`, reused while it is valid for another
 * week, otherwise (re)issued with `tailscale cert`. Issuing publishes the name
 * in Certificate Transparency logs, which is why it only runs when the user
 * turns phone access on with HTTPS.
 */
export function ensureTailscaleCert(dir: string, domain: string, run: Runner = runTailscale, now = Date.now()): { cert: string; key: string } | { error: string } {
  const cert = path.join(dir, `${domain}.crt`)
  const key = path.join(dir, `${domain}.key`)
  try {
    const x509 = new X509Certificate(fs.readFileSync(cert))
    if (fs.existsSync(key) && Date.parse(x509.validTo) - now > RENEW_BEFORE_MS) return { cert, key }
  } catch {
    // Missing or unreadable: issue below.
  }
  fs.mkdirSync(dir, { recursive: true })
  const result = run(['cert', '--cert-file', cert, '--key-file', key, '--min-validity', '168h', domain], 60_000)
  if (result.status !== 0 || !fs.existsSync(cert) || !fs.existsSync(key)) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-2).join(' ')
    return { error: `tailscale cert failed${detail ? `: ${detail}` : ''} (enable HTTPS Certificates in the Tailscale admin console › DNS)` }
  }
  return { cert, key }
}
