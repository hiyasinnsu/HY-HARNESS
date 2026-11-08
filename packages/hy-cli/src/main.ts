#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import {
  Agent,
  ExecRpcClient,
  HARNESS_VERSION,
  Hooks,
  Ledger,
  MCP_PROTOCOL_VERSION,
  LspManager,
  McpManager,
  MemoryStore,
  elicitationContent,
  setElicitationHandler,
  describeHooks,
  loadPlugins,
  READ_ONLY_TOOLS,
  MockCompactorProvider,
  MockGraderProvider,
  MockGuardianProvider,
  MODEL_CATALOG,
  SessionLog,
  SessionIndex,
  ToolRuntime,
  createHarnessContext,
  createProvider,
  deriveNotes,
  discoverPinned,
  discoverSkills,
  ensureStateDirs,
  loadConfig,
  listProviderModels,
  parseSandboxMode,
  protectSecret,
  readEvents,
  rebuildHistory,
  resolveServerPath,
  sessionLogPath,
  forkRun,
  FEATURES,
  configPaths,
  assertFeatureName,
  WorktreeManager,
  writeUserConfig,
  type AgentEvent,
  type ApprovalCallback,
  type ApprovalRequest,
  type ChatMessage,
  type ImageInput,
  type ContextManager,
  type CliOverrides,
  type HarnessConfig,
  type HarnessContext,
  type LlmProvider,
  type ProviderKind,
  type RoleConfig,
  type SandboxMode,
  type SessionEvent,
  type Schema,
  type SkillInfo,
  type LoadedPlugins,
  type ToolSpec,
  userConfigDir,
  userConfigJsonSchema,
  usesNativeTools,
  INTERACTION_MODES,
  isInteractionMode,
  isWorkMode,
  WORK_MODES,
} from '../../core/dist/index.js'
import {
  Budget4D,
  Guardian,
  SpillCompaction,
  createApprover,
  renderDigest,
  runVerifierRalph,
} from '../../seams/dist/index.js'
import { bool, parseArgs, str, toOverrides, type Parsed } from './cli-args.js'
import { renderApiSchema } from './api-schema.js'
import { buildDoctorReport, doctorSandbox, findSecretBinary } from './doctor.js'
import { BUILTIN_COMMANDS, chatHelp, formatDoctor, formatHooks, formatUsage } from './chat-commands.js'
import { listThreads, readThread } from './protocol-threads.js'
import { turnCancelMethod, turnStartMethod, turnStatusMethod, turnSteerMethod } from './protocol-turn.js'
import { ApprovalBridge } from './protocol-approvals.js'
import { ERROR, ProtocolRpcError, ProtocolServer, initializeHandler } from './protocol.js'
import {
  Conversation,
  approvals,
  closeServices,
  listRuns,
  lspFor,
  newRunId,
  openClient as openSessionClient,
  pluginSpecs,
  sessionContext,
  sessionHooks,
  sessionMcp,
  sessionPlugins,
  setOutputSchema,
  startServices,
} from './session-app.js'
import { startWebServer } from './web-server.js'
import { createAcpServer } from './acp.js'
import { createSdkServer } from './sdk-server.js'
import { ProtocolHost } from './protocol-host.js'
import { applyImport, importPlanView, planImport, renderImportPlan, type ImportKind } from './import.js'
import { defaultPipePath, listenPipe, listenWebSocket, serveStream } from './protocol-transport.js'
import { DaemonRunningError, claimLock, daemonInfoPath, liveDaemon, newToken, processAlive, readDaemonInfo, stateKey, waitForDaemon, type DaemonInfo } from './daemon.js'
import {
  downloadRelease,
  loadFeed,
  pickRelease,
  publicKeyFingerprint,
  readPublicKey,
  signRelease,
  updateDownloadDir,
  updateKeyPath,
  type ReleaseFeed,
} from './update-feed.js'

/** Opens the execution daemon for this command's flags. */
async function openClient(p: Parsed) {
  return openSessionClient(toOverrides(p), str(p.flags, 'exec-server'))
}

/** `--output-schema`: the final answer of run/resume must be JSON matching it. */
function loadOutputSchema(p: Parsed): void {
  const file = str(p.flags, 'output-schema')
  if (file) setOutputSchema(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as Schema)
}

function usage(): void {
  console.log(`HY-HARNESS

Usage:
  hy run "<request>" [options]
  hy version                              print the version
  hy web [options]                        local Web GUI (Electron uses the same server)
  hy chat [options]                       interactive session (/help inside)
  hy resume <run-id>|--last ["message"]   continue a run (interactive without a message)
  hy fork <run-id> [--turn n]             copy a run's history into a new run
  hy sessions [--search text] [--json] [--limit n]  runs in this workspace, newest first
  hy review [--base <ref>]                read-only review of uncommitted changes (or base...HEAD)
  hy mcp-server [options]                 serve hy_run over MCP (stdio) for other agents
  hy ralph "<objective>" --verify-cmd "<command>" [--verify-cmd ...] [options]
  hy undo <run-id> [options]
  hy checkpoint prune <run-id> [--keep base]
  hy sandbox status|grant|revoke [options]
  hy policy-test "<command>" [options]
  hy config dump|schema|paths [options]   resolved config, the JSON Schema, or layer paths
  hy secret list|set <name>|remove <name> DPAPI-protected API keys (value on stdin for set)
  hy worktree list|create <name>|apply <name>|remove <name> [--base <ref>] [--force] [--no-3way]
  hy protocol schema|serve               JSON Schema of the HTTP API, or JSON-RPC over stdio
  hy serve [start|status|stop] [--daemon] [--ws <port>]  the resident hy-protocol/1 server
  hy import claude|dsh [--yes] [--json] [--only k1,k2]  bring AGENTS.md, MCP, hooks, skills, prompts, memory or sessions over
  hy doctor [--json]                    diagnostics: workspace, sandbox, providers, MCP
  hy features [list|enable <name>|disable <name>] [--json]
  hy index status|rebuild [options]       full-text session index (FTS5) status or a rebuild
  hy models list|discover [--json]       built-in catalog, or the provider's own model list
  hy update check|fetch [--feed <url|path>] [--channel <name>]  signed release feed (Ed25519)
  hy update keygen [--out <dir>] | sign ...   release key, and the JSON entry to publish

Options:
  --cwd <dir>             Workspace root (default: current directory)
  --state-dir <dir>       State directory (default: %LOCALAPPDATA%\\hy-harness\\state\\<id>)
  --provider <kind>       ollama | deepseek | openai-compatible | opencode | gemini | mock
  --model <name>          Model name
  --work-mode <mode>     fast, thorough or reflective (hy run/chat)
  --interaction-mode <m> autonomous (default) or collaborative (hy run/chat)
  --base-url <url>        Provider base URL
  --api-key-env <name>    Environment variable holding the API key
  --sandbox <mode>        workspace-write (default) | read-only | unconfined
                          (low-integrity only through user-policy rules)
  --unsafe-unconfined     Run without a sandbox (same as --sandbox unconfined; not recommended)
  --approval <policy>     untrusted (default) | on-request | on-failure | never (CP-05)
  --max-rounds <n>        ralph: rounds (default 5)
  --max-total-tokens <n>  ralph: tokens across all roles (default 500000)
  --max-cost-usd <n|off>  ralph: USD across all roles (default 2.00; needs role pricing)
  --max-wall-clock-ms <n> ralph: wall-clock limit (default 1800000)
  --round-timeout-ms <n>  ralph: abort and roll back a round after this long
  --no-grader             ralph: skip Gate 2 (the grader); not recommended
  --unattended-ok         ralph: allow an untrusted project (reads/network are not confined)
  --allow-protected-edits Allow ralph to edit protectedPaths
  --yes                   Auto-approve prompt decisions
  --full-auto             workspace-write sandbox; approve prompts that run confined (others still ask)
  --profile <name>        Apply profiles.<name> from the user config (its bundles apply too)
  --bundle <name>         Typed bundle layered on core (core|ptc|minimal|audit|orchestrator|worker); repeatable
  --text-tools            JSON text tool protocol instead of native function calling
  --memory                Workspace memory across runs (the memory tool; notes in the state directory)
  --guardian              Let Guardian review prompt decisions (never unconfined/low-integrity)
  --rule "<text>"         Pin a constraint for this run (repeatable; kept verbatim across compaction)
  --ptc                   Advertise run_code (Programmatic Tool Calling)
  --mock                  Use the deterministic mock provider
  --trust                 Trust the project's .hy-harness config and policy
  --exec-server <path>    Path to hy-exec-server
  --port <n>              web: port (default 3080; 0 picks a free port)
  --host <addr>           web: bind address (default 127.0.0.1)
  --tailscale             web: bind to the Tailscale IPv4 and print a phone URL
  --tls-cert <pem>        web: serve HTTPS with this certificate chain (needs --tls-key)
  --tls-key <pem>         web: PEM private key for --tls-cert
  --trusted-host <a>      web: also accept this Host authority (repeatable; name the public host)
  --public-url <url>      web: advertise this HTTP(S) root behind a prefix-stripping proxy
  --show-secrets          config dump: print stored keys instead of ***
  --no-open               web: do not open the browser
  --web                   Offer web_fetch (each fetch asks unless the host is in web.allowDomains)
  --session-query         Offer session_query (FTS5 search of earlier sessions in this workspace)
  --persistent-shell      Keep one PowerShell alive so cd and variables persist (unconfined only)
  --feed <url|path>       update: the signed release feed (or update.feed in the user config)
  --channel <name>        update: the release channel (default stable)
  --public-key <pem|file> update: the Ed25519 key that signs the feed (or update.publicKey)
  --out <dir>             update keygen/fetch: where the key pair or the installer goes
  --key <file>            update sign: the Ed25519 private key
  --json                  run/chat/resume: print events as JSON lines on stdout
  --output-last-message <file>  Write the final answer to a file
  --output-schema <file>  run/resume: the final answer must be JSON matching this JSON Schema
  --image <file>          run/resume: attach an image (repeatable; needs a vision model)
  -h, --help              Show this help`)
}


