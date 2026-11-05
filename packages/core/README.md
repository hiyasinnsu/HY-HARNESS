# @hy/core

The harness's control plane: configuration, providers, tools, the agent loop and
the durable session log. No process, network or UI code — `@hy/seams` adds the
policies and `@hy/cli` wires everything together.

## What lives here

| Area | Module | Notes |
| :-- | :-- | :-- |
| Configuration | `src/config.ts`, `src/config-schema.ts` | user config + project config, CLI overrides, JSON Schema exported as `docs/config.schema.json` |
| Providers | `src/llm.ts`, `src/model-catalog.ts` | Ollama, OpenAI-compatible, OpenAI Responses, Anthropic, Gemini, OpenCode, DeepSeek, mock; catalog for limits/compat |
| Tools | `src/tools.ts`, `src/tool-registry.ts` | the 14 wire tools, schemas, PTC prompt budget |
| Agent loop | `src/agent.ts` | steps, tool calls, retries, steering, goals |
| Session log | `src/session-log.ts`, `src/session-format.ts` | newline JSON, format v2 with a header, `importEvents` for forks |
| Search | `src/session-index.ts` | SQLite FTS5 with trigram tokenization |
| Bundles | `src/bundles.ts` | typed tool narrowing (`core`, `ptc`, `minimal`, `audit`, `orchestrator`, `worker`) |
| Version | `src/version.ts` | `HARNESS_VERSION`; `pnpm check:version` keeps it in step |

## Contracts

- The wire protocol is generated from the Rust daemon (`pnpm gen:protocol`).
- Tool JSON Schemas are the single source for both validation and the PTC
  SDK (`packages/core/test/tools-sdk.d.ts.snap`).
- The user-config schema is generated: change `config-schema.ts`, then
  `node scripts/gen-config-schema.mjs`.

## Test

```powershell
pnpm build
node --test "packages/core/dist/**/*.test.js"
```
