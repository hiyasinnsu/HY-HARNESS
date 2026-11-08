import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { startWebServer } = await import(pathToFileURL(path.join(repo, 'packages/hy-cli/dist/web-server.js')).href)
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync)

test('choosing a mode in a blank chat applies it to the first turn', {
  skip: skipReason('pipe') ?? skipReason('sync') ?? (chrome ? undefined : 'Chrome or Edge is not installed'), timeout: 90_000, concurrency: false,
}, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-work-mode-ui-'))
  assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep))
  const ws = path.join(base, 'workspace')
  const stateDir = path.join(base, 'state')
  fs.mkdirSync(ws)
  fs.mkdirSync(stateDir)
  fs.writeFileSync(path.join(stateDir, 'onboarding.json'), '{"complete":true,"skipped":true}')
  fs.writeFileSync(path.join(ws, 'README.md'), '# fixture\n')
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init']]) {
    const result = spawnSync('git', args, { cwd: ws, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const previous = { HY_CONFIG_DIR: process.env.HY_CONFIG_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.HY_CONFIG_DIR = path.join(base, 'config')
  process.env.LOCALAPPDATA = path.join(base, 'local')
  let server, browser
  try {
    server = await startWebServer({ overrides: { cwd: ws, stateDir, mock: true }, port: 0, open: false, log: () => {} })
    browser = await chromium.launch({ executablePath: chrome, headless: true, chromiumSandbox: true })
    const page = await browser.newPage()
    await page.goto(server.url)
    await page.locator('#work-mode-select').selectOption('thorough')
    const api = async (route) => {
      const r = await fetch(new URL(route, server.url), { headers: { Authorization: `Bearer ${server.token}` } })
      assert.equal(r.status, 200)
      return r.json()
    }
    assert.equal((await api('/api/sessions')).sessions.length, 0)
    await page.locator('#composer-input').fill('SAY hello')
    await page.locator('#composer-input').press('Enter')
    await page.waitForFunction(async () => {
      const r = await fetch('/api/sessions')
      const v = await r.json()
      return v.sessions.length === 1 && v.sessions[0].turns >= 1
    }, undefined, { timeout: 30_000 })
    const id = (await api('/api/sessions')).sessions[0].runId
    const logPath = path.join(stateDir, 'session.v1.jsonl')
    let log = []
    for (let i = 0; i < 150; i++) {
      log = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      if (log.some(e => e.runId === id && e.type === 'turn/end')) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const snapshot = await api(`/api/sessions/${encodeURIComponent(id)}`)
    assert.equal(snapshot.state.workMode, 'thorough')
    assert.ok(log.some(e => e.runId === id && e.type === 'context/update' && e.payload.content.includes('Work mode: Thorough')), JSON.stringify({ state: snapshot.state, events: log.filter(e => e.runId === id) }))
  } finally {
    await browser?.close()
    await server?.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(base, { recursive: true, force: true })
  }
})
