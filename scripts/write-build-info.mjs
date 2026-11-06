// Writes build-info.json at the repository root after every `pnpm build`.
// The packaged app ships it (electron-builder `files`), and /api/bootstrap
// returns it so the sidebar can say which build is running even when the
// version number did not change between two local builds.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^﻿/, '')).version

function git(args) {
  try {
    // F: is exFAT, which git reports as "dubious ownership" without this.
    return execFileSync('git', ['-c', `safe.directory=${root.replace(/\\/g, '/')}`, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
  } catch {
    return undefined
  }
}

const commit = git(['rev-parse', '--short', 'HEAD'])
const status = git(['status', '--porcelain', '--untracked-files=no'])
const info = {
  version,
  ...(commit ? { commit } : {}),
  ...(status !== undefined ? { dirty: status.length > 0 } : {}),
  builtAt: new Date().toISOString(),
}
writeFileSync(join(root, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8')
console.log(`build-info: ${version}${commit ? ` ${commit}${info.dirty ? '+dirty' : ''}` : ''}`)
