import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoopManifest, validateRelease, wingetManifests } from './package-manifests.js'

const release = {
  version: '0.5.0',
  url: 'https://github.com/hiyasinnsu/HY-HARNESS/releases/download/v0.5.0/HY-HARNESS.exe',
  sha256: 'a'.repeat(64),
}

test('CP-40: Scoop manifest for the portable exe', () => {
  const m = scoopManifest(release) as { version: string; architecture: { '64bit': { url: string; hash: string } }; bin: string[][]; autoupdate: { architecture: { '64bit': { url: string } } } }
  assert.equal(m.version, '0.5.0')
  assert.deepEqual(m.architecture['64bit'], { url: release.url, hash: release.sha256 })
  assert.deepEqual(m.bin, [['HY-HARNESS.exe', 'hy-harness']])
  assert.equal(m.autoupdate.architecture['64bit'].url, 'https://github.com/hiyasinnsu/HY-HARNESS/releases/download/v$version/HY-HARNESS.exe')
})

test('CP-40: winget manifests (version, installer, locale) agree on id and version', () => {
  const files = wingetManifests({ ...release, notesUrl: 'https://example.com/notes' })
  assert.deepEqual(Object.keys(files).sort(), ['HYHarness.HYHarness.installer.yaml', 'HYHarness.HYHarness.locale.en-US.yaml', 'HYHarness.HYHarness.yaml'])
  for (const text of Object.values(files)) {
    assert.match(text, /^PackageIdentifier: HYHarness\.HYHarness$/m)
    assert.match(text, /^PackageVersion: 0\.5\.0$/m)
    assert.match(text, /^ManifestVersion: 1\.6\.0$/m)
  }
  const installer = files['HYHarness.HYHarness.installer.yaml']!
  assert.match(installer, /InstallerType: portable/)
  assert.match(installer, new RegExp(`InstallerSha256: ${'A'.repeat(64)}`))
  assert.match(files['HYHarness.HYHarness.locale.en-US.yaml']!, /ReleaseNotesUrl: https:\/\/example\.com\/notes/)
})

test('CP-40: bad release data is refused', () => {
  assert.throws(() => validateRelease({ ...release, version: 'v1' }), /semver/)
  assert.throws(() => validateRelease({ ...release, url: 'http://x' }), /https/)
  assert.throws(() => validateRelease({ ...release, sha256: 'ABC' }), /sha256/)
})
