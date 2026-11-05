// Loaded with `node --test --import` (pnpm test:integration): every test and
// every `hy` child process it starts reads an empty user configuration
// directory instead of the developer's real %APPDATA%\hy-harness. Without it,
// settings saved from the GUI (sandboxMode, autoApprove, plugins, MCP servers)
// change what the tests run. Tests that need a user config still set
// HY_CONFIG_DIR themselves for their child processes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// CP-01 made `workspace-write` the default. These tests exercise other
// features and run in `%TEMP%` (an AppContainer-ACE directory where confined
// mode refuses to start), so they pin the old mode for their child processes.
// The default itself is covered by `default-sandbox.test.mjs` and the config
// unit tests.
if (!process.env.HY_SANDBOX) process.env.HY_SANDBOX = 'unconfined'

if (!process.env.HY_CONFIG_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-test-user-'))
  process.env.HY_CONFIG_DIR = dir
  // Only the process that created the directory removes it.
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
}
