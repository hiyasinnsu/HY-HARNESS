// The original suite: a small stats library with one planted bug, and four
// tasks given one after another in one session (implement, bugfix, CLI, docs).
import fs from 'node:fs'
import path from 'node:path'
import { writeFixture } from './stats-fixture.mjs'
import { TASKS, checkWorkspace } from './stats-tasks.mjs'

export function createSuite() {
  return {
    id: 'stats',
    description: 'small stats library: 4 tasks in one session (implement, bugfix, CLI, docs)',
    tasks: TASKS,
    async prepare(ws) {
      writeFixture(ws)
      return { originalFormatTest: fs.readFileSync(path.join(ws, 'test/format.test.js'), 'utf8') }
    },
    async check(ws, prepared) {
      return checkWorkspace(ws, prepared.originalFormatTest)
    },
  }
}
