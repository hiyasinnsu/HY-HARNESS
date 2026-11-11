// Turn progress: what the model changed, what it checked, and whether it is
// still getting anywhere.
//
// Two harness-side controls read this instead of trusting the model's prose:
// - the verification gate (a final answer right after an unchecked edit is
//   sent back once), and the verification summary logged with the turn;
// - the stall escalation (consecutive steps with no successful edit and no new
//   tool result get a change-of-approach note, then a stronger one, then the
//   turn stops). The exact-repeat and cycle guards catch identical calls; this
//   one also catches varied calls that keep failing or keep returning what the
//   turn has already seen.

import { createHash } from 'node:crypto'
import path from 'node:path'

/** Tools whose success changes workspace files the agent knows about. */
const EDIT_TOOLS = new Set(['apply_patch', 'write_file', 'edit_file'])
/** Tools whose run counts as checking the work (pass or fail). */
const CHECK_TOOLS = new Set(['shell', 'run_code', 'verify_file', 'lsp', 'job_wait'])
/**
 * Edits to prose need no build or test. A turn that only touched these is not
 * held back by the verification gate.
 */
const PROSE_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc'])

export interface CheckRecord {
  step: number
  tool: string
  /** The command or file checked (shortened). */
  target: string
  /** False when the check failed (non-zero exit, timeout, tool error). */
  passed: boolean
  exitCode?: number
}

export interface VerificationSummary {
  /** Workspace-relative files the turn changed through the edit tools. */
  editedFiles: string[]
  /** Checks run during the turn, oldest first (at most the last 8). */
  checks: CheckRecord[]
  /** At least one check ran after the last edit. */
  verifiedAfterLastEdit: boolean
  /** The last check after the last edit passed. */
  lastCheckPassed?: boolean
}

export interface StallState {
  /** Consecutive steps without progress. */
  steps: number
  /** 0: none, 1: first note, 2: second note, 3: stop. */
  level: 0 | 1 | 2 | 3
}

interface Outcome {
  call: { tool: string; args?: unknown }
  ok: boolean
  output: string
  result?: unknown
  blocked?: boolean
}

