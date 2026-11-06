import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray, type MenuItemConstructorOptions } from 'electron'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSandboxMode, type CliOverrides, type ProviderKind, type SandboxMode } from '../../core/dist/index.js'
import { startWebServer, type WebServerHandle } from '../../hy-cli/dist/web-server.js'

import { chooseStartupWorkspace, usableWorkspace } from './startup.js'
import { pickUpdate, readStagedInfo, type UpdateCandidateView } from './update-pick.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const preloadPath = path.join(here, '..', 'preload.cjs')

interface DesktopState {
  workspace?: string
  workspaces?: string[]
  window?: { width: number; height: number; x?: number; y?: number }
  /** Closing the window keeps the app (and phone access) running in the tray. */
  resident?: boolean
  /** The "still running in the tray" notice was shown once. */
  residentNoticeShown?: boolean
}

interface DesktopArgs {
  workspace?: string
  port: number
  screenshot?: string
  demo: boolean
  devtools: boolean
  mock: boolean
  provider?: ProviderKind
  model?: string
  baseUrl?: string
  apiKeyEnv?: string
  sandbox?: SandboxMode
  profile?: string
  trust: boolean
  guardian: boolean
  web: boolean
  ptc: boolean
  memory: boolean
  /** Started at Windows login: stay in the tray, do not show the window. */
  background: boolean
}

let win: BrowserWindow | undefined
let server: WebServerHandle | undefined
let quitting = false
let tray: Tray | undefined

function readState(): DesktopState {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'desktop.json'), 'utf8')) as DesktopState
  } catch {
    return {}
  }
}

function writeState(next: DesktopState): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(path.join(app.getPath('userData'), 'desktop.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    // A read-only profile must not stop the app.
  }
}

function rememberWorkspace(workspace: string): void {
  const state = readState()
  const existing = (state.workspaces ?? []).filter((w) => usableWorkspace(w) !== undefined)
  const workspaces = [workspace, ...existing.filter((w) => path.resolve(w) !== path.resolve(workspace))].slice(0, 8)
  writeState({ ...state, workspace, workspaces })
}

function parseArgs(argv: string[]): DesktopArgs {
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq >= 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i += 1
    } else {
      flags[key] = true
    }
  }
  const str = (key: string): string | undefined => (typeof flags[key] === 'string' ? (flags[key] as string) : undefined)
  const bool = (key: string): boolean => flags[key] === true || flags[key] === 'true'
  const portRaw = str('port')
  return {
    ...(str('workspace') !== undefined ? { workspace: path.resolve(str('workspace')!) } : {}),
    port: portRaw === undefined ? 0 : Number(portRaw),
    ...(str('screenshot') !== undefined ? { screenshot: path.resolve(str('screenshot')!) } : {}),
    demo: bool('demo'),
    devtools: bool('devtools'),
    mock: bool('mock'),
    ...(str('provider') !== undefined ? { provider: str('provider') as ProviderKind } : {}),
    ...(str('model') !== undefined ? { model: str('model')! } : {}),
    ...(str('base-url') !== undefined ? { baseUrl: str('base-url')! } : {}),
    ...(str('api-key-env') !== undefined ? { apiKeyEnv: str('api-key-env')! } : {}),
    ...(str('sandbox') !== undefined ? { sandbox: parseSandboxMode(str('sandbox')!) } : {}),
    ...(str('profile') !== undefined ? { profile: str('profile')! } : {}),
    trust: bool('trust'),
    guardian: bool('guardian'),
    web: bool('web'),
    ptc: bool('ptc'),
    memory: bool('memory'),
    background: bool('background'),
  }
}

const args = parseArgs(process.argv.slice(1))

function overridesFor(workspace: string): CliOverrides {
  return {
    cwd: workspace,
    ...(args.mock ? { mock: true } : {}),
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(args.apiKeyEnv ? { apiKeyEnv: args.apiKeyEnv } : {}),
    ...(args.sandbox ? { sandbox: args.sandbox } : {}),
    ...(args.profile ? { profile: args.profile } : {}),
    ...(args.trust ? { projectTrusted: true } : {}),
    ...(args.guardian ? { guardian: true } : {}),
    ...(args.web ? { web: true } : {}),
    ...(args.ptc ? { ptc: true } : {}),
    ...(args.memory ? { memory: true } : {}),
  }
}

