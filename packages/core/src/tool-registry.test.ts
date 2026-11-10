import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { READ_ONLY_TOOLS, TOOL_SPECS, TOOLS_BY_NAME, deferredTools, jsonSchemaToTs, offeredTools, renderSdk, renderToolPrompt, validate, type Schema } from './tool-registry.js'
import { globToRegExp, normalizeToolArgs } from './tools.js'

// Kept outside src/ so tsc does not compile the declarations into the package.
const SNAPSHOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'tools-sdk.d.ts.snap')

test('the run_code SDK matches its snapshot (UPDATE_SNAPSHOTS=1 to accept a change)', () => {
  const sdk = renderSdk()
  if (process.env.UPDATE_SNAPSHOTS === '1' || !fs.existsSync(SNAPSHOT)) {
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true })
    fs.writeFileSync(SNAPSHOT, `${sdk}\n`)
  }
  assert.equal(`${sdk}\n`, fs.readFileSync(SNAPSHOT, 'utf8').replace(/\r\n/g, '\n'))
})

test('the SDK declarations type-check scripts and reject wrong calls', async () => {
  const ts = (await import('typescript')).default
  const files: Record<string, string> = {
    'sdk.d.ts': renderSdk(),
    'good.ts': `export async function ok() {
      const r = await tools.search.grep({ pattern: 'TODO', glob: '**/*.ts', ignoreCase: true })
      const first: number | undefined = r.matches[0]?.line
      const f = await tools.readFile({ path: 'README.md', startLine: 1 })
      await tools.applyPatch({ file: 'NOTES.md', content: f.content })
      const j = await tools.jobs.wait({ jobId: 'job-1', timeoutMs: 100 })
      return [first, j.state === 'exited', (await tools.search.glob({ pattern: '*.md' })).files.length]
    }`,
    'bad.ts': `export async function bad() {
      await tools.readFile({})
      await tools.search.grep({ pattern: 1 })
      await tools.jobs.kill({ id: 'x' })
      await tools.applyPatch({ file: 'a' })
      await tools.nope()
    }`,
  }
  const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, lang, ...rest) =>
    files[name] !== undefined ? ts.createSourceFile(name, files[name]!, lang) : original(name, lang, ...rest)
  host.fileExists = ((exists) => (name: string) => files[name] !== undefined || exists(name))(host.fileExists.bind(host))
  const program = ts.createProgram(Object.keys(files), options, host)
  const diags = ts.getPreEmitDiagnostics(program)
  const at = (file: string) => diags.filter((d) => d.file?.fileName === file).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))
  assert.deepEqual(at('sdk.d.ts'), [])
  assert.deepEqual(at('good.ts'), [])
  assert.equal(at('bad.ts').length, 5, at('bad.ts').join('\n'))
})

test('validation follows the schemas used for the prompt', () => {
  const read = TOOLS_BY_NAME.get('read_file')!.input
  assert.deepEqual(validate(read, { path: 'a' }), [])
  assert.deepEqual(validate(read, { path: 'a', extra: true }), [], 'unknown properties are tolerated')
  assert.deepEqual(validate(read, {}), ['args.path is required'])
  assert.deepEqual(validate(read, { path: 'a', startLine: -1 }), ['args.startLine must be >= 0'])
  assert.deepEqual(validate(read, { path: 'a', startLine: 1.5 }), ['args.startLine must be integer, got number'])
  const patch = TOOLS_BY_NAME.get('apply_patch')!.input
  assert.deepEqual(validate(patch, { patch: '---' }), [])
  assert.deepEqual(validate(patch, { file: 'a', content: '' }), [])
  assert.ok(validate(patch, { file: 'a' }).length > 0)
  assert.deepEqual(validate(TOOLS_BY_NAME.get('shell')!.input, { command: 1 }), ['args.command must be string, got integer'])
})

test('nested tool arguments are unwrapped without changing a valid MCP payload', () => {
  const shell = TOOLS_BY_NAME.get('shell')!
  assert.deepEqual(normalizeToolArgs(shell, { args: { command: 'Get-Location' } }), { command: 'Get-Location' })
  assert.deepEqual(normalizeToolArgs(shell, { args: '{"command":"Get-Location"}' }), { command: 'Get-Location' })
  assert.deepEqual(
    normalizeToolArgs(shell, { args: { args: { command: 'Get-Location', root: 'main' } }, cwd: '.' }),
    { command: 'Get-Location', root: 'main', cwd: '.' },
  )
  const mcp = TOOLS_BY_NAME.get('mcp_call')!
  const call = { server: 's', tool: 't', args: { server: 's2', tool: 't2', args: { nested: true } } }
  assert.deepEqual(normalizeToolArgs(mcp, call), call)
  const wrapped = { args: { server: 'playwright', tool: 'browser_click', args: { target: '#start-btn' } } }
  const expected = { server: 'playwright', tool: 'browser_click', args: { target: '#start-btn' } }
  assert.deepEqual(normalizeToolArgs(mcp, wrapped), expected)
  assert.deepEqual(normalizeToolArgs(mcp, { tool: 'browser_click', args: { server: 'playwright', target: '#start-btn' } }), expected)
  const conflicting = { ...wrapped, tool: 'browser_navigate' }
  assert.deepEqual(normalizeToolArgs(mcp, conflicting), conflicting)
})

