/**
 * The sidebar's version label. With only `v0.4.1`, two local builds of the same
 * version looked identical, so the label also names the commit and build time
 * (`v0.4.1 · ada5158 · 11/06 06:22`); `+` marks a build with uncommitted changes.
 */

export interface BuildView {
  commit?: string | undefined
  dirty?: boolean | undefined
  builtAt?: string | undefined
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `MM/DD HH:mm` in local time, or '' for a missing or invalid time. */
export function buildTime(iso: string | undefined): string {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  return `${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
}

export function buildLabel(version: string | undefined, build: BuildView | undefined): { text: string; title: string } {
  const parts = [`v${version ?? 'unknown'}`]
  if (build?.commit) parts.push(`${build.commit}${build.dirty ? '+' : ''}`)
  const time = buildTime(build?.builtAt)
  if (time) parts.push(time)
  const title = [
    `version ${version ?? 'unknown'}`,
    build?.commit ? `commit ${build.commit}${build.dirty ? ' (with uncommitted changes)' : ''}` : '',
    build?.builtAt ? `built ${new Date(build.builtAt).toLocaleString()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return { text: parts.join(' · '), title }
}
