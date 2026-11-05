import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_COMMANDS, CHAT_COMMANDS, CLI_ONLY, chatHelp, formatDoctor, formatHooks, formatUsage } from './chat-commands.js'

interface GuiCommand {
  slash?: string
  aliases?: readonly string[]
}

// The GUI table is compiled into web/dist (its own rootDir), so it is loaded at
// run time rather than imported.
const gui = (await import(new URL('../web/dist/slash-commands.js', import.meta.url).href)) as { COMMANDS: readonly GuiCommand[] }

test('CP-32: every hy chat command exists in the GUI, and /help lists them all', () => {
  const guiNames = new Set(gui.COMMANDS.flatMap((c) => [c.slash, ...(c.aliases ?? [])].filter((n): n is string => Boolean(n))))
  for (const c of CHAT_COMMANDS) {
    if (CLI_ONLY.has(c.name)) continue
    assert.ok(guiNames.has(c.name), `/${c.name} has a GUI twin`)
  }
  const help = chatHelp()
  for (const c of CHAT_COMMANDS) assert.match(help, new RegExp(`^  /${c.name}\\b`, 'm'))
  assert.match(help, /\/<prompt> \[args\]/)
  assert.ok(BUILTIN_COMMANDS.has('/quit') && BUILTIN_COMMANDS.has('/usage'))
})

test('CP-32: usage, hooks and doctor text', () => {
  assert.equal(
    formatUsage({ inputTokens: 10, outputTokens: 2, cacheHitTokens: 0, cacheMissTokens: 0, lastInputTokens: 4, lastOutputTokens: 1 }),
    'tokens this process: in 10, out 2\nlast step: in 4, out 1',
  )
  assert.match(
    formatUsage({ inputTokens: 10, outputTokens: 2, cacheHitTokens: 3, cacheMissTokens: 1, lastInputTokens: 4, lastOutputTokens: 1 }),
    /prompt cache: 3 hit \/ 1 miss \(75%\)/,
  )
  assert.equal(formatHooks([]), 'no hooks configured')
  assert.equal(
    formatHooks([{ event: 'preToolUse', command: ['guard', '--strict'], tools: ['shell'], timeoutMs: 500 }]),
    'preToolUse: guard --strict [shell] (500 ms)',
  )
  assert.equal(
    formatDoctor({ version: '1.2.3', checks: [{ name: 'node', status: 'ok', detail: 'v24' }, { name: 'sandbox', status: 'fail', detail: 'x' }] }),
    'HY-HARNESS 1.2.3\nok   node: v24\nFAIL sandbox: x',
  )
})
