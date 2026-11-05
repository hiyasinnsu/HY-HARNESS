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
import fs from 'node:fs';
import path from 'node:path';
import { userConfigDir } from './config.js';
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** Catalog limits, so a large skill collection cannot crowd the prompt. */
export const MAX_SKILLS = 40;
const MAX_DESCRIPTION = 200;
/** `name` and `description` from a leading `---` frontmatter block. */
export function parseSkillFrontmatter(text) {
    const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (!m)
        return { body: text };
    const out = { body: text.slice(m[0].length) };
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^(name|description)\s*:\s*(.*)$/.exec(line);
        if (!kv)
            continue;
        const value = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
        if (kv[1] === 'name')
            out.name = value;
        else
            out.description = value;
    }
    return out;
}
/**
 * Skills from the user's directory and the project (`.hy-harness/skills`,
 * `.agents/skills`). A project skill with the same name as a user skill wins,
 * as the more specific one. Invalid skills are skipped.
 */
export function discoverSkills(workspaceRoot, userDir = userConfigDir()) {
    const byName = new Map();
    const roots = [
        ...(userDir !== undefined ? [[path.join(userDir, 'skills'), 'user']] : []),
        [path.join(workspaceRoot, '.agents', 'skills'), 'project'],
        [path.join(workspaceRoot, '.hy-harness', 'skills'), 'project'],
    ];
    for (const [root, scope] of roots) {
        let dirs;
        try {
            dirs = fs.readdirSync(root, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const d of dirs.sort((a, b) => (a.name < b.name ? -1 : 1))) {
            if (!d.isDirectory())
                continue;
            const file = path.join(root, d.name, 'SKILL.md');
            let text;
            try {
                text = fs.readFileSync(file, 'utf8');
            }
            catch {
                continue;
            }
            const fm = parseSkillFrontmatter(text);
            const name = fm.name ?? d.name;
            if (!NAME.test(name) || !fm.description)
                continue;
            byName.set(name, { name, description: fm.description.slice(0, MAX_DESCRIPTION), file, scope });
        }
    }
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, MAX_SKILLS);
}
/** The system-prompt section listing the skills. */
export function renderSkillCatalog(skills) {
    if (skills.length === 0)
        return '';
    return [
        'Skills (instructions for specific tasks; call skill_load with the name before doing a task one describes):',
        ...skills.map((s) => `- ${s.name}: ${s.description}`),
    ].join('\n');
}
/** A skill's instructions, or one of its other files (`file` relative to the skill directory). */
export function loadSkill(skills, name, file) {
    const skill = skills.find((s) => s.name === name);
    if (!skill)
        throw new Error(`unknown skill: ${name}; available: ${skills.map((s) => s.name).join(', ') || 'none'}`);
    const dir = path.dirname(skill.file);
    const target = file === undefined ? skill.file : path.resolve(dir, file);
    if (target !== skill.file && !target.startsWith(dir + path.sep))
        throw new Error(`file escapes the skill directory: ${file}`);
    const text = fs.readFileSync(target, 'utf8');
    const content = file === undefined ? parseSkillFrontmatter(text).body.trim() : text;
    const files = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (files.length >= 50)
                return;
            const full = path.join(d, e.name);
            if (e.isDirectory())
                walk(full);
            else if (e.isFile() && full !== skill.file)
                files.push(path.relative(dir, full).split(path.sep).join('/'));
        }
    };
    walk(dir);
    const max = 50_000;
    return {
        name: skill.name,
        ...(file !== undefined ? { file } : {}),
        content: content.length > max ? `${content.slice(0, max)}\n… [truncated]` : content,
        files,
    };
}
