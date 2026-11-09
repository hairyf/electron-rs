import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const binary = process.env.ELECTRON_RS_BINARY ?? require('electron')
const home = mkdtempSync(path.join(tmpdir(), 'electron-auth-host-'))
const fixture = fileURLToPath(new URL('../fixtures/authenticated-host.mjs', import.meta.url))
function run(extraEnv) {
  const env = { ...process.env, ...extraEnv, AUTHENTICATED_HOST_HOME: home }
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [fixture], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(Error('native host exceeded 25s')) }, 25000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}
function assertPass(output) {
  assert.equal(output.code, 0, output.stderr)
  assert.match(output.stderr, /native authenticated-host: PASS/)
  assert.doesNotMatch(output.stderr, /UnhandledPromiseRejection|navigate failed|MaxListenersExceededWarning/)
}
try {
  const first = await run({ AUTHENTICATED_HOST_PHASE: 'write' })
  assertPass(first)
  const announced = first.stderr.match(/^native: origin (\S+)$/m)
  assert.ok(announced, 'fixture must announce the origin shared by both launches')
  const port = new URL(announced[1]).port
  assert.notEqual(port, '')
  const second = await run({ AUTHENTICATED_HOST_PHASE: 'read', AUTHENTICATED_HOST_PORT: port })
  assertPass(second)
  console.log('native authenticated-host: PASS (persistent session survives relaunch)')
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
