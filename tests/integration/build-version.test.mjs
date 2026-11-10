import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareBuildVersion } from '../../scripts/bump-build-version.mjs'

test('each build advances every version once, preserving file formatting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-build-version-'))
  const manifest = '\uFEFF{\r\n  "version": "0.5.0"\r\n}\r\n'
  const files = ['package.json', 'packages/core/package.json', 'packages/desktop/package.json']
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      fs.writeFileSync(path.join(root, file), manifest)
    }
    fs.mkdirSync(path.join(root, 'packages/core/src'))
    const source = path.join(root, 'packages/core/src/version.ts')
    fs.writeFileSync(source, "export const HARNESS_VERSION = '0.5.0'\r\n")
    assert.equal(prepareBuildVersion(root), '0.5.1')
    assert.equal(prepareBuildVersion(root), '0.5.2')
    for (const file of files) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), manifest.replace('0.5.0', '0.5.2'))
    assert.match(fs.readFileSync(source, 'utf8'), /'0.5.2'\r\n$/)
    assert.equal(prepareBuildVersion(root, 'minor'), '0.6.0')
    assert.throws(() => prepareBuildVersion(root, '0.6.0'), /new version/)
    fs.writeFileSync(source, 'invalid version source')
    const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    assert.throws(() => prepareBuildVersion(root), /HARNESS_VERSION/)
    assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before, 'invalid input does not leave partially updated manifests')
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
