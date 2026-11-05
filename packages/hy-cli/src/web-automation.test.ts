import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../../core/dist/index.js'
import { automationArgs } from './web-server.js'

test('automation runs: no --unattended-ok, no --yes for webhooks, --trust only for the trusted server workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-auto-args-'))
  const saved = process.env.HY_CONFIG_DIR
  try {
    process.env.HY_CONFIG_DIR = path.join(dir, 'user')
    const ws = path.join(dir, 'ws')
    const other = path.join(dir, 'other')
    fs.mkdirSync(ws)
    fs.mkdirSync(other)
    const config = loadConfig({ cwd: ws, mock: true, projectTrusted: true, autoApprove: true })
    const target = (cwd: string, autoApprove: boolean) => ({ cwd, verifyCmds: ['npm test'], autoApprove })

    const schedule = automationArgs('schedule', target(ws, true), 'obj', config)
    assert.deepEqual(schedule.slice(0, 6), ['ralph', 'obj', '--cwd', ws, '--verify-cmd', 'npm test'])
    assert.ok(!schedule.includes('--unattended-ok'), 'untrusted repositories stay refused (OQ-3)')
    assert.ok(schedule.includes('--yes'))
    assert.ok(schedule.includes('--trust'), 'the server workspace is trusted')

    const webhook = automationArgs('webhook', target(ws, true), 'obj', config)
    assert.ok(!webhook.includes('--yes'), 'webhook payloads never run auto-approved')
    assert.ok(!webhook.includes('--unattended-ok'))

    // Another directory: the server's trust does not carry over; the child
    // decides from the user's trustedProjects.
    const elsewhere = automationArgs('schedule', target(other, false), 'obj', config)
    assert.ok(!elsewhere.includes('--trust'))
    assert.ok(elsewhere.includes('--yes'), 'the server was started with --yes')

    const untrustedServer = loadConfig({ cwd: ws, mock: true })
    assert.ok(!automationArgs('manual', target(ws, false), 'obj', untrustedServer).includes('--trust'))
    assert.ok(!automationArgs('manual', target(ws, false), 'obj', untrustedServer).includes('--yes'))
  } finally {
    if (saved === undefined) delete process.env.HY_CONFIG_DIR
    else process.env.HY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
