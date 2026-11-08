// Detailed tool descriptions (2026-11-07, `promptVariant: lean4`).
//
// The short descriptions in the registry stay the default. lean4 sends these
// instead, with a description for every parameter, and drops from the system
// prompt what they now say (shell use, read-before-edit, how to search, how to
// patch). Like DeepSeek Harness, the "how to use this tool" guidance lives with
// the tool. The tool list is the same bytes on every request, so the longer
// text is a cached prefix.
//
// Keep every statement true to the implementation (tools.ts, patch.rs, the
// exec server's defaults); a wrong detail here misleads the model on every call.

export interface ToolDoc {
  description: string
  /** Parameter name → description. */
  params?: Readonly<Record<string, string>>
}

const WINDOWS = process.platform === 'win32'

export const RICH_TOOL_DOCS: Readonly<Record<string, ToolDoc>> = {
  read_file: {
    description:
      'Read a text file. Returns `content` (the lines, without line numbers), `totalLines` and `truncated`. ' +
      'One call returns at most 400 lines or 50,000 characters; when `truncated` is true, read the rest with startLine / endLine. ' +
      'Read a file before editing it: apply_patch, edit_file and write_file refuse a file you have not read, or one that changed since you read it. ' +
      'Use this rather than shell commands to look at files. A path that does not exist is an error: find the right one with search_glob or search_grep instead of guessing. ' +
      'Large outputs of earlier tools appear as `spill://…` references, which this tool can read.',
    params: {
      path: 'Workspace-relative path (src/app.ts), `rootId:path` for an added root, or a `spill://` reference.',
      startLine: 'First line to return, 1-based (default 1).',
      endLine: 'Last line to return, inclusive (default: the end of the file).',
    },
  },
  search_glob: {
    description:
      'Find files whose workspace-relative path matches a glob (`src/**/*.ts`, `docs/*.md`). ' +
      'Skips .git, node_modules and anything .gitignore\'d; an empty result for a skipped location says so in `note`. ' +
      'Use this rather than shell commands to discover files.',
    params: {
      pattern: 'Glob over the path relative to the root: `*` within a folder, `**` across folders.',
      root: 'Added root ID to search, or `*` for every root (default: main).',
      maxResults: 'Most paths to return (default 200); `truncated` says when more matched.',
    },
  },
  search_grep: {
    description:
      'Search file contents with a JavaScript regular expression; returns matching lines with their file and line number. ' +
      'Skips the same files as search_glob. Use this rather than shell commands to search; then read_file the matches you need.',
    params: {
      pattern: 'Regular expression (JavaScript syntax) matched against each line.',
      root: 'Added root ID to search, or `*` for every root (default: main).',
      glob: 'Only search files whose path matches this glob (`src/**/*.ts`).',
      ignoreCase: 'Match case-insensitively (default false).',
      maxResults: 'Most matching lines to return (default 100); `truncated` says when more matched.',
    },
  },
  shell: {
    description: `Run one command in ${WINDOWS ? 'Windows PowerShell (PowerShell syntax; Unix grep/head/find do not exist)' : 'the shell'} and return \`status\`, \`exitCode\`, \`stdout\` and \`stderr\`. ` +
      'Use it to build, test and run programs; use read_file, search_glob and search_grep to read and find files. Read an existing file before changing it. ' +
      'Each call is a fresh process: `cd` and variables do not carry over, so pass `cwd` instead. Quote paths that contain spaces. ' +
      (WINDOWS ? 'For multiline Python, write a .py file then run it; Bash heredocs (`<<`) do not work. When combining different object types in one command, format each table explicitly (`Format-Table -AutoSize`) or use `ConvertTo-Json` so columns are not lost. ' : '') +
      'A non-zero exitCode is a failure: read the output and find the cause before moving on. Chained commands can report only the last command\'s status, so inspect intermediate output or run critical checks separately. ' +
      'The call waits up to foregroundWaitMs (default 5,000 ms); a command still running then keeps going as a background job and the result is `status: "backgrounded"` with a `jobId`, ' +
      'so give builds and test suites a longer foregroundWaitMs (for example 600000). ' +
      'Commands run in the session sandbox; in workspace-write mode they can write only inside the workspace. ' +
      'A plain Node test command (`node --test`, `npm test`, `vitest`, `jest`) gets a sandbox where its child processes work; with a pipe or redirect it does not, so run it on its own and look at the output afterwards.',
    params: {
      command: `The command line${WINDOWS ? ' (PowerShell)' : ''}.`,
      cwd: 'Working directory, relative to the root (default: the root, or the session working directory).',
      root: 'Workspace root ID to run in (default main). An added root must be writable.',
      foregroundWaitMs: 'How long to wait before returning the command as a background job (default 5000).',
      hardTimeoutMs: 'Kill the command after this long (default 600000).',
      persistent: 'Run in the session\'s persistent shell, which keeps cd and variables between calls (unconfined sessions only).',
      stdinPipe: 'Keep stdin open so write_stdin can send input to the running command.',
      tty: 'Run in a pseudo terminal, for programs that need one (send input with write_stdin).',
    },
  },
  apply_patch: {
    description:
      'Change files, in one of two forms. ' +
      '(1) `patch`: a unified diff with `--- a/path` and `+++ b/path` headers and `@@ -start,count +start,count @@` hunks (line numbers required) with a few unchanged context lines; ' +
      '`*** Begin Patch` syntax is not supported; use a unified diff or file + content. ' +
      'one patch may change several files, and a new file uses `--- /dev/null`. ' +
      '(2) `file` + `content`: create the file, or replace it with the complete new content. ' +
      'Read an existing file first: one you have not read, or that changed since you read it, is refused. ' +
      'For a small targeted change edit_file is simpler when available. Split a large edit into several calls; do not send a whole large file in one response. ' +
      'In an added root only form (2) works, with `root`.',
    params: {
      patch: 'Unified diff (form 1).',
      file: 'Path of the file to create or replace (form 2).',
      content: 'The complete new content of the file (form 2).',
      root: 'Added root ID for form 2 (default main).',
    },
  },
  edit_file: {
    description:
      'Replace exact text in a file: `old` must occur exactly `count` times (default 1), and each occurrence becomes `new`. ' +
      'Copy `old` from read_file output with its exact whitespace and indentation, and include enough surrounding text to make it unique. ' +
      'On a miss, or a different number of occurrences, the error shows the closest lines so you can correct `old`. ' +
      'Read the file first. Best for small, targeted changes; primary root only.',
    params: {
      file: 'Workspace-relative path of the file.',
      old: 'The exact text to replace.',
      new: 'The replacement text.',
      count: 'How many times `old` must occur; every occurrence is replaced (default 1).',
    },
  },
  write_file: {
    description:
      'Create a file, or replace a whole file with new content. Read an existing file first (the same checks as apply_patch). ' +
      'For changes to part of a file use edit_file or apply_patch instead of rewriting it.',
    params: {
      file: 'Workspace-relative path of the file.',
      content: 'The complete content of the file.',
      root: 'Added root ID (default main).',
    },
  },
}

/** Adds parameter descriptions to a JSON Schema object (root properties only). */
export function withParamDocs<T extends { properties?: Record<string, unknown> }>(schema: T, params: Readonly<Record<string, string>> | undefined): T {
  if (!params || !schema.properties) return schema
  const properties: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(schema.properties)) {
    const doc = params[name]
    properties[name] = doc && value && typeof value === 'object' ? { ...(value as object), description: doc } : value
  }
  return { ...schema, properties }
}
