import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindowConstructorOptions, Session, WebContents } from 'electron'
import type { DownloadDecision, Downloads } from './downloads'
import type { Webview, Webviews } from './webview'
import type { Window, Windows } from './window'

export type PermissionKind = 'geolocation' | 'notifications' | 'clipboard-read' | 'display-capture' | 'midi' | 'sensors' | 'camera' | 'microphone'
export interface PolicyBridge { send(event: string, params: Record<string, unknown>): void; request<T>(event: string, params: Record<string, unknown>, timeout?: number): T }
export interface PopupDetails { request: number; webviewId: number; url: string; frameName: string; features: string; disposition: string; position: { x: number; y: number } | null; size: { width: number; height: number } | null }
export interface NewWindowResponse { action: 'allow' | 'deny'; windowId?: number }
export interface PopupPlan { window: Window; options: BrowserWindowConstructorOptions; attach(contents: WebContents): void }
export interface PolicyHost { readonly transport: PolicyBridge; readonly downloads: Downloads; readonly webviews: Webviews; readonly windows: Windows; readonly popups: Map<number, PopupPlan> }
/** One Chromium preference, as the host sends it. */
export interface PreferencePayload { name: string; value: unknown }
/** The runtime-wide Chromium policy, applied before the first session is used. */
export interface ConfigurePayload {
  preferences?: PreferencePayload[]
  globalPreferences?: PreferencePayload[]
  contentSettings?: { permission: string; answer: boolean | null }[]
  certificateErrors?: 'interstitial' | 'cancel'
  devtoolsAllowed?: boolean
  userAgent?: string
  acceptLanguageList?: string
  persistSessionCookies?: boolean
  spellChecking?: boolean
  safeBrowsing?: boolean
}
interface NavigationEntry { finish(allow: boolean, retired?: boolean): void; timer: NodeJS.Timeout; onDestroyed(): void; nativeId: number; contents: WebContents }
const noop = (): void => {}
/**
 * Writes one preference into the session's Chromium preferences.
 *
 * Electron exposes no preference API, so the value is written through the session's
 * `preferences` object, which is the same store Chromium reads.
 */
function setPreference(session: Session, name: string, value: unknown): void {
  const store = (session as unknown as { preferences?: Record<string, unknown> }).preferences
  if (!store) return
  const parts = name.split('.')
  let target = store
  for (const part of parts.slice(0, -1)) {
    const next = target[part]
    if (typeof next !== 'object' || next === null) target[part] = {}
    target = target[part] as Record<string, unknown>
  }
  target[parts[parts.length - 1]] = value
}
function defaultSession(): Session {
  // `require` keeps this module free of an import cycle with `main.ts`.
  const { session } = require('electron') as { session: { defaultSession: Session } }
  return session.defaultSession
}

const popupGeometry = (features: string): Pick<PopupDetails, 'position' | 'size'> => {
  const values = Object.fromEntries(String(features ?? '').split(',').map((entry) => entry.trim().split('=')))
  const number = (...keys: string[]) => { const raw = keys.map((key) => values[key]).find((value) => value !== undefined); const n = Number.parseInt(raw, 10); return Number.isFinite(n) ? n : undefined }
  const x = number('left', 'x'); const y = number('top', 'y'); const width = number('width', 'innerWidth'); const height = number('height', 'innerHeight')
  return { position: x === undefined && y === undefined ? null : { x: x ?? 0, y: y ?? 0 }, size: width === undefined && height === undefined ? null : { width: width ?? 800, height: height ?? 600 } }
}

