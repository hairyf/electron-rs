// Execute generated main startup with native APIs mocked; no Electron process or socket.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import vm from 'node:vm'
import { createRuntime } from '../fixtures/runtime-modules.mjs'

async function run(alreadyReady, platform) {
  const fixtureName = platform === 'linux' ? 'Startup Fixture Nightly' : 'Startup Fixture'
  let isReady = alreadyReady, resolveReady, screenReads = 0, appName = ''
  const readiness = new Promise(resolve => { resolveReady = resolve })
  if (alreadyReady) resolveReady()
  const order = [], messages = []
  const initialized = name => { assert.ok(isReady, `${name} before app readiness`); order.push(name) }
  const expected = ['app-id', 'menu', 'completed', 'error', 'navigation', 'download', 'permission']
  if (platform === 'linux') expected.unshift('desktop-name')
  const display = {
    label: 'Startup display', scaleFactor: 2,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    workArea: { x: 0, y: 0, width: 800, height: 580 },
  }
  const readScreen = () => {
    assert.ok(isReady, "The 'screen' module can't be used before the app 'ready' event")
    screenReads++
    return display
  }
  const defaultSession = {
    webRequest: {
      onCompleted: () => initialized('completed'),
      onErrorOccurred: () => initialized('error'),
      onBeforeRequest: () => initialized('navigation'),
    },
    on: event => { assert.equal(event, 'will-download'); initialized('download') },
    setPermissionRequestHandler: () => initialized('permission'),
  }
  const electron = {
    app: Object.assign(new EventEmitter(), {
      whenReady: () => readiness,
      setName: name => { appName = name },
      getName: () => appName,
      setDesktopName: name => {
        assert.equal(name, `${fixtureName}.desktop`, 'desktop name must be the app name plus the .desktop suffix')
        assert.ok(!isReady, 'desktop name must be set before app readiness')
        order.push('desktop-name')
      },
      setAppUserModelId: id => { assert.equal(id, 'startup.regression'); initialized('app-id') },
      quit: () => assert.fail('startup unexpectedly quit'),
    }),
    ipcMain: Object.assign(new EventEmitter(), { handle() {} }),
    Menu: { setApplicationMenu: menu => { assert.equal(menu, null); initialized('menu') } },
    nativeTheme: {},
    protocol: { registerSchemesAsPrivileged() {} },
    session: { get defaultSession() { assert.ok(isReady); return defaultSession } },
    screen: { getAllDisplays: () => [readScreen()], getPrimaryDisplay: readScreen },
  }
  const context = vm.createContext({
    console,
    process: {
      argv: ['node', 'main.cjs', '--port', '1', '--tauri-identifier', 'startup.regression'],
      env: platform === 'linux' ? { ELECTRON_RS_APP_NAME: fixtureName } : {},
      platform,
      versions: { electron: 'startup-fixture' },
    },
  })
  const runtime = createRuntime(context, electron, { send(message) {
    if (message.event === 'ready') {
      assert.deepEqual(order, expected, 'all initialization must finish before the handshake')
      order.push('ready')
    }
    messages.push(structuredClone(message))
  } })
  if (platform === 'linux') assert.equal(electron.app.getName(), fixtureName, 'app name must come from the injected environment')
  if (alreadyReady) await setImmediate()
  else assert.throws(() => electron.screen.getAllDisplays(), /before the app 'ready' event/)

  runtime.ipc.emit('connect')
  await setImmediate()
  if (!alreadyReady) {
    assert.deepEqual(messages, [], 'socket connect must not advertise readiness early')
    assert.deepEqual(order, platform === 'linux' ? ['desktop-name'] : [], 'initialization must wait for app readiness')
    isReady = true
    resolveReady()
    await setImmediate()
  }
  assert.deepEqual(messages, [{ event: 'ready', params: { electron: 'startup-fixture', token: '0123456789abcdef'.repeat(4) } }])
  assert.deepEqual(order, [...expected, 'ready'])
  assert.equal(screenReads, 0)
  runtime.ipc.emit('request', { id: 1, method: 'window.displays' }, false)
  const result = {
    name: 'Startup display', position: { x: 0, y: 0, width: 1600, height: 1200 },
    size: { width: 1600, height: 1200 },
    workArea: { position: { x: 0, y: 0, width: 1600, height: 1160 }, size: { width: 1600, height: 1160 } },
    scaleFactor: 2,
  }
  assert.deepEqual(messages[1], { id: 1, result: { displays: [result], primary: result } })
  assert.equal(screenReads, 2)
  await setImmediate()
  assert.equal(messages.filter(message => message.event === 'ready').length, 1, 'exactly one authenticated handshake')
}
for (const alreadyReady of [false, true]) await run(alreadyReady, 'darwin')
await run(false, 'linux')
console.log('startup: PASS (generated main, delayed/already-ready app, initialization before authenticated handshake, screen RPC, linux desktop name)')
