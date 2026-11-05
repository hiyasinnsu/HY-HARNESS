// Skills: reusable instructions the model loads on demand (Codex
// `docs/skills.md`, DSH `packages/skill`). Each skill is a directory with a
// `SKILL.md` whose frontmatter names and describes it:
//
//   ---
//   name: release-notes
//   description: Write release notes from the git log.
//   ---
//   <instructions>
//
// Only the one-line catalog (name: description) is in the system prompt;
// `skill_load` returns the body when the model decides it applies, so unused
// skills cost a line each.
import fs from 'node:fs'
import path from 'node:path'
import { userConfigDir } from './config.js'

export interface SkillInfo {
  name: string
  description: string
  /** Absolute path of SKILL.md. */
  file: string
  scope: 'user' | 'project'
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i
/** Catalog limits, so a large skill collection cannot crowd the prompt. */
export const MAX_SKILLS = 40
const MAX_DESCRIPTION = 200

/** `name` and `description` from a leading `---` frontmatter block. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { body: text }
  const out: { name?: string; description?: string; body: string } = { body: text.slice(m[0].length) }
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const value = kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')
    if (kv[1] === 'name') out.name = value
    else out.description = value
  }
  return out
}

/**
 * Skills from the user's directory and the project (`.hy-harness/skills`,
 * `.agents/skills`). A project skill with the same name as a user skill wins,
 * as the more specific one. Invalid skills are skipped.
 */
export function discoverSkills(workspaceRoot: string, userDir: string | undefined = userConfigDir()): SkillInfo[] {
  const byName = new Map<string, SkillInfo>()
  const roots: Array<[string, SkillInfo['scope']]> = [
    ...(userDir !== undefined ? [[path.join(userDir, 'skills'), 'user'] as [string, SkillInfo['scope']]] : []),
    [path.join(workspaceRoot, '.agents', 'skills'), 'project'],
    [path.join(workspaceRoot, '.hy-harness', 'skills'), 'project'],
  ]
  for (const [root, scope] of roots) {
    let dirs: fs.Dirent[]
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirs.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!d.isDirectory()) continue
      const file = path.join(root, d.name, 'SKILL.md')
      let text: string
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const fm = parseSkillFrontmatter(text)
      const name = fm.name ?? d.name
      if (!NAME.test(name) || !fm.description) continue
      byName.set(name, { name, description: fm.description.slice(0, MAX_DESCRIPTION), file, scope })
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, MAX_SKILLS)
}

/** The system-prompt section listing the skills. */
export function renderSkillCatalog(skills: readonly SkillInfo[]): string {
  if (skills.length === 0) return ''
  return [
    'Skills (instructions for specific tasks; call skill_load with the name before doing a task one describes):',
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n')
}

/** A skill's instructions, or one of its other files (`file` relative to the skill directory). */
export function loadSkill(skills: readonly SkillInfo[], name: string, file?: string) {
  const skill = skills.find((s) => s.name === name)
  if (!skill) throw new Error(`unknown skill: ${name}; available: ${skills.map((s) => s.name).join(', ') || 'none'}`)
  const dir = path.dirname(skill.file)
  const target = file === undefined ? skill.file : path.resolve(dir, file)
  if (target !== skill.file && !target.startsWith(dir + path.sep)) throw new Error(`file escapes the skill directory: ${file}`)
  const text = fs.readFileSync(target, 'utf8')
  const content = file === undefined ? parseSkillFrontmatter(text).body.trim() : text
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (files.length >= 50) return
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && full !== skill.file) files.push(path.relative(dir, full).split(path.sep).join('/'))
    }
  }
  walk(dir)
  const max = 50_000
  return {
    name: skill.name,
    ...(file !== undefined ? { file } : {}),
    content: content.length > max ? `${content.slice(0, max)}\n… [truncated]` : content,
    files,
  }
}

/**
 * CP-21: ranks skills for a request. Exact name/mention hits score highest,
 * then word overlap with the description, then prior usage (so a skill the
 * workspace keeps using stays near the top on ties).
 */
export function rankSkills(
  skills: readonly SkillInfo[],
  query: string,
  options: { usage?: (name: string) => number; limit?: number } = {},
): SkillInfo[] {
  const words = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9._-]+/)
      .filter((word) => word.length >= 3),
  )
  const scored = skills.map((skill) => {
    const name = skill.name.toLowerCase()
    const haystack = `${name} ${skill.description.toLowerCase()}`
    let score = 0
    // Short names would match inside ordinary words; only real words count.
    if (name.length >= 3 && query.toLowerCase().includes(name)) score += 10
    for (const word of words) {
      if (name.includes(word)) score += 3
      else if (haystack.includes(word)) score += 1
    }
    score += Math.min(5, options.usage?.(skill.name) ?? 0) * 0.1
    return { skill, score }
  })
  scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
  const limit = options.limit ?? skills.length
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.skill)
}

/**
 * CP-21: how often each skill was loaded, persisted beside the workspace state
 * so prompt ordering is stable across runs. Best effort: a broken file reads
 * as empty and a failed write is ignored.
 */
export class SkillUsageStore {
  constructor(private readonly file: string) {}

  static forStateDir(stateDir: string): SkillUsageStore {
    return new SkillUsageStore(path.join(stateDir, 'skill-usage.json'))
  }

  all(): Record<string, number> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, number> = {}
      for (const [name, count] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof count === 'number' && Number.isFinite(count) && count >= 0) out[name] = count
      }
      return out
    } catch {
      return {}
    }
  }

  get(name: string): number {
    return this.all()[name] ?? 0
  }

  bump(name: string): void {
    const counts = this.all()
    counts[name] = (counts[name] ?? 0) + 1
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(counts, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch {
      // Usage counts are advisory only.
    }
  }

  /** Skills sorted by usage (most used first), stable by name otherwise. */
  sort(skills: readonly SkillInfo[]): SkillInfo[] {
    const counts = this.all()
    return [...skills].sort((a, b) => (counts[b.name] ?? 0) - (counts[a.name] ?? 0) || a.name.localeCompare(b.name))
  }
}

/**
 * CP-21: `@skill:<name>` in a user message loads that skill for the turn.
 * The mention stays in the text; each known skill's SKILL.md body is added
 * once as a <skill> block, and an unknown name is said to be unknown instead
 * of being dropped silently.
 */
export function expandSkillMentions(
  message: string,
  skills: readonly SkillInfo[],
  load: (name: string) => { content: string } = (name) => loadSkill(skills, name),
): { text: string; used: string[]; unknown: string[] } {
  const names = [...new Set([...message.matchAll(/(?:^|\s)@skill:([A-Za-z0-9][\w.-]*)/g)].map((m) => m[1]!))]
  if (names.length === 0) return { text: message, used: [], unknown: [] }
  const used: string[] = []
  const unknown: string[] = []
  const blocks: string[] = []
  for (const name of names) {
    if (!skills.some((s) => s.name === name)) {
      unknown.push(name)
      continue
    }
    try {
      blocks.push(`<skill name="${name}">\n${load(name).content.trim()}\n</skill>`)
      used.push(name)
    } catch {
      unknown.push(name)
    }
  }
  const note = unknown.length ? [`[not installed skills: ${unknown.map((n) => `@skill:${n}`).join(', ')}]`] : []
  return { text: [message, ...blocks, ...note].join('\n\n'), used, unknown }
}
