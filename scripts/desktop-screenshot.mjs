// Launches the Electron app in screenshot/demo mode against a throwaway
// fixture. Used for visual verification; it is not part of the product.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(os.homedir(), 'hy-desktop-fixture')
const output = path.join(repo, 'screenshots', 'desktop.png')
const electron = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe')

if (!fs.existsSync(electron)) {
  console.error(`electron binary not found: ${electron}`)
  process.exit(2)
}

fs.rmSync(fixture, { recursive: true, force: true })
fs.mkdirSync(fixture, { recursive: true })
fs.writeFileSync(path.join(fixture, 'README.md'), '# HY-HARNESS desktop demo\n\nA small repository used for the Electron screenshot.\n', 'utf8')
for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=hy', '-c', 'user.email=hy@example.invalid', 'commit', '-qm', 'init']]) {
  const r = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`git ${args.join(' ')} failed: ${r.stderr}`)
    process.exit(1)
  }
}
fs.mkdirSync(path.dirname(output), { recursive: true })
// Start from a clean session log so the screenshot shows one run.
try {
  const { stateDirFor } = await import(
    new URL('../packages/core/dist/index.js', import.meta.url).href
  )
  const stateDir = stateDirFor(fixture)
  fs.rmSync(stateDir, { recursive: true, force: true })
  // `HY_SCREENSHOT_ONBOARDING=skip` takes the shot without the first-run wizard
  // (the wizard blurs the sidebar, including the version label).
  if (process.env.HY_SCREENSHOT_ONBOARDING === 'skip') {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'onboarding.json'), `${JSON.stringify({ complete: true, skipped: true }, null, 2)}\n`, 'utf8')
  }
} catch {
  // The state directory is optional; an old session list is not fatal.
}

const child = spawn(
  electron,
  [
    path.join(repo, 'packages', 'desktop', 'dist', 'main.js'),
    '--workspace',
    fixture,
    '--mock',
    '--demo',
    '--screenshot',
    output,
  ],
  {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  },
)

const timer = setTimeout(() => {
  console.error('desktop screenshot timed out')
  child.kill()
  process.exit(1)
}, 120_000)

child.on('exit', (code) => {
  clearTimeout(timer)
  if (code !== 0) {
    console.error(`electron exited with ${code}`)
    process.exit(code ?? 1)
  }
  if (!fs.existsSync(output)) {
    console.error(`screenshot was not written: ${output}`)
    process.exit(1)
  }
  console.log(`screenshot: ${output}`)
})
