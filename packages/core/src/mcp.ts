// Model Context Protocol client (stdio transport): external tool servers, as
// in Codex (`mcp_tool_call.rs`) and DSH (`packages/mcp`). Each configured
// server is started once per session; its tools are listed in the system
// prompt and called through the `mcp_call` tool.
//
// Servers come only from the user's own configuration (or a trusted project's),
// like `--verify-cmd`: they run unconfined, as the user. Calls go through the
// approval chain unless the server is marked `trusted` or the tool says it is
// read-only (`annotations.readOnlyHint`).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { jsonSchemaToTs, type Schema } from './tool-registry.js'

export interface McpServerConfig {
  /** CP-11: remote MCP endpoint (Streamable HTTP). Takes precedence over command. */
  url?: string
  /** Extra request headers for HTTP servers (e.g. Authorization). */
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Skip approval for this server's tools. */
  trusted?: boolean
  /** Only these tools are offered (default: all). */
  tools?: string[]
  /** Per-request timeout (default 60 s). */
  timeoutMs?: number
}

export interface McpResource {
  server: string
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface McpTool {
  server: string
  name: string
  description: string
  inputSchema: Schema
  readOnly: boolean
}

export const MCP_PROTOCOL_VERSION = '2025-06-18'
const MAX_CATALOG_TOOLS = 40

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** One stdio MCP server: newline-delimited JSON-RPC 2.0. */
export class McpClient implements McpTransport {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private buffer = ''
  private stderrTail = ''
  private exited: string | undefined

  private constructor(
    readonly name: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2_000)
    })
    child.on('exit', (code) => this.fail(`exited with code ${String(code)}`))
    child.on('error', (error) => this.fail(error.message))
  }

  static async start(name: string, config: McpServerConfig): Promise<McpClient> {
    if (!config.command) throw new Error(`MCP server ${name}: command is required for stdio`)
    const child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const client = new McpClient(name, child, config.timeoutMs ?? 60_000)
    await client.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { elicitation: {} },
      clientInfo: { name: 'hy-harness', version: '0.1.0' },
    })
    client.notify('notifications/initialized')
    return client
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg: { id?: number | string; result?: unknown; error?: { code: number; message: string }; method?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        continue // Servers may log to stdout by mistake; skip non-JSON lines.
      }
      if (msg.method !== undefined) {
        // CP-11: elicitation asks the user (through the registered handler);
        // other server requests (sampling, roots) are not supported.
        if (msg.id !== undefined) {
          const id = msg.id
          if (msg.method === 'elicitation/create') {
            void answerElicitation(this.name, (msg as { params?: unknown }).params).then((result) => this.send({ jsonrpc: '2.0', id, result }))
          } else {
            this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'not supported by hy-harness' } })
          }
        }
        continue
      }
      const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
      if (!p) continue
      this.pending.delete(msg.id as number)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`${this.name}: ${msg.error.message} (${msg.error.code})`))
      else p.resolve(msg.result)
    }
  }

  private fail(reason: string): void {
    if (this.exited) return
    this.exited = reason
    const tail = this.stderrTail.trim() ? `; stderr: ${this.stderrTail.trim().slice(-500)}` : ''
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`MCP server ${this.name} ${reason}${tail}`))
      this.pending.delete(id)
    }
  }

  private send(msg: unknown): void {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error(`MCP server ${this.name} ${this.exited}`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP server ${this.name}: ${method} timed out after ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    do {
      const page = (await this.request('tools/list', cursor !== undefined ? { cursor } : {})) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: Schema; annotations?: { readOnlyHint?: boolean } }>
        nextCursor?: string
      }
      for (const t of page.tools ?? []) {
        tools.push({
          server: this.name,
          name: t.name,
          description: (t.description ?? '').replace(/\s+/g, ' ').trim(),
          inputSchema: t.inputSchema ?? { type: 'object' },
          readOnly: t.annotations?.readOnlyHint === true,
        })
      }
      cursor = page.nextCursor
    } while (cursor !== undefined && tools.length < 1_000)
    return tools
  }

  async callTool(name: string, args: unknown): Promise<{ isError: boolean; text: string; structured?: unknown }> {
    const r = (await this.request('tools/call', { name, arguments: args ?? {} })) as {
      content?: Array<{ type: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } }>
      isError?: boolean
      structuredContent?: unknown
    }
    const text = (r.content ?? [])
      .map((c) =>
        c.type === 'text'
          ? (c.text ?? '')
          : c.type === 'resource'
            ? (c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`)
            : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''} omitted]`,
      )
      .join('\n')
    return { isError: r.isError === true, text, ...(r.structuredContent !== undefined ? { structured: r.structuredContent } : {}) }
  }

  async listResources(): Promise<McpResource[]> {
    const resources: McpResource[] = []
    let cursor: string | undefined
    do {
      const page = (await this.request('resources/list', cursor !== undefined ? { cursor } : {})) as {
        resources?: Array<{ uri?: string; name?: string; description?: string; mimeType?: string }>
        nextCursor?: string
      }
      for (const r of page.resources ?? []) {
        if (!r.uri) continue
        resources.push({
          server: this.name,
          uri: r.uri,
          name: r.name ?? r.uri,
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        })
      }
      cursor = page.nextCursor
    } while (cursor !== undefined && resources.length < 200)
    return resources
  }

  async readResource(uri: string): Promise<{ uri: string; mimeType?: string; text: string }> {
    const r = (await this.request('resources/read', { uri })) as {
      contents?: Array<{ uri?: string; mimeType?: string; text?: string }>
    }
    const text = (r.contents ?? []).map((c) => c.text ?? '[binary resource omitted]').join('\n')
    const mimeType = (r.contents ?? []).find((c) => c.mimeType)?.mimeType
    return { uri, ...(mimeType ? { mimeType } : {}), text }
  }
  close(): void {
    this.fail('was closed')
    this.child.stdin.end()
    this.child.kill()
  }
}


