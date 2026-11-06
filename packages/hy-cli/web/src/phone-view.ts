// Settings › Phone, kept free of the DOM so both views can be tested.
//
// The desktop (owner) turns phone access on, shows a one-time QR code and
// manages paired phones. A paired phone sees only itself and its own
// notification switch, which needs HTTPS and, on iPhone, the home-screen app.
import { escapeHtml } from './markdown.js'
import { translate } from './i18n.js'
import { formatRelative } from './time-format.js'

export interface PhoneDeviceView {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  push: boolean
}

export interface PhoneStatus {
  enabled: boolean
  url?: string
  https: boolean
  error?: string
  warning?: string
  devices: PhoneDeviceView[]
  client: { kind: 'owner' } | { kind: 'device'; id: string; name: string; push: boolean }
}

export interface PhonePairing {
  code: string
  url: string
  expiresAt: number
  qrSvg: string
}

/** What this browser can do about notifications (from the page, not the server). */
export interface PushSupport {
  secure: boolean
  supported: boolean
  /** iPhone/iPad Safari outside the home-screen app: push is unavailable there. */
  needsHomeScreen: boolean
  permission: 'default' | 'granted' | 'denied' | 'unsupported'
}

export function pushSupport(env: {
  isSecureContext: boolean
  hasServiceWorker: boolean
  hasPushManager: boolean
  userAgent: string
  standalone: boolean
  permission?: string
}): PushSupport {
  const ios = /iPhone|iPad|iPod/.test(env.userAgent)
  const permission = env.permission === 'granted' || env.permission === 'denied' || env.permission === 'default' ? env.permission : 'unsupported'
  return {
    secure: env.isSecureContext,
    supported: env.isSecureContext && env.hasServiceWorker && env.hasPushManager,
    needsHomeScreen: ios && !env.standalone,
    permission,
  }
}

const note = (text: string, kind: 'info' | 'warn' = 'info'): string => `<div class="settings-note${kind === 'warn' ? ' warn' : ''}">${escapeHtml(text)}</div>`

export function renderPhoneSection(status: PhoneStatus | undefined, pairing: PhonePairing | undefined, push: PushSupport, locale: string, now = Date.now()): string {
  const t = (key: string, vars?: Record<string, string | number>): string => translate(locale, key, vars)
  if (!status) return note(t('phoneLoading'))

  if (status.client.kind === 'device') {
    const client = status.client
    let control: string
    if (!push.secure) control = note(t('phoneNotifyNeedsHttps'), 'warn')
    else if (push.needsHomeScreen) control = note(t('phoneNotifyNeedsHome'), 'warn')
    else if (!push.supported) control = note(t('phoneNotifyUnsupported'), 'warn')
    else if (push.permission === 'denied') control = note(t('phoneNotifyDenied'), 'warn')
    else if (client.push)
      control = `<div class="plugin-actions"><span class="tag ok">${escapeHtml(t('phoneNotifyIsOn'))}</span><button type="button" class="btn ghost" data-action="push-test">${escapeHtml(t('phoneNotifyTest'))}</button><button type="button" class="btn ghost" data-action="push-disable">${escapeHtml(t('phoneNotifyOff'))}</button></div>`
    else control = `<div class="plugin-actions"><button type="button" class="btn primary" data-action="push-enable">${escapeHtml(t('phoneNotifyOn'))}</button></div>`
    return `<div class="settings-row"><span>${escapeHtml(t('phoneThisDevice'))}</span><strong>${escapeHtml(client.name)}</strong></div>
      ${note(t('phoneNotifyHint'))}
      ${control}`
  }

  const rows: string[] = []
  rows.push(`<div class="settings-row"><span>${escapeHtml(t('phoneAccess'))}</span><span class="plugin-actions">${
    status.enabled
      ? `<span class="tag ok">${escapeHtml(t('phoneOn'))}</span><button type="button" class="btn ghost" data-action="phone-disable">${escapeHtml(t('phoneDisable'))}</button>`
      : `<button type="button" class="btn primary" data-action="phone-enable">${escapeHtml(t('phoneEnable'))}</button>`
  }</span></div>`)
  if (status.error) rows.push(note(status.error, 'warn'))
  if (status.enabled && status.url) {
    rows.push(`<div class="settings-row"><span>${escapeHtml(t('phoneUrl'))}</span><code>${escapeHtml(status.url)}</code></div>`)
    rows.push(note(status.https ? t('phoneHttpsOn') : t('phoneHttpsOff'), status.https ? 'info' : 'warn'))
    if (status.warning) rows.push(note(status.warning, 'warn'))
    if (pairing) {
      const minutes = Math.max(1, Math.ceil((pairing.expiresAt - now) / 60_000))
      rows.push(`<div class="phone-pairing"><div class="phone-qr">${pairing.qrSvg}</div><div class="phone-pairing-text">
        <strong>${escapeHtml(t('phonePairTitle'))}</strong>
        <span>${escapeHtml(t('phonePairHint'))}</span>
        <code>${escapeHtml(pairing.url)}</code>
        <span class="muted small">${escapeHtml(t('phonePairExpires', { minutes }))}</span>
        <button type="button" class="btn ghost" data-action="phone-pair-cancel">${escapeHtml(t('cancel'))}</button>
      </div></div>`)
    } else {
      rows.push(`<div class="plugin-actions"><button type="button" class="btn primary" data-action="phone-pair">${escapeHtml(t('phoneAddDevice'))}</button></div>`)
    }
  }
  rows.push(`<h4>${escapeHtml(t('phoneDevices'))}</h4>`)
  if (status.devices.length === 0) rows.push(note(t('phoneNoDevices')))
  for (const device of status.devices) {
    rows.push(`<div class="phone-device" data-device-id="${escapeHtml(device.id)}"><span class="phone-device-main"><strong>${escapeHtml(device.name)}</strong><span class="muted small">${escapeHtml(
      t('phoneLastSeen', { when: formatRelative(now, device.lastSeenAt, locale) }),
    )}${device.push ? ` · ${escapeHtml(t('phoneNotifyIsOn'))}` : ''}</span></span><button type="button" class="link-btn danger" data-action="phone-revoke" data-device-id="${escapeHtml(device.id)}">${escapeHtml(t('phoneRevoke'))}</button></div>`)
  }
  return `${note(t('phoneHint'))}${rows.join('\n')}`
}
