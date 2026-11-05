/**
 * Splits an orchestrator notice into worker blocks.
 *
 * `web-server.ts` delivers worker traffic to the orchestrator as synthetic
 * turns, and `flushOrchestratorInbox()` joins queued notices with a blank
 * line. One `notice` entry can therefore carry several blocks:
 *
 *   [worker heartbeat]
 *   worker: <title> (<runId>)
 *   ...
 *
 *   [worker report]
 *   worker: <title> (<runId>)
 *   status: waiting for review
 *   report:
 *   <the worker's own text>
 *
 * Only the `[worker report]` blocks are meant to be folded in the GUI;
 * heartbeats and approval requests must stay visible. A block boundary is a
 * marker line that is preceded by a blank line (or the start of the text) and
 * followed by the `worker: <title> (<runId>)` header the server always writes.
 * Requiring that header keeps a worker's report body from faking a boundary
 * with a bare `[worker report]` line of its own.
 */

export type NoticeBlock =
  | { kind: 'report'; summary: string; body: string }
  | { kind: 'plain'; text: string }

const MARKER = /^\[worker (report|approval request|heartbeat)\]$/
const WORKER_HEADER = /^worker: .+\(run-[a-z0-9]+\)$/

function summarize(body: string): string {
  const worker = /^worker: (.+)$/m.exec(body)?.[1] ?? 'worker report'
  const status = /^status: (.+)$/m.exec(body)?.[1]
  return status ? `${worker} (${status})` : worker
}

/** Pure: returns blocks derived from `text` and never mutates it. */
export function splitNotice(text: string): NoticeBlock[] {
  const lines = text.split('\n')
  const starts: number[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined || !MARKER.test(line)) continue
    if (i > 0 && lines[i - 1]?.trim() !== '') continue
    const header = lines[i + 1]
    if (header === undefined || !WORKER_HEADER.test(header)) continue
    starts.push(i)
  }
  if (starts.length === 0) return [{ kind: 'plain', text }]

  const blocks: NoticeBlock[] = []
  const head = lines.slice(0, starts[0]).join('\n').trim()
  if (head) blocks.push({ kind: 'plain', text: head })

  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index] ?? 0
    const to = starts[index + 1] ?? lines.length
    const body = lines.slice(from, to).join('\n').trim()
    if (!body) continue
    const kind = MARKER.exec(lines[from] ?? '')?.[1]
    if (kind === 'report') blocks.push({ kind: 'report', summary: summarize(body), body })
    else blocks.push({ kind: 'plain', text: body })
  }
  return blocks
}
