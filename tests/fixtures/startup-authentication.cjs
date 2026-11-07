const { app } = require('electron')
const { writeSync } = require('node:fs')
app.setPath('userData', process.env.ELECTRON_STARTUP_AUTH_HOME)
require('../../assets/main.cjs')
app.whenReady().then(() => queueMicrotask(() => {
  writeSync(2, 'startup-authentication: busy start\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200)
  writeSync(2, 'startup-authentication: busy end\n')
}))
