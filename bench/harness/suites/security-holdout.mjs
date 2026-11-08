// Windows adaptation of Terminal-Bench 2 fix-code-vulnerability, using the
// pinned Bottle source and task files in cacheRoot/security-holdout-2fd12b88aafd.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function createSuite({ cacheRoot }) {
  const source = path.join(cacheRoot, 'security-holdout-2fd12b88aafd')
  const archive = path.join(source, 'bottle-lf.tar')
  const verifier = path.join(source, 'tests', 'test_outputs.py')
  const prompt = fs.readFileSync(path.join(source, 'instruction.md'), 'utf8').replaceAll('/app/', './').replaceAll('/app', '.').trim()
  return {
    id: 'security-holdout-windows',
    description: 'Windows adaptation of Terminal-Bench 2 fix-code-vulnerability; workspace-relative paths and local Python',
    source: { repo: 'https://github.com/harbor-framework/terminal-bench-2', commit: '2fd12b88aafdd04a52c298e3940bcb189f9766d6', task: 'fix-code-vulnerability', fixture: 'https://github.com/bottlepy/bottle/tree/0207a34f0c5716cd292dd4480253ad35d3da49f3', adaptation: 'Windows host; /app paths become workspace-relative paths; verifier accepts equivalent paths to the workspace file' },
    tasks: [{ id: 'security-holdout', prompt }],
    agentTimeoutMs: 900_000,
    async prepare(ws) {
      const extracted = spawnSync('tar', ['-xf', archive, '-C', ws], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
      if (extracted.status !== 0) throw new Error(`extract fixture: ${extracted.stderr || extracted.error?.message}`)
      const file = path.join(ws, 'bottle.py')
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      if (!lines[1561]?.includes("if '\\n' in key") || !lines[1562]?.includes('raise ValueError')) throw new Error('unexpected pinned Bottle fixture')
      lines.splice(1561, 2)
      if (!lines[1566]?.includes("if '\\n' in value") || !lines[1567]?.includes('raise ValueError')) throw new Error('unexpected pinned Bottle fixture after first deletion')
      lines.splice(1566, 2)
      fs.writeFileSync(file, lines.join('\n'))
      return {}
    },
    async check(ws) {
      const grader = `${ws}.grader`
      fs.mkdirSync(grader, { recursive: false })
      const tests = fs.readFileSync(verifier, 'utf8')
        .replaceAll('/app/report.jsonl', 'report.jsonl')
        .replaceAll('/app/bottle.py', './bottle.py')
        .replaceAll('file_path = item.get("file_path", "")', 'file_path = item.get("file_path", "")\n            file_path = "./bottle.py" if os.path.normcase(os.path.abspath(file_path)) == os.path.normcase(os.path.abspath("bottle.py")) else file_path')
        .replace('os.path.join(os.path.dirname(__file__), "bottle")', JSON.stringify(ws.replaceAll('\\', '/')))
      const testFile = path.join(grader, 'test_outputs.py')
      fs.writeFileSync(testFile, tests)
      const pytestConfig = path.join(grader, 'pytest.ini')
      fs.writeFileSync(pytestConfig, '[pytest]\naddopts = -ra\n')
      const extracted = spawnSync('tar', ['-xf', archive, '-C', grader, 'test'], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
      if (extracted.status !== 0) throw new Error(`extract frozen tests: ${extracted.stderr || extracted.error?.message}`)
      const env = { ...process.env, PYTHONPATH: `${grader}${path.delimiter}${ws}`, PYTHONIOENCODING: 'utf-8' }
      const run = (args, name) => {
        const result = spawnSync('uvx', ['-p', '3.11', '-w', 'pytest==8.4.1', 'pytest', '-c', pytestConfig, ...args, '-p', 'no:cacheprovider'], { cwd: ws, env, encoding: 'utf8', timeout: 300_000, windowsHide: true })
        fs.writeFileSync(path.join(grader, `${name}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`)
        return result
      }
      const original = run([path.join(grader, 'test')], 'original-repo')
      const junit = path.join(grader, 'official.xml')
      const official = run([testFile, `--junitxml=${junit}`], 'official')
      const xml = fs.existsSync(junit) ? fs.readFileSync(junit, 'utf8') : ''
      const checks = { original_repo_tests: original.status === 0 }
      for (const match of xml.matchAll(/<testcase\b[^>]*\bname="([^\"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
        checks[match[1].replace(/^test_/, '')] = !/<(failure|error|skipped)\b/.test(match[3] ?? '')
      }
      if (official.status !== 0 && Object.keys(checks).length === 1) checks.official_grader_ran = false
      checks.reward = original.status === 0 && official.status === 0 && Object.keys(checks).length >= 7 && Object.values(checks).every(Boolean)
      return checks
    },
  }
}