function bundledExecServer(): string | undefined {
  if (!app.isPackaged) return undefined
  const file = path.join(process.resourcesPath, 'hy-exec-server.exe')
  return fs.existsSync(file) ? file : undefined
}

async function startFor(workspace: string): Promise<WebServerHandle> {
  return startWebServer({
    overrides: overridesFor(workspace),
    execServer: process.env.HY_EXEC_SERVER ?? bundledExecServer(),
    host: '127.0.0.1',
    port: args.port,
    open: false,
    desktop: true,
    // Phone access the user turned on earlier comes back with the app (not in
    // screenshot/demo runs, which must not open a network listener).
    phoneAutoStart: !args.screenshot && !args.demo,
    log: (line) => console.error(`[desktop] ${line}`),
  })
}

// ---------- Resident mode: tray icon, close-to-tray, start at login ----------

/** The exe Windows should start at login: the portable exe, not its temp extraction. */
function loginExecutable(): string | undefined {
  if (!app.isPackaged) return undefined
  return process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath
}

function residentState(): { resident: boolean; openAtLogin: boolean; loginAvailable: boolean } {
  const exe = loginExecutable()
  const openAtLogin = exe ? app.getLoginItemSettings({ path: exe, args: ['--background'] }).openAtLogin : false
  return { resident: readState().resident === true || openAtLogin, openAtLogin, loginAvailable: exe !== undefined }
}

function setResident(next: { resident?: boolean; openAtLogin?: boolean }): ReturnType<typeof residentState> {
  const state = readState()
  const exe = loginExecutable()
  if (next.openAtLogin !== undefined && exe) {
    app.setLoginItemSettings({ openAtLogin: next.openAtLogin, path: exe, args: ['--background'] })
  }
  // Starting hidden at login only makes sense if the app stays in the tray.
  const resident = next.openAtLogin === true ? true : (next.resident ?? state.resident === true)
  writeState({ ...state, resident })
  if (resident === false && exe && app.getLoginItemSettings({ path: exe, args: ['--background'] }).openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: false, path: exe, args: ['--background'] })
  }
  void refreshTray()
  return residentState()
}

function showWindow(): void {
  if (!server) return
  if (!win || win.isDestroyed()) {
    win = createWindow()
    void win.loadURL(server.url)
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

async function refreshTray(): Promise<void> {
  if (!tray) return
  const phone = server?.phone.status()
  const resident = residentState()
  tray.setToolTip(phone?.enabled ? `HY-HARNESS — phone: ${phone.url ?? 'on'}` : 'HY-HARNESS')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open HY-HARNESS', click: () => showWindow() },
      { type: 'separator' },
      {
        label: phone?.enabled ? `Phone access: ${phone.url ?? 'on'}` : 'Phone access: off',
        enabled: false,
      },
      {
        label: 'Phone access',
        type: 'checkbox',
        checked: phone?.enabled === true,
        click: () => {
          void (phone?.enabled ? server?.phone.disable() : server?.phone.enable())?.then((view) => {
            if (view.error) dialog.showErrorBox('HY-HARNESS', view.error)
            void refreshTray()
          })
        },
      },
      { label: 'Keep running when the window is closed', type: 'checkbox', checked: resident.resident, click: (item) => setResident({ resident: item.checked }) },
      ...(resident.loginAvailable
        ? [{ label: 'Start at Windows login', type: 'checkbox' as const, checked: resident.openAtLogin, click: (item: Electron.MenuItem) => setResident({ openAtLogin: item.checked }) }]
        : []),
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

function createTray(): void {
  if (tray || args.screenshot || args.demo) return
  const image = nativeImage.createFromPath(path.join(here, '..', 'assets', 'HY_icon.png')).resize({ width: 16, height: 16 })
  tray = new Tray(image)
  tray.on('click', () => showWindow())
  void refreshTray()
}

interface UpdateCandidate {
  file: string
  /** `next`/`update` candidates are explicit staging; `release` itself is not. */
  staged: boolean
}

/** Staged portable exes the user may have built with `desktop:package:next`. */
function stagedUpdateCandidates(): UpdateCandidate[] {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  const workspace = server?.config.workspaceRoot ?? readState().workspace
  const candidates: UpdateCandidate[] = []
  const seen = new Set<string>()
  const add = (file: string, staged: boolean): void => {
    const name = path.basename(file)
    if (!name.toLowerCase().endsWith('.exe')) return
    if (/\.(bak|old)-/i.test(name) || name.toLowerCase().includes('.running')) return
    const key = path.resolve(file).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ file, staged })
  }
  const addDir = (dir: string | undefined, staged: boolean): void => {
    if (!dir || !fs.existsSync(dir)) return
    try {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name)
        if (fs.statSync(file).isFile()) add(file, staged)
      }
    } catch {
      // An unreadable staging directory is simply not a candidate.
    }
  }
  if (portable) {
    const base = path.dirname(portable)
    const nextName = `${path.basename(portable, '.exe')}.next.exe`
    addDir(path.join(base, 'next'), true)
    addDir(path.join(base, 'update'), true)
    add(path.join(base, nextName), true)
  }
  if (workspace) {
    addDir(path.join(workspace, 'release', 'next'), true)
    addDir(path.join(workspace, 'release'), false)
  }
  addDir(path.join(app.getPath('userData'), 'update'), true)
  // WP-53: installers fetched with the signed release feed.
  if (server?.config.stateDir) addDir(path.join(server.config.stateDir, 'update', 'download'), true)
  return candidates
}

