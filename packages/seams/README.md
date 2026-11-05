# @hy/seams

The policies that wrap the agent loop. Everything here is opt-in from the CLI,
and every seam is a pure function with the process boundaries injected, so it can
be tested without a provider or a sandbox.

| Seam | Module | What it decides |
| :-- | :-- | :-- |
| Guardian | `src/guardian.ts` | whether a `prompt` command is approved (never widens `unconfined` / `low-integrity`) |
| Spill | `src/spill.ts` | when a tool output is written to the state directory and replaced by a handle |
| Compaction | `src/compaction.ts` | summarising old turns at the context threshold |
| Rationale ledger | `src/ledger.ts` | how constraints and notes are re-projected into every request |
| Budget4D | `src/budget.ts` | rounds, tokens, USD and wall-clock limits |
| Verifier loop | `src/verifier-ralph.ts` | claim → tamper check → Gate 1 (commands) → Gate 2 (grader) |
| Approver | `src/approver.ts` | the interactive/auto approval policy shared by CLI and GUI |

## Rules of thumb

- A seam may only *narrow* what the agent can do. Nothing here turns an approval
  into a wider sandbox mode.
- Token accounting is exact where the provider reports usage and estimated
  otherwise; the budget counts every role, not just the worker.
- A failing seam fails closed: an unreadable policy is a denial, not a pass.

## Test

```powershell
pnpm build
node --test "packages/seams/dist/**/*.test.js"
```
