// The tasks, given one after another in one session, and their hidden checks.
// The checks run after the session in the workspace; the agent never sees them.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const TASKS = [
  {
    id: 'implement',
    prompt:
      'src/stats.js に median(values)（中央値）と mode(values)（最頻値。最多が複数あれば最小の値）を追加し、test/stats.test.js にテストを足して。空配列は TypeError にすること。最後に npm test の stats のテストが通ることを確認して。',
  },
  {
    id: 'bugfix',
    prompt: 'npm test を実行すると format のテストが落ちる。原因を特定して src/format.js を直して。テストファイルは変更しないこと。',
  },
  {
    id: 'cli',
    prompt:
      'bin/stats.js に CLI を追加して。`node bin/stats.js 1 2 3 4` で sum, mean, median, mode を src/format.js の formatTable で表示する（ラベルは sum / mean / median / mode）。数値でない引数があれば標準エラーにメッセージを出して終了コード 1 で終わる。テストも追加して、npm test が全部通ることを確認して。',
  },
  {
    id: 'docs',
    prompt: 'README.md の Functions に追加した関数を追記し、CLI の使い方の節も追加して。最後に、変更したファイルの一覧と npm test の結果を短く報告して。',
  },
]


/** Returns { implement, bugfix, cli, docs, suite } as booleans. */
export async function checkWorkspace(ws, originalFormatTest) {
  const result = {}
  const importFresh = async (rel) => import(`${pathToFileURL(path.join(ws, rel)).href}?t=${Date.now()}${Math.random()}`)
  try {
    const stats = await importFresh('src/stats.js')
    const throwsType = (fn) => {
      try {
        fn()
        return false
      } catch (error) {
        return error instanceof TypeError
      }
    }
    result.implement =
      stats.median([3, 1, 2]) === 2 &&
      stats.median([4, 1, 3, 2]) === 2.5 &&
      stats.mode([1, 2, 2, 3, 3]) === 2 &&
      stats.mode([5]) === 5 &&
      throwsType(() => stats.median([])) &&
      throwsType(() => stats.mode([]))
  } catch {
    result.implement = false
  }
  try {
    const format = await importFresh('src/format.js')
    const testNow = fs.readFileSync(path.join(ws, 'test/format.test.js'), 'utf8')
    result.bugfix = format.formatTable([['a', 1], ['bbb', 2]]) === 'a    1.00\nbbb  2.00' && testNow === originalFormatTest
  } catch {
    result.bugfix = false
  }
  {
    const ok = spawnSync(process.execPath, ['bin/stats.js', '1', '2', '3', '4'], { cwd: ws, encoding: 'utf8', timeout: 20_000 })
    const bad = spawnSync(process.execPath, ['bin/stats.js', '1', 'x'], { cwd: ws, encoding: 'utf8', timeout: 20_000 })
    const out = ok.stdout ?? ''
    const line = (label, value) => new RegExp(`^${label}\\s+${value.replace('.', '\\.')}\\s*$`, 'm').test(out)
    result.cli =
      ok.status === 0 &&
      line('sum', '10.00') &&
      line('mean', '2.50') &&
      line('median', '2.50') &&
      line('mode', '1.00') &&
      bad.status === 1 &&
      (bad.stderr ?? '').trim().length > 0
  }
  {
    const readme = fs.existsSync(path.join(ws, 'README.md')) ? fs.readFileSync(path.join(ws, 'README.md'), 'utf8') : ''
    result.docs = /median/.test(readme) && /mode/.test(readme) && /bin\/stats\.js|stats\.js/.test(readme)
  }
  {
    const suite = spawnSync(process.execPath, ['--test'], { cwd: ws, encoding: 'utf8', timeout: 120_000 })
    result.suite = suite.status === 0
  }
  return result
}
