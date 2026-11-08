// Terminal-Bench 2.0 `financial-document-processor`, run on Windows.
// https://github.com/harbor-framework/terminal-bench-2/tree/main/financial-document-processor
// (Apache-2.0). Nothing of the task is vendored: the documents, the
// instruction and the official pytest file are fetched once at a pinned commit
// into <workdir>/../cache and used from there.
//
// Differences from the Docker task, all mechanical:
// - The workspace replaces `/app`: the instruction's `/app/x` becomes `x`
//   (relative to the working directory), and the official tests get the same
//   rewrite before they run against the workspace.
// - The documents get fresh random names per run, as the task's Dockerfile does.
// - The host is Windows, not Ubuntu: no OCR is preinstalled for either harness;
//   the agent installs what it needs (network is allowed, as in the task).
// - Grading runs the unmodified test functions with `uvx` (Python 3.13,
//   pytest 8.4.1, pandas 2.3.2, as tests/test.sh does). Each test function is
//   one check; `reward` is 1 when all pass, like the benchmark's reward.txt.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = 'https://github.com/harbor-framework/terminal-bench-2.git'
const COMMIT = '2fd12b88aafdd04a52c298e3940bcb189f9766d6'
const TASK = 'financial-document-processor'

let fetched
/** The task directory in the cache, fetched once per process. */
function taskDir(cacheRoot) {
  fetched ??= (() => {
    const dir = path.join(cacheRoot, `tb2-${COMMIT.slice(0, 12)}`)
    const task = path.join(dir, TASK)
    if (fs.existsSync(path.join(task, 'tests', 'test_outputs.py'))) return task
    if (fs.existsSync(dir)) throw new Error(`incomplete benchmark cache already exists: ${dir}`)
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    const git = (args, cwd) => {
      // exFAT records no owner: safe.directory, scoped to this command.
      const r = spawnSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'utf8', timeout: 600_000 })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.error?.message}`)
    }
    git(['clone', '-q', '--filter=blob:none', '--no-checkout', REPO, dir])
    git(['sparse-checkout', 'set', TASK], dir)
    git(['-c', 'core.autocrlf=false', 'checkout', '-q', COMMIT], dir)
    return task
  })()
  return fetched
}

/** The instruction with `/app/` mapped to the working directory. */
function instruction(task) {
  return fs.readFileSync(path.join(task, 'instruction.md'), 'utf8').replace(/\r\n/g, '\n').replaceAll('/app/', '').trim()
}

export function createSuite({ cacheRoot }) {
  const task = taskDir(cacheRoot)
  return {
    id: 'tb2-financial',
    description: `Terminal-Bench 2 ${TASK} @ ${COMMIT.slice(0, 12)} (OCR, classification, CSV), one task`,
    source: { repo: REPO, commit: COMMIT, task: TASK },
    tasks: [{ id: 'financial-document-processor', prompt: instruction(task) }],
    // The task's agent timeout is 1,200 s; slow provider turns get half again.
    agentTimeoutMs: 1_800_000,
    async prepare(ws) {
      const docs = path.join(ws, 'documents')
      fs.mkdirSync(docs, { recursive: true })
      const used = new Set()
      for (const name of fs.readdirSync(path.join(task, 'environment', 'documents'))) {
        let random
        do random = `${crypto.randomBytes(9).toString('base64url')}${path.extname(name)}`
        while (used.has(random))
        used.add(random)
        fs.copyFileSync(path.join(task, 'environment', 'documents', name), path.join(docs, random))
      }
      return {}
    },
    async check(ws) {
      const graderDir = `${ws}.grader`
      fs.mkdirSync(graderDir, { recursive: false })
      const root = ws.replace(/\\/g, '/')
      const tests = fs.readFileSync(path.join(task, 'tests', 'test_outputs.py'), 'utf8').replaceAll('"/app/', `"${root}/`)
      const testFile = path.join(graderDir, 'test_outputs.py')
      const junit = path.join(graderDir, 'junit.xml')
      fs.writeFileSync(testFile, tests)
      const r = spawnSync(
        'uvx',
        ['-p', '3.13', '-w', 'pytest==8.4.1', '-w', 'pandas==2.3.2', 'pytest', testFile, '-rA', '-p', 'no:cacheprovider', `--junitxml=${junit}`],
        { cwd: graderDir, encoding: 'utf8', timeout: 1_200_000, windowsHide: true },
      )
      fs.writeFileSync(path.join(graderDir, 'pytest.log'), `${r.stdout ?? ''}\n${r.stderr ?? ''}`)
      const result = {}
      const xml = fs.existsSync(junit) ? fs.readFileSync(junit, 'utf8') : ''
      for (const match of xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
        const body = match[3] ?? ''
        result[match[1].replace(/^test_/, '')] = !/<(failure|error|skipped)\b/.test(body)
      }
      if (Object.keys(result).length === 0) result.graderRan = false
      result.reward = Object.keys(result).length > 0 && Object.values(result).every(Boolean)
      return result
    },
  }
}
