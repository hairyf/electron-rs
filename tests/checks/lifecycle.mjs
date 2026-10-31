import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const filename = fileURLToPath(import.meta.url)
const credential = '0123456789abcdef'.repeat(4)

if (process.versions.electron) {
  const { app } = require('electron')
  const profile = process.argv.find(value => value.startsWith('--profile=')).slice(10)
  for (const name of ['appData', 'userData', 'sessionData', 'crashDumps']) app.setPath(name, profile)
  const runtime = require('../../assets/main.cjs')
  void app.whenReady().then(async () => {
    runtime.commands['window.create']({ windowId: 1, window: { visible: false, closable: false }, webview: { webviewId: 1 } })
    const contents = runtime.webviews.get(1).contents
    await contents.loadURL('data:text/html,<script>onbeforeunload=()=>false</script>')
    await contents.executeJavaScript('1')
    const listener = net.createServer()
    listener.listen(0, '127.0.0.1', () => runtime.transport.send('lifecycle.prepared', { port: listener.address().port }))
  })
} else {
  const electron = path.dirname(require.resolve('electron/package.json'))
  const executable = path.join(electron, 'dist', fs.readFileSync(path.join(electron, 'path.txt'), 'utf8').trim())
  assert.ok(fs.existsSync(executable), 'installed Electron executable is required')
  const directory = fs.mkdtempSync(path.resolve('.lifecycle-check-'))
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf(String.fromCharCode(10))) >= 0) {
        const message = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        if (message.event === 'ready') { assert.equal(message.params.token, credential); authenticated = true }
        if (message.event === 'lifecycle.prepared') { prepared = true; ownedPort = message.params.port; socket.destroy() }
      }
    })
    socket.on('error', () => {})
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const env = { ...process.env, TAURI_RUNTIME_ELECTRON_OWNER: '', APPDATA: directory, LOCALAPPDATA: directory, TEMP: directory, TMP: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [filename, '--port', String(server.address().port), '--profile=' + directory], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = '', prepared = false, authenticated = false, ownedPort
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.stdin.end(credential + String.fromCharCode(10))
  const timeout = setTimeout(() => child.kill(), 10000)
  try {
    const [code, signal] = await once(child, 'exit')
    assert.equal(authenticated, true, 'production runtime must authenticate before disconnect')
    assert.equal(prepared, true, 'the nonclosable window and beforeunload veto must be installed')
    assert.equal(signal, null, output)
    assert.equal(code, 0, output)
    assert.ok(Number.isInteger(ownedPort) && ownedPort > 0)
    const released = net.createServer()
    released.listen(ownedPort, '127.0.0.1')
    await once(released, 'listening')
    await new Promise(resolve => released.close(resolve))
    console.log('lifecycle: PASS (production runtime, host disconnect, nonclosable window, beforeunload veto, released port)')
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
