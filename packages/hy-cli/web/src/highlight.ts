/**
 * CP-36: a small, dependency-free syntax highlighter for code blocks.
 *
 * It recognises comments, strings, numbers and keywords for the languages the
 * agent writes most (JS/TS/JSON, Python, Rust, Go, C-like, shell/PowerShell,
 * diff) and wraps them in `tok-*` spans; colours come from the theme
 * (`[data-code-theme]` in styles.css). Output is always escaped HTML.
 *
 * Pure module: web/test/highlight.test.mjs.
 */
// Own escaper: markdown.ts imports this module, so importing it back would cycle.
const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

type Family = 'c' | 'python' | 'shell' | 'json' | 'diff' | 'none'

const FAMILY: Record<string, Family> = {
  js: 'c', javascript: 'c', jsx: 'c', ts: 'c', typescript: 'c', tsx: 'c', mjs: 'c', cjs: 'c',
  rust: 'c', rs: 'c', go: 'c', java: 'c', c: 'c', cpp: 'c', 'c++': 'c', cs: 'c', csharp: 'c', kotlin: 'c', swift: 'c',
  py: 'python', python: 'python',
  sh: 'shell', bash: 'shell', shell: 'shell', zsh: 'shell', ps1: 'shell', powershell: 'shell', pwsh: 'shell', bat: 'shell', cmd: 'shell',
  json: 'json', jsonc: 'json',
  diff: 'diff', patch: 'diff',
}

const KEYWORDS: Record<'c' | 'python' | 'shell', ReadonlySet<string>> = {
  c: new Set(
    'abstract as async await break case catch class const continue crate default defer delete do else enum export extends false final finally fn for func function go if impl implements import in instanceof interface let loop match mod module mut new null package private protected pub public return self static struct super switch this throw trait true try type typeof undefined use var void where while with yield'.split(' '),
  ),
  python: new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self'.split(' ')),
  shell: new Set('if then else elif fi for while do done case esac function in return export local echo cd set unset param foreach begin process end try catch finally throw switch write-host get-childitem set-location'.split(' ')),
}

interface Rule {
  re: RegExp
  cls: string
}

function rules(family: Exclude<Family, 'none' | 'diff'>): Rule[] {
  const num = { re: /\b(?:0x[0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b/y, cls: 'num' }
  const word = { re: /[A-Za-z_$][\w$-]*/y, cls: 'word' }
  switch (family) {
    case 'c':
      return [
        { re: /\/\/[^\n]*/y, cls: 'com' },
        { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'com' },
        { re: /`(?:\\[\s\S]|[^`\\])*`?/y, cls: 'str' },
        { re: /"(?:\\.|[^"\\\n])*"?/y, cls: 'str' },
        { re: /'(?:\\.|[^'\\\n])*'?/y, cls: 'str' },
        num,
        { re: /[A-Za-z_$][\w$]*/y, cls: 'word' },
      ]
    case 'python':
      return [
        { re: /#[^\n]*/y, cls: 'com' },
        { re: /("""|''')[\s\S]*?(?:\1|$)/y, cls: 'str' },
        { re: /[rbfu]?"(?:\\.|[^"\\\n])*"?/y, cls: 'str' },
        { re: /[rbfu]?'(?:\\.|[^'\\\n])*'?/y, cls: 'str' },
        num,
        { re: /[A-Za-z_][\w]*/y, cls: 'word' },
      ]
    case 'shell':
      return [
        { re: /(?:^|(?<=\s))#[^\n]*/y, cls: 'com' },
        { re: /"(?:\\.|`.|[^"\\`\n])*"?/y, cls: 'str' },
        { re: /'[^'\n]*'?/y, cls: 'str' },
        { re: /\$\{?[\w:]+\}?/y, cls: 'var' },
        num,
        word,
      ]
    case 'json':
      return [
        { re: /"(?:\\.|[^"\\\n])*"(?=\s*:)/y, cls: 'key' },
        { re: /"(?:\\.|[^"\\\n])*"?/y, cls: 'str' },
        { re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: 'num' },
        { re: /\b(?:true|false|null)\b/y, cls: 'kw' },
      ]
  }
}

export function languageFamily(lang: string | undefined): Family {
  return FAMILY[(lang ?? '').trim().toLowerCase()] ?? 'none'
}

/** Escaped HTML with `tok-*` spans; unknown languages are only escaped. */
export function highlightCode(code: string, lang?: string): string {
  const family = languageFamily(lang)
  if (family === 'none') return escapeHtml(code)
  if (family === 'diff') {
    return code
      .split('\n')
      .map((line) => {
        const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'meta' : ''
        return cls ? `<span class="tok-${cls}">${escapeHtml(line)}</span>` : escapeHtml(line)
      })
      .join('\n')
  }
  const list = rules(family)
  const keywords = family === 'json' ? undefined : KEYWORDS[family]
  let out = ''
  let plain = ''
  let i = 0
  const flush = () => {
    if (plain) out += escapeHtml(plain)
    plain = ''
  }
  outer: while (i < code.length) {
    for (const rule of list) {
      rule.re.lastIndex = i
      const m = rule.re.exec(code)
      if (!m || m[0].length === 0) continue
      const text = m[0]
      if (rule.cls === 'word') {
        const isKeyword = keywords?.has(family === 'shell' ? text.toLowerCase() : text)
        if (isKeyword) {
          flush()
          out += `<span class="tok-kw">${escapeHtml(text)}</span>`
        } else {
          plain += text
        }
      } else {
        flush()
        out += `<span class="tok-${rule.cls}">${escapeHtml(text)}</span>`
      }
      i += text.length
      continue outer
    }
    plain += code[i]
    i += 1
  }
  flush()
  return out
}
