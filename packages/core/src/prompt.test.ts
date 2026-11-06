import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt } from './prompt.js'

// Cross-session prefix cache: two sessions with the same tool set share the
// system prompt up to "This session:", whatever their workspace or role.
function sharedPrefix(a: string, b: string): string {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return a.slice(0, i)
}

const marker = '\nThis session:\nWorkspace root: '

for (const native of [true, false]) {
  test(`the system prompt is identical across workspaces and roles up to the session part (${native ? 'native' : 'text'} tools)`, () => {
    const chat = buildSystemPrompt('C:\\work\\alpha', true, false, { native, delegate: true, ask: true })
    const otherWorkspace = buildSystemPrompt('D:\\elsewhere\\beta', true, false, { native, delegate: true, ask: true })
    const worker = buildSystemPrompt('C:\\work\\alpha', true, false, {
      native,
      delegate: true,
      ask: true,
      roleInstruction: 'You are a worker. Report STATUS: done | partial | blocked.',
    })
    for (const other of [otherWorkspace, worker]) {
      const shared = sharedPrefix(chat, other)
      assert.ok(shared.length >= chat.indexOf(marker), 'nothing before the session part differs')
      assert.ok(shared.length > 2_000, `a long shared prefix (${shared.length} chars)`)
    }
    assert.match(chat, /\nThis session:\nWorkspace root: C:\\work\\alpha\n*$/)
    assert.match(worker.slice(worker.indexOf(marker)), /You are a worker\./)
    assert.doesNotMatch(worker.slice(0, worker.indexOf(marker)), /alpha|You are a worker/)
  })
}

test('the path hint names search tools the model has: run_code only with PTC', () => {
  for (const native of [true, false]) {
    const plain = buildSystemPrompt('C:\\work\\alpha', false, false, { native })
    assert.doesNotMatch(plain, /run_code/, 'without PTC there is no run_code to point at')
    assert.match(plain, /search_glob \/ search_grep/)
    const ptc = buildSystemPrompt('C:\\work\\alpha', true, false, { native })
    assert.match(ptc, /tools\.search\.glob \/ tools\.search\.grep inside run_code/)
  }
})

test('skill and MCP catalogs sit in the session part (only the tools they add change the earlier text)', () => {
  const prompt = buildSystemPrompt('C:\\work\\alpha', true, false, {
    native: true,
    skills: [{ name: 'review-diff', description: 'Review a diff', path: 'x', source: 'workspace' } as never],
    mcpCatalog: 'MCP servers: docs-server (2 tools)',
  })
  const head = prompt.slice(0, prompt.indexOf(marker))
  const tail = prompt.slice(prompt.indexOf(marker))
  assert.match(tail, /MCP servers: docs-server/)
  assert.match(tail, /review-diff/)
  assert.doesNotMatch(head, /MCP servers: docs-server|alpha/)
})