test('argument aliases are declared data and never shadow a schema property (G-12)', () => {
  const declared = (schema: Schema, key: string): boolean =>
    Object.hasOwn(schema.properties ?? {}, key) || (schema.anyOf ?? []).some((child) => declared(child, key))
  // Declared next to the tool, not in a hand-written branch per tool name.
  assert.deepEqual(
    TOOL_SPECS.filter((spec) => spec.aliases !== undefined).map((spec) => spec.name),
    ['read_file', 'apply_patch', 'search_grep'],
  )
  for (const spec of TOOL_SPECS) {
    for (const [alias, canonical] of Object.entries(spec.aliases ?? {})) {
      assert.ok(declared(spec.input, canonical), `${spec.name}: ${alias} must point at a declared argument (${canonical})`)
      assert.ok(!declared(spec.input, alias), `${spec.name}: alias ${alias} must not be a declared argument`)
    }
  }
  // One generic pass drives all of them.
  assert.deepEqual(normalizeToolArgs(TOOLS_BY_NAME.get('read_file')!, { file: 'a.md', startLine: 2 }), { path: 'a.md', startLine: 2 })
  assert.deepEqual(normalizeToolArgs(TOOLS_BY_NAME.get('apply_patch')!, { path: 'a.md', content: 'x' }), { file: 'a.md', content: 'x' })
  assert.deepEqual(normalizeToolArgs(TOOLS_BY_NAME.get('search_grep')!, { pattern: 'x', path: '*.ts' }), { pattern: 'x', glob: '*.ts' })
  // A canonical key the call already set wins; the alias is left alone.
  assert.deepEqual(
    normalizeToolArgs(TOOLS_BY_NAME.get('apply_patch')!, { file: 'a.md', path: 'b.md', content: 'x' }),
    { file: 'a.md', path: 'b.md', content: 'x' },
  )
  // A tool that declares `arguments` itself keeps it (not an alias slot).
  const prompt = { server: 's', name: 'p', arguments: { topic: 'x' } }
  assert.deepEqual(normalizeToolArgs(TOOLS_BY_NAME.get('get_mcp_prompt')!, prompt), prompt)
})

test('jsonSchemaToTs renders unions, arrays and optional fields', () => {  assert.equal(
    jsonSchemaToTs({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'array', items: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } }, required: ['a'] }),
    '{ a: string; b?: (number | null)[] }',
  )
  assert.equal(jsonSchemaToTs({ type: 'string', enum: ['x', 'y'] }), "'x' | 'y'")
  assert.equal(jsonSchemaToTs({}), 'unknown')
})

