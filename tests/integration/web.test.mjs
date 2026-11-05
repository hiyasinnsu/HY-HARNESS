// web_fetch is opt-in (--web); allowlisted hosts need no approval, others ask.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipReason } from './capability.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(repo, 'packages', 'hy-cli', 'dist', 'main.js')

// spawnSync would block the event loop that serves the local page.
function hy(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: repo, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('web_fetch: off by default, allowlist skips approval, others ask', { skip: skipReason('pipe') }, async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>Local</title><p>served page</p>')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-web-'))
  const user = path.join(dir, 'user')
  try {
    fs.mkdirSync(user)
    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ web: { allowDomains: ['127.0.0.1'] } }))
    const env = { ...process.env, HY_CONFIG_DIR: user }
    const finals = (r) => r.stdout.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'turn/final').map((e) => e.content)

    const off = await hy(['chat', '--mock', '--cwd', dir, '--json'], `FETCH ${url}\n/exit\n`, env)
    assert.match(finals(off)[0], /web_fetch: web access is off/)

    const on = await hy(['chat', '--mock', '--cwd', dir, '--json', '--web'], `FETCH ${url}\n/exit\n`, env)
    assert.match(finals(on)[0], /"title": "Local".*"text": "served page"/)
    assert.doesNotMatch(on.stderr, /Approve command\?/)

    fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ web: { enabled: true } }))
    const asked = await hy(['chat', '--mock', '--cwd', dir, '--json'], `FETCH ${url}\nn\n/exit\n`, env)
    assert.match(asked.stderr, /Approve command\? web_fetch http:\/\/127\.0\.0\.1/)
    assert.match(finals(asked)[0], /web_fetch not approved/)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
