# @hy/desktop

The Electron shell. It starts the same local server as `hy web` in-process,
opens a `BrowserWindow` on its URL, and adds only what a browser cannot do:
a workspace picker, a native menu, notifications and the portable self-update.

## Files

| File | Role |
| :-- | :-- |
| `src/main.ts` | app lifecycle, single-instance lock, window, menu, IPC, update staging |
| `src/startup.ts` | state file (last workspace), argument parsing, port selection |
| `update.ps1`, `update-register.ps1` | the scheduled task that swaps the portable exe |
| `update.mjs` | the same swap for non-PowerShell callers (tests, tooling) |

## Security posture

- The renderer is sandboxed (`contextIsolation`, no Node integration); the
  preload bridge exposes a fixed, small API.
- The server binds loopback and authenticates with a launch token exchanged for
  an HttpOnly `SameSite=Strict` cookie.
- `update.ps1` verifies the SHA-256 of the new exe and rolls the backup back on a
  mismatch (exit code 5). The updater log is
  `C:\Users\Public\hy-harness-update\update.log`.

## Self-update

`pnpm release:local` builds everything (Rust release binaries, TypeScript,
checks, tests) and packages it, staged under `release\next` while the app runs;
`pnpm desktop:package` / `pnpm desktop:package:next` are the single steps. The
app finds a staged build (picked by version; downgrades are refused), shows
"Update ready" in the sidebar, registers a scheduled task, quits, and the task
swaps the exe, verifies its SHA-256, keeps one backup and restarts it. See
[../README.md](../README.md) and `docs/troubleshooting.md`.

## Build and run

```powershell
pnpm desktop:install   # downloads Electron if the install script was skipped
pnpm desktop           # build + start
pnpm desktop:screenshot  # mock demo + screenshots/desktop.png
```