test('SDK-only tools are not offered as wire tools', () => {
  // 5-2: `job_*` carries `wire: true` now (operating a backgrounded command),
  // but `wireRequires: 'shell'` keeps it out of sessions without shell; the
  // offered-list cases at the end of this test cover that gate.
  const wire = TOOL_SPECS.filter((t) => t.wire && !t.objectiveOnly).map((t) => t.name)
  assert.deepEqual(wire, ['read_file', 'verify_file', 'apply_patch', 'shell', 'run_code', 'search_glob', 'search_grep', 'job_status', 'job_output', 'job_wait', 'job_kill', 'current_time', 'sleep', 'get_context_remaining', 'update_plan', 'skill_load', 'mcp_call', 'delegate', 'web_fetch', 'web_search', 'tool_search', 'lsp', 'memory', 'spawn_agent', 'wait_agent', 'list_agents', 'close_agent', 'list_mcp_resources', 'read_mcp_resource', 'list_mcp_prompts', 'get_mcp_prompt', 'request_permissions', 'write_stdin', 'ask_user', 'git_status', 'git_prepare', 'git_commit', 'git_push', 'github_repo_info', 'github_pages_enable', 'github_actions_status', 'github_create_pr'])
  // A read-only session (subagent, review) is offered only reading tools.
  const ro = renderToolPrompt(true, undefined, false, new Set(['delegate']), READ_ONLY_TOOLS)
  assert.ok(!/- (apply_patch|shell|delegate)\(/.test(ro) && !/namespace (agents|jobs) \{[\s\S]*function kill/.test(ro), ro)
  assert.match(ro, /- read_file\(/)
  assert.match(renderToolPrompt(false, undefined, false, new Set(['delegate'])), /- delegate\(args: \{ task: string; readOnly\?: boolean; background\?: boolean; requires\?: \('read' \| 'edit' \| 'shell'\)\[\] \}\)/)
  // skill_load and mcp_call are advertised only when the session has skills / MCP tools.
  assert.ok(!renderToolPrompt(true).includes('mcp_call') && !renderToolPrompt(true).includes('namespace mcp'))
  assert.ok(!renderToolPrompt(true).includes('skill_load') && !renderToolPrompt(true).includes('namespace skills'))
  assert.match(renderToolPrompt(false, undefined, false, new Set(['skills'])), /- skill_load\(args: \{ name: string; file\?: string \}\)/)
  // claim_complete exists only in hy ralph sessions (OQ-4).
  assert.ok(!renderToolPrompt(true).includes('claim_complete'))
  assert.match(renderToolPrompt(false, undefined, true), /- claim_complete\(args: \{ summary: string \}\)/)
  assert.match(renderToolPrompt(true, undefined, true), /tools\.objective\.claimComplete = claim_complete/)
  const prompt = renderToolPrompt(false)
  assert.ok(!prompt.includes('run_code'))
  // CP-14: the search tools are direct now (they used to be SDK-only).
  assert.match(prompt, /- search_glob\(args/)
  // K9: a wire tool's SDK twin is named once, not repeated with its signature.
  const ptc = renderToolPrompt(true)
  assert.match(ptc, /tools\.search\.grep = search_grep/)
  assert.doesNotMatch(ptc, /function (readFile|applyPatch|shell|glob|grep)\(/)
  // SDK-only tools keep their full declaration.
  assert.match(ptc, /namespace jobs \{[\s\S]*function kill\(args: \{ jobId: string \}\)/)
  // The plain SDK (no wire tools in the same prompt) still declares everything.
  assert.match(renderSdk(), /namespace search \{[\s\S]*function grep\(/)
  // 5-2: job tools travel with shell. Without it they stay SDK-only (a
  // read-only session has no shell); with it they are direct even without PTC,
  // and the PTC prompt names the SDK twin instead of repeating the signature.
  assert.ok(!renderToolPrompt(false).includes('- job_status('))
  assert.match(renderToolPrompt(false, undefined, false, new Set(['shell'])), /- job_status\(args: \{ jobId: string \}\)/)
  assert.match(renderToolPrompt(true, undefined, false, new Set(['shell'])), /tools\.jobs\.status = job_status/)
  assert.match(renderSdk(), /namespace jobs \{[\s\S]*function kill\(args: \{ jobId: string \}\)/)
  assert.ok(!offeredTools(false, TOOL_SPECS, false, new Set(['delegate']), READ_ONLY_TOOLS).some((t) => t.name.startsWith('job_')))
})

test('globs match workspace-relative paths', () => {
  const m = (g: string, p: string) => globToRegExp(g).test(p)
  assert.ok(m('**/*.ts', 'a.ts') && m('**/*.ts', 'src/x/a.ts'))
  assert.ok(m('src/*.ts', 'src/a.ts') && !m('src/*.ts', 'src/x/a.ts'))
  assert.ok(m('*.{md,txt}', 'README.md') && m('*.{md,txt}', 'a.txt') && !m('*.{md,txt}', 'a.ts'))
  assert.ok(m('f?.txt', 'f1.txt') && !m('f?.txt', 'f10.txt'))
  assert.ok(m('a.b', 'a.b') && !m('a.b', 'axb'), 'dots are literal')
})

test('CP-10: deferred tools stay hidden until tool_search loads them', () => {
  const features = new Set(['lsp'])
  assert.equal(offeredTools(false, TOOL_SPECS, false, features).some((t) => t.name === 'lsp'), false)
  assert.equal(renderToolPrompt(false, TOOL_SPECS, false, features).includes('- lsp('), false)
  assert.equal(renderToolPrompt(false, TOOL_SPECS, false, features).includes('- tool_search('), false, 'no deferred tools, no search')

  const withSearch = new Set(['lsp', 'deferred'])
  assert.equal(renderToolPrompt(false, TOOL_SPECS, false, withSearch).includes('- tool_search('), true)
  const loaded = offeredTools(false, TOOL_SPECS, false, withSearch, undefined, new Set(['lsp']))
  assert.equal(loaded.some((t) => t.name === 'lsp'), true)
  assert.match(renderToolPrompt(false, TOOL_SPECS, false, withSearch, undefined, new Set(['lsp'])), /- lsp\(args/)
  assert.deepEqual(deferredTools(features).map((t) => t.name), ['lsp'])
})

test('CP-10: run_code SDK only declares loaded deferred tools', () => {
  const features = new Set(['lsp', 'deferred'])
  assert.doesNotMatch(renderSdk(TOOL_SPECS, false, features), /namespace lsp/)
  assert.match(renderSdk(TOOL_SPECS, false, features, undefined, new Set(['lsp'])), /namespace lsp/)
})
