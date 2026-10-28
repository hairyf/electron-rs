import fs from 'node:fs'
import Module, { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { isMainThread } from 'node:worker_threads'
import type { Console } from 'node:console'

export type Command =
  | { kind: 'version', argv: string[], version: string }
  | { kind: 'eval', argv: string[], source: string, print: boolean }
  | { kind: 'file', argv: string[], filename: string }

/** A deliberately small in-process CLI, not Node/Electron startup-option emulation. */
export function prepareCommand(args: string[], mode: 'node' | 'electron'): Command {
  const [first, ...rest] = args
  if (first === '-v' || first === '--version') {
    if (rest.length) throw new Error('version mode does not accept additional CLI arguments')
    const version = mode === 'node' ? process.versions.node : process.versions.electron
    if (!version) throw new Error('Electron version is unavailable outside an Electron host')
    return { kind: 'version', argv: [process.execPath], version: `v${version}` }
  }
  if (first === '-e' || first === '--eval' || first === '-p' || first === '--print') {
    if (!rest.length) throw new Error(`${first} requires JavaScript source`)
    const [source, ...scriptArgs] = rest
    if (scriptArgs[0] === '--') scriptArgs.shift()
    else if (scriptArgs[0]?.startsWith('-')) throw new Error(`unsupported CLI option: ${scriptArgs[0]} (use -- before script arguments)`)
    return { kind: 'eval', argv: [process.execPath, ...scriptArgs], source, print: first === '-p' || first === '--print' }
  }
  const fileArgs = first === '--' ? rest : args
  const [entry, ...scriptArgs] = fileArgs
  if (!entry || entry === '-') throw new Error('interactive/stdin execution is unsupported; use -e, -p, or a CommonJS entry file')
  if (first !== '--' && entry.startsWith('-')) throw new Error(`unsupported CLI option: ${entry}; startup flags and ESM are unsupported`)
  const absolute = path.resolve(entry)
  const filename = createRequire(path.join(process.cwd(), '__electron_rs_command__.cjs')).resolve(absolute)
  const extension = path.extname(filename)
  if (extension !== '.cjs' && extension !== '.js') throw new Error('unsupported CLI entry: only CommonJS .js/.cjs files and directories are supported; ESM is unsupported')
  if (extension === '.js') {
    for (let directory = path.dirname(filename);;) {
      const manifest = path.join(directory, 'package.json')
      if (fs.existsSync(manifest)) {
        if (JSON.parse(fs.readFileSync(manifest, 'utf8')).type === 'module') throw new Error('ESM CLI entries are unsupported; use a CommonJS .cjs file')
        break
      }
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return { kind: 'file', argv: [process.execPath, absolute, ...scriptArgs], filename }
}

export function runCommand(command: Command, console: Console, commandProcess = process): unknown {
  if (command.kind === 'version') { commandProcess.stdout.write(`${command.version}${process.platform === 'win32' ? '\r\n' : '\n'}`); return }
  const filename = command.kind === 'file' ? command.filename : path.join(process.cwd(), '[eval]')
  const entry = new Module(filename)
  entry.filename = filename
  entry.id = command.kind === 'file' ? '.' : '[eval]'
  const nativeRequire = createRequire(filename)
  const require = Object.assign((id: string) => {
    if (id === 'electron' && !isMainThread) throw new Error('Electron is only available in electron mode')
    return id === 'process' || id === 'node:process' ? commandProcess : nativeRequire(id)
  }, nativeRequire)
  require.main = entry
  entry.require = require
  entry.paths = nativeRequire.resolve.paths('__electron_rs_command__') ?? []
  const context = vm.createContext({
    Buffer, console, process: commandProcess, require, module: entry, exports: entry.exports,
    __filename: '[eval]', __dirname: '.',
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
    queueMicrotask, structuredClone, URL, URLSearchParams, TextEncoder, TextDecoder,
    AbortController, AbortSignal, fetch, Headers, Request, Response,
  })
  context.global = context
  if (command.kind === 'file') {
    // Native CommonJS wrapper/resolver, with a fresh entry (never require(entry)'s cache).
    // ponytail: dependencies retain the host cache/main module; full module-graph isolation needs a separate process.
    const source = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '').replace(/^#![^\r\n]*/, '')
    const wrapper = new vm.Script(Module.wrap(source), { filename }).runInContext(context)
    wrapper.call(entry.exports, entry.exports, require, entry, filename, path.dirname(filename))
    entry.loaded = true
    return
  }
  const value = new vm.Script(command.source, { filename: '[eval]' }).runInContext(context)
  if (command.print) console.log(value)
  return value
}
