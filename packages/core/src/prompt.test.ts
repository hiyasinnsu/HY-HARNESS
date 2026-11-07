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

test('promptVariant: lean is the default; legacy keeps the old opening; the rest is shared', () => {
  for (const native of [true, false]) {
    const lean = buildSystemPrompt('C:\\work\\alpha', false, false, { native })
    assert.equal(buildSystemPrompt('C:\\work\\alpha', false, false, { native, promptVariant: 'lean' }), lean)
    const base = buildSystemPrompt('C:\\work\\alpha', false, false, { native, promptVariant: 'legacy' })
    assert.match(base, /^You are HY-HARNESS, a careful autonomous coding agent\. The workspace and this session's role are given at the end/)
    assert.match(lean, /^You are HY-HARNESS, a careful autonomous coding agent\.\nPrivate reasoning style: use a concise tone\.\nShell environment:/)
    assert.doesNotMatch(lean, /Japanese|given at the end|Start with one sentence/)
    const rest = (s: string) => s.slice(s.indexOf('Shell environment:'))
    assert.equal(rest(lean), rest(base), 'only the first two lines differ')
  }
})

test('promptVariant lean2: the user-drafted rules (native function calling)', () => {
  const p = buildSystemPrompt('C:\\work\\alpha', false, false, { native: true, promptVariant: 'lean2' })
  assert.match(p, /^You are HY-HARNESS, an autonomous coding agent\.\nPrivate reasoning style: use a concise tone\. Do not state uncertain points as certain; present them as possibilities\.\nShell environment:/)
  for (const line of [
    "Read the user's intent and its background before acting.",
    'Do not settle for a partial solution.',
    'Ask the user only when a decision is genuinely theirs',
    'In the final answer, lead with the conclusion; if you did work, summarize clearly what changed and what you verified.',
    'If a path is missing, locate it with search_glob / search_grep.\n',
  ]) assert.ok(p.includes(line), line)
  for (const gone of ['never write JSON such as', 'Such JSON', 'Never claim success', 'instead of guessing similar paths', 'careful']) {
    assert.ok(!p.includes(gone), `removed: ${gone}`)
  }
  assert.match(p, /\nThis session:\nWorkspace root: C:\\work\\alpha\n*$/)
  // An objective run keeps its own ending rule.
  assert.match(buildSystemPrompt('C:\\work\\alpha', false, true, { native: true, promptVariant: 'lean2' }), /Finish only by calling claim_complete/)
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
