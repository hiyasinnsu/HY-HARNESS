// JSON Schema for `%APPDATA%\hy-harness\config.json` (WP-11).
//
// The loader ignores unknown keys, so `additionalProperties` stays true: this
// schema documents and validates the known surface; it is not a lock file.
// `docs/config.schema.json` is generated from this module by
// `scripts/gen-config-schema.mjs` and checked in CI (`pnpm check:config-schema`).

const roleConfig = {
  type: 'object',
  additionalProperties: true,
  properties: {
    provider: {
      type: 'string',
      enum: ['ollama', 'deepseek', 'openai-compatible', 'openai-responses', 'opencode', 'gemini', 'anthropic', 'mock'],
      description: 'Adapter used for this role.',
    },
    model: { type: 'string' },
    baseUrl: { type: 'string' },
    apiKeyEnv: { type: 'string', description: 'Environment variable that holds the key (preferred).' },
    apiKey: { type: 'string', description: 'Directly stored key; takes precedence over apiKeyEnv.' },
    apiKeySecret: {
      type: 'string',
      description: 'Name in `secrets` holding a DPAPI reference (CP-08). Set it with `hy secret set <name>`.',
    },
    effort: {
      type: 'string',
      description: 'Provider reasoning effort (none/minimal/low/medium/high/xhigh/max).',
    },
    contextWindowTokens: { type: 'integer', minimum: 1 },
    maxOutputTokens: { type: 'integer', minimum: 1 },
    temperature: { type: 'number', minimum: 0 },
    verbosity: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Responses API text.verbosity (openai-responses only).',
    },
    reasoningSummary: {
      type: 'string',
      enum: ['auto', 'concise', 'detailed', 'none'],
      description: 'Responses API reasoning.summary (openai-responses only).',
    },
    serviceTier: {
      type: 'string',
      enum: ['auto', 'default', 'flex', 'priority'],
      description: 'Responses API service_tier (openai-responses only).',
    },
    pricing: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inputPerMTokUsd: { type: 'number', minimum: 0 },
        cachedInputPerMTokUsd: { type: 'number', minimum: 0 },
        outputPerMTokUsd: { type: 'number', minimum: 0 },
      },
      required: ['inputPerMTokUsd', 'outputPerMTokUsd'],
    },
    nativeTools: { type: 'boolean' },
    vision: {
      type: 'boolean',
      description: 'Whether the model accepts image input (read_image). Defaults to a provider/model heuristic.',
    },
  },
  required: ['provider', 'model'],
} as const

const hookSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'array', minItems: 1, items: { type: 'string' } },
    tools: { type: 'array', items: { type: 'string' } },
  },
  required: ['command'],
} as const

const mcpServer = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string' },
    args: { type: 'array', items: { type: 'string' } },
    env: { type: 'object', additionalProperties: { type: 'string' } },
    cwd: { type: 'string' },
    trusted: { type: 'boolean', description: 'Skip approval for this server tools.' },
    tools: { type: 'array', items: { type: 'string' }, description: 'Allowlist; default all.' },
    timeoutMs: { type: 'integer', minimum: 1 },
  },
  required: ['command'],
} as const

