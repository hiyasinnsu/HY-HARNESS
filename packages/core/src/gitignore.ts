// `.gitignore` matching for the workspace search tools (search_glob,
// search_grep). Search skips what the repository ignores (build output,
// vendored checkouts such as `.refs/`), so results stay relevant and a walk does
// not visit tens of thousands of generated files. read_file is unaffected.
//
// Supported: comments, blank lines, `!` negation, a trailing `/` (directories
// only), anchoring (a `/` at the start or in the middle), `*`, `?`, `**` and
// `[...]` classes, and nested `.gitignore` files whose rules apply below their
// own directory. As in git, the last matching rule wins and nothing below an
// ignored directory is visited, so a negation cannot re-include a file there.

export interface IgnoreRule {
  /** Directory of the `.gitignore` the rule came from, root-relative (`''` = root). */
  base: string
  negate: boolean
  dirOnly: boolean
  re: RegExp
}

function patternToRegExp(pattern: string): string {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\' && i + 1 < pattern.length) {
      re += escapeChar(pattern[++i]!)
    } else if (c === '*') {
      if (pattern[i + 1] === '*') {
        const atStart = i === 0 || pattern[i - 1] === '/'
        const next = pattern[i + 2]
        if (atStart && next === '/') {
          re += '(?:.*/)?'
          i += 2
        } else if (atStart && next === undefined) {
          re += '.*'
          i += 1
        } else {
          re += '[^/]*'
          i += 1
        }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2)
      if (end < 0) re += '\\['
      else {
        let body = pattern.slice(i + 1, end)
        if (body.startsWith('!')) body = `^${body.slice(1)}`
        re += `[${body.replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else re += escapeChar(c)
  }
  return re
}

function escapeChar(c: string): string {
  return /[.+^$(){}|[\]\\]/.test(c) ? `\\${c}` : c
}

/** Parses one `.gitignore`; `base` is its directory, root-relative with `/`. */
export function parseGitignore(text: string, base = ''): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '')
    if (line === '' || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1)
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (line === '') continue
    // A slash at the start or in the middle anchors the pattern to `base`;
    // otherwise it matches a name at any depth below `base`.
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    const body = patternToRegExp(line)
    rules.push({ base, negate, dirOnly, re: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}$`, 'i') })
  }
  return rules
}

/**
 * Whether `rel` (root-relative, `/`-separated) is ignored by `rules`, given in
 * the order they apply (outer `.gitignore` first). Parents are not checked:
 * the walker never descends into an ignored directory.
 */
export function isIgnored(rules: readonly IgnoreRule[], rel: string, isDir: boolean): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    let sub = rel
    if (rule.base !== '') {
      if (!rel.toLowerCase().startsWith(`${rule.base.toLowerCase()}/`)) continue
      sub = rel.slice(rule.base.length + 1)
    }
    if (rule.re.test(sub)) ignored = !rule.negate
  }
  return ignored
}
