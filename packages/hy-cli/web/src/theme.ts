/**
 * Theme choice and its toggle (WP-61), kept free of the DOM so the rules can be
 * tested.
 *
 * The stored choice is `light`, `dark` or `system`; the page only ever carries
 * the resolved `light` / `dark` in `<html data-theme>`, because the stylesheet
 * has no `system` palette. Writing the raw choice there made `system` fall back
 * to the default (dark) colours whatever the OS said.
 */

export type ThemeChoice = 'light' | 'dark' | 'system'

/** One cycle for every entry point (sidebar button, shortcut, menu): light → dark → system → light. */
export function nextTheme(theme: ThemeChoice): ThemeChoice {
  return theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'
}

/** The value for `<html data-theme>`: never `system`. */
export function resolveTheme(theme: ThemeChoice, prefersDark: boolean): 'light' | 'dark' {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
}

/**
 * The sidebar toggle shows the current choice (icon and label) and says in its
 * tooltip what a click switches to. It used to show only "Light" or "Dark",
 * so in dark mode it read "Light" while a click actually chose `system`.
 */
export function themeToggleView(theme: ThemeChoice): { icon: 'sun' | 'moon' | 'desktop'; labelKey: string; nextKey: string } {
  const icon = theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'desktop'
  const labelKey = theme === 'system' ? 'themeSystemShort' : theme
  return { icon, labelKey, nextKey: `theme_${nextTheme(theme)}` }
}
