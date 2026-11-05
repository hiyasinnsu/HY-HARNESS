// Optional first-party automation presets: Playwright MCP (browser) and the
// agent-desktop MCP wrapper (Windows accessibility tree). This starts both
// servers and checks that their tools are discoverable; it does not drive the
// browser or desktop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { loadConfig, McpManager } = await import(pathToFileURL(path.join(repo, 'packages', 'core', 'dist', 'index.js')).href)

test('automation presets start Playwright MCP and agent-desktop MCP', { skip: skipReason('pipe'), timeout: 120_000, concurrency: false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-auto-mcp-'))
  const saved = { HY_CONFIG_DIR: process.env.HY_CONFIG_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA }
  try {
    const user = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(user)
    fs.mkdirSync(ws)
    fs.writeFileSync(
      path.join(user, 'config.json'),
      JSON.stringify({
        roles: { worker: { provider: 'mock' } },
        automation: {
          browser: { enabled: true, browser: 'msedge', headless: true },
          desktop: { enabled: true },
        },
      }),
    )
    process.env.HY_CONFIG_DIR = user
    process.env.LOCALAPPDATA = path.join(dir, 'localappdata')
    const config = loadConfig({ cwd: ws, mock: true })
    assert.ok(config.mcpServers.playwright)
    assert.ok(config.mcpServers['agent-desktop'])
    const mcp = await McpManager.start(config.mcpServers)
    try {
      const names = mcp.tools.map((t) => t.name)
      assert.ok(names.some((n) => n.startsWith('browser_')), names.join(', '))
      assert.ok(names.includes('desktop_snapshot'), names.join(', '))
      assert.ok(names.includes('desktop_list_apps'), names.join(', '))
      assert.equal(mcp.errors.length, 0, mcp.errors.join('\n'))
    } finally {
      mcp.close()
    }
  } finally {
    if (saved.HY_CONFIG_DIR === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved.HY_CONFIG_DIR
    if (saved.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = saved.LOCALAPPDATA
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
