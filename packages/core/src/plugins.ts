// User plugins: JavaScript modules that add tools without rebuilding the
// harness (DSH's "everything is a plugin", in a smaller form). Listed in the
// user's config, or a trusted project's, as file paths:
//
//   "plugins": ["C:/Users/me/hy-plugins/jira.mjs"]
//
// A plugin module exports `tools`, each with a JSON Schema for its input:
//
//   export const tools = [{
//     name: 'jira_issue', description: 'Fetch a Jira issue.', readOnly: true,
//     input: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
//     run: async (args, ctx) => ({ ... }),   // ctx.workspaceRoot
//   }]
//
// Plugin code runs in the harness process, as the user, like the user's own
// hooks: it is trusted configuration, not model output. Its tools go through
// the same argument validation, hooks and read-only rules as the built-ins.
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { TOOLS_BY_NAME, type Schema, type ToolSpec } from './tool-registry.js'

export interface PluginContext {
  workspaceRoot: string
}

export interface PluginTool {
  name: string
  description: string
  input: Schema
  /** May run in parallel with other reads; offered to read-only subagents. Default false. */
  readOnly?: boolean
  run: (args: Record<string, unknown>, ctx: PluginContext) => Promise<unknown> | unknown
}

export interface LoadedPlugins {
  tools: Map<string, PluginTool & { spec: ToolSpec; plugin: string }>
  errors: string[]
}

const NAME = /^[a-z][a-z0-9_]{0,47}$/

export interface LoadPluginsOptions {
  /** Bypass the ESM module cache (used by the GUI's reload button). */
  cacheBust?: boolean
}

export async function loadPlugins(files: readonly string[], options: LoadPluginsOptions = {}): Promise<LoadedPlugins> {
  const tools: LoadedPlugins['tools'] = new Map()
  const errors: string[] = []
  for (const file of files) {
    let mod: { tools?: unknown; default?: { tools?: unknown } }
    try {
      const url = pathToFileURL(path.resolve(file))
      if (options.cacheBust) url.searchParams.set('v', String(Date.now()))
      mod = (await import(url.href)) as typeof mod
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const list = (mod.tools ?? mod.default?.tools) as unknown
    if (!Array.isArray(list)) {
      errors.push(`${file}: exports no tools array`)
      continue
    }
    for (const raw of list as PluginTool[]) {
      const problem =
        typeof raw?.name !== 'string' || !NAME.test(raw.name)
          ? `invalid tool name ${JSON.stringify(raw?.name)} (lower_snake_case)`
          : TOOLS_BY_NAME.has(raw.name) || tools.has(raw.name)
            ? `tool ${raw.name} already exists`
            : typeof raw.run !== 'function'
              ? `tool ${raw.name} has no run function`
              : typeof raw.description !== 'string' || !raw.input || raw.input.type !== 'object'
                ? `tool ${raw.name} needs a description and an object input schema`
                : undefined
      if (problem) {
        errors.push(`${file}: ${problem}`)
        continue
      }
      const spec: ToolSpec = {
        name: raw.name,
        sdk: `plugins.${raw.name}`,
        wire: true,
        readOnly: raw.readOnly === true,
        description: raw.description,
        input: raw.input,
        output: {},
      }
      tools.set(raw.name, { ...raw, spec, plugin: file })
    }
  }
  return { tools, errors }
}
