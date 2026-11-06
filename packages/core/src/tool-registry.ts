// The tool registry (design §2): one JSON Schema per tool drives argument
// validation at dispatch, the compact signatures in the system prompt, and the
// `declare namespace tools` SDK shown for `run_code` (`jsonSchemaToTs`).
//
// Wire tools are offered to the model directly; deferred wire tools (CP-10)
// join the prompt only after `tool_search` loads them. SDK-only tools
// (`tools.jobs.*`, `tools.rationale.*`) exist only inside `run_code` scripts,
// so they cost prompt tokens only when PTC is on.

/** The subset of JSON Schema the registry uses. */
export interface Schema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'null'
  description?: string
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  enum?: readonly (string | number | boolean)[]
  anyOf?: Schema[]
  minimum?: number
  /** Rendered once as a named type in the SDK (`type Job = …`) and referenced. */
  title?: string
}

export interface ToolSpec {
  /** Name the agent and the dispatcher use (`search_grep`). */
  name: string
  /** Dotted path inside `run_code` (`search.grep`), when exposed there. */
  sdk?: string
  /** Offered to the model as a top-level tool. */
  wire: boolean
  /** May run in parallel with other read-only sub-calls. */
  readOnly: boolean
  description: string
  input: Schema
  output: Schema
  /** Only in objective (`hy ralph`) sessions, where it is also a wire tool (OQ-4). */
  objectiveOnly?: boolean
  /** Advertised only when the session has this feature (e.g. skills were found). */
  requires?: 'skills' | 'mcp' | 'delegate' | 'web' | 'ask' | 'search' | 'lsp' | 'memory' | 'deferred'
  /**
   * CP-10: deferred tools stay out of the initial prompt; `tool_search`
   * loads them (and they are callable only after loading).
   */
  exposure?: 'direct' | 'deferred'
}

const str = (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) })
const int = (description?: string): Schema => ({ type: 'integer', minimum: 0, ...(description ? { description } : {}) })
const bool: Schema = { type: 'boolean' }
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required })
const arr = (items: Schema): Schema => ({ type: 'array', items })
const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: 'null' }] })

