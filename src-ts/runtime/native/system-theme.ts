import { execFile, spawn } from 'node:child_process'
import type { NativeTheme } from 'electron'

export type ThemePreference = 'system' | 'dark' | 'light'
export type ColorScheme = 'dark' | 'light'

export interface ThemeProcesses {
  read(command: string, args: readonly string[]): Promise<string>
  watch(command: string, args: readonly string[], onData: (chunk: string) => void, onEnd: (recoverable: boolean) => void): () => void
}

const POLL_INTERVAL_MS = 2_000
const PORTAL_READ: string[] = ['--user', 'call', 'org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.Settings', 'ReadOne', 'ss', 'org.freedesktop.appearance', 'color-scheme']
const PORTAL_MONITOR: string[] = ['--user', 'monitor', 'org.freedesktop.portal.Desktop']
const PORTAL_SIGNAL = 'color-scheme'
const SETTINGS_READ: string[] = ['get', 'org.gnome.desktop.interface', 'color-scheme']

export const systemProcesses: ThemeProcesses = {
  read(command, args) {
    return new Promise((resolve, reject) => {
      execFile(command, [...args], { timeout: 1_000, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))
    })
  },
  watch(command, args, onData, onEnd) {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', onData)
    child.once('error', () => onEnd(false))
    child.once('exit', () => onEnd(true))
    return () => {
      child.stdout?.removeAllListeners()
      child.removeAllListeners()
      child.kill()
    }
  },
}

export function portalScheme(output: string): ColorScheme | null {
  const value = Number(/(\d+)\s*$/.exec(output)?.[1])
  return value === 1 ? 'dark' : value === 2 ? 'light' : null
}

export function settingsScheme(output: string): ColorScheme | null {
  const value = output.trim().replace(/['"]/g, '')
  return value === 'prefer-dark' ? 'dark' : value === 'prefer-light' ? 'light' : null
}

/**
 * 主题源唯一写入点。Linux 上 Chromium 既不跟 org.freedesktop.portal.Settings 的
 * color-scheme，也不跟 gsettings，GTK_THEME=Adwaita:dark 之类的环境变量还会把它钉死，
 * 所以主进程自己读门户、自己写 nativeTheme.themeSource（issue #1509）。
 */
export class SystemTheme {
  private preference: ThemePreference
  private watching = false
  private disposed = false
  private reading = false
  private rerun = false
  private stop?: () => void
  private timer?: NodeJS.Timeout

  constructor(private readonly nativeTheme: NativeTheme, private readonly processes: ThemeProcesses = systemProcesses) {
    this.preference = nativeTheme.themeSource as ThemePreference
  }

  start(): void {
    if (this.watching || this.disposed) return
    this.watching = true
    this.sync()
    this.stop = this.processes.watch('busctl', PORTAL_MONITOR, (chunk) => { if (chunk.includes(PORTAL_SIGNAL)) this.sync() }, (recoverable) => {
      if (recoverable) this.poll()
      else this.watching = false
    })
  }

  set(preference: ThemePreference): void {
    this.preference = preference
    if (preference !== 'system') this.write(preference)
    else if (this.watching) this.sync()
    else this.write('system')
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.stop?.()
    this.stop = undefined
  }

  private sync(): void {
    if (this.disposed || this.preference !== 'system') return
    if (this.reading) {
      this.rerun = true
      return
    }
    this.reading = true
    void this.processes.read('busctl', PORTAL_READ)
      .then(portalScheme, () => null)
      .then(scheme => scheme ?? this.processes.read('gsettings', SETTINGS_READ).then(settingsScheme, () => null))
      .then((scheme) => {
        this.reading = false
        if (!this.disposed && this.preference === 'system') this.write(scheme ?? 'system')
        if (this.rerun) {
          this.rerun = false
          this.sync()
        }
      })
  }

  private poll(): void {
    if (this.disposed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.sync()
      this.poll()
    }, POLL_INTERVAL_MS)
    this.timer.unref()
  }

  private write(target: ThemePreference): void {
    if (this.nativeTheme.themeSource === target) return
    this.nativeTheme.themeSource = target
  }
}