async function approveInteractive(request: ApprovalRequest): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const suffix = request.justification ? ` (${request.justification})` : ''
    const answer = await rl.question(`\nApprove command? ${request.command}${suffix} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/** Lines from stdin, one at a time; shared by `hy chat` and its approval prompts. */
class LineReader {
  private readonly queue: string[] = []
  private readonly waiters: Array<(line: string | undefined) => void> = []
  private closed = false
  private readonly rl: readline.Interface

  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, terminal: false })
    this.rl.on('line', (line) => {
      const w = this.waiters.shift()
      if (w) w(line)
      else this.queue.push(line)
    })
    this.rl.on('close', () => {
      this.closed = true
      for (const w of this.waiters.splice(0)) w(undefined)
    })
  }

  /** The next line, or undefined at end of input. */
  next(prompt?: string): Promise<string | undefined> {
    if (prompt !== undefined) process.stderr.write(prompt)
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closed) return Promise.resolve(undefined)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  close(): void {
    this.rl.close()
  }
}

/** Prints agent events: JSONL on stdout with `--json` (Codex `exec --json` style), else a log on stderr. */

/** The text of the changes `hy review` looks at: uncommitted work, or `base...HEAD`. */
function reviewDiff(cwd: string, base?: string): { diff: string; untracked: string[] } {
  const git = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const d = base ? git(['diff', '--no-color', `${base}...HEAD`]) : git(['diff', '--no-color', 'HEAD'])
  if (d.status !== 0) throw new Error(`git diff failed: ${d.stderr.trim()}`)
  const untracked = base ? [] : git(['ls-files', '--others', '--exclude-standard']).stdout.split('\n').filter(Boolean)
  return { diff: d.stdout, untracked }
}

const REVIEW_MAX_DIFF = 60_000

/** The task given to the read-only review agent (Codex `/review`). */
function reviewTask(base: string | undefined, diff: string, untracked: string[]): string {
  const shown = diff.length > REVIEW_MAX_DIFF ? `${diff.slice(0, REVIEW_MAX_DIFF)}\n… [diff truncated; read the files for the rest]` : diff
  return [
    `Review the changes ${base ? `on this branch against ${base}` : 'in the working tree (uncommitted)'} for correctness.`,
    'Look for bugs, regressions, security problems and missing tests; read surrounding code when the diff is not enough.',
    'Report each finding as: severity (high/medium/low), file:line, what is wrong, and why it matters. Do not report style nits.',
    'If you find nothing that needs fixing, say so plainly. Finish with {"final":"<findings>"}.',
    '',
    '```diff',
    shown,
    '```',
    ...(untracked.length > 0 ? ['', `Untracked new files (read them): ${untracked.slice(0, 50).join(', ')}`] : []),
  ].join('\n')
}

/** `/init` (Codex): draft an AGENTS.md from the repository. */
const INIT_PROMPT =
  // Index and traps, not a map (Zed / Sentry, 2026-11-07): every session loads
  // AGENTS.md, structure descriptions go stale, and agents read the code.
  // Keep in sync with the GUI's copy in web/src/app.ts.
  'Create an AGENTS.md at the workspace root for coding agents working in this repository. Inspect the repository first ' +
  '(README, package manifests, build and test scripts, directory layout). Write an index and the traps, not a map; ' +
  'keep it under 60 lines. Include: (1) one or two lines on what the project is; (2) the exact commands to build, test ' +
  'and lint, and how to run a single test; (3) where things live, one line per area, only where the names do not make it ' +
  'obvious; (4) traps: mistakes an experienced contributor would still make here. Add a trap only if it is non-obvious, ' +
  'specific enough to act on, and backed by something you saw in this repository, not general good practice. Do not ' +
  'describe the code structure in detail: agents read the code, and such descriptions go stale. Do not invent commands. ' +
  'If AGENTS.md already exists, rewrite it the same way and keep what is still right.'

/** Custom prompts (Codex custom prompts): `prompts/<name>.md` in the user directory or `.hy-harness/prompts`. */
function loadPrompts(workspaceRoot: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const dir of [path.join(userConfigDir(), 'prompts'), path.join(workspaceRoot, '.hy-harness', 'prompts')]) {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      const m = /^([a-z0-9][a-z0-9_-]*)\.md$/i.exec(n)
      if (m) out.set(m[1]!.toLowerCase(), fs.readFileSync(path.join(dir, n), 'utf8'))
    }
  }
  return out
}

/** `$ARGUMENTS` is the whole argument string; `$1`…`$9` are its words. */
export function expandPrompt(template: string, args: string): string {
  const words = args.split(/\s+/).filter(Boolean)
  return template.replace(/\$ARGUMENTS/g, args).replace(/\$([1-9])/g, (_, d: string) => words[Number(d) - 1] ?? '')
}


const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

/** `--image <file>` (repeatable): attached to the request (Codex `--image`). */
function loadImages(p: Parsed): ImageInput[] {
  return (p.lists.image ?? []).map((file) => {
    const mimeType = IMAGE_TYPES[path.extname(file).toLowerCase()]
    if (!mimeType) throw new Error(`unsupported image type: ${file} (png, jpg, gif, webp)`)
    return { mimeType, data: fs.readFileSync(path.resolve(file)).toString('base64') }
  })
}

/** Writes the final message where `--output-last-message` asks (Codex `exec -o`). */
function writeLastMessage(p: Parsed, text: string): void {
  const file = str(p.flags, 'output-last-message')
  if (file) fs.writeFileSync(path.resolve(file), `${text}\n`, 'utf8')
}

/** `--work-mode` and `--interaction-mode`; each is independent of the other. */
function applyWorkModeOption(conv: Conversation, p: Parsed): void {
  if (p.flags['work-mode'] !== undefined) {
    const mode = str(p.flags, 'work-mode')
    if (!isWorkMode(mode)) throw new Error(`--work-mode must be one of ${WORK_MODES.join(', ')}`)
    conv.setWorkMode(mode)
  }
  if (p.flags['interaction-mode'] !== undefined) {
    const interaction = str(p.flags, 'interaction-mode')
    if (!isInteractionMode(interaction)) throw new Error(`--interaction-mode must be one of ${INTERACTION_MODES.join(', ')}`)
    conv.setInteractionMode(interaction)
  }
}

async function run(p: Parsed): Promise<number> {
  const objective = p.positional[0]
  if (!objective) {
    console.error('hy run: missing request')
    usage()
    return 2
  }
  const json = bool(p.flags, 'json')
  const { config, client } = await openClient(p)
  try {
    console.error(`[hy] workspace: ${config.workspaceRoot}`)
    console.error(`[hy] provider: ${config.role.provider}/${config.role.model}`)
    if (!(await reportSandbox(client, config.sandbox, config.sandboxSource))) return 2
    if (config.guardianRole) console.error(`[hy] guardian: ${config.guardianRole.provider}/${config.guardianRole.model}`)
    await startServices(config)
    loadOutputSchema(p)
    const conv = Conversation.create(config, client, newRunId(), json)
    applyWorkModeOption(conv, p)
    console.error(`[hy] run: ${conv.runId} (hy resume ${conv.runId} continues it)`)
    const final = await conv.turn(objective, loadImages(p))
    await conv.end()
    if (json) console.log(JSON.stringify({ runId: conv.runId, type: 'turn/final', content: final }))
    else console.log(`\n${final}`)
    writeLastMessage(p, final)
    console.error(`\n[hy] ${conv.status().split('\n').at(-1)}`)
    console.error(`[hy] session log: ${sessionLogPath(config.stateDir)}`)
    return 0
  } finally {
    await client.stop()
  }
}

/** `hy review [--base <ref>]`: a read-only review of the changes (Codex `/review`). */
async function review(p: Parsed): Promise<number> {
  const base = str(p.flags, 'base')
  const { config, client } = await openClient(p)
  try {
    const { diff, untracked } = reviewDiff(config.workspaceRoot, base)
    if (!diff.trim() && untracked.length === 0) {
      console.log('nothing to review')
      return 0
    }
    const json = bool(p.flags, 'json')
    const conv = Conversation.create(config, client, newRunId(), json)
    console.error(`[hy] reviewing ${base ? `${base}...HEAD` : 'uncommitted changes'} (read-only)`)
    const { final } = await conv.delegate(reviewTask(base, diff, untracked), true)
    await conv.end()
    if (json) console.log(JSON.stringify({ type: 'review', content: final }))
    else console.log(final)
    writeLastMessage(p, final)
    return 0
  } finally {
    await client.stop()
  }
}