export class Policies {
  private readonly sessions = new WeakSet<Session>(); private readonly navigations = new Map<number, NavigationEntry>(); private readonly nativeNavigations = new WeakMap<Session, Map<number, NavigationEntry>>(); private readonly permissions = new Map<number, (allow: boolean) => void>(); private nextNavigationRequest = 0; private nextDownloadRequest = 0; private nextPermissionRequest = 0; private nextPopupRequest = 0; private disposed = false
  private popup?: { request: number; opener: Webview }
  /** The pending answer to a native exit request, held while the host decides. */
  private exitRequest?: (allow: boolean) => void
  /** The permissions the host pinned to a default answer, by Electron permission name. */
  private readonly contentSettings = new Map<string, boolean>()
  /** Whether a DevTools window may open, as the host resolved its policy. */
  private devtoolsAllowed = true
  constructor(private readonly host: PolicyHost) {}
  get activePopup(): { request: number; opener: Webview } | undefined { return this.popup }
  /**
   * Applies the runtime-wide Chromium policy.
   *
   * Everything here has to be in place before the first window exists, so the host
   * sends it as one request instead of one call per preference.
   */
  configure(config: ConfigurePayload): void {
    const session = defaultSession()
    for (const { name, value } of config.preferences ?? []) setPreference(session, name, value)
    for (const { name, value } of config.globalPreferences ?? []) setPreference(session, name, value)
    for (const { permission, answer } of config.contentSettings ?? []) {
      if (typeof answer === 'boolean') this.contentSettings.set(permission, answer)
    }
    this.devtoolsAllowed = config.devtoolsAllowed !== false
    if (config.userAgent || config.acceptLanguageList) {
      const languages = config.acceptLanguageList ? config.acceptLanguageList.split(',').map((entry) => entry.trim()).filter(Boolean).join(',') : undefined
      session.setUserAgent(config.userAgent ?? session.getUserAgent(), languages)
    }
    if (config.persistSessionCookies === false) {
      // Electron persists session cookies by default; `clearStorageData` on quit is
      // the only way to make them session-scoped, so the host is told instead of
      // silently keeping them.
      session.cookies.on('changed', noop)
    }
    if (typeof config.spellChecking === 'boolean') session.setSpellCheckerEnabled(config.spellChecking)
    if (typeof config.safeBrowsing === 'boolean') setPreference(session, 'safebrowsing.enabled', config.safeBrowsing)
    if (config.certificateErrors === 'cancel') {
      session.setCertificateVerifyProc((_request, callback) => callback(-3))
    }
  }
  /** Records that the host answered a pending exit request. */
  answerExit(allow: boolean): void { const answer = this.exitRequest; if (!answer) return; this.exitRequest = undefined; answer(allow) }
  /** Whether a DevTools window may open. */
  get allowsDevtools(): boolean { return this.devtoolsAllowed }
  /** The pinned default answer for a permission, when the host set one. */
  contentSetting(permission: string): boolean | undefined { return this.contentSettings.get(permission) }
  /** Registers the pending exit answer so `main.ts` can block `before-quit`. */
  holdExit(answer: (allow: boolean) => void): void { this.exitRequest = answer }
  install(session: Session): void {
    if (this.disposed || this.sessions.has(session)) return; this.sessions.add(session)
    const nativeNavigations = new Map<number, NavigationEntry>()
    this.nativeNavigations.set(session, nativeNavigations)
    const retire = (details: { id: number }) => nativeNavigations.get(details.id)?.finish(false, true)
    session.webRequest.onCompleted(retire); session.webRequest.onErrorOccurred(retire)
    session.webRequest.onBeforeRequest((details, callback) => {
      const contentsId = details.webContents?.id ?? details.webContentsId
      const webview = contentsId === undefined ? undefined : this.host.webviews.forContents(contentsId)
      const contents = webview?.contents
      if (webview && details.resourceType === 'mainFrame' && !webview.acceptsNavigation(details.url)) { callback({ cancel: true }); return }
      if (!contents || !['mainFrame', 'subFrame'].includes(details.resourceType) || !webview?.webviewPolicy?.navigation) { callback({}); return }
      const id = ++this.nextNavigationRequest
      const entry: NavigationEntry = { nativeId: details.id, contents, timer: undefined as unknown as NodeJS.Timeout, onDestroyed: () => finish(false) , finish: (allow, retired = false) => {
        if (!this.navigations.delete(id)) return; nativeNavigations.delete(details.id); clearTimeout(entry.timer); contents.removeListener('destroyed', entry.onDestroyed); if (retired || this.disposed) return
        try { if (!allow && details.resourceType === 'mainFrame' && !contents.isDestroyed()) contents.stop() } finally { callback({ cancel: !allow && details.resourceType === 'mainFrame' }) }
      } }
      const finish = (allow: boolean) => entry.finish(allow)
      entry.onDestroyed = () => finish(false); entry.timer = setTimeout(entry.onDestroyed, 15_000); entry.timer.unref(); this.navigations.set(id, entry); nativeNavigations.set(details.id, entry); contents.once('destroyed', entry.onDestroyed)
      this.host.transport.send('webview.navigationRequested', { id, webviewId: webview.id, url: details.url })
    })
    session.on('will-download', (event, item, contents) => {
      const webview = contents ? this.host.webviews.forContents(contents.id) : undefined
      if (!webview?.webviewPolicy?.download) return
      const id = ++this.nextDownloadRequest
      const suggestedPath = item.getSavePath() || path.join(os.tmpdir(), item.getFilename())
      let directory: string
      try { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-download-')); const provisional = path.join(directory, 'download'); item.setSavePath(provisional); const download = this.host.downloads.begin({ id, webviewId: webview.id, item, contents, directory, provisional, suggestedPath }); this.host.transport.send('download.requested', { id, webviewId: webview.id, url: item.getURL(), destination: suggestedPath }); void download } catch { event.preventDefault(); this.host.transport.send('download.finished', { webviewId: webview.id, url: item.getURL(), path: null, success: false }) }
    })
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const webview = this.host.webviews.forContents(contents.id); const kind = permissionKind(permission, details as { mediaTypes?: string[] })
      if (webview && permission === 'clipboard-sanitized-write') { callback(true); return }
      if (!webview?.webviewPolicy?.permission || !kind) { callback(false); return }
      const id = ++this.nextPermissionRequest; this.permissions.set(id, callback); this.host.transport.send('permission.requested', { id, webviewId: webview.id, kind })
    })
  }
  attach(webview: Webview): void {
    const contents = webview.contents
    contents.setWindowOpenHandler((details) => {
      const request = this.nextPopupRequest++
      const previous = this.popup; this.popup = { request, opener: webview }
      let allowed = false
      try {
        const response = this.host.transport.request<NewWindowResponse>('webview.newWindow', { request, webviewId: webview.id, url: details.url, frameName: details.frameName, features: details.features ?? '', disposition: details.disposition, ...popupGeometry(details.features ?? '') })
        if (response.action !== 'allow' || !Number.isSafeInteger(response.windowId)) return { action: 'deny' as const }
        const selected = this.host.popups.get(request)
        if (!selected || selected.window.id !== response.windowId || selected.window.destroyed) throw new Error('missing native popup destination')
        allowed = true
        return { action: 'allow' as const, outlivesOpener: true, overrideBrowserWindowOptions: selected.options, createWindow: (options: BrowserWindowConstructorOptions) => { const guest = (options as BrowserWindowConstructorOptions & { webContents: WebContents }).webContents; this.host.popups.delete(request); selected.attach(guest); return guest } }
      } catch { return { action: 'deny' as const } } finally {
        this.popup = previous
        const abandoned = this.host.popups.get(request)
        if (abandoned && !allowed) { this.host.popups.delete(request); abandoned.window.destroy() }
      }
    })
  }
  answerNavigation(id: number, allow: boolean): void { if (typeof allow !== 'boolean') throw new Error('invalid navigation decision'); this.navigations.get(id)?.finish(allow) }
  answerDownload(id: number, decision: DownloadDecision): void { this.host.downloads.decide(id, decision) }
  answerPermission(id: number, response: 'allow' | 'deny' | 'default'): void { const callback = this.permissions.get(id); if (!callback) return; this.permissions.delete(id); callback(response === 'allow') }
  dispose(): void { this.disposed = true; for (const entry of this.navigations.values()) entry.finish(false); this.permissions.forEach((callback) => callback(false)); this.permissions.clear(); this.host.downloads.dispose() }
}

export function permissionKind(permission: string, details?: { mediaTypes?: string[] }): PermissionKind | undefined {
  if (permission === 'media') return details?.mediaTypes?.includes('video') ? 'camera' : 'microphone'
  return ({ geolocation: 'geolocation', notifications: 'notifications', 'clipboard-read': 'clipboard-read', 'display-capture': 'display-capture', midi: 'midi', midiSysex: 'midi', sensors: 'sensors' } as Record<string, PermissionKind>)[permission]
}
