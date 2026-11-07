import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { app, ipcMain } = require('electron');
const { Protocols } = require('../../assets/runtime/protocol.cjs');
Protocols.registerPrivileged(['tauri']);
assert.ok(process.env.AUTHENTICATED_HOST_HOME);
app.setPath('userData', process.env.AUTHENTICATED_HOST_HOME);
app.on('window-all-closed', () => { });
let held = Promise.withResolvers();
const seen = [];
const backend = createServer((request, response) => {
    seen.push({ url: request.url, cookie: request.headers.cookie });
    if (request.url === '/auth') {
        response.writeHead(303, { 'set-cookie': 'auth=owned; HttpOnly', location: '/' });
        response.end();
    }
    else {
        assert.equal(request.headers.cookie, 'auth=owned', 'old API must retain its private backend credential');
        response.end('<!doctype html><body>owned backend</body>');
    }
});
let origin;
const target = createServer((request, response) => {
    assert.equal(request.headers.cookie, undefined, 'bootstrap must never receive backend cookie');
    if (request.url === '/redirect') {
        response.writeHead(302, { location: origin + '/redirect-return' });
        response.end();
    }
    else
        held.resolve(response);
});
const deadline = setTimeout(() => { console.error('native handoff timeout'); app.exit(1); }, 15000);
async function run() {
    await app.whenReady();
    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    origin = 'http://127.0.0.1:' + backend.address().port;
    const targetOrigin = 'http://127.0.0.1:' + target.address().port;
    const url = targetOrigin + '/held';
    const { Factory } = require('../../assets/runtime/factory.cjs');
    const { Webviews } = require('../../assets/runtime/webview.cjs');
    const { Windows } = require('../../assets/runtime/window.cjs');
    const { Environment } = require('../../assets/runtime/environment.cjs');
    const { Policies } = require('../../assets/runtime/policy.cjs');
    const { Downloads } = require('../../assets/runtime/downloads.cjs');
    const { createCommands } = require('../../assets/runtime/commands.cjs');
    const webviews = new Webviews(), windows = new Windows(), popups = new Map();
    let policies, owner;
    const transport = { closed: false, send(event, params) { if (event === 'webview.navigationRequested')
            policies.answerNavigation(params.id, true); }, request() { return { action: 'deny' }; } };
    policies = new Policies({ transport, downloads: new Downloads(), webviews, windows, popups });
    const protocols = new Protocols({ policies, transport });
    protocols.register('tauri');
    const originalSend = transport.send;
    transport.send = (event, params) => { if (event === 'protocol.request')
        protocols.answer(params.id, { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<!doctype html><body>bootstrap</body>').toString('base64') });
    else
        originalSend(event, params); };
    const factory = new Factory({ webviews, windows, popups, policies, protocols, transport, environment: new Environment(webviews) });
    const commands = createCommands({ webviews, windows, protocols, factory, policies });
    const sent = Promise.withResolvers(), invoked = Promise.withResolvers();
    const probe = (_event, label) => { const result = { label, accepted: owner.acceptsIpc(_event.senderFrame.url), url: _event.senderFrame.url }; if (label === 'send')
        sent.resolve(result);
    else
        invoked.resolve(result); };
    ipcMain.on('handoff-preload', probe);
    ipcMain.handle('handoff-preload-invoke', event => owner.acceptsIpc(event.senderFrame.url));
    const preload = `if(location.pathname==='/held'){const {ipcRenderer}=require('electron');ipcRenderer.send('handoff-preload','send');ipcRenderer.invoke('handoff-preload-invoke').then(value=>ipcRenderer.send('handoff-preload',value?'invoke-accepted':'invoke-rejected'))}`;
    factory.createWindow({ windowId: 1, window: { visible: false }, webview: { webviewId: 2, url: 'tauri://localhost/', browserHost: true, authenticatedWebHostSession: true, policy: { navigation: true }, preloadScripts: [preload] } });
    owner = webviews.get(2);
    await once(owner.contents, 'did-finish-load');
    const host = await commands['webHost.authenticate']({ url: origin + '/auth' });
    commands['webHost.bind']({ webviewId: 2, hostId: host.id });
    await owner.contents.loadURL(host.documentUrl);
    const request = () => owner.contents.mainFrame.executeJavaScript('fetch("/api/old").then(response=>response.status)');
    for (const invalid of [{ origin: targetOrigin, url: origin + '/' }, { origin: 'unknown://localhost', url: 'unknown://localhost/' }, { origin: targetOrigin, url: targetOrigin.replace('http://', 'http://u:p@') + '/' }])
        await assert.rejects(commands['webview.trustedOriginAndNavigate']({ webviewId: 2, ...invalid }), /invalid trusted/);
    await assert.rejects(commands['webview.trustedOriginAndNavigate']({ webviewId: 2, origin, url: origin + '/#same' }), /different document/);
    let transition = commands['webview.trustedOriginAndNavigate']({ webviewId: 2, origin: targetOrigin, url }).then(() => null, error => error);
    let response = await held.promise;
    assert.equal(await request(), 200);
    assert.equal(owner.acceptsIpc(origin), true);
    assert.equal(owner.acceptsIpc(targetOrigin), false);
    assert.throws(() => factory.acquireBrowserGuest(2, 'late'), /pending/);
    assert.throws(() => commands['webHost.bind']({ webviewId: 2, hostId: host.id }), /pending/);
    await assert.rejects(commands['webview.trustedOrigin']({ webviewId: 2, origin: targetOrigin }), /pending/);
    await assert.rejects(commands['webview.trustedOriginAndNavigate']({ webviewId: 2, origin: targetOrigin, url }), /pending/);
    owner.contents.stop();
    assert.ok(await transition instanceof Error);
    response.end();
    assert.equal(owner.acceptsIpc(origin), true);
    assert.equal(await request(), 200);
    const afterCancel = factory.acquireBrowserGuest(2, 'after-cancel');
    await factory.releaseBrowserGuest(2, afterCancel.lease);
    const redirected = await commands['webview.trustedOriginAndNavigate']({ webviewId: 2, origin: targetOrigin, url: targetOrigin + '/redirect' }).then(() => null, error => error);
    assert.ok(redirected instanceof Error);
    assert.equal(owner.acceptsIpc(origin), true);
    assert.equal(owner.acceptsIpc(targetOrigin), false);
    await owner.contents.loadURL(host.documentUrl);
    assert.equal(await request(), 200);
    assert.equal(seen.some(row => row.url === '/redirect-return'), false, 'redirect must not gain old-origin navigation authority');
    const reserved = factory.acquireBrowserGuest(2, 'before-success');
    const attached = once(owner.contents, 'did-attach-webview');
    await owner.contents.executeJavaScript('new Promise((resolve,reject)=>{const guest=document.createElement("webview");guest.partition=' + JSON.stringify(reserved.partition) + ';guest.src=' + JSON.stringify('about:blank#' + reserved.lease) + ';guest.addEventListener("dom-ready",resolve,{once:true});guest.addEventListener("did-fail-load",()=>reject(Error("guest failed")),{once:true});document.body.append(guest)})');
    const [, guest] = await attached;
    held = Promise.withResolvers();
    transition = commands['webview.trustedOriginAndNavigate']({ webviewId: 2, origin: targetOrigin, url }).then(() => null, error => error);
    response = await held.promise;
    assert.equal(guest.isDestroyed(), true, 'previous guests must close before target commit');
    assert.equal(await request(), 200);
    response.end('<!doctype html><body>target</body>');
    assert.equal(await transition, null);
    assert.equal((await sent.promise).accepted, true, 'earliest target preload send must observe committed trust');
    assert.equal((await invoked.promise).label, 'invoke-accepted', 'earliest target preload invoke must observe committed trust');
    assert.equal(owner.acceptsIpc(origin), false);
    assert.equal((await owner.contents.session.cookies.get({ url: origin })).length, 0);
    const requestsBeforeRetired = seen.length;
    assert.ok([0, 503].includes(await owner.contents.executeJavaScript('fetch(' + JSON.stringify(origin + '/api/retired') + ').then(response=>response.status,()=>0)')));
    assert.equal(seen.length, requestsBeforeRetired, 'retired backend must receive no request after commit');
    windows.get(1).destroy();
    ipcMain.removeListener('handoff-preload', probe);
    ipcMain.removeHandler('handoff-preload-invoke');
    clearTimeout(deadline);
    backend.closeAllConnections();
    target.closeAllConnections();
    await new Promise(resolve => backend.close(resolve));
    await new Promise(resolve => target.close(resolve));
    console.error('native authenticated handoff: PASS');
    app.quit();
}
void run().catch(error => { console.error(error); app.exit(1); });