export const userConfigJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://hy-harness.invalid/config.schema.json',
  title: 'HY-HARNESS user configuration',
  description:
    'User config at %APPDATA%\\hy-harness\\config.json (override the directory with HY_CONFIG_DIR). Unknown keys are ignored by the loader.',
  type: 'object',
  additionalProperties: true,
  properties: {
    profiles: {
      type: 'object',
      description: 'Named overlays selected with --profile (merged over the user config).',
      additionalProperties: {
        type: 'object',
        additionalProperties: true,
        properties: { $ref: '#' },
      },
    },
    workspaceRoots: {
      type: 'array',
      description: 'Additional roots for every workspace; the workspace root is always main. The GUI stores roots per workspace in workspaceRootsByWorkspace instead.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          path: { type: 'string' },
          label: { type: 'string' },
          writable: { type: 'boolean' },
        },
        required: ['path'],
      },
    },
    workspaceRootsByWorkspace: {
      type: 'object',
      description: 'Additional roots per workspace, keyed by the primary root path (lower-cased on Windows). Written by the GUI roots dialog.',
      additionalProperties: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            path: { type: 'string' },
            label: { type: 'string' },
            writable: { type: 'boolean' },
          },
          required: ['path'],
        },
      },
    },
    roles: {
      type: 'object',
      additionalProperties: false,
      properties: {
        worker: roleConfig,
        orchestrator: roleConfig,
        subagent: roleConfig,
        grader: roleConfig,
        compactor: roleConfig,
        summarizer: roleConfig,
        guardian: roleConfig,
      },
    },
    guardian: {
      type: 'object',
      additionalProperties: false,
      properties: { approveBelow: { type: 'number', minimum: 0, maximum: 100 } },
    },
    sandbox: {
      type: 'object',
      additionalProperties: false,
      properties: {
        envPassthrough: { type: 'array', items: { type: 'string' } },
        extraWritableRoots: { type: 'array', items: { type: 'string' } },
        legacyUnconfined: {
          type: 'boolean',
          description: 'Keep the pre-0.5 default (unconfined) without --unsafe-unconfined. Confinement is recommended.',
        },
        denyRead: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Paths the confined token must not read (CP-02). Supports ~, $HOME and %VAR%; directories include their children.',
        },
        readOnly: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace subdirectories that stay readable but not writable for confined commands (CP-02).',
        },
      },
    },
    defaultPermissions: {
      type: 'string',
      description: 'Permission profile applied by default (CP-02).',
    },
    permissions: {
      type: 'object',
      description: 'Named permission profiles (CP-02). Only the user config may define them.',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string' },
          extends: { type: 'string', description: 'Inherit another profile first (cycles are rejected).' },
          denyRead: { type: 'array', items: { type: 'string' } },
          readOnly: { type: 'array', items: { type: 'string' } },
          write: { type: 'array', items: { type: 'string' }, description: 'Reserved; extra writable roots.' },
        },
      },
    },
    approvalPolicy: {
      type: 'string',
      enum: ['untrusted', 'on-request', 'on-failure', 'never'],
      description: 'How prompt decisions are handled (CP-05). untrusted asks for every prompt (default).',
    },
    sandboxMode: {
      type: 'string',
      enum: ['unconfined', 'workspace-write', 'read-only', 'low-integrity'],
      description: 'Default sandbox mode for new sessions. The default is workspace-write (CLI --sandbox and --unsafe-unconfined override it).',
    },
    userPolicyPath: { type: 'string', description: 'Path to policy.star.' },
    features: {
      type: 'object',
      description: 'CP-38: feature overrides (name -> boolean). Unknown names are ignored.',
      additionalProperties: { type: 'boolean' },
    },
    secrets: {
      type: 'object',
      description: 'DPAPI references written by `hy secret set` (CP-08). Values are `dpapi:<base64>`.',
      additionalProperties: { type: 'string' },
    },
    trustedProjects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          configSha256: { type: 'string', description: 'Pin the project config hash; a change re-prompts.' },
        },
        required: ['path'],
      },
    },
    mcpServers: {
      type: 'object',
      description: 'stdio MCP servers; tools are offered as mcp_call.',
      additionalProperties: mcpServer,
    },
    hooks: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionStart: { type: 'array', items: hookSpec },
        sessionEnd: { type: 'array', items: hookSpec },
        userPromptSubmit: { type: 'array', items: hookSpec },
        modelRequest: { type: 'array', items: hookSpec },
        permissionRequest: { type: 'array', items: hookSpec },
        subagentStart: { type: 'array', items: hookSpec },
        subagentStop: { type: 'array', items: hookSpec },
        stop: { type: 'array', items: hookSpec },
        interrupt: { type: 'array', items: hookSpec },
        preCompact: { type: 'array', items: hookSpec },
        postCompact: { type: 'array', items: hookSpec },
        preToolUse: { type: 'array', items: hookSpec },
        postToolUse: { type: 'array', items: hookSpec },
        turnEnd: { type: 'array', items: hookSpec },
      },
    },
    notify: { type: 'array', items: { type: 'string' }, description: 'Codex-style notify command.' },
    web: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        allowDomains: { type: 'array', items: { type: 'string' } },
        maxBytes: { type: 'integer', minimum: 1 },
        timeoutMs: { type: 'integer', minimum: 1 },
        searchUrl: { type: 'string', description: 'SearXNG-compatible JSON endpoint; enables web_search.' },
      },
    },
    lsp: {
      type: 'object',
      description: 'Language servers for the lsp tool, keyed by language name.',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'array', minItems: 1, items: { type: 'string' } },
          extensions: { type: 'array', minItems: 1, items: { type: 'string' } },
          languageId: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 1 },
        },
        required: ['command', 'extensions'],
      },
    },
    plugins: {
      type: 'array',
      description: 'JS modules that export tools[] (paths or package names).',
      items: { type: 'string' },
    },
    memory: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        auto: { type: 'boolean', description: 'CP-20: extract workspace memories after each turn.' },
      },
    },
    sessionQuery: {
      type: 'object',
      additionalProperties: false,
      properties: { enabled: { type: 'boolean' } },
      description: 'Offer session_query: full-text search of earlier sessions in this workspace.',
    },
    bundles: {
      type: 'array',
      items: { type: 'string', enum: ['core', 'ptc', 'minimal', 'audit', 'orchestrator', 'worker'] },
      description: 'Typed bundles layered on core; a bundle can only narrow the tool set (--bundle adds to them).',
    },    persistentShell: {
      type: 'object',
      additionalProperties: false,
      properties: { enabled: { type: 'boolean' } },
      description: 'Keep one PowerShell alive per session so cd and variables persist (unconfined only).',
    },
    update: {
      type: 'object',
      additionalProperties: false,
      properties: {
        feed: { type: 'string', description: 'HTTPS URL (or a local path) of the signed release feed.' },
        channel: { type: 'string', description: 'Release channel to follow (default stable).' },
        publicKey: { type: 'string', description: 'The Ed25519 public key (PEM) that signs the feed.' },
        autoCheck: { type: 'boolean', description: 'Check the feed once at start; install stays explicit.' },
      },
      description: 'Desktop release feed and its Ed25519 key (WP-53); `hy update` never runs on its own.',
    },
    phone: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: 'Listen on this PC\'s Tailscale address for paired phones (set from Settings › Phone).' },
        port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Port of the phone listener (default 3443).' },
        pushSubject: { type: 'string', description: 'VAPID contact (mailto: or https:) sent to push services.' },
      },
      description: 'Phone access over Tailscale: QR pairing, per-device keys and Web Push notifications.',
    },
    telemetry: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: 'Send spans to a local OTLP collector (default off).' },
        endpoint: { type: 'string', description: 'OTLP/HTTP endpoint on this machine (default http://127.0.0.1:4318).' },
        serviceName: { type: 'string' },
        sampleRatio: { type: 'number', description: '0..1; sampled once per turn.' },
        allowRemote: { type: 'boolean', description: 'Allow a non-local collector (explicit opt-in).' },
      },
      description: 'Opt-in OTLP tracing (WP-62): identifiers, timings and counts only — never message content.',
    },
    automation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        browser: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            browser: { type: 'string', enum: ['msedge', 'chrome', 'chromium', 'firefox', 'webkit'] },
            headless: { type: 'boolean' },
            isolated: { type: 'boolean' },
          },
        },
        desktop: {
          type: 'object',
          additionalProperties: false,
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    autoApprove: { type: 'boolean' },
    fullAuto: { type: 'boolean' },
    reasoningHistory: {
      type: 'string',
      enum: ['none', 'full'],
      description: 'full: keep the model reasoning in the conversation and send it back (DeepSeek reasoning_content). Default none.',
    },
    models: {
      type: 'array',
      description: 'Reusable model presets shown in Settings.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          provider: { type: 'string', enum: ['ollama', 'deepseek', 'openai-compatible', 'openai-responses', 'opencode', 'gemini', 'anthropic', 'mock'] },
          model: { type: 'string' },
          baseUrl: { type: 'string' },
          apiKeyEnv: { type: 'string' },
          contextWindowTokens: { type: 'integer', minimum: 1 },
          maxOutputTokens: { type: 'integer', minimum: 1 },
        },
        required: ['id', 'name', 'provider', 'model'],
      },
    },
  },
} as const