/** Shared surface of the stdio and HTTP clients (CP-11). */
/** CP-11: an MCP server asking the user for input (`elicitation/create`). */
export interface ElicitationRequest {
  server: string
  message: string
  /** A flat JSON Schema object (`properties` of primitives). */
  requestedSchema?: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
}

export type ElicitationResult = { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' }

let elicitationHandler: ((request: ElicitationRequest) => Promise<ElicitationResult>) | undefined

/** Registers the UI that answers elicitations (CLI prompt, GUI question card). */
export function setElicitationHandler(handler: ((request: ElicitationRequest) => Promise<ElicitationResult>) | undefined): void {
  elicitationHandler = handler
}

async function answerElicitation(server: string, params: unknown): Promise<ElicitationResult> {
  const p = (params ?? {}) as { message?: unknown; requestedSchema?: ElicitationRequest['requestedSchema'] }
  if (!elicitationHandler) return { action: 'decline' }
  try {
    return await elicitationHandler({ server, message: String(p.message ?? ''), ...(p.requestedSchema ? { requestedSchema: p.requestedSchema } : {}) })
  } catch {
    return { action: 'cancel' }
  }
}

/**
 * A typed answer for an elicitation from a free-text reply: one field takes
 * the reply (coerced to its type); several fields need a JSON object. An
 * empty reply declines.
 */
export function elicitationContent(schema: ElicitationRequest['requestedSchema'], answer: string): ElicitationResult {
  const text = answer.trim()
  if (!text) return { action: 'decline' }
  const props = Object.entries(schema?.properties ?? {})
  const coerce = (type: string | undefined, value: string): unknown =>
    type === 'number' || type === 'integer' ? Number(value) : type === 'boolean' ? /^(y|yes|true|1|はい)$/i.test(value) : value
  if (props.length === 1) {
    const [name, spec] = props[0]!
    return { action: 'accept', content: { [name]: coerce(spec.type, text) } }
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { action: 'accept', content: parsed as Record<string, unknown> }
  } catch {
    // fall through
  }
  return props.length === 0 ? { action: 'accept', content: { response: text } } : { action: 'decline' }
}

export interface McpPrompt {
  server: string
  name: string
  description?: string
  arguments: Array<{ name: string; description?: string; required?: boolean }>
}

export interface McpTransport {
  readonly name: string
  request(method: string, params?: unknown): Promise<unknown>
  notify(method: string, params?: unknown): void
  listTools(): Promise<McpTool[]>
  callTool(name: string, args: unknown): Promise<{ isError: boolean; text: string; structured?: unknown }>
  listResources(): Promise<McpResource[]>
  readResource(uri: string): Promise<{ uri: string; mimeType?: string; text: string }>
  close(): void
}

/** Parses one SSE event block into its data payloads. */
function ssePayloads(block: string): string[] {
  const out: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    out.push(line.slice(5).trimStart())
  }
  return out
}