const jobInfo: Schema = {
  ...obj(
  {
    jobId: str(),
    command: str(),
    state: { type: 'string', enum: ['running', 'exited', 'killed'] },
    exitCode: nullable({ type: 'integer' }),
    outputBytes: { type: 'integer' },
  },
  ['jobId', 'command', 'state', 'outputBytes'],
),
  title: 'Job',
}
const jobId = obj({ jobId: str() }, ['jobId'])
const ledgerSummary: Schema = {
  ...obj({ entries: { type: 'integer' }, tokens: { type: 'integer' } }, ['entries', 'tokens']),
  title: 'NoteCount',
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'read_file',
    sdk: 'readFile',
    wire: true,
    readOnly: true,
    description: 'Read a workspace file (read before editing). Added roots use root:path.',
    input: obj({ path: str(), startLine: int(), endLine: int() }, ['path']),
    output: obj({ content: str(), totalLines: { type: 'integer' }, truncated: bool }, ['content', 'totalLines', 'truncated']),
  },
  {
    name: 'apply_patch',
    sdk: 'applyPatch',
    wire: true,
    readOnly: false,
    description: 'Diff, or file + content. Read existing files first. Added roots: whole-file content with root.',
    input: {
      anyOf: [
        obj({ patch: str() }, ['patch']),
        obj({ file: str(), content: str(), root: str() }, ['file', 'content']),
      ],
    },
    output: obj({ appliedFiles: arr(str()), created: arr(str()), deleted: arr(str()), warnings: arr(str()) }, [
      'appliedFiles',
      'created',
      'deleted',
      'warnings',
    ]),
  },
  {
    name: 'shell',
    sdk: 'shell',
    wire: true,
    readOnly: false,
    description:
      'Run a command; after foregroundWaitMs it becomes a job. root: workspace root ID (default main). Windows: PowerShell, not grep/head/find.',
    input: obj(
      { command: str(), root: str(), cwd: str(), foregroundWaitMs: int(), hardTimeoutMs: int(), persistent: bool, stdinPipe: bool, tty: bool },
      ['command'],
    ),
    output: obj(
      {
        status: { type: 'string', enum: ['completed', 'backgrounded'] },
        exitCode: nullable({ type: 'integer' }),
        stdout: str(),
        stderr: str(),
        jobId: nullable(str()),
        gap: str(),
      },
      ['status', 'stdout', 'stderr'],
    ),
  },
  {
    name: 'run_code',
    wire: true,
    readOnly: false,
    description:
      'Async JavaScript body calling the `tools` SDK below; only its return value and logs come back. Use for 2+ chained calls, loops or filtering.',
    input: obj({ code: str(), description: str(), timeoutMs: int(), maxSubCalls: int() }, ['code']),
    output: obj({ status: { type: 'string', enum: ['ok'] }, value: {}, logs: arr(str()), subCalls: { type: 'integer' } }, [
      'status',
      'logs',
      'subCalls',
    ]),
  },
  {
    name: 'search_glob',
    sdk: 'search.glob',
    wire: true,
    readOnly: true,
    description: "Root-relative paths matching a glob (docs/*.md); skips .git, node_modules, .gitignore'd. root:* = all roots.",
    input: obj({ pattern: str(), root: str(), maxResults: int() }, ['pattern']),
    output: obj({ files: arr(str()), truncated: bool, note: str() }, ['files', 'truncated']),
  },
  {
    name: 'search_grep',
    sdk: 'search.grep',
    wire: true,
    readOnly: true,
    description: 'Regex lines; optional path glob; same skips. root:* = all roots.',
    input: obj({ pattern: str(), root: str(), glob: str(), ignoreCase: bool, maxResults: int() }, ['pattern']),
    output: obj(
      {
        matches: arr(obj({ path: str(), line: { type: 'integer' }, text: str() }, ['path', 'line', 'text'])),
        truncated: bool,
        filesSearched: { type: 'integer' },
        note: str(),
      },
      ['matches', 'truncated', 'filesSearched'],
    ),
  },
  { name: 'job_status', sdk: 'jobs.status', wire: false, readOnly: true, description: 'State of a background job.', input: jobId, output: jobInfo },
  {
    name: 'job_output',
    sdk: 'jobs.output',
    wire: false,
    readOnly: true,
    description: 'A page of a job\'s output from offset.',
    input: obj({ jobId: str(), offset: int(), maxBytes: int() }, ['jobId']),
    output: obj({ data: str(), nextOffset: { type: 'integer' }, totalBytes: { type: 'integer' }, eof: bool }, [
      'data',
      'nextOffset',
      'totalBytes',
      'eof',
    ]),
  },
  {
    name: 'job_wait',
    sdk: 'jobs.wait',
    wire: false,
    readOnly: true,
    description: 'Wait up to timeoutMs for a job to finish.',
    input: obj({ jobId: str(), timeoutMs: int() }, ['jobId']),
    output: jobInfo,
  },
  { name: 'job_kill', sdk: 'jobs.kill', wire: false, readOnly: false, description: 'Kill a job and its process tree.', input: jobId, output: jobInfo },
  {
    name: 'rationale_upsert',
    sdk: 'rationale.upsert',
    wire: false,
    readOnly: false,
    description: 'A note that survives compaction (max 12 / ~1500 tokens).',
    input: obj({ key: str(), rule: str(), rationale: str() }, ['key', 'rule']),
    output: ledgerSummary,
  },
  {
    name: 'rationale_supersede',
    sdk: 'rationale.supersede',
    wire: false,
    readOnly: false,
    description: 'Replace oldKey with a new note.',
    input: obj({ oldKey: str(), newKey: str(), rule: str(), rationale: str() }, ['oldKey', 'newKey', 'rule']),
    output: ledgerSummary,
  },
  {
    name: 'claim_complete',
    sdk: 'objective.claimComplete',
    wire: true,
    readOnly: false,
    objectiveOnly: true,
    description: 'The only way to finish: claim the objective is done. Independent gates verify it; a false claim costs a round.',
    input: obj({ summary: str() }, ['summary']),
    output: obj({ accepted: bool }, ['accepted']),
  },
  { name: 'rationale_remove', sdk: 'rationale.remove', wire: false, readOnly: false, description: 'Delete a note.', input: obj({ key: str() }, ['key']), output: ledgerSummary },
  {
    name: 'current_time',
    wire: true,
    readOnly: true,
    description: 'Current local time, timezone and weekday.',
    input: obj({}),
    output: obj(
      {
        iso: str(),
        local: str(),
        timezone: str(),
        weekday: str(),
      },
      ['iso', 'local', 'timezone', 'weekday'],
    ),
  },
  {
    name: 'sleep',
    wire: true,
    readOnly: true,
    description: 'Wait briefly (max 60 s) when polling a job or a build.',
    input: obj({ ms: int(), reason: str() }, ['ms']),
    output: obj({ sleptMs: { type: 'integer' } }, ['sleptMs']),
  },
  {
    name: 'get_context_remaining',
    wire: true,
    readOnly: true,
    description: 'Context window left in tokens for this session (provider-reported, after the last step).',
    input: obj({}),
    output: obj(
      {
        window: { type: 'integer' },
        used: { type: 'integer' },
        remaining: { type: 'integer' },
        percentUsed: { type: 'number' },
        source: str(),
      },
      ['window', 'used', 'remaining', 'percentUsed', 'source'],
    ),
  },  {
    name: 'update_plan',
    // Wire only: a plan inside a run_code script has no use, and the SDK entry
    // would cost prompt tokens on every PTC request.
    wire: true,
    readOnly: true,
    description: 'Track multi-step work: the full list each time; one in_progress.',
    input: obj(
      {
        plan: arr(obj({ step: str(), status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, ['step', 'status'])),
      },
      ['plan'],
    ),
    output: obj({ ok: bool }, ['ok']),
  },
  {
    name: 'skill_load',
    sdk: 'skills.load',
    wire: true,
    readOnly: true,
    requires: 'skills',
    description: 'Instructions of a listed skill, or one of its files.',
    input: obj({ name: str(), file: str() }, ['name']),
    output: obj({ content: str(), files: arr(str()) }, ['content', 'files']),
  },
  {
    name: 'mcp_call',
    sdk: 'mcp.call',
    wire: true,
    readOnly: false,
    exposure: 'deferred',
    requires: 'mcp',
    description: 'Call a listed MCP tool.',
    input: obj({ server: str(), tool: str(), args: { type: 'object' } }, ['server', 'tool']),
    output: obj({ text: str(), structured: {} }, ['text']),
  },
  {
    name: 'delegate',
    sdk: 'agents.run',
    wire: true,
    // Read-only subagents may run in parallel inside run_code; see ToolRuntime.runCode.
    readOnly: false,
    requires: 'delegate',
    description:
      'Subagent for one subtask; readOnly (default true) = reading only; background = return its agentId.',
    input: obj({ task: str(), readOnly: bool, background: bool }, ['task']),
    output: obj({ final: str(), steps: { type: 'integer' }, agentId: str() }, ['final', 'steps']),
  },
  {
    name: 'web_fetch',
    sdk: 'web.fetch',
    wire: true,
    readOnly: true,
    exposure: 'deferred',
    requires: 'web',
    description: 'Fetch an http(s) URL as text (may need approval).',
    input: obj({ url: str() }, ['url']),
    output: obj({ status: { type: 'integer' }, title: str(), text: str(), truncated: bool }, ['status', 'text', 'truncated']),
  },
  {
    name: 'web_search',
    sdk: 'web.search',
    wire: true,
    readOnly: true,
    exposure: 'deferred',
    requires: 'search',
    description: 'Search the web; returns URLs, titles and snippets (read pages with web_fetch).',
    input: obj({ query: str(), maxResults: int() }, ['query']),
    output: obj({ results: arr(obj({ url: str(), title: str(), snippet: str() }, ['url', 'title', 'snippet'])) }, ['results']),
  },
  {
    name: 'tool_search',
    wire: true,
    readOnly: true,
    requires: 'deferred',
    description: 'Load a tool that is not listed yet (web, lsp, memory, mcp, skills): search by name or words.',
    input: obj({ query: str(), limit: int() }, ['query']),
    output: obj(
      {
        tools: arr(obj({ name: str(), description: str(), signature: str() }, ['name', 'description', 'signature'])),
        activated: arr(str()),
        available: { type: 'integer' },
      },
      ['tools', 'activated', 'available'],
    ),
  },  {
    name: 'lsp',
    sdk: 'lsp.query',
    wire: true,
    readOnly: true,
    exposure: 'deferred',
    requires: 'lsp',
    description: 'Language server query on a workspace file: definition, references, hover, diagnostics or symbols (1-based line/column).',
    input: obj(
      {
        op: { type: 'string', enum: ['definition', 'references', 'hover', 'diagnostics', 'symbols'] },
        path: str(),
        line: int(),
        column: int(),
      },
      ['op', 'path'],
    ),
    output: { type: 'object' },
  },
  {
    name: 'memory',
    wire: true,
    readOnly: false,
    exposure: 'deferred',
    requires: 'memory',
    description: 'Save (or forget) a short fact for future sessions in this workspace: build quirks, user preferences.',
    input: obj({ action: { type: 'string', enum: ['save', 'forget'] }, key: str(), text: str() }, ['action', 'key']),
    output: obj({ entries: { type: 'integer' } }, ['entries']),
  },
  {
    name: 'spawn_agent',
    wire: true,
    readOnly: false,
    exposure: 'deferred',
    requires: 'delegate',
    description: 'Start a background subagent for one task; returns its agentId.',
    input: obj({ task: str(), readOnly: bool }, ['task']),
    output: obj({ agentId: str(), status: str() }, ['agentId', 'status']),
  },
  {
    name: 'wait_agent',
    wire: true,
    readOnly: true,
    exposure: 'deferred',
    requires: 'delegate',
    description: 'Wait for a background subagent (default 30 s) and return its answer.',
    input: obj({ agentId: str(), timeoutMs: int() }, ['agentId']),
    output: obj({ final: str(), status: str(), timedOut: bool }, ['final', 'status', 'timedOut']),
  },
  {
    name: 'list_agents',
    wire: true,
    readOnly: true,
    exposure: 'deferred',
    requires: 'delegate',
    description: 'List this session\'s background subagents and their status.',
    input: obj({}),
    output: obj({ agents: arr(obj({ agentId: str(), task: str(), status: str() }, ['agentId', 'task', 'status'])) }, [
      'agents',
    ]),
  },
  {
    name: 'close_agent',
    wire: true,
    readOnly: false,
    exposure: 'deferred',
    requires: 'delegate',
    description: 'Close a finished background subagent.',
    input: obj({ agentId: str() }, ['agentId']),
    output: obj({ agentId: str(), status: str() }, ['agentId', 'status']),
  },  {
    name: 'list_mcp_resources',
    wire: true,
    readOnly: true,
    exposure: 'deferred',
    requires: 'mcp',
    description: 'List resources exposed by the configured MCP servers.',
    input: obj({}),
    output: obj(
      {
        resources: arr(
          obj(
            { server: str(), uri: str(), name: str(), description: str(), mimeType: str() },
            ['server', 'uri', 'name'],
          ),
        ),
        errors: arr(str()),
      },
      ['resources', 'errors'],
    ),
  },
  {
    name: 'read_mcp_resource',
    wire: true,
    readOnly: true,
    exposure: 'deferred',
    requires: 'mcp',
    description: 'Read one MCP resource by server and uri.',
    input: obj({ server: str(), uri: str() }, ['server', 'uri']),
    output: obj({ uri: str(), mimeType: str(), text: str(), truncated: bool }, ['uri', 'text', 'truncated']),
  },
  {
    name: 'list_mcp_prompts',
    wire: true,
    readOnly: true,
    exposure: 'deferred',
    requires: 'mcp',
    description: 'List the prompt templates offered by the configured MCP servers.',
    input: obj({}),
    output: obj(
      {
        prompts: arr(obj({ server: str(), name: str(), description: str(), arguments: arr(obj({ name: str(), required: bool }, ['name'])) }, ['server', 'name', 'arguments'])),
        errors: arr(str()),
      },
      ['prompts', 'errors'],
    ),
  },
  {
    name: 'get_mcp_prompt',
    wire: true,
    readOnly: true,
    exposure: 'deferred',
    requires: 'mcp',
    description: 'Render one MCP prompt template (server, name, string arguments) into messages.',
    input: obj({ server: str(), name: str(), arguments: obj({}) }, ['server', 'name']),
    output: obj({ description: str(), messages: arr(obj({ role: str(), text: str() }, ['role', 'text'])) }, ['messages']),
  },  {
    name: 'request_permissions',
    wire: true,
    readOnly: false,
    description: 'Ask the user to allow writes under a path outside the workspace (the reason is shown).',
    input: obj({ write: arr(str()), reason: str() }, ['write']),
    output: obj({ granted: arr(str()), rejected: arr(str()), note: str() }, ['granted', 'rejected', 'note']),
  },  {
    name: 'write_stdin',
    wire: true,
    readOnly: false,
    description: 'Send input to a shell job started with stdinPipe or tty; returns its new output.',
    input: obj({ jobId: str(), chars: str(), timeoutMs: int() }, ['jobId', 'chars']),
    output: obj(
      {
        output: str(),
        exited: bool,
        exitCode: nullable({ type: 'integer' }),
        timedOut: bool,
      },
      ['output', 'exited', 'timedOut'],
    ),
  },  {
    name: 'ask_user',
    wire: true,
    readOnly: true,
    requires: 'ask',
    description: 'Ask the user a question and wait for the answer (only when you cannot decide from the repository).',
    input: obj({ question: str() }, ['question']),
    output: obj({ answer: str() }, ['answer']),
  },
]

