import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
async function run() {
  if (!process.versions.electron) {
    const home = mkdtempSync(path.join(tmpdir(), 'electron-browser-guest-'))
    const env = { ...process.env, BROWSER_GUEST_HOME: home }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => child.kill(), 45_000)
    const [code] = await once(child, 'exit')
    clearTimeout(timer)
    rmSync(home, { recursive: true, force: true })
    assert.equal(code, 0)
  } else {
    const { app } = require('electron')
    app.setPath('userData', process.env.BROWSER_GUEST_HOME)
    const timer = setTimeout(() => { console.error('browser guest exceeded 35s'); app.exit(1) }, 35_000)
    const servers = []
    try {
      await app.whenReady()
      const { Factory } = require('../../assets/runtime/factory.cjs')
      const { Webviews } = require('../../assets/runtime/webview.cjs')
      const { Windows } = require('../../assets/runtime/window.cjs')
      const { Environment } = require('../../assets/runtime/environment.cjs')
      const windows = new Windows(), webviews = new Webviews(), events = []
      const serve = async (html) => {
        const server = createServer((_request, response) => response.end(html))
        servers.push(server)
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        return 'http://127.0.0.1:' + server.address().port
      }
      const hostUrl = await serve('<!doctype html><style>html{background:rgb(17,85,153)}</style><body>host<script>window.captureNonce=crypto.randomUUID();window.captureLoads=Number(sessionStorage.captureLoads||0)+1;sessionStorage.captureLoads=window.captureLoads</script></body>')
      const externalUrl = await serve('<!doctype html><title>external browser</title><body>external</body>')
      const factory = new Factory({ windows, webviews, environment: new Environment(webviews),
        policies: { attach() {} }, protocols: { prepare() {}, authenticatedHosts: { ownsSession() { return false } } }, popups: new Map(),
        transport: { closed: false, send(event, params) { events.push({ event, params }) } },
      })
      factory.createWindow({ windowId: 1, window: { width: 700, height: 500, visible: false }, webview: { webviewId: 2, url: hostUrl } })
      const shell = webviews.get(2)
      await once(shell.contents, 'did-finish-load')
      windows.get(1).native.show()
      const dpi = require('electron').screen.getDisplayMatching(windows.get(1).native.getBounds()).scaleFactor
      for (const zoom of [0.7, 1, 1.5]) {
        shell.contents.setZoomFactor(zoom)
        await shell.contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        await windows.get(1).probeScale()
        assert.ok(Math.abs(windows.get(1).scale - dpi) < 0.001, `page zoom ${zoom} must preserve native DPI`)
      }
      shell.contents.setZoomFactor(1)
      await shell.contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await windows.get(1).probeScale()
      console.log('native DPI at 70%, 100%, 150% zoom: PASS')
      factory.createWebview({ windowId: 1, webviewId: 3, url: hostUrl + '/harness', guestHost: 2, browserHost: true })
      await shell.contents.executeJavaScript(
        'new Promise((resolve,reject)=>{const w=document.createElement("webview");w.src=' + JSON.stringify(hostUrl + '/harness') + ';w.style="width:600px;height:400px";w.addEventListener("dom-ready",resolve,{once:true});w.addEventListener("did-fail-load",e=>reject(new Error(e.errorDescription)),{once:true});document.body.append(w)})')
      let host = webviews.get(3)
      assert.equal(host.adopted, true)
      assert.equal(host.contents.getLastWebPreferences().webviewTag, true)
      assert.equal(await host.contents.executeJavaScript('typeof document.createElement("webview").loadURL'), 'undefined')
      factory.closeWebview(3)
      factory.createWebview({ windowId: 1, webviewId: 3, url: hostUrl + '/harness', browserHost: true })
      host = webviews.get(3)
      await once(host.contents, 'did-finish-load')
      assert.equal(host.adopted, false)
      assert.equal(host.contents.getLastWebPreferences().webviewTag, true)
      const commands = require('../../assets/runtime/commands.cjs').createCommands({ webviews })
      const captureState = '({nonce:window.captureNonce,url:location.href,loads:window.captureLoads})'
      windows.get(1).native.show()
      await host.contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const beforeCapture = await host.contents.executeJavaScript(captureState)
      const image = require('electron').nativeImage.createFromDataURL(await commands['webview.capture']({ webviewId: 3 }))
      assert.equal(image.isEmpty(), false)
      assert.deepEqual([...image.toBitmap().subarray(0, 3)], [153, 85, 17], 'capture must contain the native host background, not a blank placeholder')
      assert.deepEqual(await host.contents.executeJavaScript(captureState), beforeCapture, 'capture must preserve the live document, URL and reload count')
      assert.throws(() => commands['webview.capture']({ webviewId: 999 }), /unknown webview/);
      const capturePage = host.contents.capturePage
      try {
        host.contents.capturePage = async () => require('electron').nativeImage.createEmpty()
        await assert.rejects(commands['webview.capture']({ webviewId: 3 }), /empty image/)
        host.contents.capturePage = async () => { throw new Error('capture failed') }
        await assert.rejects(commands['webview.capture']({ webviewId: 3 }), /capture failed/)
      } finally { host.contents.capturePage = capturePage }
      assert.throws(() => factory.acquireBrowserGuest(2, 'workspace'), /untrusted owner/)
      for (const invalid of ['', null, 'x'.repeat(4097)]) assert.throws(() => factory.acquireBrowserGuest(3, invalid), /invalid workspace/)
      const reservation = factory.acquireBrowserGuest(3, 'workspace')
      const sibling = factory.acquireBrowserGuest(3, 'workspace')
      assert.equal(sibling.partition, reservation.partition)
      assert.notEqual(factory.acquireBrowserGuest(3, 'other').partition, reservation.partition)
      assert.equal(reservation.partition.startsWith('persist:'), false)
      const hostLifecycleStart = events.length
      const attached = once(host.contents, 'did-attach-webview')
      await host.contents.executeJavaScript(
        'new Promise((resolve,reject)=>{const w=window.browser=document.createElement("webview");w.partition=' + JSON.stringify(reservation.partition) + ';w.src=' + JSON.stringify('about:blank#' + reservation.lease) + ';w.setAttribute("allowpopups","");w.setAttribute("preload","file:///invalid.cjs");w.setAttribute("webpreferences","nodeIntegration=yes,sandbox=no,webviewTag=yes");w.style="width:500px;height:300px";w.addEventListener("dom-ready",resolve,{once:true});w.addEventListener("did-fail-load",e=>reject(new Error(e.errorDescription)),{once:true});document.body.append(w)})')
      const [, guest] = await attached
      assert.equal(webviews.forContents(guest.id), undefined)
      const prefs = guest.getLastWebPreferences()
      for (const [name, value] of Object.entries({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true })) assert.equal(prefs[name], value, name)
      assert.ok(!prefs.preload)
      await host.contents.executeJavaScript('window.browser.loadURL(' + JSON.stringify(externalUrl) + ')')
      assert.deepEqual(events.slice(hostLifecycleStart).filter(entry => entry.params.webviewId === 3 && ['webview.loadStarted', 'webview.loadFinished', 'webview.loadFailed'].includes(entry.event)), [], 'opening and navigating Browser must not change the host document lifecycle')
      assert.deepEqual(await guest.executeJavaScript('({ipc:typeof window.ipc,tauri:typeof window.__TAURI_INTERNALS__,require:typeof require,process:typeof process})'), { ipc: 'undefined', tauri: 'undefined', require: 'undefined', process: 'undefined' })
      for (const url of [hostUrl, hostUrl.replace('127.0.0.1', 'localhost'), 'http://ipc.localhost/private', 'file:///C:/Windows/win.ini', 'ipc://localhost/private']) {
        const result = await guest.executeJavaScript('fetch(' + JSON.stringify(url) + ').then(()=>false,()=>true)')
        assert.equal(result, true, url)
        await assert.rejects(guest.loadURL(url), /ERR_/)
      }
      await guest.loadURL(externalUrl)
      await guest.executeJavaScript('window.open(' + JSON.stringify(externalUrl + '/popup') + ')')
      const opened = events.find(entry => entry.event === 'browser.openRequested')
      assert.deepEqual(opened?.params, { webviewId: 3, lease: reservation.lease, url: externalUrl + '/popup' })
      assert.equal(require('electron').BaseWindow.getAllWindows().length, 1)
      const count = events.filter(entry => entry.event === 'browser.openRequested').length
      await guest.executeJavaScript('window.open(' + JSON.stringify(hostUrl) + ')')
      assert.equal(events.filter(entry => entry.event === 'browser.openRequested').length, count)
      const reuse = { partition: reservation.partition, src: 'about:blank#' + reservation.lease }
      let denied = false
      host.contents.emit('will-attach-webview', { preventDefault() { denied = true } }, {}, reuse)
      assert.equal(denied, true)
      const nested = factory.acquireBrowserGuest(3, 'workspace')
      denied = false
      host.contents.emit('will-attach-webview', { preventDefault() { denied = true } }, {}, { src: 'about:blank#' + nested.lease, partition: 'persist:forged' })
      assert.equal(denied, true)
      await factory.releaseBrowserGuest(3, reservation.lease)
      assert.equal(guest.isDestroyed(), true)
      await factory.releaseBrowserGuest(3, reservation.lease)
      factory.createWebview({ windowId: 1, webviewId: 5, url: hostUrl + '/second', browserHost: true })
      const second = webviews.get(5)
      await once(second.contents, 'did-finish-load')
      await assert.rejects(factory.releaseBrowserGuest(5, sibling.lease), /another owner/)
      assert.equal(second.acceptsIpc(externalUrl), false)
      assert.equal(second.acceptsIpc(hostUrl), true)
      const sameDocumentStart = events.length
      await second.contents.executeJavaScript("history.pushState({}, '', '/second#browser')")
      assert.deepEqual(events.slice(sameDocumentStart).filter(entry => entry.params.webviewId === 5 && entry.event.startsWith('webview.load')), [], 'same-document navigation must preserve the loaded host')
      const reloadStart = events.length
      const reloaded = once(second.contents, 'did-finish-load')
      second.contents.reload()
      await reloaded
      assert.deepEqual(events.slice(reloadStart).filter(entry => entry.params.webviewId === 5 && entry.event.startsWith('webview.load')).map(entry => entry.event), ['webview.loadStarted', 'webview.loadFinished'], 'a real host reload must still invalidate and finish its document')
      const attachGuest = async (reservation) => {
        const attached = once(host.contents, 'did-attach-webview')
        await host.contents.executeJavaScript('new Promise(resolve=>{const w=document.createElement("webview");w.partition=' + JSON.stringify(reservation.partition) + ';w.src=' + JSON.stringify('about:blank#' + reservation.lease) + ';w.addEventListener("dom-ready",resolve,{once:true});document.body.append(w)})')
        return (await attached)[1]
      }
      const crashedLease = factory.acquireBrowserGuest(3, 'workspace')
      const crashed = await attachGuest(crashedLease)
      const crashClosed = once(crashed, 'destroyed')
      crashed.forcefullyCrashRenderer()
      await crashClosed
      const earlyLease = factory.acquireBrowserGuest(3, 'workspace')
      const earlyClosed = new Promise(resolve => host.contents.once('did-attach-webview', (_event, guest) => {
        guest.once('destroyed', resolve)
        void factory.releaseBrowserGuest(3, earlyLease.lease)
      }))
      await host.contents.executeJavaScript('(()=>{const w=document.createElement("webview");w.partition=' + JSON.stringify(earlyLease.partition) + ';w.src=' + JSON.stringify('about:blank#' + earlyLease.lease) + ';document.body.append(w)})()')
      await earlyClosed
      const navigateLease = factory.acquireBrowserGuest(3, 'workspace')
      const navigateGuest = await attachGuest(navigateLease)
      const pending = factory.acquireBrowserGuest(3, 'workspace')
      await host.contents.loadURL(hostUrl + '/next')
      assert.equal(navigateGuest.isDestroyed(), true)
      await host.contents.loadURL(externalUrl)
      assert.throws(() => factory.acquireBrowserGuest(3, 'workspace'), /untrusted owner/)
      await host.contents.loadURL(hostUrl + '/back')
      denied = false
      host.contents.emit('will-attach-webview', { preventDefault() { denied = true } }, {}, { src: 'about:blank#' + pending.lease, partition: pending.partition })
      assert.equal(denied, true)
      const failedUrl = 'http://127.0.0.1:1/load-failure'
      await assert.rejects(second.contents.loadURL(failedUrl), /ERR_/)
      assert.ok(events.some(entry => entry.event === 'webview.loadFailed' && entry.params.webviewId === 5))
      second.contents.forcefullyCrashRenderer()
      await once(second.contents, 'render-process-gone')
      assert.ok(events.some(entry => entry.event === 'webview.processGone' && entry.params.webviewId === 5))
      assert.ok(events.some(entry => entry.event === 'webview.loadStarted' && entry.params.webviewId === 3))
      assert.ok(events.some(entry => entry.event === 'webview.loadFinished' && entry.params.webviewId === 3))
      const closedLease = factory.acquireBrowserGuest(3, 'workspace')
      const closedGuest = await attachGuest(closedLease)
      const closed = once(closedGuest, 'destroyed')
      factory.closeWebview(3)
      await closed
      if (process.platform === 'darwin') {
        factory.createWindow({ windowId: 6, window: { width: 820, height: 560, visible: false,
          titleBarStyle: 'Overlay', hiddenTitle: true, trafficLightPosition: { x: 18, y: 24 } } })
        const caption = windows.get(6).native
        caption.show()
        caption.focus()
        caption.blur()
        caption.focus()
        caption.setBounds({ width: 800, height: 540 })
        const resized = caption.getBounds()
        assert.deepEqual([resized.width, resized.height, windows.get(6).configuration.trafficLightPosition], [800, 540, { x: 18, y: 24 }],
          'an inset macOS window must keep its frame and inset across key-state and resize layout passes')
        assert.equal(caption.isVisible(), true, 'the first key-window pass after the caption inset must keep the window alive')
        console.log('macOS caption inset on first key window: PASS')
        windows.get(6).destroy()
      }
      windows.get(1).destroy()
      console.log('browser guest real Electron (WebContentsView host): PASS')
      clearTimeout(timer)
      for (const server of servers) server.close()
      app.exit(0)
    } catch (error) {
      console.error(error)
      clearTimeout(timer)
      for (const server of servers) server.close()
      app.exit(1)
    }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
