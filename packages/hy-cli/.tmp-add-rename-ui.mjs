import fs from 'node:fs'

const file = 'F:/HY-HARNESS/packages/hy-cli/web/src/app.ts'
let src = fs.readFileSync(file, 'utf8')

const steps = []

// A) modal union + two state fields
steps.push([
  "  modal?: 'settings' | 'help' | 'goal' | 'ralph' | 'model' | 'workspace' | 'palette' | 'automation' | 'roots' | undefined",
  "  modal?: 'settings' | 'help' | 'goal' | 'ralph' | 'model' | 'workspace' | 'palette' | 'automation' | 'roots' | 'rename' | undefined\n  /** Chat being renamed; only set while the rename dialog is open. */\n  renameRunId?: string | undefined\n  /** Current text of the rename input, so a failed save keeps what was typed. */\n  renameDraft: string",
])

// B) initializer
steps.push([
  "  paletteQuery: '',",
  "  paletteQuery: '',\n  renameDraft: '',",
])

// C) rename button on chat rows only
steps.push([
  '        <button class="session-action danger" data-action="delete-session" data-run-id="${session.runId}" title="${tr(\'deleteSession\')}">${icon(\'trash\', 14)}</button>',
  '        <button class="session-action" data-action="rename-session" data-run-id="${session.runId}" title="${tr(\'renameChat\')}">${icon(\'edit\', 14)}</button>\n        <button class="session-action danger" data-action="delete-session" data-run-id="${session.runId}" title="${tr(\'deleteSession\')}">${icon(\'trash\', 14)}</button>',
])

// D) saveTitle() before renderModal()
steps.push([
  'function renderModal(): void {',
  `/**
 * Saves a chat name. An empty field clears the override, so the automatic
 * title from the first message shows again. On failure the dialog stays open
 * with the typed text and only an error toast appears; nothing is reported as
 * saved unless the server accepted it.
 */
async function saveTitle(runId: string): Promise<void> {
  const input = document.getElementById('rename-input') as HTMLInputElement | null
  const raw = input?.value ?? state.renameDraft
  try {
    const data = await post<{ runId: string; title: string | null }>(\`/api/sessions/\${encodeURIComponent(runId)}/title\`, { title: raw })
    state.modal = undefined
    state.renameRunId = undefined
    state.renameDraft = ''
    renderModal()
    toast(data.title ? tr('renamed') : tr('renamedAuto'), 'success')
    await refreshSessions()
  } catch (error) {
    // Keep the dialog and the typed name so the user can fix it.
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function renderModal(): void {`,
])

// E) rename dialog
steps.push([
  "  if (state.modal === 'model') {",
  `  if (state.modal === 'rename') {
    const runId = state.renameRunId ?? ''
    el.innerHTML = \`<div class="modal-backdrop" data-action="close-modal"><div class="modal goal-modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>\${icon('edit', 16)} \${tr('renameChat')}</h2><button class="icon-btn" data-action="close-modal">\${icon('close', 16)}</button></div>
      <div class="modal-body">
        <p class="muted">\${tr('renameDesc')}</p>
        <label class="modal-field">\${tr('renamePlaceholder')}<input id="rename-input" value="\${escapeHtml(state.renameDraft)}" maxlength="120" autocomplete="off" autofocus></label>
      </div>
      <div class="modal-foot"><button class="btn ghost" data-action="close-modal">\${tr('cancel')}</button><button class="btn primary" data-action="save-title" data-run-id="\${escapeHtml(runId)}">\${icon('check', 16)} \${tr('save')}</button></div>
    </div></div>\`
    const input = document.getElementById('rename-input') as HTMLInputElement | null
    if (input) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
    return
  }
  if (state.modal === 'model') {`,
])

// F) open the dialog from a chat row
steps.push([
  "    case 'delete-session':\n      if (el.dataset.runId) void deleteSession(el.dataset.runId)\n      break",
  "    case 'rename-session': {\n      const runId = el.dataset.runId\n      if (!runId) break\n      const session = state.sessions.find((candidate) => candidate.runId === runId)\n      state.renameRunId = runId\n      state.renameDraft = session?.title ?? ''\n      state.modal = 'rename'\n      renderModal()\n      break\n    }\n    case 'delete-session':\n      if (el.dataset.runId) void deleteSession(el.dataset.runId)\n      break",
])

// G) save handler
steps.push([
  "    case 'save-model':\n      void saveModel()\n      break",
  "    case 'save-model':\n      void saveModel()\n      break\n    case 'save-title':\n      if (el.dataset.runId) void saveTitle(el.dataset.runId)\n      break",
])

// H) cancel clears the draft
steps.push([
  "    case 'close-modal':\n      state.modal = undefined\n      renderModal()\n      break",
  "    case 'close-modal':\n      state.modal = undefined\n      state.renameRunId = undefined\n      state.renameDraft = ''\n      renderModal()\n      break",
])

for (const [i, step] of steps.entries()) {
  const oldText = step[0]
  const newText = step[1]
  const hits = src.split(oldText).length - 1
  if (hits !== 1) {
    console.error('aborted at step ' + (i + 1) + ': expected exactly 1 match, found ' + hits + '; nothing written')
    process.exit(2)
  }
  src = src.replace(oldText, () => newText)
}

fs.writeFileSync(file, src, 'utf8')
const after = fs.readFileSync(file, 'utf8')
const count = (needle) => after.split(needle).length - 1
console.log('renameSessionAction: ' + count("data-action=\"rename-session\""))
console.log('renameModal: ' + count("state.modal === 'rename'"))
console.log('saveTitleFn: ' + count('async function saveTitle('))
console.log('saveTitleCase: ' + count("case 'save-title':"))
console.log('renameDraftField: ' + count('renameDraft'))
console.log('lines: ' + after.split(/\r?\n/).length)
