import { randomUUID } from 'node:crypto'
import { documentOrigin } from './origin'
import { session } from 'electron'
import type { WebContents } from 'electron'
import type { Webview } from './webview'
import type { Transport } from '../socket/transport'

type Lease = { owner: Webview; partition: string; frame: WebContents['mainFrame']; attached: boolean; guest?: WebContents }

export class BrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly hosts = new Map<Webview, string>()
  private readonly leases = new Map<string, Lease>()

  constructor(private readonly transport: Transport) {}

  private owner(owner: Webview): void {
    const origin = this.hosts.has(owner) ? owner.trustedOrigin : undefined
    if (!origin || owner.contents.isDestroyed() || documentOrigin(owner.contents.getURL()) !== origin) throw new Error('browser guest: untrusted owner')
  }

  acquire(owner: Webview, workspace: unknown): { lease: string; partition: string } {
    this.owner(owner)
    if (typeof workspace !== 'string' || !workspace.length || workspace.length > 4096) throw new Error('browser guest: invalid workspace')
    let partition = this.partitions.get(workspace)
    if (!partition) {
      partition = 'electron-browser-' + randomUUID()
      const target = session.fromPartition(partition)
      target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      target.setPermissionCheckHandler(() => false)
      target.setDevicePermissionHandler(() => false)
      target.setDisplayMediaRequestHandler((_request, callback) => callback({}))
      target.on('will-download', event => event.preventDefault())
      target.webRequest.onBeforeRequest((details, callback) => {
        let allowed = false
        try {
          const url = new URL(details.url)
          allowed = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
            ? !url.username && !url.password && !this.applicationHost(url)
            : ['about:', 'data:', 'blob:'].includes(url.protocol)
        } catch {}
        callback({ cancel: !allowed })
      })
      this.partitions.set(workspace, partition)
    }
    const lease = randomUUID()
    this.leases.set(lease, { owner, partition, frame: owner.contents.mainFrame, attached: false })
    return { lease, partition }
  }

  async releaseAll(owner: Webview): Promise<void> {
    await Promise.all([...this.leases].filter(([, lease]) => lease.owner === owner).map(([id]) => this.close(id)))
  }

  async release(owner: Webview, id: unknown): Promise<void> {
    this.owner(owner)
    if (typeof id !== 'string') throw new Error('browser guest: invalid lease')
    const lease = this.leases.get(id)
    if (!lease) return
    if (lease.owner !== owner) throw new Error('browser guest: lease belongs to another owner')
    await this.close(id)
  }

  private async close(id: string): Promise<void> {
    const lease = this.leases.get(id)
    this.leases.delete(id)
    const guest = lease?.guest
    if (!guest || guest.isDestroyed()) return
    await new Promise<void>(resolve => {
      guest.once('destroyed', resolve)
      guest.close({ waitForBeforeUnload: false })
    })
  }

  private applicationHost(url: URL): boolean {
    if (['ipc.localhost', 'tauri.localhost'].includes(url.hostname)) return true
    return [...this.hosts.keys()].some(owner => {
      const host = new URL(owner.trustedOrigin)
      return url.port === host.port && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    })
  }

  private navigation(value: string): boolean {
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !this.applicationHost(url)
    } catch { return false }
  }

  bind(owner: Webview): void {
    const origin = owner.trustedOrigin
    if (origin === 'null') throw new Error('browser guest: host requires a document origin')
    this.hosts.set(owner, origin)
    const contents = owner.contents
    const attachments = new Map<number, string>()
    const releaseAll = () => {
      attachments.clear()
      for (const [id, lease] of this.leases) if (lease.owner === owner) void this.close(id).catch(error => console.error('browser guest cleanup failed', error))
    }
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) releaseAll() })
    contents.on('render-process-gone', releaseAll)
    owner.once('closed', () => { releaseAll(); this.hosts.delete(owner) })
    contents.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#') ? params.src.slice(12) : ''
      const lease = this.leases.get(id)
      if (!lease || lease.owner !== owner || lease.frame !== contents.mainFrame || lease.attached || params.partition !== lease.partition || documentOrigin(contents.getURL()) !== owner.trustedOrigin) { event.preventDefault(); return }
      const instanceId: unknown = params.instanceId
      if (typeof instanceId !== 'number' || !Number.isSafeInteger(instanceId) || attachments.has(instanceId)) { event.preventDefault(); return }
      attachments.set(instanceId, id)
      lease.attached = true
      for (const key of Object.keys(preferences)) if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      Object.assign(preferences, {
        partition: lease.partition, contextIsolation: true, sandbox: true,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
        plugins: false, navigateOnDragDrop: false, disableDialogs: true, devTools: false,
      })
      params.httpreferrer = ''
    })
    contents.on('did-attach-webview', (_event, guest) => {
      const instanceId = (guest as WebContents & { viewInstanceId?: number }).viewInstanceId
      const attachedId = instanceId === undefined ? undefined : attachments.get(instanceId)
      if (instanceId !== undefined) attachments.delete(instanceId)
      const attached = attachedId === undefined ? undefined : this.leases.get(attachedId)
      if (!attachedId || !attached || attached.owner !== owner || attached.guest || attached.frame !== contents.mainFrame || guest.session !== session.fromPartition(attached.partition)) { guest.close({ waitForBeforeUnload: false }); return }
      attached.guest = guest
      guest.once('destroyed', () => { this.leases.delete(attachedId) })
      guest.once('render-process-gone', () => { void this.close(attachedId).catch(error => console.error('browser guest cleanup failed', error)) })
      guest.once('dom-ready', () => {
        if (this.leases.get(attachedId) !== attached || guest.getURL() !== 'about:blank#' + attachedId) { void this.close(attachedId).catch(error => console.error('browser guest cleanup failed', error)) }
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedId ? this.leases.get(attachedId) : undefined
        if (lease?.guest === guest && !contents.isDestroyed() && lease.frame === contents.mainFrame && documentOrigin(contents.getURL()) === owner.trustedOrigin && postBody === undefined && this.navigation(url)) {
          this.transport.send('browser.openRequested', { webviewId: owner.id, lease: attachedId, url: new URL(url).href })
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', event => { if (!this.navigation(event.url)) event.preventDefault() })
      guest.on('will-redirect', (event, url) => { if (!this.navigation(url)) event.preventDefault() })
      guest.on('will-attach-webview', event => event.preventDefault())
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
  }
}
