import { randomUUID } from 'node:crypto'
import { session } from 'electron'
import type { Session } from 'electron'
import type { Webview } from './webview'

type Host = { id: string; documentUrl: string; backendOrigin: string; cookie: string }
type Binding = { owner?: Webview; host?: Host; retiredOrigin?: string }

export class AuthenticatedHosts {
  private readonly hosts = new Map<string, Host>()
  private readonly sessions = new WeakMap<Session, Binding>()

  async authenticate(value: unknown): Promise<{ id: string; documentUrl: string; backendOrigin: string }> {
    if (typeof value !== 'string') throw new Error('invalid Host launch URL')
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid Host launch URL')
    const response = await fetch(url, { redirect: 'manual' })
    const cookie = response.headers.get('set-cookie')
    await response.body?.cancel()
    if (response.status !== 303 || !cookie) throw new Error('Host authentication failed')
    const document = new URL(response.headers.get('location') ?? '/', url)
    if (document.origin !== url.origin || document.username || document.password) throw new Error('Host authentication redirected outside its origin')
    const id = randomUUID()
    const host = { id, documentUrl: document.href, backendOrigin: url.origin, cookie: cookie.split(';', 1)[0] }
    this.hosts.set(id, host)
    return { id, documentUrl: host.documentUrl, backendOrigin: host.backendOrigin }
  }

  cookieHeader(id: unknown): string {
    const host = typeof id === 'string' ? this.hosts.get(id) : undefined
    if (!host) throw new Error('unknown authenticated host')
    return host.cookie
  }

  ownsSession(target: Session): boolean { return this.sessions.has(target) }

  createSession(): Session {
    const target = session.fromPartition('electron-authenticated-' + randomUUID())
    const binding: Binding = {}
    this.sessions.set(target, binding)
    target.webRequest.onBeforeSendHeaders((details, callback) => {
      const host = binding.host
      if (!host || !this.matches(details.url, host.backendOrigin)) { callback({}); return }
      const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]))
      if (details.webContentsId !== binding.owner?.contentsId || (headers.origin !== undefined && headers.origin !== host.backendOrigin)) { callback({ cancel: true }); return }
      callback({ requestHeaders: { ...headers, origin: host.backendOrigin, cookie: host.cookie, 'sec-fetch-site': 'same-origin' } })
    })
    return target
  }

  bind(owner: Webview, id: unknown): void {
    const binding = this.sessions.get(owner.contents.session)
    const host = typeof id === 'string' ? this.hosts.get(id) : undefined
    if (!binding || !host || (binding.owner && binding.owner !== owner)) throw new Error('Host binding requires its own authenticated webview session')
    binding.owner = owner
    binding.host = host
    binding.retiredOrigin = undefined
    owner.setAuthenticatedOrigin(host.backendOrigin)
    owner.once('closed', () => {
      binding.retiredOrigin = binding.host?.backendOrigin ?? binding.retiredOrigin
      binding.host = undefined
      binding.owner = undefined
    })
  }

  unbind(owner: Webview): void {
    const binding = this.sessions.get(owner.contents.session)
    if (!binding || binding.owner !== owner) return
    binding.retiredOrigin = binding.host?.backendOrigin
    binding.host = undefined
  }

  route(target: Session, request: Request): Promise<Response> | undefined {
    const binding = this.sessions.get(target)
    const url = new URL(request.url)
    if (binding?.retiredOrigin === url.origin) return Promise.resolve(new Response(null, { status: 503 }))
    const host = binding?.host
    if (!host || url.origin !== host.backendOrigin) return undefined
    return this.forward(request, host)
  }

  private matches(value: string, origin: string): boolean {
    const url = new URL(value)
    if (url.protocol === 'ws:') url.protocol = 'http:'
    else if (url.protocol === 'wss:') url.protocol = 'https:'
    return url.origin === origin
  }

  private async forward(request: Request, host: Host): Promise<Response> {
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== host.backendOrigin) return new Response(null, { status: 403 })
    const headers = new Headers(request.headers)
    for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
    headers.set('cookie', host.cookie)
    headers.set('origin', host.backendOrigin)
    const init: RequestInit & { duplex: string } = { method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual' }
    const response = await fetch(request.url, init)
    const outgoing = new Headers(response.headers)
    for (const name of ['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization']) outgoing.delete(name)
    return new Response(response.body, { status: response.status, headers: outgoing })
  }
}
