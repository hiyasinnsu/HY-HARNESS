/**
 * CP-40: package-manager manifests for a release (winget and Scoop).
 *
 * The release is the portable exe, so both describe a portable install:
 * winget's `InstallerType: portable` and Scoop's single-file `bin`. The
 * SHA-256 is the same value the signed release feed carries.
 * `scripts/gen-package-manifests.mjs` writes them under release/manifests/.
 */

export interface ReleaseInfo {
  version: string
  /** Download URL of HY-HARNESS.exe for this version. */
  url: string
  /** Lowercase hex SHA-256 of that file. */
  sha256: string
  /** Release notes URL (optional). */
  notesUrl?: string
}

export const PACKAGE = {
  identifier: 'HYHarness.HYHarness',
  name: 'HY-HARNESS',
  publisher: 'HY-HARNESS',
  homepage: 'https://github.com/hiyasinnsu/HY-HARNESS',
  license: 'Proprietary',
  description: 'A sandboxed coding agent for Windows: desktop GUI, CLI and protocol server.',
  exe: 'HY-HARNESS.exe',
  command: 'hy-harness',
} as const

export function validateRelease(release: ReleaseInfo): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version)) throw new Error(`version must be semver: ${release.version}`)
  if (!/^https:\/\//.test(release.url)) throw new Error(`url must be https: ${release.url}`)
  if (!/^[0-9a-f]{64}$/.test(release.sha256)) throw new Error('sha256 must be 64 lowercase hex characters')
}

/** Scoop app manifest (bucket JSON). */
export function scoopManifest(release: ReleaseInfo): Record<string, unknown> {
  validateRelease(release)
  return {
    version: release.version,
    description: PACKAGE.description,
    homepage: PACKAGE.homepage,
    license: PACKAGE.license,
    architecture: { '64bit': { url: release.url, hash: release.sha256 } },
    bin: [[PACKAGE.exe, PACKAGE.command]],
    shortcuts: [[PACKAGE.exe, PACKAGE.name]],
    checkver: { github: PACKAGE.homepage },
    autoupdate: { architecture: { '64bit': { url: release.url.split(release.version).join('$version') } } },
  }
}

const yaml = (fields: Array<[string, string | number | undefined]>): string =>
  fields
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'number' || /^[\w.:/@ -]+$/.test(String(v)) ? v : JSON.stringify(v)}`)
    .join('\n')

/** winget multi-file manifest (version, installer, default locale), schema 1.6.0. */
export function wingetManifests(release: ReleaseInfo): Record<string, string> {
  validateRelease(release)
  const head = (type: string) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.6.0.schema.json\n`
  const base = `${PACKAGE.identifier}`
  return {
    [`${base}.yaml`]: `${head('version')}${yaml([
      ['PackageIdentifier', PACKAGE.identifier],
      ['PackageVersion', release.version],
      ['DefaultLocale', 'en-US'],
      ['ManifestType', 'version'],
      ['ManifestVersion', '1.6.0'],
    ])}\n`,
    [`${base}.installer.yaml`]: `${head('installer')}${yaml([
      ['PackageIdentifier', PACKAGE.identifier],
      ['PackageVersion', release.version],
      ['InstallerType', 'portable'],
      ['Commands', undefined],
    ])}\nCommands:\n  - ${PACKAGE.command}\nInstallers:\n  - Architecture: x64\n    InstallerUrl: ${release.url}\n    InstallerSha256: ${release.sha256.toUpperCase()}\nManifestType: installer\nManifestVersion: 1.6.0\n`,
    [`${base}.locale.en-US.yaml`]: `${head('defaultLocale')}${yaml([
      ['PackageIdentifier', PACKAGE.identifier],
      ['PackageVersion', release.version],
      ['PackageLocale', 'en-US'],
      ['Publisher', PACKAGE.publisher],
      ['PackageName', PACKAGE.name],
      ['License', PACKAGE.license],
      ['ShortDescription', PACKAGE.description],
      ['PackageUrl', PACKAGE.homepage],
      ['ReleaseNotesUrl', release.notesUrl],
      ['ManifestType', 'defaultLocale'],
      ['ManifestVersion', '1.6.0'],
    ])}\n`,
  }
}
