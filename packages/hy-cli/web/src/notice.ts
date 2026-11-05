import { escapeHtml, oneLine } from './markdown.js'

export type NoticeLevel = 'info' | 'warn' | 'error'

export interface NoticeBlock {
  /** `text` is anything that is not a recognised worker block header. */
  kind: 'report' | 'approval' | 'heartbeat' | 'text'
  text: string
}

export interface WorkerNoticeLayout {
  blocks: NoticeBlock[]
  /**
   * A `[worker …]` line was seen but could not be read as a block header. The
   * old format (no blank-line separator, no `worker:` line) is ambiguous, and
   * guessing could hide an approval request inside a folded report, so such a
   * notice is rendered in full instead.
   */
  ambiguous: boolean
}

const MARKER = /^\[worker (report|approval request|heartbeat)\]$/
const WORKER_LINE = /^worker: /

/**
 * Splits a notice into the blocks the orchestrator inbox produced. Blocks are
 * joined with a blank line, so a header only starts a block at the very start
 * or right after a blank line, and only when the `worker:` line follows it. A
 * report body that quotes `[worker report]` therefore stays inside its block.
 */
export function splitWorkerNotice(text: string): WorkerNoticeLayout {
  const lines = text.split('\n')
  const starts: number[] = []
  let ambiguous = false
  for (let i = 0; i < lines.length; i++) {
    const marker = MARKER.exec((lines[i] ?? '').trim())
    if (!marker) continue
    const atStart = i === 0
    const afterBlank = i > 0 && (lines[i - 1] ?? '').trim() === ''
    if (!atStart && !afterBlank) {
      // The same marker inside a report body: not a block boundary.
      ambiguous = true
      continue
    }
    if (!WORKER_LINE.test((lines[i + 1] ?? '').trim())) {
      ambiguous = true
      continue
    }
    starts.push(i)
  }
  if (starts.length === 0) return { blocks: [{ kind: 'text', text }], ambiguous }
  const blocks: NoticeBlock[] = []
  const pushText = (from: number, to: number): void => {
    const chunk = lines.slice(from, to).join('\n').trim()
    if (chunk) blocks.push({ kind: 'text', text: chunk })
  }
  const first = starts[0]!
  if (first > 0) pushText(0, first)
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!
    const to = s + 1 < starts.length ? starts[s + 1]! : lines.length
    const kind = MARKER.exec((lines[from] ?? '').trim())![1] as NoticeBlock['kind']
    blocks.push({ kind, text: lines.slice(from, to).join('\n').trim() })
  }
  return { blocks, ambiguous }
}

function reportSummary(text: string): string {
  const worker = /^worker: (.+)$/m.exec(text)?.[1] ?? 'worker report'
  const status = /^status: (.+)$/m.exec(text)?.[1]
  return status ? `${worker} (${status})` : worker
}

function visible(level: NoticeLevel, text: string): string {
  return `<div class="notice ${level}">${escapeHtml(text)}</div>`
}

/**
 * Renders one `notice` entry. Only worker reports are folded; heartbeats and
 * approval requests stay visible so a pending decision cannot be missed, and
 * an ambiguous notice is never folded.
 */
export function renderNoticeHtml(level: NoticeLevel, text: string): string {
  const layout = splitWorkerNotice(text)
  const only = layout.blocks[0]
  if (layout.blocks.length === 1 && only?.kind === 'text') return visible(level, text)
  if (layout.ambiguous) return layout.blocks.map((block) => visible(level, block.text)).join('')
  return layout.blocks
    .map((block) =>
      block.kind === 'report'
        ? `<details class="notice ${level} worker-report"><summary>${escapeHtml(oneLine(reportSummary(block.text), 160))}</summary><div class="worker-report-body">${escapeHtml(block.text)}</div></details>`
        : visible(level, block.text),
    )
    .join('')
}