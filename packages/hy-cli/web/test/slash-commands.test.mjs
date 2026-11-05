// CP-32: one command table drives the composer, /help and the palette.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS, filterCommands, helpRows, parseSlash, slashCompletions } from '../dist/slash-commands.js'

const here = path.dirname(fileURLToPath(import.meta.url))

test('CP-32: ids and slash names (aliases included) are unique', () => {
  const ids = COMMANDS.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length)
  const names = COMMANDS.flatMap((c) => [c.slash, ...(c.aliases ?? [])].filter(Boolean))
  assert.equal(new Set(names).size, names.length)
})

test('CP-32: the plan commands are all present', () => {
  const names = new Set(COMMANDS.flatMap((c) => [c.slash, ...(c.aliases ?? [])].filter(Boolean)))
  // docs/codex-adoption-plan.md CP-32, minus /worktree and /import (no GUI backend yet).
  for (const name of ['status', 'usage', 'diff', 'export', 'skills', 'mcp', 'plugins', 'hooks', 'memories', 'resume', 'fork', 'archive', 'rename', 'doctor', 'config', 'compact']) {
    assert.ok(names.has(name), `/${name}`)
  }
})

test('CP-32: /help lists every slash command with its arguments', () => {
  const rows = helpRows()
  assert.equal(rows.length, COMMANDS.filter((c) => c.slash).length)
  assert.ok(rows.some((r) => r.usage === '/model <name>'))
  assert.ok(rows.some((r) => r.usage === '/new, /clear'), 'aliases are listed with the command')
  assert.ok(rows.some((r) => r.usage === '/settings, /config'))
})

test('CP-32: every command has a handler in the GUI bundle', () => {
  const bundle = fs.readFileSync(path.join(here, '..', 'dist', 'app.js'), 'utf8')
  const body = bundle.slice(bundle.indexOf('async function runCommand('), bundle.indexOf('async function showRight('))
  assert.ok(body.length > 0, 'runCommand is in the bundle')
  for (const c of COMMANDS) {
    if (c.section) continue
    assert.ok(body.includes(`case '${c.id}':`), `runCommand handles ${c.id}`)
  }
  for (const c of COMMANDS.filter((x) => x.section)) {
    assert.ok(bundle.includes(`data-section="${c.section}"`), `details section ${c.section} exists for ${c.id}`)
  }
})

test('CP-32: parseSlash resolves names and aliases and keeps the arguments', () => {
  assert.equal(parseSlash('hello'), undefined)
  assert.equal(parseSlash('/path/to/file explain'), undefined, 'a path is a message, not a command')
  assert.deepEqual(parseSlash('/Rename  New title ')?.args, 'New title')
  assert.equal(parseSlash('/rename x')?.command?.id, 'rename')
  assert.equal(parseSlash('/clear')?.command?.id, 'new')
  assert.equal(parseSlash('/memory')?.command?.id, 'memories')
  const unknown = parseSlash('/nope')
  assert.equal(unknown?.name, 'nope')
  assert.equal(unknown?.command, undefined)
})

test('CP-32: palette search matches labels, slash names and descriptions', () => {
  assert.equal(filterCommands('').length, COMMANDS.filter((c) => c.label).length)
  assert.equal(filterCommands('rename')[0]?.id, 'rename')
  assert.equal(filterCommands('/mcp')[0]?.id, 'mcp')
  assert.ok(filterCommands('token').some((c) => c.id === 'usage'), 'description hit')
  assert.ok(!filterCommands('model').some((c) => c.id === 'model'), 'slash-only commands stay out of the palette')
  assert.deepEqual(filterCommands('zzz-nothing'), [])
})

test('CP-32: composer completion by slash prefix', () => {
  assert.deepEqual(slashCompletions('/re').map((c) => c.id).sort(), ['rename', 'resume', 'review', 'rewind'])
  assert.deepEqual(slashCompletions('/mem').map((c) => c.id), ['memories'])
  assert.deepEqual(slashCompletions('hello'), [])
  assert.deepEqual(slashCompletions('/rename x'), [])
})
