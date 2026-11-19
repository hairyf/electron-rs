import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'

function nativeTheme() {
  let value = 'system'
  return {
    writes: [],
    get themeSource() { return value },
    set themeSource(next) { value = next; this.writes.push(next) },
    shouldUseDarkColors: false,
    shouldUseHighContrastColors: false,
  }
}

function processes(outputs) {
  const reads = [], watchers = []
  return {
    reads,
    watchers,
    outputs,
    read(command) {
      reads.push(command)
      const output = outputs[command]
      return output instanceof Error ? Promise.reject(output) : Promise.resolve(output ?? '')
    },
    watch(command, args, onData, onEnd) {
      const watcher = { command, args, onData, onEnd, stopped: false }
      watchers.push(watcher)
      return () => { watcher.stopped = true }
    },
  }
}

const { portalScheme, settingsScheme, SystemTheme } = createRequire(import.meta.url)('../../assets/runtime/native/system-theme.cjs')

assert.equal(portalScheme('v u 1\n'), 'dark')
assert.equal(portalScheme('v u 2\n'), 'light')
assert.equal(portalScheme('v u 0\n'), null)
assert.equal(portalScheme('garbage'), null)
assert.equal(portalScheme(''), null)
assert.equal(settingsScheme("'prefer-dark'\n"), 'dark')
assert.equal(settingsScheme('"prefer-light"'), 'light')
assert.equal(settingsScheme("'default'\n"), null)
assert.equal(settingsScheme('garbage'), null)

for (const [raw, expected] of [['v u 1\n', 'dark'], ['v u 2\n', 'light']]) {
  const theme = nativeTheme(), bus = processes({ busctl: raw })
  const system = new SystemTheme(theme, bus)
  system.start()
  await sleep(5)
  assert.deepEqual(theme.writes, [expected], 'portal color-scheme maps onto the native theme')
  system.dispose()
  assert.equal(bus.watchers[0].stopped, true, 'disposing releases the portal subscription')
}

{
  // issue #1577：带 SERVICE 位置参数时 systemd 262 会忽略 --match、按 peer 全量订阅，
  // 与主题无关的 portal 流量全灌进主进程，空闲也要 ~2% CPU。过滤必须在 --match 上，
  // 且不能再出现位置参数。
  const theme = nativeTheme(), bus = processes({ busctl: 'v u 1\n' })
  const system = new SystemTheme(theme, bus)
  system.start()
  await sleep(5)
  const args = bus.watchers[0].args
  assert.deepEqual(args, [
    '--user',
    '--match',
    "type='signal',interface='org.freedesktop.portal.Settings',member='SettingChanged'",
    'monitor',
  ], 'the portal subscription filters in the kernel instead of draining the whole peer')
  assert.ok(!args.includes('org.freedesktop.portal.Desktop'), 'no SERVICE positional argument, or --match is ignored')
  system.dispose()
}

{
  const theme = nativeTheme(), bus = processes({ busctl: 'v u 0\n', gsettings: "'prefer-light'\n" })
  const system = new SystemTheme(theme, bus)
  system.start()
  await sleep(5)
  assert.deepEqual(bus.reads, ['busctl', 'gsettings'], 'no-preference falls through to gsettings')
  assert.deepEqual(theme.writes, ['light'])
  system.dispose()
}

{
  const theme = nativeTheme(), bus = processes({ busctl: new Error('portal unavailable'), gsettings: "'prefer-dark'\n" })
  const system = new SystemTheme(theme, bus)
  system.start()
  await sleep(5)
  assert.deepEqual(theme.writes, ['dark'], 'a parse failure degrades to the gsettings fallback')
  system.dispose()
}

{
  const theme = nativeTheme(), bus = processes({ busctl: new Error('no portal'), gsettings: new Error('no dconf') })
  const system = new SystemTheme(theme, bus)
  system.start()
  await sleep(5)
  assert.deepEqual(theme.writes, [], 'a missing portal and dconf keep the system source without a redundant write')
  bus.watchers[0].onEnd(false)
  await sleep(2_100)
  assert.equal(bus.reads.length, 2, 'a busctl that cannot spawn never starts the two-second poll')
  system.dispose()
}

{
  const theme = nativeTheme(), bus = processes({ busctl: 'v u 1\n' })
  const system = new SystemTheme(theme, bus)
  system.start()
  await sleep(5)
  bus.watchers[0].onData('SettingsChanged org.freedesktop.appearance color-scheme uint32 1\n')
  await sleep(5)
  assert.deepEqual(theme.writes, ['dark'], 'a repeated identical portal value must not write again')
  system.dispose()
}