/**
 * CP-11: Streamable HTTP transport. Each request is a POST; the reply is either
 * a JSON body or an SSE stream that ends after the matching message.
 */
export class McpHttpClient implements McpTransport {
  private nextId = 1
  private sessionId: string | undefined

  private constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
  ) {}

  static async start(name: string, config: McpServerConfig): Promise<McpHttpClient> {
    const url = config.url ?? ''
    if (!/^https?:\/\//i.test(url)) throw new Error(`MCP server ${name}: url must be http(s)`);
    const client = new McpHttpClient(name, config)
    await client.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { elicitation: {} },
      clientInfo: { name: 'hy-harness', version: '0.1.0' },
    })
    client.notify('notifications/initialized')
    return client
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      ...(this.sessionId === undefined ? {} : { 'mcp-session-id': this.sessionId }),
      ...(this.config.headers ?? {}),
    }
  }

  private async post(body: unknown, signal: AbortSignal): Promise<Response> {
    const response = await fetch(this.config.url ?? '', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    })
    const session = response.headers.get('mcp-session-id')
    if (session) this.sessionId = session
    return response
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const body = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }
    const timeout = this.config.timeoutMs ?? 60_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`${method} timed out after ${timeout} ms`)), timeout)
    try {
      const response = await this.post(body, controller.signal)
      if (!response.ok) throw new Error(`${this.name}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
      const type = response.headers.get('content-type') ?? ''
      if (!type.includes('text/event-stream')) {
        const text = await response.text()
        return this.unwrap(text, id)
      }
      // SSE: read until the matching message arrives.
      const reader = response.body?.getReader()
      if (!reader) throw new Error(`${this.name}: empty SSE body`)
      const decoder = new TextDecoder()
      let buffer = ''
      let answer: unknown
      let failure: Error | undefined
      let found = false
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let split: number
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          for (const payload of ssePayloads(block)) {
            const result = this.match(payload, id)
            if (result.ok) {
              answer = result.value
              found = true
            } else if (result.error) {
              failure = result.error
              found = true
            }
            if (found) break
          }
          if (found) break
        }
        if (found) {
          await reader.cancel().catch(() => undefined)
          break
        }
      }
      if (failure) throw failure
      if (!found) throw new Error(`${this.name}: no response to ${method} in the SSE stream`)
      return answer
    } finally {
      clearTimeout(timer)
    }
  }

  private unwrap(text: string, id: number): unknown {
    const result = this.match(text, id)
    if (result.error) throw result.error
    if (!result.ok) throw new Error(`${this.name}: unexpected response`)
    return result.value
  }

  private match(text: string, id: number): { ok: boolean; value?: unknown; error?: Error } {
    let msg: { id?: number | string; result?: unknown; error?: { code: number; message: string } }
    try {
      msg = JSON.parse(text)
    } catch {
      return { ok: false }
    }
    if (typeof msg.id !== 'number' || msg.id !== id) return { ok: false }
    if (msg.error) return { ok: false, error: new Error(`${this.name}: ${msg.error.message} (${msg.error.code})`) }
    return { ok: true, value: msg.result }
  }

  notify(method: string, params?: unknown): void {
    const body = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }
    void this.post(body, AbortSignal.timeout(this.config.timeoutMs ?? 60_000)).catch(() => undefined)
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    do {
      const page = (await this.request('tools/list', cursor !== undefined ? { cursor } : {})) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: Schema; annotations?: { readOnlyHint?: boolean } }>
        nextCursor?: string
      }
      for (const t of page.tools ?? []) {
        tools.push({
          server: this.name,
          name: t.name,
          description: (t.description ?? '').replace(/\s+/g, ' ').trim(),
          inputSchema: t.inputSchema ?? { type: 'object' },
          readOnly: t.annotations?.readOnlyHint === true,
        })
      }
      cursor = page.nextCursor
    } while (cursor !== undefined && tools.length < 1_000)
    return tools
  }

  async callTool(name: string, args: unknown): Promise<{ isError: boolean; text: string; structured?: unknown }> {
    const r = (await this.request('tools/call', { name, arguments: args ?? {} })) as {
      content?: Array<{ type: string; text?: string; resource?: { uri?: string; text?: string } }>
      isError?: boolean
      structuredContent?: unknown
    }
    const text = (r.content ?? [])
      .map((c) =>
        c.type === 'text'
          ? (c.text ?? '')
          : c.type === 'resource'
            ? (c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`)
            : `[${c.type} omitted]`,
      )
      .join('\n')
    return { isError: r.isError === true, text, ...(r.structuredContent !== undefined ? { structured: r.structuredContent } : {}) }
  }

  async listResources(): Promise<McpResource[]> {
    const resources: McpResource[] = []
    let cursor: string | undefined
    do {
      const page = (await this.request('resources/list', cursor !== undefined ? { cursor } : {})) as {
        resources?: Array<{ uri?: string; name?: string; description?: string; mimeType?: string }>
        nextCursor?: string
      }
      for (const r of page.resources ?? []) {
        if (!r.uri) continue
        resources.push({
          server: this.name,
          uri: r.uri,
          name: r.name ?? r.uri,
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        })
      }
      cursor = page.nextCursor
    } while (cursor !== undefined && resources.length < 200)
    return resources
  }

  async readResource(uri: string): Promise<{ uri: string; mimeType?: string; text: string }> {
    const r = (await this.request('resources/read', { uri })) as {
      contents?: Array<{ uri?: string; mimeType?: string; text?: string }>
    }
    const text = (r.contents ?? []).map((c) => c.text ?? '[binary resource omitted]').join('\n')
    const mimeType = (r.contents ?? []).find((c) => c.mimeType)?.mimeType
    return { uri, ...(mimeType ? { mimeType } : {}), text }
  }

  close(): void {
    this.sessionId = undefined
  }
}
/** All configured servers of a session. A server that fails to start is reported, not fatal. */
export class McpManager {
  private constructor(
    private readonly clients: Map<string, McpTransport>,
    readonly tools: McpTool[],
    private readonly configs: Record<string, McpServerConfig>,
    readonly errors: string[],
  ) {}

