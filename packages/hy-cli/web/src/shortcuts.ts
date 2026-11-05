// WP-61: keyboard shortcuts (DSH's `dsh-client-shortcuts`).
//
// Bindings are accelerators (`Ctrl+K`, `Ctrl+Shift+N`, `Alt+ArrowUp`) stored per
// device in localStorage. The parser is strict so a recorded chord is always
// reproducible and never silently binds to nothing.
import type { Locale } from './i18n.js'

export interface ShortcutAction {
  id: string
  /** i18n key of the label shown in the editor. */
  labelKey: string
  /** Default chord. */
  defaultKeys: string
}

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: 'palette', labelKey: 'shortcutPalette', defaultKeys: 'Ctrl+K' },
  { id: 'newSession', labelKey: 'shortcutNewSession', defaultKeys: 'Ctrl+N' },
  { id: 'settings', labelKey: 'shortcutSettings', defaultKeys: 'Ctrl+,' },
  { id: 'outline', labelKey: 'shortcutOutline', defaultKeys: 'Ctrl+Shift+O' },
  { id: 'toggleSidebar', labelKey: 'shortcutSidebar', defaultKeys: 'Ctrl+B' },
  { id: 'toggleTheme', labelKey: 'shortcutTheme', defaultKeys: 'Ctrl+Shift+L' },
  { id: 'focusComposer', labelKey: 'shortcutFocusComposer', defaultKeys: 'Ctrl+L' },
  { id: 'stopTurn', labelKey: 'shortcutStop', defaultKeys: 'Ctrl+.' },
]

export type ShortcutMap = Record<string, string>

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const
const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  space: 'Space',
  esc: 'Escape',
  escape: 'Escape',
  del: 'Delete',
  delete: 'Delete',
  ins: 'Insert',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
}

/**
 * Parses `ctrl+shift+k` into the canonical `Ctrl+Shift+K`.
 * Returns null for a chord that is only modifiers or unknown names.
 */
export function normalizeAccelerator(raw: string): string | null {
  const parts = raw
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const modifiers = new Set<string>()
  let key: string | undefined
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') modifiers.add('Ctrl')
    else if (lower === 'alt' || lower === 'option') modifiers.add('Alt')
    else if (lower === 'shift') modifiers.add('Shift')
    else if (lower === 'meta' || lower === 'cmd' || lower === 'win') modifiers.add('Meta')
    else if (key === undefined) {
      const alias = KEY_ALIASES[lower]
      key = alias ?? (part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    } else {
      // Two non-modifier keys: not an accelerator.
      return null
    }
  }
  if (!key) return null
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier))
  // A bare letter would fire while typing; only Escape and the function keys are
  // safe without a modifier.
  if (ordered.length === 0 && key !== 'Escape' && !/^F([1-9]|1[0-2])$/.test(key)) return null
  return [...ordered, key].join('+')
}

/** Whether a keyboard event matches the parsed accelerator. */
export function matchesAccelerator(
  event: { key: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean },
  accelerator: string,
): boolean {
  const parsed = normalizeAccelerator(accelerator)
  if (!parsed) return false
  const parts = parsed.split('+')
  const key = parts[parts.length - 1]!
  const modifiers = new Set(parts.slice(0, -1))
  if (modifiers.has('Ctrl') !== (event.ctrlKey === true)) return false
  if (modifiers.has('Alt') !== (event.altKey === true)) return false
  if (modifiers.has('Shift') !== (event.shiftKey === true)) return false
  if (modifiers.has('Meta') !== (event.metaKey === true)) return false
  const eventKey = event.key.length === 1 ? event.key.toUpperCase() : event.key
  const wanted = key.length === 1 ? key.toUpperCase() : key
  return eventKey === wanted || event.key === key
}

/** Defaults with the stored overrides applied; invalid values are dropped. */
export function resolveShortcuts(stored: unknown): ShortcutMap {
  const out: ShortcutMap = {}
  for (const action of SHORTCUT_ACTIONS) out[action.id] = action.defaultKeys
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out
  const overrides = stored as Record<string, unknown>
  for (const action of SHORTCUT_ACTIONS) {
    const value = overrides[action.id]
    if (typeof value !== 'string') continue
    const parsed = normalizeAccelerator(value)
    if (parsed) out[action.id] = parsed
  }
  return out
}

/** Actions whose chord is also used by another action. */
export function shortcutConflicts(bindings: ShortcutMap): string[] {
  const seen = new Map<string, string>()
  const conflicts: string[] = []
  for (const action of SHORTCUT_ACTIONS) {
    const keys = normalizeAccelerator(bindings[action.id] ?? '')
    if (!keys) continue
    const other = seen.get(keys)
    if (other) conflicts.push(`${other} / ${action.id}: ${keys}`)
    else seen.set(keys, action.id)
  }
  return conflicts
}

export function shortcutLabel(actionId: string, bindings: ShortcutMap): string {
  return bindings[actionId] ?? ''
}

/** Locale-independent: the editor shows the chord itself. */
export function localeHint(locale: Locale): string {
  return locale === 'ja' ? 'ショートカット' : locale === 'zh' ? '快捷键' : 'Shortcuts'
}
