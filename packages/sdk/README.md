# @hy/sdk

A dependency-free TypeScript client for `hy serve --sdk`, the JSON-RPC 2.0
server that speaks newline-delimited JSON over stdio. The same protocol has a
Python client in [`../../python`](../../python).

## Use

```ts
import { HarnessClient } from '@hy/sdk'

const client = await HarnessClient.start({
  command: 'node',
  args: ['packages/hy-cli/dist/main.js', 'serve', '--sdk'],
  cwd: 'C:\\work\\my-repo',
})
client.onEvent((event) => console.log(event.type))
client.onStatus((status) => console.log(status.busy ? 'busy' : 'idle'))
const session = await client.createSession()
const { final } = await client.prompt(session.runId, 'Summarise README.md')
await client.closeSession(session.runId)
await client.close()
```

`runOnce()` wraps the common case (one session, one prompt, close).

## Protocol

| Method | Reply |
| :-- | :-- |
| `initialize` | server name, version, workspace |
| `session.create` | `{ runId }` |
| `session.resume` | `{ runId }` for an existing run |
| `session.prompt` | `{ accepted: true }`; the answer arrives as events and a final notification |
| `session.cancel` | `{ cancelled: boolean }` |
| `session.close` | `{ ok: true }` |
| `shutdown` | `{ ok: true }`, then the process exits |

Notifications: `session/event` (the same `AgentEvent` the CLI renders) and
`session/status` (`busy`, `turns`). Prompts are dispatched without awaiting, so a
cancel is processed while a turn runs.

## Limits

- One server = one workspace.
- Approval follows the server's configuration (`--yes`, full auto); there is no
  client-side permission request (that is the ACP surface, `hy acp`).
- The Python client re-exports the same behaviour; see `python/README.md`.