/** Tools a read-only subagent (and `hy review`) may use. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'search_glob',
  'search_grep',
  'job_status',
  'job_output',
  'job_wait',
  'skill_load',
  'update_plan',
  'run_code',
  'web_fetch',
  'web_search',
  'lsp',
])

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOL_SPECS.map((t) => [t.name, t]))
export const TOOLS_BY_SDK: ReadonlyMap<string, ToolSpec> = new Map(
  TOOL_SPECS.filter((t) => t.sdk !== undefined).map((t) => [t.sdk!, t]),
)

// ---------------------------------------------------------------- validation

function typeOf(v: unknown): Schema['type'] | 'undefined' {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v as Schema['type'] | 'undefined'
}

/**
 * Checks `value` against `schema`; returns the problems (empty when valid).
 * Unknown properties are tolerated (small models add them); types, enums,
 * minimums and required properties are not.
 */
export function validate(schema: Schema, value: unknown, at = 'args'): string[] {
  if (schema.anyOf) {
    const results = schema.anyOf.map((s) => validate(s, value, at))
    if (results.some((r) => r.length === 0)) return []
    // Report the alternative that came closest.
    return results.reduce((best, r) => (r.length < best.length ? r : best))
  }
  const actual = typeOf(value)
  if (schema.type !== undefined) {
    const ok = schema.type === actual || (schema.type === 'number' && actual === 'integer')
    if (!ok) return [`${at} must be ${schema.type}, got ${actual}`]
  }
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    return [`${at} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`]
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    return [`${at} must be >= ${schema.minimum}`]
  }
  const errors: string[] = []
  if (schema.type === 'object' && value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    for (const r of schema.required ?? []) {
      if (o[r] === undefined) errors.push(`${at}.${r} is required`)
    }
    for (const [k, s] of Object.entries(schema.properties ?? {})) {
      if (o[k] !== undefined) errors.push(...validate(s, o[k], `${at}.${k}`))
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validate(schema.items!, v, `${at}[${i}]`)))
  }
  return errors
}