function isPortableExe(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r')
    const magic = Buffer.alloc(2)
    fs.readSync(fd, magic, 0, 2, 0)
    fs.closeSync(fd)
    return magic.toString('ascii') === 'MZ'
  } catch {
    return false
  }
}

function fileHash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * The `.sha256` sidecar written by the fetcher, when it is next to the staged
 * exe. A malformed sidecar is ignored (the caller asked for no verification
 * rather than for a guess); an absent one means a build produced locally.
 */
function readExpectedSha256(staged: string): string | undefined {
  try {
    const text = fs.readFileSync(`${staged}.sha256`, 'utf8').trim().toLowerCase()
    return /^[0-9a-f]{64}$/.test(text) ? text : undefined
  } catch {
    return undefined
  }
}

type UpdateEvaluation =
  | { ok: true; current: string; pick: UpdateCandidateView }
  | { ok: false; error: string; reason?: 'unsupported' | 'none' | 'same' | 'downgrade'; newest?: UpdateCandidateView | undefined }

/** Finds the staged build the self-update would apply, without applying it. */
function evaluateUpdate(): UpdateEvaluation {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  if (!portable) return { ok: false, reason: 'unsupported', error: 'self-update is only available in the portable exe' }
  const current = path.resolve(portable)
  let currentStat: fs.Stats
  try {
    currentStat = fs.statSync(current)
  } catch {
    return { ok: false, error: `current exe is missing: ${current}` }
  }
  let currentHash: string | undefined
  const sameAsCurrent = (file: string, size: number): boolean => {
    if (size !== currentStat.size) return false
    currentHash ??= fileHash(current)
    return fileHash(file) === currentHash
  }
  const evaluated: UpdateCandidateView[] = stagedUpdateCandidates()
    .filter((candidate) => path.resolve(candidate.file).toLowerCase() !== current.toLowerCase() && isPortableExe(candidate.file))
    .map((candidate) => {
      const stat = fs.statSync(candidate.file)
      return { ...candidate, mtime: stat.mtimeMs, same: sameAsCurrent(candidate.file, stat.size), info: readStagedInfo(candidate.file) }
    })
  const result = pickUpdate(app.getVersion(), currentStat.mtimeMs, evaluated)
  if (result.ok) return { ok: true, current, pick: result.pick }
  if (result.reason === 'downgrade') {
    return {
      ok: false,
      reason: 'downgrade',
      newest: result.newest,
      error: `the staged build is older (${result.newest?.info.version ?? '?'}) than the running version ${app.getVersion()}; it was not applied.`,
    }
  }
  if (result.reason === 'same') {
    return { ok: false, reason: 'same', error: 'the staged build is identical to the running one. Run pnpm release:local to stage a new build.' }
  }
  return { ok: false, reason: 'none', error: 'no staged build found. Run pnpm release:local (it stages into release/next while the app is running).' }
}