/** A schema-valid example used by tests and documentation. */
export const exampleUserConfig = {
  sandboxMode: 'workspace-write',
  autoApprove: false,
  fullAuto: false,
  guardian: { approveBelow: 80 },
  roles: {
    worker: { provider: 'ollama', model: 'qwen2.5:3b', contextWindowTokens: 32768, maxOutputTokens: 8192 },
    guardian: { provider: 'ollama', model: 'qwen2.5:3b', contextWindowTokens: 32768, maxOutputTokens: 8192 },
  },
  mcpServers: { fs: { command: 'node', args: ['server.js'], trusted: true } },
  hooks: { preToolUse: [{ command: ['node', 'hook.mjs'], tools: ['shell'] }] },
  web: { enabled: true, allowDomains: ['docs.python.org'] },
  lsp: { ts: { command: ['typescript-language-server', '--stdio'], extensions: ['.ts', '.tsx'] } },
  plugins: ['./plugins/example.mjs'],
  memory: { enabled: true },
  models: [
    {
      id: 'deepseek-flash',
      name: 'DeepSeek V4.1 Flash',
      provider: 'deepseek',
      model: 'deepseek-v4.1-flash',
      contextWindowTokens: 262144,
      maxOutputTokens: 131072,
    },
  ],
} as const
