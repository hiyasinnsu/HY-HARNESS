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

test('promptVariant lean3: tool use and rules groups; the shell is the fallback', () => {
  const p = buildSystemPrompt('C:\\work\\alpha', false, false, { native: true, promptVariant: 'lean3' })
  assert.match(p, /^You are HY-HARNESS, an autonomous coding agent\.\nPrivate reasoning style: use a concise tone\. Do not state uncertain points as certain; present them as possibilities\.\nShell environment: /)
  for (const line of [
    'Tool use:\nMake independent calls together, at the same time.\nRead a file before editing it.\n',
    'If a path is missing, locate it with search_glob / search_grep, not the shell.',
    'split it into several edit_file / apply_patch calls',
    'Rules:\nRead the user\'s intent and its background before acting.\nDo not settle for a partial solution.\n',
    'Do not implement a lot at once; proceed in small, verifiable steps. Inspect shell output before continuing.\n',
  ]) assert.ok(p.includes(line), line)
  assert.ok(!p.includes('Use the provided tools through function calls'))
  assert.match(p, /\nThis session:\nWorkspace root: C:\\work\\alpha\n*$/)
  assert.match(buildSystemPrompt('C:\\work\\alpha', false, true, { native: true, promptVariant: 'lean3' }), /Finish only by calling claim_complete/)
})

test('promptVariant lean4: detailed tool docs, and the prompt drops what they cover', async () => {
  const { nativeToolDefs } = await import('./prompt.js')
  const { RICH_TOOL_DOCS } = await import('./tool-docs.js')
  const { TOOL_SPECS } = await import('./tool-registry.js')
  const p = buildSystemPrompt('C:\\work\\alpha', false, false, { native: true, promptVariant: 'lean4' })
  assert.match(p, /^You are HY-HARNESS, an autonomous coding agent\.\nPrivate reasoning style: [^\n]+\nTool use:\nMake independent calls together, at the same time\.\nDo not try to read or write outside the workspace\.\nRules:\n/)
  assert.doesNotMatch(p, /Shell environment|Read a file before editing|search_glob|apply_patch|edit_file/, 'now in the tool descriptions')
  assert.match(p, /Inspect shell output before continuing\.\n\nThis session:/)

  // The plugin-provided editors, as the session registers them.
  const extraTools = [
    { name: 'edit_file', wire: true, readOnly: false, description: 'short', input: { type: 'object', properties: { file: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' }, count: { type: 'number' } }, required: ['file', 'old', 'new'] } },
    { name: 'write_file', wire: true, readOnly: false, description: 'short', input: { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' }, root: { type: 'string' } }, required: ['file', 'content'] } },
  ] as never
  const rich = nativeToolDefs(false, false, { promptVariant: 'lean4', extraTools })
  const plain = nativeToolDefs(false, false, { promptVariant: 'lean3', extraTools })
  for (const [name, doc] of Object.entries(RICH_TOOL_DOCS)) {
    const def = rich.find((t) => t.name === name)
    assert.ok(def, `${name} is offered`)
    assert.equal(def.description, doc.description)
    const props = (def.parameters as { properties: Record<string, { description?: string }> }).properties
    // Every documented parameter exists, and every parameter is documented.
    assert.deepEqual(Object.keys(doc.params ?? {}).sort(), Object.keys(props).sort(), `${name} parameters`)
    for (const [param, text] of Object.entries(doc.params ?? {})) assert.equal(props[param]!.description, text)
    assert.notEqual(plain.find((t) => t.name === name)!.description, doc.description, 'other variants keep the short text')
  }
  assert.ok(TOOL_SPECS.length > 0)
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