// ---------------------------------------------------------------- rendering

/**
 * Renders a schema as a TypeScript type expression. With `named`, schemas that
 * have a `title` are rendered once into `named` and referenced by name.
 */
export function jsonSchemaToTs(schema: Schema, named?: Map<string, string>): string {
  if (named && schema.title) {
    if (!named.has(schema.title)) {
      named.set(schema.title, '')
      const { title: _title, ...rest } = schema
      named.set(schema.title, jsonSchemaToTs(rest, named))
    }
    return schema.title
  }
  const ts = (s: Schema) => jsonSchemaToTs(s, named)
  if (schema.anyOf) return schema.anyOf.map(ts).join(' | ')
  if (schema.enum) return schema.enum.map((e) => JSON.stringify(e).replace(/"/g, "'")).join(' | ')
  switch (schema.type) {
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array': {
      const item = ts(schema.items ?? {})
      return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`
    }
    case 'object': {
      if (!schema.properties || Object.keys(schema.properties).length === 0) return 'object'
      const required = new Set(schema.required ?? [])
      const fields = Object.entries(schema.properties ?? {}).map(
        ([k, s]) => `${k}${required.has(k) ? '' : '?'}: ${ts(s)}`,
      )
      return `{ ${fields.join('; ')} }`
    }
    default:
      return 'unknown'
  }
}

interface NsNode {
  fns: string[]
  children: Map<string, NsNode>
}

/**
 * The `declare namespace tools { … }` block for `run_code` scripts.
 *
 * `mirrored` names wire tools whose full signature is already in the same
 * prompt. Those SDK functions are listed once as `tools.x = wire_name`
 * instead of repeating the signature and description: K9 keeps the initial
 * tool prompt small (budget 12,000 tokens; 1,200 until 2026-11-06), and the
 * repetition alone cost ~300.
 */
export function renderSdk(
  specs: readonly ToolSpec[] = TOOL_SPECS,
  objective = false,
  features: ReadonlySet<string> = new Set(),
  allow?: ReadonlySet<string>,
  active?: ReadonlySet<string>,
  mirrored?: ReadonlySet<string>,
): string {
  const root: NsNode = { fns: [], children: new Map() }
  const named = new Map<string, string>()
  const aliases: string[] = []
  for (const t of specs) {
    if (!t.sdk || t.name === 'run_code' || (t.objectiveOnly && !objective) || (t.requires && !features.has(t.requires))) continue
    if (t.exposure === 'deferred' && active?.has(t.name) !== true) continue
    if (allow && !allow.has(t.name)) continue
    if (mirrored?.has(t.name)) {
      aliases.push(`tools.${t.sdk} = ${t.name}`)
      continue
    }
    const parts = t.sdk.split('.')
    let node = root
    for (const p of parts.slice(0, -1)) {
      if (!node.children.has(p)) node.children.set(p, { fns: [], children: new Map() })
      node = node.children.get(p)!
    }
    node.fns.push(
      `/** ${t.description} */\nfunction ${parts.at(-1)}(args: ${jsonSchemaToTs(t.input, named)}): Promise<${jsonSchemaToTs(t.output, named)}>`,
    )
  }
  const emit = (node: NsNode, indent: string): string[] => {
    const lines: string[] = []
    for (const f of node.fns) for (const l of f.split('\n')) lines.push(indent + l)
    for (const [name, child] of node.children) {
      lines.push(`${indent}namespace ${name} {`, ...emit(child, `${indent}  `), `${indent}}`)
    }
    return lines
  }
  const types = [...named].map(([name, body]) => `  type ${name} = ${body}`)
  const alias = aliases.length > 0 ? [`  // Same args and results as the tools above: ${aliases.join(', ')}`] : []
  return ['declare namespace tools {', ...alias, ...types, ...emit(root, '  '), '}'].join('\n')
}


/** CP-10: deferred tools this session could load with `tool_search`. */
export function deferredTools(
  features: ReadonlySet<string>,
  specs: readonly ToolSpec[] = TOOL_SPECS,
  allow?: ReadonlySet<string>,
): ToolSpec[] {
  return specs.filter(
    (t) =>
      t.wire &&
      t.exposure === 'deferred' &&
      (!t.requires || features.has(t.requires)) &&
      (!allow || allow.has(t.name)),
  )
}
/** The wire tools a session offers. */
export function offeredTools(
  ptc: boolean,
  specs: readonly ToolSpec[] = TOOL_SPECS,
  objective = false,
  features: ReadonlySet<string> = new Set(),
  allow?: ReadonlySet<string>,
  active?: ReadonlySet<string>,
): ToolSpec[] {
  return specs.filter(
    (t) =>
      t.wire &&
      (ptc || t.name !== 'run_code') &&
      (objective || !t.objectiveOnly) &&
      (!t.requires || features.has(t.requires)) &&
      (!allow || allow.has(t.name)) &&
      (t.exposure !== 'deferred' || active?.has(t.name) === true),
  )
}

/**
 * A tool's input as native function parameters. Providers require an object
 * at the root, so a root `anyOf` (apply_patch) becomes one object with every
 * alternative's properties optional; dispatch still validates the real schema.
 */
export function nativeParameters(spec: ToolSpec): Schema {
  const input = spec.input
  if (!input.anyOf) return input
  const properties: Record<string, Schema> = {}
  for (const alt of input.anyOf) Object.assign(properties, alt.properties ?? {})
  return { type: 'object', properties, required: [] }
}

/** The tool section of the system prompt. */
export function renderToolPrompt(
  ptc: boolean,
  specs: readonly ToolSpec[] = TOOL_SPECS,
  objective = false,
  features: ReadonlySet<string> = new Set(),
  allow?: ReadonlySet<string>,
  active?: ReadonlySet<string>,
): string {
  const wire = offeredTools(ptc, specs, objective, features, allow, active)
  const lines = ['Tools (call as {"tool":"<name>","args":{...}}):']
  for (const t of wire) {
    lines.push(`- ${t.name}(args: ${jsonSchemaToTs(t.input)}) → ${jsonSchemaToTs(t.output)}`, `  ${t.description}`)
  }
  if (ptc) {
    lines.push(
      'Inside run_code, use only this SDK (no require, import, fs, process or network):',
      renderSdk(specs, objective, features, allow, active, new Set(wire.map((t) => t.name))),
    )
  }
  return lines.join('\n')
}