{
  // 键名被 chunk 边界劈成两半时仍要认出这次变更，否则一次真实切换会漏掉。
  // 读取值跟着变，才能区分「认出了信号」和「认不出」：认不出就只会保持 dark。
  const theme = nativeTheme(), bus = processes({ busctl: 'v u 1\n' })
  const system = new SystemTheme(theme, bus)
  system.start()
  await sleep(5)
  bus.outputs.busctl = 'v u 2\n'
  bus.watchers[0].onData('SettingsChanged org.freedesktop.appearance color-sch')
  bus.watchers[0].onData('eme uint32 2\n')
  await sleep(5)
  assert.deepEqual(theme.writes, ['dark', 'light'], 'a signal split across chunks still triggers a re-read')
  system.dispose()
}

{
  // 无关的 portal 流量不该触发重读：那正是 issue #1577 里被灌满主线程的东西。
  const theme = nativeTheme(), bus = processes({ busctl: 'v u 1\n' })
  const system = new SystemTheme(theme, bus)
  system.start()
  await sleep(5)
  bus.outputs.busctl = 'v u 2\n'
  bus.watchers[0].onData('member=NameOwnerChanged path=/org/freedesktop/portal/desktop\n')
  await sleep(5)
  assert.deepEqual(bus.reads, ['busctl'], 'an unrelated portal signal must not trigger a re-read')
  system.dispose()
}

{
  const theme = nativeTheme(), bus = processes({ busctl: 'v u 2\n' })
  const system = new SystemTheme(theme, bus)
  system.start()
  await sleep(5)
  assert.deepEqual(theme.writes, ['light'])
  system.set('dark')
  bus.watchers[0].onData('SettingsChanged org.freedesktop.appearance color-scheme uint32 2\n')
  await sleep(5)
  assert.deepEqual(theme.writes, ['light', 'dark'], 'an explicit preference is never overwritten by the portal')
  system.set('system')
  await sleep(5)
  assert.deepEqual(theme.writes, ['light', 'dark', 'light'], 'returning to system resumes following the portal')
  system.dispose()
}

{
  const theme = nativeTheme()
  const bus = processes({ busctl: new Error('no portal'), gsettings: new Error('no dconf') })
  const system = new SystemTheme(theme, bus)
  system.start()
  await sleep(5)
  system.set('dark')
  await sleep(5)
  system.set('system')
  await sleep(5)
  assert.deepEqual(theme.writes, ['dark'], 'an unreachable portal never rewrites the active source')
  assert.equal(theme.themeSource, 'dark', 'the active source survives an unreachable portal')
  system.dispose()
}

{
  const theme = nativeTheme(), bus = processes({ busctl: 'v u 1\n' })
  const system = new SystemTheme(theme, bus)
  system.start()
  await sleep(5)
  bus.watchers[0].onEnd(true)
  await sleep(2_100)
  assert.deepEqual(theme.writes, ['dark'], 'the poll re-reads an unchanged portal value without writing')
  system.dispose()
  await sleep(50)
  assert.equal(theme.writes.length, 1, 'disposing clears the poll timer')
}

{
  const theme = nativeTheme(), bus = processes({ busctl: 'v u 1\n' })
  const system = new SystemTheme(theme, bus)
  system.start()
  system.start()
  await sleep(5)
  assert.equal(bus.watchers.length, 1, 'start is idempotent')
  system.dispose()
  bus.watchers[0].onData('SettingsChanged org.freedesktop.appearance color-scheme uint32 2\n')
  await sleep(5)
  assert.deepEqual(theme.writes, ['dark'], 'a disposed watcher never writes again')
}

{
  // runtime-modules 之类的 fixture 用 mock 的 electron 加载这份产物，那里没有 nativeTheme。
  // 构造和 start 都必须安全空转，否则整个 runtime 模块在 CI 上起不来（#1577 排查时踩到）。
  const bus = processes({ busctl: 'v u 1\n' })
  const system = new SystemTheme(undefined, bus)
  system.start()
  system.set('dark')
  system.set('system')
  await sleep(5)
  assert.deepEqual(bus.reads, [], 'a missing nativeTheme must not read or write anything')
  assert.equal(bus.watchers.length, 0, 'a missing nativeTheme must not subscribe to the portal')
  system.dispose()
}

console.log('system-theme: PASS')