/**
 * `hy mcp-server`: HY-HARNESS as a stdio MCP server (Codex `mcp-server`), so
 * other agents and IDEs can hand it tasks. One tool, `hy_run`: a prompt, and
 * optionally the runId of an earlier call to continue that conversation.
 * Approvals are headless: `--yes`, `--full-auto` or Guardian, else denied.
 * stdout carries only protocol messages; logs go to stderr.
 */
async function mcpServer(p: Parsed): Promise<number> {
  const { config, client } = await openClient(p)
  const conversations = new Map<string, Conversation>()
  const turnControllers = new Map<string, AbortController>()
  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`)
  const tool = {
    name: 'hy_run',
    description: `Run a coding task with HY-HARNESS in ${config.workspaceRoot} and return its final answer. Pass runId from an earlier result to continue that conversation.`,
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, runId: { type: 'string' } },
      required: ['prompt'],
    },
  }
  // One request at a time: turns share the workspace.
  let queue: Promise<void> = Promise.resolve()
  try {
    if (!(await reportSandbox(client, config.sandbox, config.sandboxSource))) return 2
    await startServices(config)
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    for await (const line of rl) {
      if (!line.trim()) continue
      let msg: { id?: number | string; method?: string; params?: Record<string, unknown> }
      try {
        msg = JSON.parse(line)
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
        continue
      }
      if (msg.id === undefined) continue // notifications
      const id = msg.id
      switch (msg.method) {
        case 'initialize':
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: String(msg.params?.protocolVersion ?? MCP_PROTOCOL_VERSION),
              capabilities: { tools: {} },
              serverInfo: { name: 'hy-harness', version: HARNESS_VERSION },
            },
          })
          break
        case 'ping':
          send({ jsonrpc: '2.0', id, result: {} })
          break
        case 'tools/list':
          send({ jsonrpc: '2.0', id, result: { tools: [tool] } })
          break
        case 'tools/call': {
          const args = (msg.params?.arguments ?? {}) as { prompt?: unknown; runId?: unknown }
          if (msg.params?.name !== 'hy_run' || typeof args.prompt !== 'string') {
            send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'hy_run needs a string prompt' } })
            break
          }
          queue = queue.then(async () => {
            try {
              const runId = typeof args.runId === 'string' ? args.runId : newRunId()
              let conv = conversations.get(runId)
              if (!conv) {
                conv = Conversation.create(config, client, runId, false)
                conversations.set(runId, conv)
              }
              const final = await conv.turn(String(args.prompt))
              send({
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: final }], structuredContent: { runId, final }, isError: false },
              })
            } catch (error) {
              send({
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true },
              })
            }
          })
          break
        }
        default:
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(msg.method)}` } })
      }
    }
    await queue
    return 0
  } finally {
    await client.stop()
  }
}

