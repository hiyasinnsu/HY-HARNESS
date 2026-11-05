import { ExecRpcClient, ToolRuntime, ensureStateDirs, resolveServerPath } from '../packages/core/dist/index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-ptc-'))
fs.writeFileSync(path.join(root, 'README.md'), '# PTC\n\nhello\n')
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-ptc-state-'))
ensureStateDirs(state)
const client = await ExecRpcClient.start(resolveServerPath(), {
  protocolVersion: 1,
  workspaceRoot: root,
  stateDir: state,
  sandbox: 'unconfined',
  extraWritableRoots: [],
  envPassthrough: [],
  projectTrusted: false,
  protectedPaths: [],
})
try {
  const tools = new ToolRuntime(client, root)
  const result = await tools.execute('run_code', {
    code: `
      const r = await tools.readFile({ path: 'README.md' })
      console.log('read', r.totalLines, 'lines')
      const p = await tools.applyPatch({ file: 'PTC.md', content: '# PTC result\\n' })
      return { lines: r.totalLines, created: p.created }
    `,
    description: 'read and create',
  })
  console.log(JSON.stringify(result, null, 2))
  console.log('file:', fs.readFileSync(path.join(root, 'PTC.md'), 'utf8'))
} finally {
  await client.stop()
}
