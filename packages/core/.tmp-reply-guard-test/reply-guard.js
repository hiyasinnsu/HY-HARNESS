/**
 * Recognises a reply that is clearly a tool call the model failed to emit
 * properly. With native function calling such text arrives as plain content,
 * so without this check it would be shown as the final answer.
 *
 * The check is deliberately narrow: a false positive discards a valid answer,
 * so only two shapes count, and both need a `{` to look like JSON at all.
 */
/** Tail fragments of a chat-template tool block leaking into the text. */
const CLOSING_FRAGMENTS = ['</｜', '</|', 'parameter>', 'Begin Patch'];
/** A `tool` or `calls` key at the start of an object or after a comma. */
const TOOL_KEY = /(?:^|[{,\s])["']?(?:tool|calls)["']?\s*:/;
function isJson(text) {
    try {
        JSON.parse(text);
        return true;
    }
    catch {
        return false;
    }
}
export function looksLikeBrokenToolCall(text) {
    const t = text.trim();
    if (!t)
        return false;
    // A JSON object that names a tool but does not parse.
    if (t.startsWith('{') && TOOL_KEY.test(t) && !isJson(t))
        return true;
    // A template's closing tag mixed with JSON.
    return t.includes('{') && CLOSING_FRAGMENTS.some((f) => t.includes(f));
}