/** For the renderer's "update ready" banner: what would be applied, if anything. */
function checkUpdate(): { available: boolean; version?: string; commit?: string; builtAt?: string; current: string; reason?: string } {
  const evaluation = evaluateUpdate()
  if (!evaluation.ok) return { available: false, current: app.getVersion(), ...(evaluation.reason ? { reason: evaluation.reason } : {}) }
  const info = evaluation.pick.info
  return {
    available: true,
    current: app.getVersion(),
    ...(info.version ? { version: info.version } : {}),
    ...(info.commit ? { commit: info.commit } : {}),
    builtAt: info.builtAt ?? new Date(evaluation.pick.mtime).toISOString(),
  }
}

function applyUpdate(): { ok: boolean; error?: string; from?: string } {
  const evaluation = evaluateUpdate()
  if (!evaluation.ok) return { ok: false, error: evaluation.error }
  const current = evaluation.current
  const staged = evaluation.pick.file
  // WP-53: `hy update fetch` (or the web server's /api/update/fetch) leaves the
  // verified installer plus a `.sha256` sidecar here; local staged builds get
  // one from tag-next-artifact.mjs. The swap verifies the copy against it.
  const expectedSha256 = readExpectedSha256(staged) ?? evaluation.pick.info.sha256
  const updaterSource = path.join(app.getAppPath(), 'packages', 'desktop', 'update.ps1')
  const registerSource = path.join(app.getAppPath(), 'packages', 'desktop', 'update-register.ps1')
  if (!fs.existsSync(updaterSource) || !fs.existsSync(registerSource)) {
    return { ok: false, error: 'updater scripts are missing from the package' }
  }
  const updateDir = path.join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'hy-harness-update')
  const script = path.join(updateDir, 'update.ps1')
  const register = path.join(updateDir, 'update-register.ps1')
  const config = path.join(updateDir, `update-${process.pid}.json`)
  const taskName = `HY-HARNESS-Update-${process.pid}`
  const logFile = path.join(updateDir, 'update.log')
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const schtasks = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe')
  try {
    fs.mkdirSync(updateDir, { recursive: true })
    fs.copyFileSync(updaterSource, script)
    fs.copyFileSync(registerSource, register)
    fs.writeFileSync(
      config,
      `${JSON.stringify({ oldExe: current, newExe: staged, processId: process.pid, log: logFile, taskName, ...(expectedSha256 ? { expectedSha256 } : {}) }, null, 2)}\n`,
      'utf8',
    )
    execFileSync(
      powershell,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        register,
        '-TaskName',
        taskName,
        '-Script',
        script,
        '-Config',
        config,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
  } catch (error) {
    try {
      execFileSync(schtasks, ['/Delete', '/TN', taskName, '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      // The task may not have been created.
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  setTimeout(() => app.quit(), 500)
  return { ok: true, from: staged }
}

async function chooseWorkspace(): Promise<string | undefined> {
  const state = readState()
  const picked = await dialog.showOpenDialog({
    title: 'Choose a workspace',
    defaultPath: usableWorkspace(args.workspace) ?? usableWorkspace(state.workspace) ?? app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use this folder',
  })
  if (picked.canceled || !picked.filePaths[0]) return undefined
  return picked.filePaths[0]
}

async function switchWorkspace(workspace: string): Promise<void> {
  if (!win) return
  const target = usableWorkspace(workspace)
  if (!target) {
    dialog.showErrorBox('HY-HARNESS', `The workspace no longer exists:\n${workspace}`)
    return
  }
  workspace = target
  const previous = server
  try {
    const next = await startFor(workspace)
    server = next
    rememberWorkspace(workspace)
    await win.loadURL(next.url)
    await previous?.close()
    setTimeout(() => void refreshTray(), 3_000)
  } catch (error) {
    dialog.showErrorBox('HY-HARNESS', error instanceof Error ? error.message : String(error))
    if (previous) {
      server = previous
      await win.loadURL(previous.url)
    }
  }
}

function sendMenu(action: string): void {
  win?.webContents.send('menu', action)
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-session') },
        {
          label: 'Open Workspace…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            void chooseWorkspace().then((workspace) => {
              if (workspace) void switchWorkspace(workspace)
            })
          },
        },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => sendMenu('toggle-sidebar') },
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => sendMenu('refresh') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About HY-HARNESS',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: 'HY-HARNESS',
              message: 'HY-HARNESS Desktop',
              detail: `Version ${app.getVersion()}\nElectron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode ${process.versions.node}`,
              buttons: ['OK'],
            })
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): BrowserWindow {
  const saved = readState().window
  const width = Math.max(960, Math.min(saved?.width ?? 1440, 4000))
  const height = Math.max(640, Math.min(saved?.height ?? 920, 3000))
  const onScreen =
    saved?.x !== undefined &&
    saved?.y !== undefined &&
    screen.getAllDisplays().some((display) => {
      const area = display.workArea
      return saved.x! < area.x + area.width && saved.x! + width > area.x && saved.y! < area.y + area.height && saved.y! + height > area.y
    })
  const position =
    onScreen && saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}
  const window = new BrowserWindow({
    width,
    height,
    ...position,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#fff9fc',
    icon: path.join(here, '..', 'assets', 'HY_icon.png'),
    title: 'HY-HARNESS',
    autoHideMenuBar: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  // Started at login: the app lives in the tray until the user opens it.
  window.once('ready-to-show', () => {
    if (!args.background) window.show()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    try {
      const current = server ? new URL(server.url).origin : ''
      const target = new URL(url)
      if (target.origin !== current) {
        event.preventDefault()
        if (/^https?:$/i.test(target.protocol)) void shell.openExternal(url)
      }
    } catch {
      event.preventDefault()
    }
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.on('close', (event) => {
    const state = readState()
    const bounds = window.getBounds()
    writeState({ ...state, window: { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y } })
    // Resident: hide instead of quitting, so running turns and phone access go on.
    if (!quitting && tray && residentState().resident) {
      event.preventDefault()
      window.hide()
      if (!state.residentNoticeShown && Notification.isSupported()) {
        new Notification({ title: 'HY-HARNESS', body: 'Still running in the tray. Use the tray icon to open it or quit.' }).show()
        writeState({ ...readState(), residentNoticeShown: true })
      }
    }
  })
  if (args.devtools) window.webContents.openDevTools({ mode: 'detach' })
  return window
}

async function waitForUi(): Promise<void> {
  if (!win) return
  for (let i = 0; i < 100; i++) {
    const ready = await win.webContents.executeJavaScript("!!document.querySelector('#composer-input')")
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
}

async function runDemo(handle: WebServerHandle): Promise<void> {
  const base = new URL(handle.url).origin
  const headers = { Authorization: `Bearer ${handle.token}`, 'Content-Type': 'application/json' }
  const created = (await (await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: '{}' })).json()) as { runId: string }
  await win?.webContents.executeJavaScript(`window.hySelectSession && window.hySelectSession(${JSON.stringify(created.runId)})`)
  await fetch(`${base}/api/sessions/${created.runId}/turn`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'Create the demo file' }),
  })
  for (let i = 0; i < 150; i++) {
    const snapshot = (await (await fetch(`${base}/api/sessions/${created.runId}`, { headers })).json()) as {
      state?: { busy?: boolean }
      entries?: Array<{ kind?: string }>
    }
    if (snapshot.state?.busy === false && (snapshot.entries ?? []).some((entry) => entry.kind === 'assistant')) break
    await new Promise((resolve) => setTimeout(resolve, 160))
  }
}

