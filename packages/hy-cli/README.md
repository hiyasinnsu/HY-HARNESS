# @hy/cli

The `hy` command, the local web server and the shared GUI. This package is the
only place that knows about processes, files on disk and the browser; everything
else is `@hy/core` or `@hy/seams`.

## Entry points

| Command | Module | Notes |
| :-- | :-- | :-- |
| `hy run` / `chat` / `resume` | `src/main.ts`, `src/session-app.ts` | one turn, interactive, continue a run |
| `hy web` | `src/web-server.ts` | the local API + the static GUI (`web/`) |
| `hy ralph` | `src/main.ts` | verifier-gated loop over `@hy/seams` |
| `hy acp` | `src/acp.ts` | ACP v1 over stdio for editors |
| `hy serve --sdk` | `src/sdk-server.ts` | JSON-RPC 2.0 NDJSON for `@hy/sdk` and `python/` |
| `hy update` | `src/update-feed.ts` | Ed25519-signed release feed |
| `hy index` / `hy models` | `src/session-index.ts`, `model-catalog` | search and model discovery |

## The web server

`src/web-server.ts` is one closure per process: it owns the sessions map, the
SSE streams, the turn queue, the orchestration state and the UI state file. Every
route is declared once in `src/api-contract.ts`; `web/src/api.gen.ts` is
generated from it (`pnpm gen:api`, verified by `pnpm check:api`).

Feature modules that keep the server readable:

| Feature | Module |
| :-- | :-- |
| Document previews | `documents.ts` |
| Generated chat names | `session-title.ts`, `session-title-gen.ts` |
| Timings | `session-stats.ts` |
| Forks | `session-fork.ts` |
| `@session:` references | `session-reference.ts` |
| Feedback | `feedback.ts` |
| Secret masking | `secret-mask.ts` |
| Open In | `open-in.ts` |
| Telemetry | `telemetry.ts` |
| First-run wizard | `onboarding.ts` |
| Background subagents | `agents.ts` |
| Orchestration | `orchestration.ts` |
| Turn queue | `turn-queue.ts` |

## The GUI

`web/src` is TypeScript + CSS with no framework. `app.ts` holds the state and the
render functions; pure helpers live in their own modules (`shortcuts.ts`,
`notice.ts`, `turn-queue-view.ts`, `composer-draft.ts`, `secret-mask.ts`, …) so
they can be unit-tested from `web/test/`.

## Test

```powershell
pnpm build
node --test "packages/hy-cli/dist/**/*.test.js" "packages/hy-cli/web/test/*.test.mjs"
pnpm test:integration   # starts real servers against throwaway workspaces
```
