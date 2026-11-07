import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const home = mkdtempSync(path.join(tmpdir(), 'electron-startup-auth-'))
const token = randomBytes(32).toString('hex')
const sockets = new Set()
let expired = false, frames = 0, acceptedAt, authenticationMs
const server = createServer(socket => {
  sockets.add(socket)
  acceptedAt = performance.now()
  let buffer = ''
  const timeout = setTimeout(() => { expired = true; socket.destroy() }, 500)
  socket.on('error', () => {})
  socket.once('close', () => { clearTimeout(timeout); sockets.delete(socket) })
  socket.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf(String.fromCharCode(10))) >= 0) {
      clearTimeout(timeout)
      const frame = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      assert.equal(frame.event, 'ready')
      assert.ok(frame.params.token === token, 'native ready credential must match its private launch token')
      assert.equal(typeof frame.params.electron, 'string')
      frames++
      authenticationMs = performance.now() - acceptedAt
    }
    if (frames) socket.end()
  })
})
let child, timer
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const env = { ...process.env, ELECTRON_STARTUP_AUTH_HOME: home }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(process.env.ELECTRON_RS_BINARY ?? require('electron'), [fileURLToPath(new URL('../fixtures/startup-authentication.cjs', import.meta.url)), '--port', String(server.address().port)], { env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  child.stdin.end(token + String.fromCharCode(10))
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  timer = setTimeout(() => child.kill(), 25_000)
  const [code] = await once(child, 'exit')
  clearTimeout(timer)
  assert.equal(code, 0, stderr)
  assert.ok(stderr.includes('startup-authentication: busy start') && stderr.includes('startup-authentication: busy end'))
  assert.equal(expired, false, '500ms peer authentication must not require the busy main event loop')
  assert.equal(frames, 1, 'the initialized native process must send exactly one authenticated ready frame')
  assert.doesNotMatch(stderr, /UnhandledPromiseRejection|startup unexpectedly quit/)
  console.log('native startup authentication: PASS', JSON.stringify({ frames, authenticationMs: Math.round(authenticationMs) }))
} finally {
  clearTimeout(timer)
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
