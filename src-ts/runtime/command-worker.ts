import { createRequire } from 'node:module'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

/** A fresh Node thread per command; no Electron imports and no child processes. */
if (parentPort) {
  const port = parentPort
  const { script, args } = workerData as { script: string, args: string[] }
  const requireScript = createRequire(path.join(process.cwd(), '__electron_rs_command__.cjs'))
  const scriptRequire = Object.assign((id: string) => {
    if (id === 'electron') throw new Error('Electron is only available in electron mode')
    return requireScript(id)
  }, requireScript)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

  port.postMessage({ kind: 'started' })
  // Returning from the body does not stop pending timers or change process.exitCode.
  // The owner waits for the real thread exit and both stdio pipes to finish.
  port.unref()
  void (async () => {
    try {
      await new AsyncFunction('args', 'signal', 'require', 'process', 'console', script)(
        args, new AbortController().signal, scriptRequire, process, console,
      )
    } catch (error) {
      process.exitCode = 1
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    }
  })().catch((error) => {
    // Bootstrap/message failures must not become an unobserved rejection.
    port.postMessage({ kind: 'failure', message: `command worker failed: ${error instanceof Error ? error.message : String(error)}` })
    process.exitCode = 1
  })
}
