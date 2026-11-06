import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once, EventEmitter } from 'node:events'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { runtimeModules } from '../fixtures/runtime-modules.mjs'

const require = createRequire(import.meta.url)
const received = []
const server = createServer((request, response) => {
  received.push({ url: request.url, headers: request.headers })
  if (request.url === '/?token=owned') {
    response.writeHead(303, { 'set-cookie': 'auth=private; HttpOnly; SameSite=Strict', location: '/' })
    response.end()
  } else if (request.url === '/bad-auth') {
    response.writeHead(200, { 'set-cookie': 'bad=1' }); response.end()
  } else if (request.url === '/cross-auth') {
    response.writeHead(303, { 'set-cookie': 'bad=1', location: 'https://attacker.example' }); response.end()
  } else if (request.url === '/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'must=not-leak', 'cache-control': 'immutable' })
    response.write('first')
    request.once('close', () => { response.end(); cancelled.resolve() })
  } else {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('proxied')
  }
})
let cancelled = Promise.withResolvers()
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = 'http://127.0.0.1:' + server.address().port
const sessions = []
function newSession() {
  const handlers = new Map()
  const target = Object.assign(new EventEmitter(), {
    handlers, protocol: { handle: (scheme, handler) => handlers.set(scheme, handler) },
    webRequest: { onBeforeSendHeaders(handler) { target.beforeHeaders = handler } },
    fetch: async (request, options) => { assert.equal(options.bypassCustomProtocolHandlers, true); return new Response('ordinary') },
  })
  sessions.push(target)
  return target
}
const context = vm.createContext({ URL, Request, Response, Headers, Buffer, fetch, console })
const load = runtimeModules(context, name => name === 'electron' ? { session: { fromPartition: newSession } } : require(name))
try {
  const { Protocols } = load('./runtime/protocol.cjs')
  const protocols = new Protocols({ policies: { install() {} }, transport: { send() { assert.fail('stream crossed Rust') } } })
  const hosts = protocols.authenticatedHosts
  await assert.rejects(hosts.authenticate(origin + '/bad-auth'), /Host authentication failed/)
  await assert.rejects(hosts.authenticate(origin + '/cross-auth'), /outside its origin/)
  const host = await hosts.authenticate(origin + '/?token=owned')
  assert.equal(host.documentUrl, origin + '/')
  assert.equal(host.backendOrigin, origin)
  assert.equal(JSON.stringify(host).includes('private'), false)
  assert.equal(hosts.cookieHeader(host.id), 'auth=private')
  assert.throws(() => hosts.cookieHeader('unregistered'), /unknown authenticated host/)
  const target = hosts.createSession()
  protocols.prepare(target)
  const owner = Object.assign(new EventEmitter(), {
    id: 51, contentsId: 8, contents: { id: 8, session: target },
    setAuthenticatedOrigin(value) { this.authenticatedOrigin = value },
  })
  hosts.bind(owner, host.id)
  const handler = target.handlers.get('http')
  const response = await handler(new Request(origin + '/stream', { headers: { Cookie: 'forged=1', Origin: origin } }))
  assert.equal(response.headers.get('set-cookie'), null)
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first')
  assert.equal(received.at(-1).headers.cookie, 'auth=private')
  assert.equal(received.at(-1).headers.origin, origin)
  await reader.cancel()
  await Promise.race([cancelled.promise, new Promise((_, reject) => setTimeout(() => reject(Error('stream cancellation timed out')), 3000))])
  assert.equal((await handler(new Request('https://github.com/'))).status, 200)
  assert.equal((await handler(new Request(origin + '/blocked', { headers: { Origin: 'https://attacker.example' } }))).status, 403)
  function headers(webContentsId, url, originHeader = origin) {
    let result
    target.beforeHeaders({ webContentsId, url, requestHeaders: { Cookie: 'forged=1', Origin: originHeader } }, value => { result = value })
    return result
  }
  assert.equal(headers(8, origin + '/api').requestHeaders.cookie, 'auth=private')
  assert.equal(headers(8, origin.replace('http:', 'ws:') + '/socket').requestHeaders.origin, origin)
  assert.equal(headers(9, origin + '/api').cancel, true)
  assert.equal(headers(8, origin + '/api', 'https://attacker.example').cancel, true)
  assert.equal(headers(8, 'http://127.0.0.1:1/api').requestHeaders, undefined)
  assert.equal(headers(8, origin.replace('http:', 'https:') + '/api').requestHeaders, undefined)
  assert.throws(() => hosts.bind({ contents: { session: {} } }, host.id), /own authenticated webview session/)
  owner.emit('closed')
  assert.equal((await handler(new Request(origin + '/closed'))).status, 503)
  console.log('authenticated-host: PASS')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