/** The interactive loop (`hy chat`, `hy resume` without a message). */
async function chatLoop(p: Parsed, config: HarnessConfig, client: ExecRpcClient, runId: string): Promise<number> {
  const json = bool(p.flags, 'json')
  const reader = new LineReader()
  const ask = async (request: ApprovalRequest) => {
    const suffix = request.justification ? ` (${request.justification})` : ''
    const answer = await reader.next(`\nApprove command? ${request.command}${suffix} [y/N] `)
    return /^y(es)?$/i.test((answer ?? '').trim())
  }
  const answer = async (question: string) => (await reader.next(`\n[agent asks] ${question}\n> `)) ?? ''
  // CP-11: an MCP server asking for input is answered at the prompt.
  setElicitationHandler(async (request) =>
    elicitationContent(request.requestedSchema, (await reader.next(`\n[MCP ${request.server} asks] ${request.message}\n> `)) ?? ''),
  )
  let conv = Conversation.create(config, client, runId, json, ask, answer)
  applyWorkModeOption(conv, p)
  const prompts = loadPrompts(config.workspaceRoot)
  console.error(`[hy] run: ${conv.runId}${conv.turns > 0 ? ` (resumed after ${conv.turns} turn(s))` : ''}. /help for commands.`)
  const doTurn = async (text: string) => {
    try {
      const final = await conv.turn(text)
      if (json) console.log(JSON.stringify({ runId: conv.runId, type: 'turn/final', content: final }))
      else console.log(`\n${final}`)
      writeLastMessage(p, final)
    } catch (error) {
      // A failed turn (step limit, Guardian breaker) does not end the session.
      console.error(`[hy] turn failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    for (;;) {
      const line = await reader.next('\nhy> ')
      if (line === undefined) break
      const text = line.trim()
      if (!text) continue
      if (text.startsWith('/')) {
        const cmd = text.split(/\s+/)[0]!
        const rest = text.slice(cmd.length).trim()
        if (cmd === '/exit' || cmd === '/quit') break
        if (cmd === '/init') {
          await doTurn(INIT_PROMPT)
          continue
        }
        const custom = prompts.get(cmd.slice(1).toLowerCase())
        if (custom !== undefined && !BUILTIN_COMMANDS.has(cmd)) {
          await doTurn(expandPrompt(custom, rest))
          continue
        }
        let out: string
        switch (cmd) {
          case '/review':
            try {
              const { diff, untracked } = reviewDiff(config.workspaceRoot, rest || undefined)
              out =
                !diff.trim() && untracked.length === 0
                  ? 'nothing to review'
                  : (await conv.delegate(reviewTask(rest || undefined, diff, untracked), true)).final
            } catch (error) {
              out = `review failed: ${error instanceof Error ? error.message : String(error)}`
            }
            break
          case '/compact':
            out = await conv.compact()
            break
          case '/plan-mode':
            out = conv.setPlanMode(rest !== 'off')
            break
          case '/interaction-mode':
            out = isInteractionMode(rest) ? conv.setInteractionMode(rest) : rest ? `usage: /interaction-mode [${INTERACTION_MODES.join('|')}]` : `interaction mode: ${conv.currentInteractionMode()}`
            break
          case '/work-mode':
            out = isWorkMode(rest) ? conv.setWorkMode(rest) : rest ? `usage: /work-mode [${WORK_MODES.join('|')}]` : `work mode: ${conv.currentWorkMode()}`
            break
          case '/model':
            out = rest ? conv.setModel(rest) : `model: ${config.role.provider}/${config.role.model}`
            break
          case '/help':
            out = chatHelp()
            break
          case '/status':
            out = conv.status()
            break
          case '/diff':
            out = await conv.diff()
            break
          case '/undo':
            out = await conv.undo()
            break
          case '/notes':
            out = conv.notes()
            break
          case '/plan':
            out = conv.plan()
            break
          case '/skills':
            out = conv.skillList()
            break
          // CP-32: the same commands as the GUI.
          case '/usage':
            out = formatUsage(conv.usageSnapshot())
            break
          case '/mcp':
            out = sessionMcp?.renderCatalog() || 'no MCP tools (configure mcpServers)'
            break
          case '/plugins': {
            const tools = pluginSpecs()
            out = tools.length ? tools.map((t) => `${t.name}: ${t.description}`).join('\n') : 'no plugin tools'
            break
          }
          case '/memories':
            out = config.memory ? MemoryStore.forStateDir(config.stateDir).render() || 'workspace memory is empty' : 'workspace memory is off (memory: true enables it)'
            break
          case '/hooks':
            out = formatHooks(describeHooks(config.hooks))
            break
          case '/doctor':
            out = formatDoctor(await doctorReport(config, client))
            break
          case '/config':
            out = Object.entries(configPaths(config.workspaceRoot, config.stateDir))
              .map(([name, value]) => `${name}: ${value}`)
              .join('\n')
            break
          case '/new':
            conv = Conversation.create(config, client, newRunId(), json, ask, answer)
            out = `new run: ${conv.runId}`
            break
          default:
            out = `unknown command ${cmd}; /help lists them`
        }
        if (json) console.log(JSON.stringify({ runId: conv.runId, type: 'command', command: cmd, output: out }))
        else console.error(out)
        continue
      }
      await doTurn(text)
    }
  } finally {
    reader.close()
  }
  console.error(`[hy] hy resume ${conv.runId} continues this run`)
  return 0
}

async function chat(p: Parsed): Promise<number> {
  const { config, client } = await openClient(p)
  try {
    console.error(`[hy] workspace: ${config.workspaceRoot}`)
    console.error(`[hy] provider: ${config.role.provider}/${config.role.model}`)
    if (!(await reportSandbox(client, config.sandbox, config.sandboxSource))) return 2
    await startServices(config)
    return await chatLoop(p, config, client, newRunId())
  } finally {
    await client.stop()
  }
}


async function sessions(p: Parsed): Promise<number> {
  const config = loadConfig(toOverrides(p))
  const logPath = sessionLogPath(config.stateDir)
  const events = readEvents(logPath)
  let runs = listRuns(events)
  const limit = Number(str(p.flags, 'limit') ?? 20)
  // --search: FTS5 over the session log (WP-32), with the old linear scan as a
  // fallback when the index cannot be opened (older Node, locked file).
  const search = str(p.flags, 'search')?.toLowerCase()
  if (search) {
    let hitRunIds: Set<string> | undefined
    try {
      const index = SessionIndex.open(config.stateDir, config.workspaceRoot)
      try {
        index.sync(logPath)
        hitRunIds = new Set(index.search(search, { limit: 500 }).map((hit) => hit.runId.split('.sub')[0]!))
      } finally {
        index.close()
      }
    } catch (error) {
      console.error(`[hy] search index unavailable (${error instanceof Error ? error.message : String(error)}); scanning the log instead`)
    }
    if (!hitRunIds) {
      hitRunIds = new Set(
        events
          .filter((e) => (e.type === 'user/message' || e.type === 'assistant/message') && e.runId)
          .filter((e) => String((e.payload as { content?: unknown }).content ?? '').toLowerCase().includes(search))
          .map((e) => e.runId!.split('.sub')[0]!),
      )
    }
    runs = runs.filter((r) => hitRunIds!.has(r.runId))
  }
  if (bool(p.flags, 'json')) {
    console.log(JSON.stringify(runs.slice(0, limit), null, 2))
    return 0
  }
  if (runs.length === 0) {
    console.log('no runs in this workspace yet')
    return 0
  }
  for (const r of runs.slice(0, limit)) {
    const when = new Date(r.last).toISOString().replace('T', ' ').slice(0, 19)
    const kind = r.ralph ? 'ralph' : `${r.turns} turn(s)`
    console.log(`${r.runId}  ${when}  ${kind.padEnd(10)}  ${r.first.replace(/\s+/g, ' ').slice(0, 70)}`)
  }
  return 0
}

/** `hy models list [--json]`: the built-in model catalog and this session's roles. */
async function modelsCommand(p: Parsed): Promise<number> {
  const config = loadConfig(toOverrides(p))
  // hy models discover: ask the worker's provider which models it offers.
  if (p.positional[0] === 'discover') {
    try {
      const models = await listProviderModels(config.role)
      if (bool(p.flags, 'json')) console.log(JSON.stringify({ provider: config.role.provider, models }, null, 2))
      else for (const model of models) console.log(model)
      return 0
    } catch (error) {
      console.error(`hy models discover: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  const roles: Record<string, RoleConfig> = {
    worker: config.role,
    orchestrator: config.orchestratorRole,
    subagent: config.subagentRole,
    grader: config.graderRole,
    compactor: config.compactorRole,
    summarizer: config.summarizerRole,
  }
  const active = Object.fromEntries(
    Object.entries(roles).map(([name, role]) => [name, { provider: role.provider, model: role.model }]),
  )
  if (bool(p.flags, 'json')) {
    console.log(JSON.stringify({ models: MODEL_CATALOG, active }, null, 2))
    return 0
  }
  console.log('provider              model                       context   max out   tools  vision  reasoning')
  for (const entry of MODEL_CATALOG) {
    const isActive = Object.values(roles).some((role) => role.provider === entry.provider && role.model === entry.model)
    const caps = entry.capabilities
    console.log(
      `${isActive ? '*' : ' '} ${entry.provider.padEnd(20)} ${entry.model.padEnd(26)} ${String(entry.contextWindowTokens).padStart(8)}  ${String(entry.maxOutputTokens).padStart(8)}  ${caps.tools ? 'yes  ' : 'no   '}  ${caps.vision ? 'yes   ' : 'no      '}  ${caps.reasoning ? 'yes' : 'no'}`,
    )
  }
  const listed = new Set(MODEL_CATALOG.map((entry) => `${entry.provider}:${entry.model}`))
  const missing = Object.entries(active).filter(([, role]) => !listed.has(`${role.provider}:${role.model}`))
  if (missing.length > 0) {
    console.log(`\nnot in the catalog (the role's own limits apply): ${missing.map(([name, role]) => `${name}=${role.provider}:${role.model}`).join(', ')}`)
  }
  console.log('\n* = a role uses this model. `hy models list --json` prints the raw catalog.')
  return 0
}

/** `hy index status|rebuild [--state-dir]`: the FTS5 session index (WP-32). */
function indexCommand(p: Parsed): number {
  const config = loadConfig(toOverrides(p))
  const logPath = sessionLogPath(config.stateDir)
  const action = p.positional[0] ?? 'status'
  try {
    const index = SessionIndex.open(config.stateDir, config.workspaceRoot)
    try {
      if (action === 'rebuild') {
        const added = index.rebuild(logPath)
        console.log(`rebuilt ${index.file}: ${added} event(s)`)
        return 0
      }
      if (action !== 'status') {
        console.error(`hy index: unknown action ${action}; use status or rebuild`)
        return 2
      }
      const added = index.sync(logPath)
      const status = index.status()
      console.log(`${status.path}`)
      console.log(`  files ${status.files}, sessions ${status.sessions}, events ${status.events}, ${status.bytes} bytes${added > 0 ? ` (+${added} just now)` : ''}`)
      return 0
    } finally {
      index.close()
    }
  } catch (error) {
    console.error(`hy index: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/** `hy resume <run-id>|--last ["message"]`: continues a run's conversation. */
async function resume(p: Parsed): Promise<number> {  const config = loadConfig(toOverrides(p))
  const runs = listRuns(readEvents(sessionLogPath(config.stateDir)))
  const last = bool(p.flags, 'last')
  const runId = last ? runs.find((r) => !r.ralph)?.runId : p.positional[0]
  const message = last ? p.positional[0] : p.positional[1]
  const target = runs.find((r) => r.runId === runId)
  if (!runId || !target) {
    console.error(`hy resume: ${runId ? `unknown run ${runId}` : 'no run to resume'}; hy sessions lists them`)
    return 2
  }
  if (target.ralph) {
    console.error(`hy resume: ${runId} is a ralph run; start a new hy ralph instead`)
    return 2
  }
  const { client } = await openClient(p)
  try {
    if (!(await reportSandbox(client, config.sandbox, config.sandboxSource))) return 2
    await startServices(config)
    if (message === undefined) return await chatLoop(p, config, client, runId)
    const json = bool(p.flags, 'json')
    loadOutputSchema(p)
    const conv = Conversation.create(config, client, runId, json)
    console.error(`[hy] resumed ${runId} after ${conv.turns} turn(s)`)
    const final = await conv.turn(message, loadImages(p))
    if (json) console.log(JSON.stringify({ runId, type: 'turn/final', content: final }))
    else console.log(`\n${final}`)
    writeLastMessage(p, final)
    return 0
  } finally {
    await client.stop()
  }
}

/**
 * Prints the sandbox state, notices and gaps at session start (NFR: report
 * `enforcement` and `gaps` at every session start). Fails closed when the
 * requested confined mode is unavailable.
 */
async function reportSandbox(
  client: ExecRpcClient,
  mode: SandboxMode,
  source: HarnessConfig['sandboxSource'] = 'config',
): Promise<boolean> {
  const status = await client.sandboxStatus()
  console.error(`[hy] sandbox: ${mode} (enforcement: ${status.enforcement})`)
  if (source === 'default' && mode !== 'unconfined') {
    console.error('[hy] sandbox defaulted to workspace-write; pass --unsafe-unconfined to opt out (not recommended)')
  }
  for (const notice of status.notices ?? []) console.error(`[hy] ${notice}`)
  for (const gap of status.gaps) console.error(`[hy] gap: ${gap}`)
  if ((status.denyRead ?? []).length > 0) {
    console.error(`[hy] denyRead: ${status.denyRead!.length} path(s) are not readable by confined commands`)
  }
  for (const failed of status.denyReadFailed ?? []) console.error(`[hy] denyRead failed: ${failed}`)
  if ((status.readOnly ?? []).length > 0) {
    console.error(`[hy] readOnly: ${status.readOnly!.length} path(s) are not writable by confined commands`)
  }
  for (const failed of status.readOnlyFailed ?? []) console.error(`[hy] readOnly failed: ${failed}`)
  if (mode !== 'unconfined' && !status.workspaceWriteAvailable) {
    console.error(`[hy] sandbox ${mode} is unavailable: ${status.unavailableReason ?? 'unknown reason'}`)
    return false
  }
  return true
}

async function sandbox(p: Parsed): Promise<number> {
  const action = p.positional[0] ?? 'status'
  if (!['status', 'grant', 'revoke'].includes(action)) {
    console.error(`hy sandbox: unknown action ${action}; expected status, grant or revoke`)
    return 2
  }
  const { config, client } = await openClient(p)
  try {
    if (action === 'grant') {
      const result = await client.sandboxGrant()
      console.log(JSON.stringify({ workspace: config.workspaceRoot, ...result }, null, 2))
      return result.failed > 0 ? 1 : 0
    }
    if (action === 'revoke') {
      const result = await client.sandboxRevoke()
      console.log(JSON.stringify({ workspace: config.workspaceRoot, ...result }, null, 2))
      return result.failed > 0 ? 1 : 0
    }
    const status = await client.sandboxStatus()
    console.log(JSON.stringify({ workspace: config.workspaceRoot, ...status }, null, 2))
    return 0
  } finally {
    await client.stop()
  }
}

async function policyTest(p: Parsed): Promise<number> {
  const command = p.positional[0]
  if (!command) {
    console.error('hy policy-test: missing command')
    return 2
  }
  const { client } = await openClient(p)
  try {
    const evalResult = await client.policyEvaluate(command)
    console.log(JSON.stringify(evalResult, null, 2))
    return 0
  } finally {
    await client.stop()
  }
}

async function ralph(p: Parsed): Promise<number> {
  const objective = p.positional[0]
  const verifyCmds = p.lists['verify-cmd'] ?? []
  if (!objective || verifyCmds.length === 0) {
    console.error('hy ralph: an objective and at least one --verify-cmd are required')
    return 2
  }
  const runId = `run-${Date.now().toString(36)}`
  const { config, client } = await openClient(p)
  try {
    console.error(`[hy] ralph ${runId}: workspace=${config.workspaceRoot}`)
    // OQ-3: reads and network are not confined, so unattended runs on
    // repositories the user has not trusted are refused by default.
    if (!config.projectTrusted && !bool(p.flags, 'unattended-ok')) {
      console.error('[hy] ralph refuses untrusted projects by default; pass --trust if you trust this repository, or --unattended-ok')
      return 2
    }
    if (!(await reportSandbox(client, config.sandbox, config.sandboxSource))) return 2
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: config.workspaceRoot, encoding: 'utf8' }).stdout?.trim()
    if (dirty) console.error(`[hy] warning: the working tree has uncommitted changes; hy undo ${runId} returns to this state`)

    const noGrader = bool(p.flags, 'no-grader')
    const roles: Record<string, RoleConfig> = {
      worker: config.role,
      compactor: config.compactorRole,
      ...(noGrader ? {} : { grader: config.graderRole }),
      ...(config.guardianRole ? { guardian: config.guardianRole } : {}),
    }
    let budget: Budget4D
    try {
      const { maxCostUsd, ...limits } = config.budget
      budget = new Budget4D(
        maxCostUsd === undefined ? limits : { ...limits, maxCostUsd },
        Object.fromEntries(Object.entries(roles).map(([role, r]) => [role, r.pricing])),
      )
    } catch (error) {
      console.error(`[hy] ${error instanceof Error ? error.message : String(error)}`)
      return 2
    }
    if (noGrader) console.error('[hy] warning: --no-grader skips Gate 2; only the --verify-cmd gate decides')
    const worker = budget.meter(createProvider(config.role, config.workspaceRoot, runId), 'worker')
    const grader = noGrader
      ? undefined
      : budget.meter(
          config.graderRole.provider === 'mock' ? new MockGraderProvider() : createProvider(config.graderRole, config.workspaceRoot, runId),
          'grader',
        )
    const { approve, guardian } = approvals(config, objective, budget, undefined, runId, sessionHooks(config))
    if (config.guardianRole) console.error(`[hy] guardian: ${config.guardianRole.provider}/${config.guardianRole.model}`)
    const logFile = sessionLogPath(config.stateDir)
    const runLog = new SessionLog(logFile)
    runLog.setRun(runId)
    const allowProtected = bool(p.flags, 'allow-protected-edits')
    const skills = discoverSkills(config.workspaceRoot)
    await startServices(config)
    const mcp = sessionMcp
    const hooks = sessionHooks(config)
    const roundTimeout = str(p.flags, 'round-timeout-ms')

    const interrupt = new AbortController()
    const onSigint = () => {
      console.error('\n[hy] interrupted; rolling back the current round')
      interrupt.abort()
    }
    process.once('SIGINT', onSigint)
    try {
      const result = await runVerifierRalph({
        exec: client,
        runId,
        objective,
        verifyCmds,
        budget,
        protectedPaths: config.protectedPaths,
        allowProtectedEdits: allowProtected,
        ...(grader ? { grader } : {}),
        pinned: discoverPinned(config.workspaceRoot, config.rules),
        workerNotes: () => deriveNotes(readEvents(logFile), runId),
        ...(roundTimeout !== undefined ? { roundTimeoutMs: Number(roundTimeout) } : {}),
        signal: interrupt.signal,
        log: (type, payload) => runLog.append(type, payload),
        report: (line) => console.error(`[hy] ${line}`),
        runRound: async (round, prompt, signal) => {
          guardian?.reset()
          // A fresh child session: its own log session and read hashes; the
          // run's ledger is rebuilt from the log (design §7, §8).
          const log = new SessionLog(logFile)
          log.setRun(runId, round)
          const { ledger, spillDir, context } = sessionContext(config, log, runId, budget, hooks)
          // CP-44: log every approval with Guardian's evidence for the round.
          const roundApprove: ApprovalCallback = async (request) => {
            const decision = await approve(request)
            const d = typeof decision === 'boolean' ? { approved: decision, by: 'user' as const } : decision
            log.append('approval/decision', {
              command: request.command,
              ...(request.sandbox !== undefined ? { sandbox: request.sandbox } : {}),
              approved: d.approved,
              by: d.by,
              ...(d.reason !== undefined ? { reason: d.reason } : {}),
              ...(d.evidence !== undefined ? { evidence: d.evidence } : {}),
            })
            return decision
          }
          const tools = new ToolRuntime(client, config.workspaceRoot, roundApprove, !allowProtected, {
            contextWindowTokens: config.role.contextWindowTokens,
            ledger,
            spillDir,
            objective: true,
            runId,
            skills,
            signal,
            ...(mcp ? { mcp } : {}),
            ...(hooks ? { hooks } : {}),
            ...(config.web ? { web: config.web } : {}),
            ...(lspFor(config) ? { lsp: lspFor(config)! } : {}),
            ...(sessionPlugins?.tools.size ? { plugins: sessionPlugins.tools } : {}),
            ...(config.memory ? { memory: MemoryStore.forStateDir(config.stateDir) } : {}),
          })
          // CP-44: Guardian judges the command against what the round has done.
          guardian?.setContext(() => tools.recentActivity())
          const roundCtx = createHarnessContext({
            execRpc: client,
            llm: worker,
            sessionLog: log,
            ledger,
            spillStore: context,
            tools,
            ...(guardian ? { guardian } : {}),
          })
          try {
            const agent = new Agent({
              ...(hooks ? { hooks } : {}),
              provider: worker,
              tools,
              sessionLog: log,
              workspaceRoot: config.workspaceRoot,
              maxOutputTokens: config.role.maxOutputTokens,
              reasoningHistory: config.reasoningHistory,
              promptVariant: config.promptVariant,
              temperature: config.role.temperature ?? 0,
              nativeTools: usesNativeTools(config.role),
              ptc: config.ptc,
              objective: true,
              ledger,
              context,
              skills,
              web: config.web !== undefined,
              search: config.web?.searchUrl !== undefined,
              lsp: lspFor(config) !== undefined,
              extraTools: pluginSpecs(),
              ...(config.memory ? { memory: MemoryStore.forStateDir(config.stateDir) } : {}),
              ...(mcp ? { mcpCatalog: mcp.renderCatalog() || 'MCP servers are configured, but none is running; mcp_call has no tools to call.' } : {}),
              onEvent: (event) => {
                if (event.type === 'tool') console.error(`[r${round}] tool ${String(event.name)}`)
                if (event.type === 'tool-error') console.error(`[r${round}] tool error: ${String(event.message)}`)
              },
            })
            return await agent.run(prompt)
          } finally {
            await roundCtx.stop()
          }
        },
      })
      console.error(`[hy] ${result.outcome} after ${result.rounds} round(s); budget ${JSON.stringify(budget.snapshot())}`)
      if (result.outcome === 'succeeded') {
        console.log(`Succeeded in round ${result.rounds}: ${result.final ?? ''}`)
        console.error(`[hy] hy undo ${runId} reverts the whole run`)
        return 0
      }
      if (result.digest) console.error(renderDigest(result.digest))
      return 1
    } finally {
      process.removeListener('SIGINT', onSigint)
    }
  } finally {
    await client.stop()
  }
}

async function checkpoint(p: Parsed): Promise<number> {
  const [action, runId] = p.positional
  if (action !== 'prune' || !runId) {
    console.error('hy checkpoint prune <run-id> [--keep base,r1]')
    return 2
  }
  const keep = (str(p.flags, 'keep') ?? '').split(',').filter(Boolean)
  const { client } = await openClient(p)
  try {
    console.log(JSON.stringify(await client.checkpointPrune(runId, keep), null, 2))
    return 0
  } finally {
    await client.stop()
  }
}

async function undo(p: Parsed): Promise<number> {
  const runId = p.positional[0]
  if (!runId) {
    console.error('hy undo: missing run id')
    return 2
  }
  const { client } = await openClient(p)
  try {
    // ralph runs start at `base`; run/chat runs at their first turn's `t1`.
    let result
    try {
      result = await client.checkpointRollback(runId, 'base')
    } catch {
      result = await client.checkpointRollback(runId, 't1')
    }
    console.log(JSON.stringify(result, null, 2))
    await client.checkpointPrune(runId, [])
    return 0
  } finally {
    await client.stop()
  }
}

/** The Tailscale IPv4 of this node, or undefined when the CLI is unavailable. */
function tailscaleIpv4(): string | undefined {
  const result = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
  if (result.status !== 0) return undefined
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(line))
}

/** `hy web`: the local GUI server. The Electron app starts the same server. */
async function web(p: Parsed): Promise<number> {
  const portRaw = str(p.flags, 'port')
  const port = portRaw === undefined ? 3080 : Number(portRaw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('hy web: --port must be an integer between 0 and 65535')
    return 2
  }
  const tailscale = bool(p.flags, 'tailscale')
  let host = str(p.flags, 'host') ?? '127.0.0.1'
  if (tailscale) {
    const ip = tailscaleIpv4()
    if (!ip) {
      console.error('hy web: --tailscale requires the Tailscale CLI and a logged-in tailnet')
      return 2
    }
    host = ip
  }
  const handle = await startWebServer({
    overrides: toOverrides(p),
    execServer: str(p.flags, 'exec-server'),
    port,
    host,
    open: !bool(p.flags, 'no-open') && !tailscale,
    tlsCert: str(p.flags, 'tls-cert'),
    tlsKey: str(p.flags, 'tls-key'),
    trustedHosts: p.lists['trusted-host'],
    publicUrl: str(p.flags, 'public-url'),
  })
  console.log(handle.url)
  if (tailscale) {
    console.error('[hy] Tailscale: open this URL on a phone on the same tailnet (then Add to Home Screen)')
    console.error('[hy] if the phone cannot connect, allow Node.js inbound on the Private/Tailscale profile in Windows Firewall')
  }
  console.error('[hy] Ctrl-C stops the server')
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await handle.close()
  return 0
}

/** `hy config dump|schema` (WP-11): the resolved config and its JSON Schema. */
function redactSecrets(value: unknown, showSecrets: boolean): unknown {
  if (showSecrets) return value
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, false))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'apiKey' && typeof entry === 'string' && entry.length > 0) {
        out[key] = '***'
      } else if (key === 'env' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
        out[key] = Object.fromEntries(Object.keys(entry as Record<string, unknown>).map((name) => [name, '***']))
      } else {
        out[key] = redactSecrets(entry, false)
      }
    }
    return out
  }
  return value
}

/**
 * CP-08: `hy secret list|set|remove`. The value is read from stdin so it never
 * appears in the process list or in shell history.
 */
function secretCommand(p: Parsed): number {
  const action = p.positional[0] ?? 'list'
  const file = path.join(userConfigDir(), 'config.json')
  const readSecrets = (): Record<string, string> => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as { secrets?: unknown }
      const secrets = parsed.secrets
      return secrets !== null && typeof secrets === 'object' && !Array.isArray(secrets)
        ? (secrets as Record<string, string>)
        : {}
    } catch {
      return {}
    }
  }
  if (action === 'list') {
    const names = Object.keys(readSecrets()).sort()
    for (const name of names) console.log(name)
    if (names.length === 0) console.error('no secrets stored; set one with: hy secret set <name>')
    return 0
  }
  const name = p.positional[1]
  if (!name || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
    console.error('usage: hy secret set|remove <name>  (letters, digits, . _ -)')
    return 2
  }
  if (action === 'set') {
    const stdin = fs.readFileSync(0, 'utf8')
    const value = (stdin.split(/\r?\n/)[0] ?? '').trim()
    if (!value) {
      console.error('hy secret set: provide the value on stdin (it is never taken from argv)')
      return 2
    }
    const reference = protectSecret(value)
    writeUserConfig((config) => {
      const secrets = (config.secrets ?? {}) as Record<string, string>
      secrets[name] = reference
      config.secrets = secrets
    })
    console.log(`stored ${name} (dpapi) in ${file}`)
    return 0
  }
  if (action === 'remove') {
    writeUserConfig((config) => {
      const secrets = (config.secrets ?? {}) as Record<string, string>
      delete secrets[name]
      config.secrets = secrets
    })
    console.log(`removed ${name}`)
    return 0
  }
  console.error(`hy secret: unknown action ${action}; expected list, set or remove`)
  return 2
}

/**
 * CP-16: `hy worktree list|create|apply|remove`. Worktrees live under the
 * workspace's state directory, so they never appear in the main checkout.
 */
async function worktreeCommand(p: Parsed): Promise<number> {
  const action = p.positional[0] ?? 'list'
  const config = loadConfig(toOverrides(p))
  const manager = new WorktreeManager(config.workspaceRoot, config.stateDir)
  if (!manager.isRepo()) {
    console.error('hy worktree: the workspace is not a git repository')
    return 2
  }
  const name = p.positional[1]
  if (action !== 'list' && !name) {
    console.error('usage: hy worktree list|create <name>|apply <name>|remove <name>')
    return 2
  }
  try {
    if (action === 'list') {
      for (const worktree of manager.list()) {
        console.log(`${worktree.path}  ${worktree.branch ?? (worktree.detached ? '(detached)' : '')}`)
      }
      return 0
    }
    if (action === 'create') {
      const created = manager.create(name!, { ...(str(p.flags, 'base') ? { base: str(p.flags, 'base')! } : {}) })
      console.log(created.path)
      return 0
    }
    if (action === 'apply') {
      const result = manager.apply(name!, { threeWay: !bool(p.flags, 'no-3way') })
      if (result.empty) {
        console.log('no changes to apply')
        return 0
      }
      if (result.conflicts.length > 0) {
        console.error(`conflicts: ${result.conflicts.join(', ')}`)
        return 1
      }
      console.log(`applied ${result.applied.length} file(s): ${result.applied.join(', ')}`)
      if (result.committed === false) {
        console.error(`hy worktree: the change was applied but not committed on hy/${name}; remove needs --force`)
      }
      return 0
    }
    if (action === 'remove') {
      manager.remove(name!, { force: bool(p.flags, 'force') })
      console.log(`removed ${name}`)
      return 0
    }
  } catch (error) {
    console.error(`hy worktree: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  console.error(`hy worktree: unknown action ${action}; expected list, create, apply or remove`)
  return 2
}
/** CP-26/CP-25: `hy protocol schema` or `hy protocol serve` (JSON-RPC over stdio). */
async function protocolCommand(p: Parsed): Promise<number> {
  const action = p.positional[0] ?? 'schema'
  if (action === 'schema') {
    console.log(renderApiSchema().trimEnd())
    return 0
  }
  if (action !== 'serve') {
    console.error(`hy protocol: unknown action ${action}; expected schema or serve`)
    return 2
  }
  const config = loadConfig(toOverrides(p))
  const host = protocolHost(p, config)
  try {
    // stdio is a trusted transport (the parent started us): no token.
    await serveStream(host, process.stdin, (line) => process.stdout.write(`${line}\n`), {
      log: (line) => console.error(`[hy protocol] ${line}`),
    })
  } finally {
    await host.close()
  }
  return 0
}

/** CP-27/29: the shared host; the exec server starts on the first turn. */
function protocolHost(p: Parsed, config: HarnessConfig): ProtocolHost {
  return new ProtocolHost({
    config,
    overrides: toOverrides(p),
    openClient: async () => {
      const opened = await openClient(p)
      await startServices(opened.config)
      return opened
    },
    log: (line) => console.error(`[hy protocol] ${line}`),
  })
}
/** CP-39: `hy doctor` gathers the facts a support request needs. */
/** The `hy doctor` report for a loaded config; `client` is asked for the sandbox. */
async function doctorReport(config: HarnessConfig, client: ExecRpcClient | undefined, error?: unknown) {
  let sandbox: Parameters<typeof buildDoctorReport>[0]['sandbox']
  try {
    if (!client) throw error ?? new Error('the exec server did not start')
    sandbox = doctorSandbox(await client.sandboxStatus())
  } catch (failure) {
    sandbox = { enforcement: 'unknown', available: false, error: failure instanceof Error ? failure.message : String(failure) }
  }
  const secretBin = findSecretBinary()
  return buildDoctorReport({
    version: HARNESS_VERSION,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    workspace: config.workspaceRoot,
    config,
    execServerPath: resolveServerPath(),
    sandbox,
    mcpServers: Object.keys(config.mcpServers),
    ...(secretBin ? { secretBin } : {}),
  })
}

async function doctorCommand(p: Parsed): Promise<number> {
  const config = loadConfig(toOverrides(p))
  let report: Awaited<ReturnType<typeof doctorReport>>
  try {
    const { client } = await openClient(p)
    try {
      report = await doctorReport(config, client)
    } finally {
      await client.stop()
    }
  } catch (error) {
    report = await doctorReport(config, undefined, error)
  }
  console.log(bool(p.flags, 'json') ? JSON.stringify(report, null, 2) : formatDoctor(report))
  return report.ok ? 0 : 1
}
/** CP-38: `hy features [list|enable|disable]`, persisted in the user config. */
function featuresCommand(p: Parsed): number {
  const config = loadConfig(toOverrides(p))
  const action = p.positional[0] ?? 'list'
  if (action === 'list') {
    const rows = FEATURES.map((feature) => ({
      name: feature.name,
      enabled: config.features[feature.name] ?? feature.defaultOn,
      maturity: feature.maturity,
      description: feature.description,
    }))
    if (bool(p.flags, 'json')) {
      console.log(JSON.stringify(rows, null, 2))
    } else {
      for (const row of rows) {
        console.log(`${row.enabled ? 'on ' : 'off'} ${row.name} (${row.maturity}): ${row.description}`)
      }
    }
    return 0
  }
  const name = p.positional[1]
  if (!name) {
    console.error('usage: hy features [list|enable <name>|disable <name>]')
    return 2
  }
  try {
    assertFeatureName(name)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  if (action !== 'enable' && action !== 'disable') {
    console.error(`hy features: unknown action ${action}; expected list, enable or disable`)
    return 2
  }
  const enabled = action === 'enable'
  const file = writeUserConfig((user) => {
    const current = user.features
    const features =
      current !== null && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {}
    features[name] = enabled
    user.features = features
  })
  console.log(`${enabled ? 'enabled' : 'disabled'} ${name} in ${file}`)
  return 0
}
/** CP-35: `hy fork <run-id> [--turn n]` starts a copy of a run's history. */
async function forkCommand(p: Parsed): Promise<number> {
  const runId = p.positional[0]
  if (!runId) {
    console.error('usage: hy fork <run-id> [--turn n]')
    return 2
  }
  const config = loadConfig(toOverrides(p))
  const turn = str(p.flags, 'turn')
  if (turn !== undefined && (!/^\d+$/.test(turn) || Number(turn) < 1)) {
    console.error('hy fork: --turn must be a positive integer')
    return 2
  }
  try {
    const newId = newRunId()
    const result = forkRun(sessionLogPath(config.stateDir), runId, newId, {
      ...(turn !== undefined ? { upToTurn: Number(turn) } : {}),
    })
    console.error(`[hy] forked ${result.turns} turn(s) / ${result.events} event(s)`)
    console.log(newId)
    return 0
  } catch (error) {
    console.error(`hy fork: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
async function configCommand(p: Parsed): Promise<number> {
  const sub = p.positional[0] ?? 'dump'
  if (sub === 'schema') {
    console.log(JSON.stringify(userConfigJsonSchema, null, 2))
    return 0
  }
  if (sub === 'paths') {
    const config = loadConfig(toOverrides(p))
    const paths = configPaths(config.workspaceRoot, config.stateDir)
    if (bool(p.flags, 'json')) console.log(JSON.stringify(paths, null, 2))
    else for (const [name, value] of Object.entries(paths)) console.log(`${name}: ${value}`)
    return 0
  }
  if (sub !== 'dump') {
    console.error(`hy config: unknown subcommand "${sub}" (expected dump, schema or paths)`)
    return 2
  }
  const showSecrets = bool(p.flags, 'show-secrets')
  const config = loadConfig(toOverrides(p))
  const dumped = redactSecrets(config, showSecrets) as Record<string, unknown>
  // A Set serialises as `{}`; the bundle resolution is the readable form.
  dumped.bundles = {
    names: config.bundles.names,
    ...(config.bundles.tools ? { tools: [...config.bundles.tools].sort() } : {}),
    prompts: config.bundles.prompts,
    panels: config.bundles.panels,
    commands: config.bundles.commands,
  }
  console.log(JSON.stringify(dumped, null, 2))
  return 0
}

/**
 * `hy update check|fetch|keygen|sign` (WP-53). Checking and fetching are always
 * explicit: no command here runs on its own, and a feed that does not verify is
 * refused before anything is written.
 */
async function updateCommand(p: Parsed): Promise<number> {
  const sub = p.positional[0] ?? 'check'
  const config = loadConfig(toOverrides(p))
  const stateDir = config.stateDir
  const channel = str(p.flags, 'channel') ?? config.update?.channel ?? 'stable'
  if (sub === 'keygen') {
    const outDir = path.resolve(str(p.flags, 'out') ?? path.join(stateDir, 'update', 'keys'))
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const privateFile = path.join(outDir, 'update-key.pem')
    const publicFile = path.join(outDir, 'update-public.pem')
    fs.mkdirSync(outDir, { recursive: true })
    if (fs.existsSync(privateFile)) {
      console.error(`hy update keygen: ${privateFile} already exists; move it away first (a release key is never overwritten)`)
      return 2
    }
    fs.writeFileSync(privateFile, privatePem, { encoding: 'utf8', mode: 0o600 })
    fs.writeFileSync(publicFile, publicPem, 'utf8')
    // The default key location is what the desktop reads; keep it in step.
    fs.mkdirSync(path.dirname(updateKeyPath(stateDir)), { recursive: true })
    fs.writeFileSync(updateKeyPath(stateDir), publicPem, 'utf8')
    console.log(privateFile)
    console.log(publicFile)
    console.error(`public key fingerprint: ${publicKeyFingerprint(publicPem)}`)
    console.error('Keep update-key.pem offline: anyone holding it can sign a release.')
    return 0
  }
  if (sub === 'sign') {
    const keyFile = str(p.flags, 'key')
    const version = str(p.flags, 'version')
    const url = str(p.flags, 'url')
    const sha = str(p.flags, 'sha256')
    if (!keyFile || !version || !url || !sha) {
      console.error('hy update sign: --key <private.pem> --version <v> --url <url> --sha256 <hex> [--channel <name>] [--mandatory]')
      return 2
    }
    let privatePem: string
    try {
      privatePem = fs.readFileSync(path.resolve(keyFile), 'utf8')
    } catch (error) {
      console.error(`hy update sign: cannot read ${keyFile}: ${error instanceof Error ? error.message : String(error)}`)
      return 2
    }
    const entry = {
      version,
      url,
      sha256: sha.toLowerCase(),
      ...(str(p.flags, 'channel') !== undefined ? { channel: str(p.flags, 'channel')! } : {}),
      ...(bool(p.flags, 'mandatory') ? { mandatory: true } : {}),
    }
    try {
      console.log(JSON.stringify({ ...entry, signature: signRelease(entry, privatePem) }, null, 2))
      return 0
    } catch (error) {
      console.error(`hy update sign: ${error instanceof Error ? error.message : String(error)}`)
      return 2
    }
  }
  if (sub !== 'check' && sub !== 'fetch') {
    console.error(`hy update: unknown subcommand "${sub}" (expected check, fetch, keygen or sign)`)
    return 2
  }
  const feed = str(p.flags, 'feed') ?? process.env.HY_UPDATE_FEED ?? config.update?.feed
  const keySource =
    str(p.flags, 'public-key') ??
    process.env.HY_UPDATE_PUBLIC_KEY ??
    config.update?.publicKey ??
    (fs.existsSync(updateKeyPath(stateDir)) ? updateKeyPath(stateDir) : undefined)
  if (!feed) {
    console.error('hy update: no release feed configured (--feed <url|path>, HY_UPDATE_FEED, or update.feed in config.json)')
    return 2
  }
  if (!keySource) {
    console.error(`hy update: no public key configured (--public-key, HY_UPDATE_PUBLIC_KEY, update.publicKey, or ${updateKeyPath(stateDir)})`)
    return 2
  }
  let parsed: ReleaseFeed
  try {
    parsed = await loadFeed(feed, readPublicKey(keySource), {
      ...(bool(p.flags, 'allow-insecure') ? { allowInsecure: true } : {}),
    })
  } catch (error) {
    console.error(`hy update: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const current = HARNESS_VERSION
  const selection = pickRelease(parsed, current, { channel })
  const release = selection.release
  if (sub === 'check') {
    if (bool(p.flags, 'json')) {
      console.log(JSON.stringify({ currentVersion: current, channel, release: release ?? null, reason: selection.reason ?? null }, null, 2))
      return 0
    }
    console.log(`current: ${current}`)
    console.log(`channel: ${channel}`)
    if (!release) {
      console.log(selection.reason === 'older-only' ? `the feed only has older releases (newest ${selection.newest?.version})` : 'up to date')
      return 0
    }
    console.log(`available: ${release.version}${release.mandatory ? ' (mandatory)' : ''}`)
    console.log(`url: ${release.url}`)
    console.log(`sha256: ${release.sha256}`)
    if (release.notes) console.log(`notes: ${release.notes}`)
    console.log('\nInstall with: hy update fetch' + (str(p.flags, 'feed') !== undefined ? ` --feed ${str(p.flags, 'feed')}` : ''))
    return 0
  }
  if (!release) {
    console.error(`hy update fetch: nothing to fetch (${selection.reason ?? 'up to date'})`)
    return 1
  }
  const outDir = path.resolve(str(p.flags, 'out') ?? updateDownloadDir(stateDir))
  try {
    const result = await downloadRelease(release, outDir, {
      ...(bool(p.flags, 'allow-insecure') ? { allowInsecure: true } : {}),
    })
    if (bool(p.flags, 'json')) console.log(JSON.stringify({ ...result, version: release.version }, null, 2))
    else {
      console.log(result.file)
      console.log(`sha256: ${result.sha256} (${result.bytes} bytes)`)
      console.log('Restart the desktop app and use "Apply update" to swap the portable exe.')
    }
    return 0
  } catch (error) {
    console.error(`hy update fetch: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/** `hy serve --sdk`: the JSON-RPC SDK server over stdio (WP-51). */
async function serveCommand(p: Parsed): Promise<number> {
  if (!bool(p.flags, 'sdk')) return daemonCommand(p)
  const config = loadConfig(toOverrides(p))
  const { client } = await openClient(p)
  try {
    await startServices(config)
    const server = createSdkServer({ config, client, input: process.stdin, output: process.stdout })
    await server.run()
    return 0
  } finally {
    await closeServices()
    await client.stop()
  }
}

/**
 * CP-27: `hy serve [start|status|stop]`, the resident hy-protocol/1 server.
 *
 *   hy serve start [--daemon] [--ws <port>] [--host 127.0.0.1] [--allow-remote] [--json]
 *
 * One daemon per workspace state directory. `--daemon` detaches and prints the
 * connection info (pipe, WebSocket URL, token); it is idempotent: a running
 * daemon is reported instead of started twice.
 */
async function daemonCommand(p: Parsed): Promise<number> {
  const action = p.positional[0] ?? 'start'
  const config = loadConfig(toOverrides(p))
  const json = bool(p.flags, 'json')
  const print = (info: DaemonInfo, note: string) => {
    if (json) console.log(JSON.stringify({ ...info, note }))
    else console.log(`${note}: pid ${info.pid}, pipe ${info.pipe}${info.ws ? `, ${info.ws}` : ''}`)
  }
  if (action === 'status') {
    const live = await liveDaemon(config.stateDir)
    if (!live) {
      if (json) console.log(JSON.stringify({ running: false }))
      else console.log('no daemon is running for this workspace')
      return 1
    }
    print(live, 'running')
    return 0
  }
  if (action === 'stop') {
    const info = readDaemonInfo(config.stateDir)
    if (!info || !processAlive(info.pid)) {
      fs.rmSync(daemonInfoPath(config.stateDir), { force: true })
      console.log('no daemon is running for this workspace')
      return 0
    }
    process.kill(info.pid)
    for (let i = 0; i < 50 && processAlive(info.pid); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    fs.rmSync(daemonInfoPath(config.stateDir), { force: true })
    console.log(`stopped the daemon (pid ${info.pid})`)
    return 0
  }
  if (action !== 'start') {
    console.error(`hy serve: unknown action ${action}; expected start, status or stop (or --sdk)`)
    return 2
  }
  const already = await liveDaemon(config.stateDir)
  if (already) {
    print(already, 'already running')
    return 0
  }
  if (bool(p.flags, 'daemon')) {
    // Re-run ourselves without --daemon, detached, and wait for the lock.
    const args = process.argv.slice(2).filter((a) => a !== '--daemon')
    const child = spawn(process.execPath, [process.argv[1]!, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: process.cwd(),
      env: process.env,
    })
    child.unref()
    const info = await waitForDaemon(config.stateDir)
    print(info, 'started')
    return 0
  }
  const wsPort = str(p.flags, 'ws')
  const bindHost = str(p.flags, 'host') ?? '127.0.0.1'
  const token = newToken()
  const pipe = defaultPipePath(stateKey(config.stateDir))
  const host = protocolHost(p, config)
  const log = (line: string) => console.error(`[hy serve] ${line}`)
  let pipeServer: import('node:net').Server | undefined
  let wsServer: import('node:http').Server | undefined
  let release: (() => void) | undefined
  try {
    if (process.platform !== 'win32') fs.rmSync(pipe, { force: true })
    const info: DaemonInfo = { pid: process.pid, pipe, token, startedAt: Date.now(), version: HARNESS_VERSION, workspace: config.workspaceRoot }
    if (wsPort !== undefined) {
      wsServer = await listenWebSocket(host, { port: Number(wsPort), host: bindHost, allowRemote: bool(p.flags, 'allow-remote'), token, log })
      const address = wsServer.address()
      const port = typeof address === 'object' && address ? address.port : Number(wsPort)
      info.ws = `ws://${bindHost.includes(':') ? `[${bindHost}]` : bindHost}:${port}`
    }
    release = await claimLock(config.stateDir, info)
    pipeServer = await listenPipe(host, pipe, { token, log })
    print(info, 'listening')
    await new Promise<void>((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.once(signal, () => resolve())
      process.once('disconnect', () => resolve())
    })
    return 0
  } catch (error) {
    if (error instanceof DaemonRunningError) {
      print(error.info, 'already running')
      return 0
    }
    console.error(`hy serve: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    release?.()
    pipeServer?.close()
    wsServer?.close()
    await host.close()
  }
}

/**
 * CP-31: `hy import claude|dsh`. Shows every change with its diff and writes
 * only after `--yes` or a "y" at the prompt; without a terminal and without
 * `--yes` it is a dry run.
 */
async function importCommand(p: Parsed): Promise<number> {
  const source = p.positional[0]
  if (source !== 'claude' && source !== 'dsh') {
    console.error('usage: hy import claude|dsh [--yes] [--json] [--only agents,mcp,hooks,skills,prompts,memory,sessions]')
    return 2
  }
  const config = loadConfig(toOverrides(p))
  const only = str(p.flags, 'only')
  const kinds = only ? new Set(only.split(',').map((k) => k.trim()).filter(Boolean) as ImportKind[]) : undefined
  const items = planImport(source, { workspaceRoot: config.workspaceRoot, stateDir: config.stateDir, userConfigDir: userConfigDir() }).filter((i) => !kinds || kinds.has(i.kind))
  const pending = items.filter((i) => i.action !== 'skip')
  if (bool(p.flags, 'json') && !bool(p.flags, 'yes')) {
    console.log(JSON.stringify({ source, items: importPlanView(items) }, null, 2))
    return 0
  }
  console.log(renderImportPlan(items))
  if (pending.length === 0) {
    console.log('\nnothing to write')
    return 0
  }
  let accepted = bool(p.flags, 'yes')
  if (!accepted && process.stdin.isTTY) {
    const reader = new LineReader()
    const answer = await reader.next(`\nWrite ${pending.length} change(s)? [y/N] `)
    reader.close()
    accepted = /^y(es)?$/i.test((answer ?? '').trim())
  }
  if (!accepted) {
    console.log('\nnothing written (pass --yes to apply)')
    return 0
  }
  const result = applyImport(items)
  if (bool(p.flags, 'json')) console.log(JSON.stringify(result, null, 2))
  else {
    for (const w of result.written) console.log(`wrote ${w}`)
    for (const f of result.failed) console.error(`failed: ${f}`)
  }
  return result.failed.length === 0 ? 0 : 1
}

/** `hy acp`: an ACP v1 server over stdio, for editors that speak ACP (WP-50). */
async function acpCommand(p: Parsed): Promise<number> {
  // CP-30: ACP sessions run on the same protocol host as `hy protocol serve`
  // and `hy serve`, so they are ordinary threads.
  const config = loadConfig(toOverrides(p))
  const host = protocolHost(p, config)
  try {
    const server = createAcpServer({ config, host, input: process.stdin, output: process.stdout })
    await server.run()
    return 0
  } finally {
    await host.close()
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (['help', '-h', '--help'].includes(parsed.command) || bool(parsed.flags, 'help')) {
    usage()
    return 0
  }
  switch (parsed.command) {
    case 'version':
    case '--version':
      console.log(HARNESS_VERSION)
      return 0
    case 'run':
      return run(parsed)
    case 'web':
      return web(parsed)
    case 'chat':
      return chat(parsed)
    case 'resume':
      return resume(parsed)
    case 'fork':
      return forkCommand(parsed)
    case 'sessions':
      return sessions(parsed)
    case 'index':
      return indexCommand(parsed)
    case 'models':
      return modelsCommand(parsed)
    case 'update':
      return updateCommand(parsed)
    case 'acp':
      return acpCommand(parsed)
    case 'serve':
      return serveCommand(parsed)
    case 'import':
      return importCommand(parsed)
    case 'review':
      return review(parsed)
    case 'mcp-server':
      return mcpServer(parsed)
    case 'ralph':
      return ralph(parsed)
    case 'undo':
      return undo(parsed)
    case 'checkpoint':
      return checkpoint(parsed)
    case 'sandbox':
      return sandbox(parsed)
    case 'policy-test':
      return policyTest(parsed)
    case 'config':
      return configCommand(parsed)
    case 'secret':
      return secretCommand(parsed)
    case 'worktree':
      return worktreeCommand(parsed)
    case 'protocol':
      return await protocolCommand(parsed)
    case 'doctor':
      return doctorCommand(parsed)
    case 'features':
      return featuresCommand(parsed)
    default:
      console.error(`unknown command: ${parsed.command}`)
      usage()
      return 2
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .finally(async () => {
    await closeServices()
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
