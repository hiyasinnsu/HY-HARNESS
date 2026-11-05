/**
 * A user-assigned chat name.
 *
 * The name is only a label: it never replaces the automatic title derived from
 * the first user message, it is stored next to pins and archives in
 * `ui-state.json`, and it is rendered as text (never as HTML) by the GUI.
 */
/** Longest accepted name, in characters after whitespace collapsing. */
export const MAX_SESSION_TITLE_LENGTH = 120;
/**
 * Normalizes a submitted name.
 *
 * `null` (or a blank string) clears the name and lets the automatic title show
 * again. Control characters are collapsed to spaces so a name cannot smuggle
 * newlines or terminal escapes into the sidebar or the window title.
 */
export function normalizeSessionTitle(raw) {
    if (raw === null || raw === undefined)
        return { title: null };
    if (typeof raw !== 'string')
        return { error: 'title must be a string' };
    const cleaned = raw
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned)
        return { title: null };
    if (cleaned.length > MAX_SESSION_TITLE_LENGTH) {
        return { error: `title must be at most ${MAX_SESSION_TITLE_LENGTH} characters` };
    }
    return { title: cleaned };
}
