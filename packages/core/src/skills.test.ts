import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rankSkills, SkillUsageStore, discoverSkills, loadSkill, parseSkillFrontmatter, renderSkillCatalog } from './skills.js'
import { buildSystemPrompt } from './prompt.js'

function skill(root: string, dir: string, text: string): void {
  fs.mkdirSync(path.join(root, dir), { recursive: true })
  fs.writeFileSync(path.join(root, dir, 'SKILL.md'), text)
}

test('skills: user and project directories, project wins on a name clash, invalid ones skipped', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-skills-'))
  try {
    const user = path.join(tmp, 'user')
    const ws = path.join(tmp, 'ws')
    skill(path.join(user, 'skills'), 'release', '---\nname: release\ndescription: user version\n---\nU')
    skill(path.join(user, 'skills'), 'nodesc', '---\nname: nodesc\n---\nno description, skipped')
    skill(path.join(ws, '.hy-harness', 'skills'), 'release', '---\nname: release\ndescription: "project version"\n---\nP')
    skill(path.join(ws, '.agents', 'skills'), 'lint-fix', '---\ndescription: Fix lint errors.\n---\nRun the linter.\n')
    fs.writeFileSync(path.join(ws, '.agents', 'skills', 'lint-fix', 'checklist.md'), '- one\n')

    const skills = discoverSkills(ws, user)
    assert.deepEqual(
      skills.map((s) => [s.name, s.description, s.scope]),
      [
        ['lint-fix', 'Fix lint errors.', 'project'],
        ['release', 'project version', 'project'],
      ],
    )
    assert.equal(renderSkillCatalog(skills).split('\n').length, 3)
    assert.match(buildSystemPrompt(ws, false, false, { skills }), /- skill_load\(args[\s\S]*Skills \(instructions[\s\S]*- lint-fix: Fix lint errors\./)
    assert.doesNotMatch(buildSystemPrompt(ws), /skill_load|Skills \(/)

    const loaded = loadSkill(skills, 'lint-fix')
    assert.equal(loaded.content, 'Run the linter.')
    assert.deepEqual(loaded.files, ['checklist.md'])
    assert.equal(loadSkill(skills, 'lint-fix', 'checklist.md').content, '- one\n')
    assert.throws(() => loadSkill(skills, 'lint-fix', '../../../user/skills/release/SKILL.md'), /escapes the skill directory/)
    assert.throws(() => loadSkill(skills, 'nope'), /unknown skill: nope; available: lint-fix, release/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('frontmatter parsing tolerates a BOM, CRLF and no frontmatter', () => {
  assert.deepEqual(parseSkillFrontmatter('﻿---\r\nname: a\r\ndescription: b\r\n---\r\nbody'), { name: 'a', description: 'b', body: 'body' })
  assert.deepEqual(parseSkillFrontmatter('just text'), { body: 'just text' })
})

const skillInfo = (name: string, description: string) => ({ name, description, file: `${name}/SKILL.md`, scope: 'user' as const })

test('CP-21: skills are ranked by name mention, description overlap and usage', () => {
  const skills = [
    skillInfo('release-notes', 'Write release notes from the git log.'),
    skillInfo('lint-fix', 'Fix lint errors in TypeScript files.'),
    skillInfo('migration', 'Plan a database migration safely.'),
  ]
  assert.equal(rankSkills(skills, 'please write release notes')[0]!.name, 'release-notes')
  assert.equal(rankSkills(skills, 'typescript errors')[0]!.name, 'lint-fix')
  // Usage breaks ties between equally scoring skills.
  const tied = [skillInfo('a', 'shared words'), skillInfo('b', 'shared words')]
  assert.equal(rankSkills(tied, 'nothing relevant', { usage: () => 3 })[0]!.name, 'a')
  assert.equal(rankSkills(tied, 'nothing relevant', { usage: (name) => (name === 'b' ? 3 : 0) })[0]!.name, 'b')
  assert.equal(rankSkills(skills, 'anything', { limit: 2 }).length, 2)
})

test('CP-21: the usage store persists counts and sorts skills', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-skill-usage-'))
  try {
    const store = SkillUsageStore.forStateDir(dir)
    const skills = [skillInfo('a', 'x'), skillInfo('b', 'y'), skillInfo('c', 'z')]
    assert.deepEqual(store.all(), {})
    store.bump('b')
    store.bump('b')
    store.bump('c')
    assert.equal(store.get('b'), 2)
    assert.deepEqual(store.sort(skills).map((s) => s.name), ['b', 'c', 'a'])
    // A corrupt file reads as empty instead of throwing.
    fs.writeFileSync(path.join(dir, 'skill-usage.json'), 'not json')
    assert.deepEqual(store.all(), {})
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})