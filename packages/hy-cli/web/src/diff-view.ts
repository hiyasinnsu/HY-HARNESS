/**
 * CP-33: the diff viewer's model and markup.
 *
 * `parseUnifiedDiff` turns `git diff` output (what `/api/sessions/:id/diff`
 * returns, with or without the leading `--stat` block) into files and hunks
 * with line numbers. New files (untracked at the start of the run) come out as
 * `added`, so they are shown and commentable like any other change.
 *
 * Pure module (no DOM): web/test/diff-view.test.mjs runs it directly.
 */
import { escapeHtml } from './markdown.js'

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'note'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'binary'
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

/** A review comment on one line: `side` says which numbering `line` uses. */
export interface DiffComment {
  path: string
  side: 'old' | 'new'
  line: number
  text: string
}

const stripPrefix = (p: string) => p.replace(/^[ab]\//, '')

export function parseUnifiedDiff(source: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let hunk: DiffHunk | undefined
  let oldNo = 0
  let newNo = 0
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(raw)
    if (header) {
      file = { path: header[2]!, status: 'modified', hunks: [], additions: 0, deletions: 0 }
      if (header[1] !== header[2]) file.oldPath = header[1]!
      files.push(file)
      hunk = undefined
      continue
    }
    if (!file) continue
    if (!hunk) {
      if (raw.startsWith('new file mode')) file.status = 'added'
      else if (raw.startsWith('deleted file mode')) file.status = 'deleted'
      else if (raw.startsWith('rename from ')) {
        file.status = 'renamed'
        file.oldPath = raw.slice('rename from '.length)
      } else if (raw.startsWith('Binary files ')) file.status = 'binary'
      else if (raw === '--- /dev/null') file.status = 'added'
      else if (raw === '+++ /dev/null') file.status = 'deleted'
      else if (raw.startsWith('+++ ') && raw !== '+++ /dev/null') file.path = stripPrefix(raw.slice(4))
    }
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (at) {
      hunk = { header: raw, lines: [] }
      file.hunks.push(hunk)
      oldNo = Number(at[1])
      newNo = Number(at[2])
      continue
    }
    if (!hunk) continue
    if (raw.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ })
      file.additions += 1
    } else if (raw.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ })
      file.deletions += 1
    } else if (raw.startsWith('\\')) {
      hunk.lines.push({ kind: 'note', text: raw })
    } else if (raw.startsWith(' ')) {
      // git prefixes every context line, blank ones too, with a space; a bare
      // empty line is only the output's final newline.
      hunk.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return files
}

export const commentKey = (c: Pick<DiffComment, 'path' | 'side' | 'line'>) => `${c.path}\u0000${c.side}\u0000${c.line}`

export interface DiffViewOptions {
  /** Paths whose body is folded. */
  collapsed: ReadonlySet<string>
  comments: ReadonlyMap<string, DiffComment>
  /** The line whose comment box is open. */
  editing?: Pick<DiffComment, 'path' | 'side' | 'line'> | undefined
  labels: { added: string; deleted: string; renamed: string; binary: string; comment: string; save: string; cancel: string }
}

export function renderDiffFiles(files: readonly DiffFile[], options: DiffViewOptions): string {
  return files
    .map((file) => {
      const open = !options.collapsed.has(file.path)
      const badge =
        file.status === 'modified'
          ? ''
          : `<span class="diff-badge diff-badge-${file.status}">${escapeHtml(options.labels[file.status])}</span>`
      const title = file.oldPath && file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path
      const body = open
        ? file.hunks
            .map(
              (hunk) =>
                `<div class="diff-hunk-head">${escapeHtml(hunk.header)}</div>${hunk.lines.map((line) => renderLine(file.path, line, options)).join('')}`,
            )
            .join('')
        : ''
      return `<section class="diff-file ${open ? 'open' : 'folded'}" data-diff-file="${escapeHtml(file.path)}">
  <button type="button" class="diff-file-head" data-action="diff-fold" data-path="${escapeHtml(file.path)}"><span class="diff-fold">${open ? '▾' : '▸'}</span><code>${escapeHtml(title)}</code>${badge}<span class="diff-count"><span class="diff-plus">+${file.additions}</span> <span class="diff-minus">−${file.deletions}</span></span></button>
  ${open ? `<div class="diff-body">${body || '<div class="panel-empty">—</div>'}</div>` : ''}
</section>`
    })
    .join('')
}

function renderLine(path: string, line: DiffLine, options: DiffViewOptions): string {
  if (line.kind === 'note') return `<div class="dl dl-note"><span class="dl-no"></span><span class="dl-no"></span><span class="dl-text">${escapeHtml(line.text)}</span></div>`
  const side: 'old' | 'new' = line.kind === 'del' ? 'old' : 'new'
  const number = side === 'old' ? line.oldNo! : line.newNo!
  const key = commentKey({ path, side, line: number })
  const comment = options.comments.get(key)
  const editing = options.editing && commentKey(options.editing) === key
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '
  const row = `<div class="dl dl-${line.kind}${comment ? ' has-comment' : ''}"><button type="button" class="dl-no dl-commentable" data-action="diff-comment" data-path="${escapeHtml(path)}" data-side="${side}" data-line="${number}" title="${escapeHtml(options.labels.comment)}">${line.oldNo ?? ''}</button><span class="dl-no">${line.newNo ?? ''}</span><span class="dl-text">${sign}${escapeHtml(line.text) || ' '}</span></div>`
  if (editing) {
    return `${row}<div class="dl-comment-edit"><textarea id="diff-comment-input" rows="2">${escapeHtml(comment?.text ?? '')}</textarea><div><button type="button" class="btn primary small" data-action="diff-comment-save">${escapeHtml(options.labels.save)}</button><button type="button" class="btn ghost small" data-action="diff-comment-cancel">${escapeHtml(options.labels.cancel)}</button></div></div>`
  }
  if (comment) {
    return `${row}<div class="dl-comment" data-action="diff-comment" data-path="${escapeHtml(path)}" data-side="${side}" data-line="${number}">${escapeHtml(comment.text)}</div>`
  }
  return row
}

/** The message that hands the diff comments to the agent. */
export function commentsToPrompt(comments: Iterable<DiffComment>): string {
  const list = [...comments].filter((c) => c.text.trim())
  if (list.length === 0) return ''
  list.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return [
    'Review comments on the current diff. Address each one, then summarise what you changed:',
    ...list.map((c) => `- ${c.path}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}: ${c.text.trim()}`),
  ].join('\n')
}
