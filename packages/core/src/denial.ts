// CP-06: classify a failed tool call so the session can report *why* it was
// blocked (policy, approval, sandbox, network, protected path). The messages
// come from `crates/hy-exec-server` (e.g. "command denied by policy",
// "read-only sandbox forbids file writes") and from the control plane's
// approval path ("command not approved: ...").
//
// Classification is heuristic by necessity: the exec server reports Windows
// error text for confined processes, and a shell command's own stderr is not a
// denial. Only messages that name a mechanism are classified.

export type DenialKind = 'policy' | 'approval' | 'sandbox' | 'network' | 'protected'

export interface DenialInfo {
  kind: DenialKind
  /** The matched phrase, for the UI and the trace. */
  detail: string
}

const PATTERNS: ReadonlyArray<{ kind: DenialKind; re: RegExp }> = [
  { kind: 'policy', re: /denied by policy|policy (?:denied|blocked)|blocked by policy|matched rule/i },
  { kind: 'protected', re: /protected ?path|tamper|protectedPaths/i },
  { kind: 'approval', re: /requires approval|not approved|approval (?:denied|rejected)|rejected by (?:the )?(?:user|guardian)/i },
  {
    kind: 'sandbox',
    re: /forbids file writes|sandbox (?:denied|blocked|unavailable)|ACCESS_DENIED|EACCES|EPERM|0xC0000022|STATUS_ACCESS_DENIED|access is denied|read-only (?:sandbox|mode)/i,
  },
  { kind: 'network', re: /ENETUNREACH|ECONNREFUSED|EAI_AGAIN|network (?:access |is )?(?:denied|blocked)/i },
]

/** Returns what kind of denial a tool error message describes, if any. */
export function classifyDenial(message: string): DenialInfo | undefined {
  if (!message) return undefined
  for (const { kind, re } of PATTERNS) {
    const match = re.exec(message)
    if (match) return { kind, detail: match[0] }
  }
  return undefined
}

/** Short label used by the GUI (`blocked: sandbox`). */
export function denialLabel(info: DenialInfo): string {
  return `blocked: ${info.kind}`
}