async function capture(file: string): Promise<void> {
  if (!win) throw new Error('no window')
  await waitForUi()
  if (args.demo && server) {
    await runDemo(server)
    for (let i = 0; i < 100; i++) {
      const done = await win.webContents.executeJavaScript("document.body.innerText.includes('Demo complete')")
      if (done) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 600))
  const image = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, image.toPNG())
  console.log(`[desktop] screenshot: ${file}`)
}

async function boot(): Promise<void> {
  app.setName('HY-HARNESS')
  app.setAppUserModelId('com.hy-harness.desktop')
  const state = readState()
  // Reopen the last usable workspace instead of dropping to a folder dialog on
  // every launch when desktop.json kept only the recent-workspace list.
  let workspace = chooseStartupWorkspace(args.workspace, state)
  if (!workspace) {
    workspace = await chooseWorkspace()
    if (!workspace) {
      app.quit()
      return
    }
  }
  try {
    server = await startFor(workspace)
  } catch (error) {
    dialog.showErrorBox('HY-HARNESS could not start', error instanceof Error ? error.message : String(error))
    app.quit()
    return
  }
  rememberWorkspace(workspace)
  buildMenu()
  createTray()
  win = createWindow()
  await win.loadURL(server.url)
  // Phone access restores itself asynchronously; show its state once it has.
  setTimeout(() => void refreshTray(), 3_000)
  if (args.screenshot) {
    try {
      await capture(args.screenshot)
      app.exit(0)
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.on('before-quit', () => {
    if (quitting) return
    quitting = true
    void server?.close()
  })
  app.on('window-all-closed', () => {
    // In resident mode the window is only hidden; this fires on a real quit path.
    if (tray && residentState().resident && !quitting) return
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) {
      win = createWindow()
      void win.loadURL(server.url)
    }
  })
  ipcMain.handle('workspace:choose', async (_event, preferred?: unknown) => {
    const workspace =
      typeof preferred === 'string' && preferred.trim() && fs.existsSync(preferred)
        ? preferred
        : await chooseWorkspace()
    if (!workspace) return null
    await switchWorkspace(workspace)
    return workspace
  })
  ipcMain.handle('workspace:recent', () => readState().workspaces ?? [])
  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return 'invalid path'
    return shell.openPath(path.resolve(filePath))
  })
  ipcMain.handle('shell:showItemInFolder', (_event, filePath: string) => {
    if (typeof filePath === 'string' && filePath) shell.showItemInFolder(path.resolve(filePath))
  })
  ipcMain.handle('folder:pick', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Add a workspace root folder',
      properties: ['openDirectory'],
      buttonLabel: 'Add this folder',
    })
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  })
  ipcMain.handle('plugins:pick', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Add a HY-HARNESS plugin',
      properties: ['openFile'],
      filters: [{ name: 'HY-HARNESS plugin', extensions: ['mjs', 'js'] }],
    })
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  })
  ipcMain.handle('clipboard:write', (_event, text: unknown) => {
    if (typeof text !== 'string') return false
    clipboard.writeText(text)
    return true
  })
  ipcMain.handle('app:notify', (_event, title: unknown, body: unknown) => {
    if (!Notification.isSupported()) return false
    new Notification({ title: String(title ?? 'HY-HARNESS'), body: String(body ?? '') }).show()
    return true
  })
  ipcMain.handle('update:apply', () => applyUpdate())
  ipcMain.handle('update:check', () => checkUpdate())
  ipcMain.handle('resident:get', () => residentState())
  ipcMain.handle('resident:set', (_event, next: unknown) => {
    const value = next && typeof next === 'object' ? (next as { resident?: unknown; openAtLogin?: unknown }) : {}
    return setResident({
      ...(typeof value.resident === 'boolean' ? { resident: value.resident } : {}),
      ...(typeof value.openAtLogin === 'boolean' ? { openAtLogin: value.openAtLogin } : {}),
    })
  })
  ipcMain.handle('phone:changed', () => void refreshTray())
  ipcMain.handle('app:versions', () => ({
    app: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
  }))
  void app.whenReady().then(boot).catch((error: unknown) => {
    console.error(error)
    dialog.showErrorBox('HY-HARNESS', error instanceof Error ? error.message : String(error))
    app.quit()
  })
}