function shorten(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The files an edit call names (`apply_patch` diff headers, `file`/`path`). */
export function editedFilesOf(tool: string, args: unknown, result?: unknown): string[] {
  const out = new Set<string>()
  const fromResult = result as { appliedFiles?: unknown; created?: unknown; deleted?: unknown } | undefined
  for (const list of [fromResult?.appliedFiles, fromResult?.created, fromResult?.deleted]) {
    if (Array.isArray(list)) for (const file of list) if (typeof file === 'string' && file) out.add(file)
  }
  if (out.size > 0) return [...out]
  const a = (args ?? {}) as Record<string, unknown>
  for (const key of ['file', 'path']) if (typeof a[key] === 'string' && a[key]) out.add(a[key] as string)
  if (tool === 'apply_patch' && typeof a.patch === 'string') {
    for (const match of a.patch.matchAll(/^\+\+\+ (?:b\/)?([^\t\n]+)/gm)) {
      const file = match[1]!.trim()
      if (file && file !== '/dev/null') out.add(file)
    }
  }
  return [...out]
}

function checkTarget(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  if (typeof a.command === 'string') return shorten(a.command)
  if (typeof a.path === 'string') return shorten(`${typeof a.check === 'string' ? `${a.check} ` : ''}${a.path}`)
  if (typeof a.code === 'string') return shorten(a.code, 60)
  return tool
}

function exitCodeOf(result: unknown): number | undefined {
  const value = (result as { exitCode?: unknown } | undefined)?.exitCode
  return typeof value === 'number' ? value : undefined
}

export class TurnProgress {
  private readonly edited = new Set<string>()
  private readonly checks: CheckRecord[] = []
  private lastEditStep = 0
  private lastCheckStep = 0
  private lastCheckPassed: boolean | undefined
  private readonly seen = new Set<string>()
  private stalled = 0
  private level: StallState['level'] = 0

  /** `stallSteps`: steps without progress before the first note (0 turns the escalation off). */
  constructor(private readonly stallSteps = 8) {}

  /** Records one step's outcomes and returns the stall state after it. */
  record(step: number, outcomes: readonly Outcome[]): StallState {
    let progressed = false
    for (const o of outcomes) {
      const tool = o.call.tool
      if (o.ok && EDIT_TOOLS.has(tool)) {
        for (const file of editedFilesOf(tool, o.call.args, o.result)) this.edited.add(file)
        this.lastEditStep = step
        progressed = true
      }
      // A backgrounded shell has not run its check yet; `job_wait` will.
      const backgrounded = (o.result as { status?: unknown } | undefined)?.status === 'backgrounded'
      if (CHECK_TOOLS.has(tool) && !o.blocked && !backgrounded) {
        const exitCode = exitCodeOf(o.result)
        const passed = o.ok && (exitCode === undefined || exitCode === 0) && (o.result as { passed?: unknown } | undefined)?.passed !== false
        this.checks.push({ step, tool, target: checkTarget(tool, o.call.args), passed, ...(exitCode !== undefined ? { exitCode } : {}) })
        if (this.checks.length > 8) this.checks.shift()
        this.lastCheckStep = step
        this.lastCheckPassed = passed
      }
      if (o.ok && !o.blocked) {
        const fingerprint = createHash('sha256').update(`${tool}\0${o.output}`).digest('hex')
        if (!this.seen.has(fingerprint)) {
          this.seen.add(fingerprint)
          progressed = true
        }
      }
    }
    if (progressed) {
      this.stalled = 0
      this.level = 0
    } else {
      this.stalled += 1
    }
    if (this.stallSteps > 0) {
      const next = this.stalled >= this.stallSteps * 3 ? 3 : this.stalled >= this.stallSteps * 2 ? 2 : this.stalled >= this.stallSteps ? 1 : 0
      if (next > this.level) {
        this.level = next
        return { steps: this.stalled, level: next }
      }
    }
    return { steps: this.stalled, level: 0 }
  }

  /** A new user instruction restarts the stall count. */
  resetStall(): void {
    this.stalled = 0
    this.level = 0
  }

  /** Files changed after the last check, excluding prose-only edits. */
  uncheckedEdits(): string[] {
    if (this.lastEditStep === 0 || this.lastCheckStep >= this.lastEditStep) return []
    const code = [...this.edited].filter((file) => !PROSE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    return code
  }

  summary(): VerificationSummary {
    const verifiedAfterLastEdit = this.lastEditStep > 0 && this.lastCheckStep >= this.lastEditStep
    return {
      editedFiles: [...this.edited],
      checks: [...this.checks],
      verifiedAfterLastEdit,
      ...(verifiedAfterLastEdit && this.lastCheckPassed !== undefined ? { lastCheckPassed: this.lastCheckPassed } : {}),
    }
  }
}

/** The note sent back when a final answer follows an unchecked edit. */
export function verificationNudge(files: readonly string[]): string {
  const list = files.slice(0, 6).join(', ') + (files.length > 6 ? `, and ${files.length - 6} more` : '')
  return `You changed ${list} after your last check, and no build, test, lint or run has confirmed the change. ` +
    'Before finishing, run the narrowest relevant check with a tool (build, test, type check, lint, or run the changed code). ' +
    'If no check applies or one cannot run here, reply with your final answer and say plainly what was not verified.'
}

/** The escalating note for a stall (levels 1 and 2). */
export function stallNote(state: StallState, canAsk: boolean): string {
  if (state.level === 1) {
    return `\n[progress check] ${state.steps} steps in a row produced no successful edit and no new result. ` +
      'Stop repeating variations of the same approach. Re-read the last error, state the most likely root cause, and pick a different method ' +
      '(another tool, a smaller experiment, or reading the code that fails).'
  }
  return `\n[progress check] ${state.steps} steps in a row produced no progress. ` +
    (canAsk
      ? 'If a missing fact, permission or decision blocks you, ask the user with ask_user now. Otherwise change approach completely or finish and report what is blocked.'
      : 'Change approach completely, or finish now with a final answer that reports what is blocked and what was tried.')
}

/** The GUI notice for a verification summary (translated by the web app). */
export function verificationNoticeText(summary: VerificationSummary): { text: string; level: 'info' | 'warn' } | undefined {
  if (summary.editedFiles.length === 0) return undefined
  if (summary.verifiedAfterLastEdit) {
    const last = summary.checks.at(-1)
    const detail = last ? `${last.target}${last.exitCode !== undefined ? ` (exit ${last.exitCode})` : ''}` : ''
    return summary.lastCheckPassed === false
      ? { text: `Last check failed: ${detail}`, level: 'warn' }
      : { text: `Checked after the last edit: ${detail}`, level: 'info' }
  }
  const prose = summary.editedFiles.every((file) => PROSE_EXTENSIONS.has(path.extname(file).toLowerCase()))
  if (prose) return undefined
  return { text: `Not verified after the last edit: ${summary.editedFiles.slice(0, 4).join(', ')}${summary.editedFiles.length > 4 ? ', …' : ''}`, level: 'warn' }
}
