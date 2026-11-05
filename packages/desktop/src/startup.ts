import fs from 'node:fs'
import path from 'node:path'

export interface StartupState {
  workspace?: string
  workspaces?: string[]
}

/** A remembered workspace is usable only while the directory still exists. */
export function usableWorkspace(dir: string | undefined): string | undefined {
  if (!dir) return undefined
  try {
    const resolved = path.resolve(dir)
    return fs.statSync(resolved).isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

/**
 * Picks the launch workspace without asking the user when a valid one is
 * remembered. `--workspace` stays strict: an explicit path that no longer
 * exists must not silently open a different folder.
 */
export function chooseStartupWorkspace(
  argWorkspace: string | undefined,
  state: StartupState,
  usable: (dir: string | undefined) => string | undefined = usableWorkspace,
): string | undefined {
  const explicit = usable(argWorkspace)
  if (explicit) return explicit
  if (argWorkspace !== undefined) return undefined
  const remembered = usable(state.workspace)
  if (remembered) return remembered
  return (state.workspaces ?? []).map((dir) => usable(dir)).find((dir) => dir !== undefined)
}