  static async start(configs: Record<string, McpServerConfig>): Promise<McpManager> {
    const clients = new Map<string, McpTransport>()
    const tools: McpTool[] = []
    const errors: string[] = []
    await Promise.all(
      Object.entries(configs).map(async ([name, config]) => {
        try {
          const client = config.url !== undefined ? await McpHttpClient.start(name, config) : await McpClient.start(name, config)
          clients.set(name, client)
          const allow = config.tools ? new Set(config.tools) : undefined
          tools.push(...(await client.listTools()).filter((t) => !allow || allow.has(t.name)))
        } catch (error) {
          errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }),
    )
    tools.sort((a, b) => (a.server === b.server ? (a.name < b.name ? -1 : 1) : a.server < b.server ? -1 : 1))
    return new McpManager(clients, tools, configs, errors)
  }

  find(server: string, tool: string): McpTool | undefined {
    return this.tools.find((t) => t.server === server && t.name === tool)
  }

  /** Whether a call needs approval: not for trusted servers or read-only tools. */
  needsApproval(tool: McpTool): boolean {
    return !(this.configs[tool.server]?.trusted === true || tool.readOnly)
  }

  call(server: string, tool: string, args: unknown) {
    const client = this.clients.get(server)
    if (!client) throw new Error(`MCP server ${server} is not running`)
    return client.callTool(tool, args)
  }

  /** CP-11: every resource of every HTTP/stdio server (errors per server are skipped). */
  async resources(): Promise<{ resources: McpResource[]; errors: string[] }> {
    const resources: McpResource[] = []
    const errors: string[] = []
    for (const [name, client] of this.clients) {
      try {
        resources.push(...(await client.listResources()))
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { resources, errors }
  }

  async readResource(server: string, uri: string): Promise<{ uri: string; mimeType?: string; text: string }> {
    const client = this.clients.get(server)
    if (!client) throw new Error(`MCP server ${server} is not running`)
    return client.readResource(uri)
  }
  /** CP-11: prompts of every server (`prompts/list`, paged). */
  async prompts(): Promise<{ prompts: McpPrompt[]; errors: string[] }> {
    const prompts: McpPrompt[] = []
    const errors: string[] = []
    for (const [name, client] of this.clients) {
      try {
        let cursor: string | undefined
        for (let page = 0; page < 20; page++) {
          const r = (await client.request('prompts/list', cursor !== undefined ? { cursor } : {})) as {
            prompts?: Array<{ name?: unknown; description?: unknown; arguments?: unknown }>
            nextCursor?: unknown
          }
          for (const p of r.prompts ?? []) {
            if (typeof p.name !== 'string') continue
            prompts.push({
              server: name,
              name: p.name,
              ...(typeof p.description === 'string' ? { description: p.description } : {}),
              arguments: Array.isArray(p.arguments)
                ? (p.arguments as Array<{ name?: unknown; description?: unknown; required?: unknown }>)
                    .filter((a) => typeof a.name === 'string')
                    .map((a) => ({ name: String(a.name), ...(typeof a.description === 'string' ? { description: a.description } : {}), ...(a.required === true ? { required: true } : {}) }))
                : [],
            })
          }
          cursor = typeof r.nextCursor === 'string' ? r.nextCursor : undefined
          if (!cursor) break
        }
      } catch (error) {
        // A server without prompts answers -32601; that is not an error to show.
        const message = error instanceof Error ? error.message : String(error)
        if (!/-32601|not found|unknown method/i.test(message)) errors.push(`${name}: ${message}`)
      }
    }
    return { prompts, errors }
  }

  /** CP-11: one prompt rendered by its server (`prompts/get`), as role + text messages. */
  async getPrompt(server: string, name: string, args: Record<string, string> = {}): Promise<{ description?: string; messages: Array<{ role: string; text: string }> }> {
    const client = this.clients.get(server)
    if (!client) throw new Error(`MCP server ${server} is not running`)
    const r = (await client.request('prompts/get', { name, arguments: args })) as {
      description?: unknown
      messages?: Array<{ role?: unknown; content?: { type?: unknown; text?: unknown; resource?: { text?: unknown } } }>
    }
    return {
      ...(typeof r.description === 'string' ? { description: r.description } : {}),
      messages: (r.messages ?? []).map((m) => ({
        role: String(m.role ?? 'user'),
        text: m.content?.type === 'text' ? String(m.content.text ?? '') : m.content?.resource?.text !== undefined ? String(m.content.resource.text) : `[${String(m.content?.type ?? 'content')}]`,
      })),
    }
  }

  /** The system-prompt section listing the tools. */
  renderCatalog(): string {
    if (this.tools.length === 0) return ''
    const shown = this.tools.slice(0, MAX_CATALOG_TOOLS)
    const lines = ['MCP tools (call with mcp_call {"server","tool","args"}):']
    for (const t of shown) {
      lines.push(`- ${t.server}/${t.name}(args: ${jsonSchemaToTs(t.inputSchema)})${t.description ? `: ${t.description.slice(0, 160)}` : ''}`)
    }
    if (this.tools.length > shown.length) lines.push(`(${this.tools.length - shown.length} more not listed)`)
    return lines.join('\n')
  }

  close(): void {
    for (const c of this.clients.values()) c.close()
  }
}
