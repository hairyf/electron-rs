import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'

const require = createRequire(import.meta.url)
const { app } = require('electron')
import { createHash } from 'node:crypto'
const home = process.env.AUTHENTICATED_HOST_HOME
assert.ok(home, 'native fixture requires an isolated userData directory')
app.setPath('userData', home)
const received = []
let streamClosed = Promise.withResolvers()
let slowRequest = Promise.withResolvers()
const server = createServer((request, response) => {
  received.push({ url: request.url, cookie: request.headers.cookie, origin: request.headers.origin })
  if (request.url === '/?token=owned') {
    response.writeHead(303, { 'set-cookie': 'auth=private; HttpOnly', location: '/' }); response.end()
  } else if (request.url === '/slow') {
    slowRequest.resolve(() => response.end('<!doctype html><body>slow document</body>'))
  } else if (request.url === '/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('first')
    request.once('close', () => { response.end(); streamClosed.resolve() })
  } else response.end('<!doctype html><body>authenticated host</body>')
})
const sockets = []
server.on('upgrade', (request, socket) => {
  sockets.push(socket)
  received.push({ url: request.url, cookie: request.headers.cookie, origin: request.headers.origin })
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
})
const deadline = setTimeout(() => { console.error('native authenticated host timeout'); app.exit(1) }, 15000)
async function run() {
try {
  await app.whenReady()
  console.error("native: ready")
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const bootstrap = createServer((_request, response) => response.end('<!doctype html><body>bootstrap</body>'))
  bootstrap.listen(0, '127.0.0.1'); await once(bootstrap, 'listening')
  const bootstrapUrl = 'http://127.0.0.1:' + bootstrap.address().port
  const { Factory } = require('../../assets/runtime/factory.cjs')
  const { Protocols } = require('../../assets/runtime/protocol.cjs')
  const { Webviews } = require('../../assets/runtime/webview.cjs')
  const { Windows } = require('../../assets/runtime/window.cjs')
  const { Environment } = require('../../assets/runtime/environment.cjs')
  const { createCommands } = require('../../assets/runtime/commands.cjs')
  const webviews = new Webviews(), windows = new Windows()
  const policies = { install() {}, attach() {} }
  const transport = { closed: false, send(event) { assert.notEqual(event, 'protocol.request', 'body must never cross Rust') } }
  const protocols = new Protocols({ policies, transport })
  const factory = new Factory({ windows, webviews, policies, protocols, transport, environment: new Environment(webviews), popups: new Map() })
  const commands = createCommands({ webviews, protocols, factory })
  factory.createWindow({ windowId: 1, window: { visible: false }, webview: { webviewId: 2, url: bootstrapUrl, browserHost: true, authenticatedWebHostSession: true } })
  const owner = webviews.get(2)
  await once(owner.contents, 'did-finish-load')
  console.error('native: bootstrap')
  const host = await commands['webHost.authenticate']({ url: origin + '/?token=owned' })
  commands['webHost.bind']({ webviewId: 2, hostId: host.id })
  console.error("native: authenticated", host.documentUrl)
  await owner.contents.loadURL(host.documentUrl)
  console.error("native: document")
  assert.equal(received.at(-1).cookie, 'auth=private')
  assert.equal((await owner.contents.session.cookies.get({ url: origin })).length, 0)
  const chunk = await owner.contents.executeJavaScript('(async()=>{window.abort=new AbortController();const response=await fetch("/stream",{signal:abort.signal});window.reader=response.body.getReader();return new TextDecoder().decode((await reader.read()).value)})()')
  console.error('native: chunk', chunk)
  assert.equal(chunk, 'first')
  await owner.contents.executeJavaScript('abort.abort();true')
  await streamClosed.promise
  console.error("native: cancelled")
  await owner.contents.executeJavaScript('new Promise((resolve,reject)=>{window.socket=new WebSocket(' + JSON.stringify(origin.replace('http:', 'ws:') + '/socket') + ');socket.onopen=()=>resolve(true);socket.onerror=()=>reject(Error("WebSocket failed"))})')
  assert.equal(received.at(-1).cookie, 'auth=private')
  assert.equal(received.at(-1).origin, origin)
  const reservation = factory.acquireBrowserGuest(2, 'workspace')
  const attached = once(owner.contents, 'did-attach-webview')
  await owner.contents.executeJavaScript('new Promise((resolve,reject)=>{const guest=document.createElement("webview");guest.partition=' + JSON.stringify(reservation.partition) + ';guest.src=' + JSON.stringify('about:blank#' + reservation.lease) + ';guest.addEventListener("dom-ready",resolve,{once:true});guest.addEventListener("did-fail-load",()=>reject(Error("browser guest failed")),{once:true});document.body.append(guest)})')
  const [, guest] = await attached
  assert.notEqual(guest.session, owner.contents.session)
  assert.equal(await guest.executeJavaScript('typeof window.ipc'), 'undefined')
  await assert.rejects(guest.loadURL(origin), /ERR_/)
  for (const invalid of ['data:text/html,no', 'http://user:pass@example.com', origin + '/path']) await assert.rejects(commands['webview.trustedOrigin']({ webviewId: 2, origin: invalid }), /invalid trusted document origin/)
  await commands['webview.trustedOrigin']({ webviewId: 2, origin: bootstrapUrl })
  assert.equal(guest.isDestroyed(), true)
  assert.equal(owner.trustedOrigin, bootstrapUrl)
  await owner.contents.loadURL(bootstrapUrl)
  const blocked = await owner.contents.executeJavaScript('fetch(' + JSON.stringify(origin) + ').then(response=>response.status,()=>0)')
  assert.ok([0, 503].includes(blocked), 'remote document must not receive local authenticated content')
  commands['webHost.bind']({ webviewId: 2, hostId: host.id })
  await owner.contents.loadURL(host.documentUrl)
  assert.equal(received.at(-1).cookie, 'auth=private')
  policies.activePopup = { request: 99, opener: owner }
  assert.throws(() => factory.createWindow({ windowId: 4, newWindowRequest: 99, webview: { webviewId: 5, url: 'https://example.com/' } }), /independent popup sessions/)
  delete policies.activePopup
  factory.createWebview({ windowId: 1, webviewId: 3, url: 'about:blank' })
  const other = webviews.get(3)
  assert.notEqual(other.contents.session, owner.contents.session)
  await once(other.contents, 'did-finish-load')
  await other.contents.loadURL(origin)
  assert.equal(received.at(-1).cookie, undefined)
  const oldDocument = other.documentGeneration
  await other.contents.loadURL(origin + '/next')
  await assert.rejects(commands['webview.eval']({ webviewId: 3, script: 'window.staleChannel = true', documentGeneration: oldDocument }), /document replaced/)
  await assert.rejects(commands['webview.eval']({ webviewId: 3, script: 'window.staleChannel = true', documentGeneration: oldDocument }), /document replaced/)
  assert.equal(await other.evaluate('typeof window.staleChannel'), 'undefined')
  slowRequest = Promise.withResolvers()
  const replacedNavigation = other.contents.loadURL(origin + '/slow').catch(error => error)
  await slowRequest.promise
  const replaced = assert.rejects(other.evaluate('window.mustNotCross = true'), /document replaced/)
  await other.contents.loadURL(origin + '/replacement')
  await replaced
  await replacedNavigation
  assert.equal(await other.evaluate('typeof window.mustNotCross'), 'undefined')
  const newDocument = other.documentGeneration
  assert.equal(await commands['webview.eval']({ webviewId: 3, script: '42', documentGeneration: newDocument }), 42)
  await other.contents.loadURL(origin + '/replacement#same-document')
  assert.equal(other.documentGeneration, newDocument)
  assert.equal(await commands['webview.eval']({ webviewId: 3, script: '43', documentGeneration: newDocument }), 43)
  slowRequest = Promise.withResolvers()
  const navigation = other.contents.loadURL(origin + '/slow')
  const finish = await slowRequest.promise
  const baseline = other.contents.listenerCount('did-stop-loading')
  const evaluations = Array.from({ length: 12 }, (_, index) => other.evaluate(String(index)))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(other.contents.listenerCount('did-stop-loading'), baseline + 1)
  finish()
  await navigation
  assert.deepEqual(await Promise.all(evaluations), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(other.contents.listenerCount('did-stop-loading'), 0)
  slowRequest = Promise.withResolvers()
  const closingNavigation = other.contents.loadURL(origin + '/slow').catch(error => error)
  await slowRequest.promise
  const waiting = assert.rejects(other.evaluate('1'), /destroyed before script evaluation/)
  other.contents.close({ waitForBeforeUnload: false })
  await waiting
  await closingNavigation
  windows.get(1).destroy()
  console.error('native authenticated-host: PASS')
  clearTimeout(deadline)
  for (const socket of sockets) socket.destroy()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await new Promise(resolve => bootstrap.close(resolve))
  app.quit()
} catch (error) {
  console.error(error); app.exit(1)
}
}
void run().catch(error => { console.error(error); app.exit(1) })
