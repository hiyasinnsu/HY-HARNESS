/**
 * CP-36: GUI preferences kept in `<stateDir>/ui-state.json` (`prefs`), so the
 * statusline, code colours, Vim mode and shortcuts survive a restart and are
 * the same in the browser and the desktop app.
 *
 * The server normalises whatever it reads or receives: unknown statusline
 * items, themes or shortcut ids are dropped instead of failing the GUI.
 */

export const STATUS_ITEMS = ['model', 'sandbox', 'tokens', 'cache', 'last', 'context', 'turns'] as const
export type StatusItem = (typeof STATUS_ITEMS)[number]

export const CODE_THEMES = ['auto', 'github', 'monokai', 'plain'] as const
export type CodeTheme = (typeof CODE_THEMES)[number]

export interface UiPrefs {
  statusline: StatusItem[]
  codeTheme: CodeTheme
  vimMode: boolean
  /** Shortcut id → accelerator (`Ctrl+K`); empty means the defaults. */
  shortcuts: Record<string, string>
}

export const DEFAULT_PREFS: UiPrefs = {
  statusline: ['tokens', 'cache', 'last'],
  codeTheme: 'auto',
  vimMode: false,
  shortcuts: {},
}

const ACCELERATOR = /^(?:(?:Ctrl|Alt|Shift|Meta)\+){0,4}[^+\s]{1,12}$/

export function normalizePrefs(raw: unknown): UiPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_PREFS, statusline: [...DEFAULT_PREFS.statusline], shortcuts: {} }
  const r = raw as Record<string, unknown>
  const statusline = Array.isArray(r.statusline)
    ? [...new Set(r.statusline.filter((x): x is StatusItem => typeof x === 'string' && (STATUS_ITEMS as readonly string[]).includes(x)))]
    : [...DEFAULT_PREFS.statusline]
  const codeTheme = typeof r.codeTheme === 'string' && (CODE_THEMES as readonly string[]).includes(r.codeTheme) ? (r.codeTheme as CodeTheme) : DEFAULT_PREFS.codeTheme
  const shortcuts: Record<string, string> = {}
  if (r.shortcuts && typeof r.shortcuts === 'object' && !Array.isArray(r.shortcuts)) {
    for (const [id, keys] of Object.entries(r.shortcuts as Record<string, unknown>)) {
      if (/^[A-Za-z][\w-]{0,40}$/.test(id) && typeof keys === 'string' && ACCELERATOR.test(keys)) shortcuts[id] = keys
    }
  }
  return { statusline, codeTheme, vimMode: r.vimMode === true, shortcuts }
}
