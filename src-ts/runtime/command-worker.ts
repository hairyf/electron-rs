import { prepareCommand, runCommand } from './command-cli'
import { parentPort, workerData } from 'node:worker_threads'
import { types } from 'node:util'

/** A fresh Node thread per command; no Electron imports and no child processes. */
if (parentPort) {
  const port = parentPort
  const { args } = workerData as { args: string[] }

  port.postMessage({ kind: 'started' })
  // Returning from the body does not stop pending timers or change process.exitCode.
  // The owner waits for the real thread exit and both stdio pipes to finish.
  port.unref()
  void (async () => {
    try {
      const command = prepareCommand(args, 'node')
      process.argv = command.argv
      await runCommand(command, console)
    } catch (error) {
      process.exitCode = 1
      process.stderr.write(`${types.isNativeError(error) ? error.stack ?? error.message : String(error)}\n`)
    }
  })().catch((error) => {
    // Bootstrap/message failures must not become an unobserved rejection.
    port.postMessage({ kind: 'failure', message: `command worker failed: ${types.isNativeError(error) ? error.message : String(error)}` })
    process.exitCode = 1
  })
}
