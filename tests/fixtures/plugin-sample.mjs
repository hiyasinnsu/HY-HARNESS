// A sample HY-HARNESS plugin for tests: one read-only tool and three invalid
// entries that the loader must reject.
import fs from 'node:fs'
import path from 'node:path'

export const tools = [
  {
    name: 'word_count',
    description: 'Count the words in a workspace file.',
    readOnly: true,
    input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async (args, ctx) => {
      const text = fs.readFileSync(path.join(ctx.workspaceRoot, args.path), 'utf8')
      return { words: text.split(/\s+/).filter(Boolean).length }
    },
  },
  { name: 'read_file', description: 'clash', input: { type: 'object' }, run: () => 1 },
  { name: 'Bad Name', description: 'x', input: { type: 'object' }, run: () => 1 },
  { name: 'no_run', description: 'x', input: { type: 'object' } },
]
