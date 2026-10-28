// Run after the parent builds assets. The supervisor catches leaked workers and accidental host exits.
import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const self = fileURLToPath(import.meta.url)
const success = 'commands: PASS'
const hostOut = ['host-before', 'host-during', 'host-after']
const hostErr = ['host-error-before', 'host-error-during', 'host-error-after']

function deadline(promise, label, ms = 4_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${label} exceeded ${ms}ms`), { code: 'CHECK_DEADLINE' })), ms) }),
  ]).finally(() => clearTimeout(timer))
}

async function until(predicate, label) {
  const end = performance.now() + 3_000
  while (!predicate()) {
    assert.ok(performance.now() < end, `${label} did not arrive`)
    await sleep(5)
  }
}

function nodeProcess(args, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const stdout = [], stderr = []
    let expired = false, size = 0
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL') }, timeoutMs)
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        chunks.push(chunk)
        size += chunk.length
        if (size > 2 * 1024 * 1024) { expired = true; child.kill('SIGKILL') }
      })
    }
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (expired) reject(new Error(`Node check exceeded its ${timeoutMs}ms deadline or output limit`))
      else resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  })
}

const bodyArgs = (script, args = []) => ['-e', `(async function(args) { ${script}\n })(process.argv.slice(1))`, '--', ...args]

async function reference(script, args = []) {
  // A real Node process is the output oracle, never a mock of the executor.
  const result = await nodeProcess(['-e', `
    const args = ${JSON.stringify(args)};
    (async function(args) { ${script}\n })(args).catch(error => {
      console.error(error && error.stack || String(error)); process.exitCode = 1;
    });
  `])
  // The wire code is Rust i32, matching Output.status.code()
  // (std::process::ExitStatus), while Node exposes Windows exit DWORDs unsigned.
  return { ...result, code: process.platform === 'win32' ? (result.code | 0) : result.code }
}

function bytes(value, label) {
  assert.equal(typeof value, 'string', `${label} must be base64`)
  const decoded = Buffer.from(value, 'base64')
  assert.equal(decoded.toString('base64'), value, `${label} must be canonical base64`)
  return decoded
}

// Error locations differ between an async-function body and Node's -e wrapper.
const withoutFrames = buffer => buffer.toString('utf8').replace(/^\s+at .*\r?\n?/gm, '')

async function checks() {
  const write = (stream, text) => deadline(new Promise((resolve, reject) => {
    process[stream].write(text + '\n', error => error ? reject(error) : resolve())
  }), `host ${stream} write`)
  const saved = { exitCode: process.exitCode, argv: process.argv, argvValue: [...process.argv] }
  await write('stdout', hostOut[0])
  await write('stderr', hostErr[0])
  const { Executions } = createRequire(import.meta.url)('../../assets/runtime/execution.cjs')
  assert.equal(typeof Executions, 'function', 'generated execution.cjs must export Executions')
  let nextId = 0
  const events = [], completed = new Set(), closeHandlers = []
  const transport = {
    send(event, params) { events.push({ event, params: structuredClone(params), afterResult: completed.has(params.taskId) }) },
    onClose(handler) { closeHandlers.push(handler) },
  }
  const service = new Executions(transport)
  const chunksFor = taskId => events.filter(entry => entry.event === 'command.output' && entry.params.taskId === taskId)
    .flatMap(entry => entry.params.chunks)
  const cli = (mode, args, overrides = {}) => {
    const taskId = `command-check-${++nextId}`
    const promise = deadline(Promise.resolve().then(() => service.execute({
      taskId, mode, args, maxOutputBytes: 256 * 1024, stream: false, ...overrides,
    })), taskId).then(result => {
      completed.add(taskId)
      assert.ok(result && typeof result === 'object', `${taskId}: output object`)
      assert.deepEqual(Object.keys(result).sort(), ['code', 'stderr', 'stdout'], `${taskId}: output-only wire contract`)
      assert.ok(Number.isInteger(result.code), `${taskId}: integer exit code`)
      bytes(result.stdout, `${taskId} stdout`)
      bytes(result.stderr, `${taskId} stderr`)
      return result
    })
    // Attach immediately: concurrent jobs may reject before their turn is awaited.
    promise.catch(() => {})
    return { taskId, promise }
  }
  const start = (mode, script, { args = [], ...overrides } = {}) => cli(mode, bodyArgs(script, args), overrides)
  const streamed = (taskId, result) => {
    const entries = events.filter(entry => entry.params.taskId === taskId)
    assert.ok(entries.length > 0, `${taskId}: output events`)
    assert.ok(entries.every(entry => entry.event === 'command.output' && !entry.afterResult), `${taskId}: flush events before result`)
    const chunks = chunksFor(taskId)
    assert.ok(chunks.length > 0, `${taskId}: nonempty chunks`)
    assert.deepEqual(chunks.map(chunk => chunk.sequence), chunks.map((_, index) => index), `${taskId}: contiguous per-task sequences from zero`)
    for (const chunk of chunks) {
      assert.ok(['stdout', 'stderr'].includes(chunk.stream), `${taskId}: valid stream`)
      bytes(chunk.data, `${taskId} chunk`)
    }
    for (const stream of ['stdout', 'stderr']) {
      assert.deepEqual(Buffer.concat(chunks.filter(chunk => chunk.stream === stream).map(chunk => bytes(chunk.data, 'chunk'))), bytes(result[stream], stream), `${taskId}: streamed ${stream} reconstructs final bytes`)
    }
  }
  try {
    // Public CLI requests are compared directly to Node, with no AsyncFunction-body adapter.
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'electron-rs-cli-'))
    try {
      await mkdir(path.join(fixture, 'package'))
      await mkdir(path.join(fixture, 'esm'))
      await writeFile(path.join(fixture, 'package', 'package.json'), JSON.stringify({ type: 'commonjs', main: 'entry.js' }))
      await writeFile(path.join(fixture, 'package', 'relative.cjs'), `module.exports = { value: 'relative require', argv: () => require('node:process').argv };`)
      const entry = path.join(fixture, 'package', 'entry.js')
      const source = `const relative = require('./relative.cjs'); console.log(JSON.stringify({ argv: process.argv, requiredArgv: relative.argv(), filename: __filename, dirname: __dirname, value: relative.value, moduleRequire: module.require('./relative.cjs').value, main: require.main === module }));`
      await writeFile(entry, source)
      const cjs = path.join(fixture, 'entry.cjs')
      await writeFile(cjs, `console.log(JSON.stringify({ argv: process.argv, filename: __filename, dirname: __dirname }));`)
      await writeFile(path.join(fixture, 'esm', 'package.json'), '{"type":"module"}')
      await writeFile(path.join(fixture, 'esm', 'entry.js'), 'export default 1')
      const mjs = path.join(fixture, 'entry.mjs')
      await writeFile(mjs, 'export default 1')
      const publicCases = [
        ['-e', 'console.log(JSON.stringify(process.argv))', 'plain', 'two words'],
        ['--eval', `console.log(JSON.stringify({ argv: require('node:process').argv, filename: __filename, dirname: __dirname }))`, '--', '--script-flag', '中文'],
        ['-p', '6 * 7'], ['--print', `({ a: 1, text: 'two' })`],
        ['-e', `setTimeout(() => console.log('natural timer'), 20)`],
        ['-e', `(async () => { await new Promise(resolve => setTimeout(resolve, 20)); console.log('IIFE finished') })()`],
        ['-e', `require('node:fs').readFile(${JSON.stringify(cjs)}, (error, data) => { if (error) throw error; console.log(data.toString().length) })`],
        ['-v'], ['--version'], [entry, 'script', '--flag'], [cjs, '', 'words'],
        [path.join(fixture, 'package'), '--arg'], ['--', entry, '--arg'],
      ]
      for (const argv of publicCases) {
        const expected = await nodeProcess(argv)
        for (const mode of ['node', 'electron']) {
          // This check host is Node; Electron's version and actual host PID are checked by real_commands.
          if (mode === 'electron' && (argv[0] === '-v' || argv[0] === '--version')) continue
          const actual = await cli(mode, argv).promise
          assert.equal(actual.code, expected.code, `${mode} ${argv[0]}: native CLI exit code`)
          assert.deepEqual(bytes(actual.stdout, 'stdout'), expected.stdout, `${mode} ${argv[0]}: native CLI stdout`)
          assert.deepEqual(bytes(actual.stderr, 'stderr'), expected.stderr, `${mode} ${argv[0]}: native CLI stderr`)
        }
      }
      for (const mode of ['node', 'electron']) {
        for (let invocation = 0; invocation < 2; invocation++) {
          const actual = await cli(mode, [entry, String(invocation)]).promise
          assert.equal(JSON.parse(bytes(actual.stdout, 'stdout')).argv[2], String(invocation), `${mode}: repeated file entry executes again`)
        }
        for (const argv of [[], ['-'], ['--inspect'], ['--input-type=module', '-e', '1'], ['--unknown'], ['-e'], ['-p'], ['-v', '--inspect'], [mjs], [path.join(fixture, 'esm', 'entry.js')]]) {
          const actual = await cli(mode, argv).promise
          assert.notEqual(actual.code, 0, `${mode}: unsupported input fails explicitly`)
          assert.match(bytes(actual.stderr, 'stderr').toString(), /unsupported|requires|does not accept/i)
        }
        for (const source of ['return 1', 'await Promise.resolve(1)']) {
          const actual = await cli(mode, ['-e', source]).promise
          assert.equal(actual.code, 1, `${mode}: eval is a script, not an async function body`)
          assert.match(bytes(actual.stderr, 'stderr').toString(), /SyntaxError/)
        }
      }
      const argvJobs = ['one', 'two', 'three'].map(token => cli('electron', ['-e', `(async () => { const native = require('node:process'); await new Promise(resolve => setTimeout(resolve, 30)); console.log(JSON.stringify([process.argv, native.argv])); })()`, '--', token]))
      for (const [index, job] of argvJobs.entries()) {
        const actual = await job.promise
        assert.deepEqual(JSON.parse(bytes(actual.stdout, 'stdout')), [[process.execPath, ['one', 'two', 'three'][index]], [process.execPath, ['one', 'two', 'three'][index]]], 'overlapping main CLI argv stays task-local')
      }
      assert.equal(process.argv, saved.argv, 'main CLI preserves host argv identity')
      assert.deepEqual(process.argv, saved.argvValue, 'main CLI preserves host argv contents')
      const requiredProcess = await cli('electron', ['-e', `const native = require('node:process'); native.exitCode = 17; console.log(native.argv[1]);`, '--', 'process facade']).promise
      assert.equal(requiredProcess.code, 17)
      assert.equal(bytes(requiredProcess.stdout, 'stdout').toString(), 'process facade\n')
      assert.equal(process.exitCode, saved.exitCode, 'required process exitCode cannot alter host')
      const moduleExit = await cli('electron', ['-e', `console.log('required process exit'); require('node:process').exit(9)`]).promise
      assert.equal(moduleExit.code, 9, 'required process exit is task-scoped')
      assert.equal(bytes(moduleExit.stdout, 'stdout').toString(), 'required process exit\n')
    } finally { await rm(fixture, { recursive: true, force: true }) }

    // Legacy body checks keep their semantics through a test-only -e IIFE adapter.
    const cases = [
      ['text', `console.log('hello'); console.error('error text'); return { ok: true };`],
      ['console formatting', `console.log('%s %d %j', 'value', 12, { a: 1 }); console.dir({ list: [1, 'two'], nested: { yes: true } }); console.warn('warn', null, undefined, { value: 3 }); return null;`],
      ['no newline', `process.stdout.write('left'); process.stdout.write('right', 'utf8'); process.stderr.write('err'); return null;`],
      ['raw bytes', `process.stdout.write(Buffer.from([0, 255, 128, 195, 40, 10])); process.stderr.write(new Uint8Array([254, 0, 129, 13])); process.stdout.write('ff00', 'hex'); return null;`],
    ]
    for (const [name, script] of cases) {
      const expected = await reference(script)
      for (const mode of ['node', 'electron']) {
        const { taskId, promise } = start(mode, script)
        const actual = await promise
        assert.equal(actual.code, expected.code, `${mode} ${name}: exit code`)
        assert.deepEqual(bytes(actual.stdout, 'stdout'), expected.stdout, `${mode} ${name}: direct Node stdout`)
        assert.deepEqual(bytes(actual.stderr, 'stderr'), expected.stderr, `${mode} ${name}: direct Node stderr`)
        assert.equal(chunksFor(taskId).length, 0, 'stream:false does not emit command.output')
      }
    }

    // Observe timer allocation synchronously; the test safety deadline is installed afterward.
    const shortTimeout = 25
    for (const mode of ['node', 'electron']) {
      for (const timeoutMs of [undefined, null, shortTimeout]) {
        const taskId = `deadline-check-${++nextId}`
        const scheduled = []
        const hook = createHook({ init(_id, kind, _trigger, resource) {
          if (kind === 'Timeout') scheduled.push(resource._idleTimeout)
        } })
        let pending
        hook.enable()
        try {
          pending = service.execute({
            taskId, mode, args: bodyArgs(`await new Promise(resolve => setTimeout(resolve, ${shortTimeout * 4})); process.stdout.write('completed without a deadline');`),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          })
        } finally { hook.disable() }
        pending.catch(() => {})
        assert.deepEqual(scheduled, timeoutMs == null ? [] : [shortTimeout], `${mode}: null/omitted timeout allocates no deadline timer`)
        const actual = await deadline(pending, `${mode} timeout ${timeoutMs}`)
        assert.deepEqual(Object.keys(actual).sort(), ['code', 'stderr', 'stdout'])
        assert.equal(actual.code, timeoutMs == null ? 0 : 124)
        assert.equal(bytes(actual.stdout, 'stdout').toString(), timeoutMs == null ? 'completed without a deadline' : '')
        assert.equal(bytes(actual.stderr, 'stderr').length, 0)
      }
      for (const timeoutMs of [0, -1, 0.5, Infinity, -Infinity, NaN, 2147483648, '25', false, {}]) {
        await assert.rejects(start(mode, '', { timeoutMs }).promise, /invalid command.execute parameters/, `${mode}: invalid timeout ${timeoutMs}`)
      }
      assert.equal((await start(mode, '', { timeoutMs: 2147483647 }).promise).code, 0, 'maximum explicit deadline is accepted')
    }

    for (const returned of [
      `(() => { const value = {}; value.self = value; return value })()`,
      `1n`,
      `({ nested: 1n })`,
      `({ toJSON() { throw new Error('return values must never be serialized') } })`,
    ]) {
      const script = `process.stdout.write('written stdout'); process.stderr.write('written stderr'); return ${returned};`
      const expected = await reference(script)
      for (const mode of ['node', 'electron']) {
        const job = start(mode, script, { stream: true })
        const actual = await job.promise
        assert.equal(actual.code, 0, `${mode}: non-JSON return is ignored`)
        assert.deepEqual(bytes(actual.stdout, 'stdout'), expected.stdout, `${mode}: return does not pollute stdout`)
        assert.deepEqual(bytes(actual.stderr, 'stderr'), expected.stderr, `${mode}: return does not pollute stderr`)
        streamed(job.taskId, actual)
      }
    }

    const args = ['', 'spaces and quotes " \'', '中文', '\u0000', '--flag']
    for (const mode of ['node', 'electron']) {
      const actual = await start(mode, `process.stdout.write(JSON.stringify({ args, value: [1, true, null, { text: 'json' }] }));`, { args }).promise
      assert.equal(actual.code, 0)
      assert.deepEqual(JSON.parse(bytes(actual.stdout, 'stdout').toString()), { args, value: [1, true, null, { text: 'json' }] })
      const identity = await start(mode, `const { isMainThread, threadId } = require('node:worker_threads'); process.stdout.write(JSON.stringify({ pid: process.pid, isMainThread, threadId }));`).promise
      const thread = JSON.parse(bytes(identity.stdout, 'stdout').toString())
      assert.equal(thread.pid, process.pid, `${mode}: no child process`)
      assert.equal(thread.isMainThread, mode === 'electron', `${mode}: required execution thread`)
      assert.equal(thread.threadId === 0, mode === 'electron')
    }

    for (const script of [
      `process.stdout.write('before exit'); process.exitCode = 7; return 'exit-code';`,
      `await new Promise(resolve => process.stdout.write('before worker exit', resolve)); process.exit(9);`,
      `setTimeout(() => { process.stdout.write('late timer'); process.stderr.write('late error'); }, 40); return 'body finished';`,
    ]) {
      const expected = await reference(script)
      const actual = await start('node', script).promise
      assert.equal(actual.code, expected.code, 'worker natural/explicit exit code matches Node')
      assert.deepEqual(bytes(actual.stdout, 'stdout'), expected.stdout, 'worker timers finish naturally')
      assert.deepEqual(bytes(actual.stderr, 'stderr'), expected.stderr)
    }
    // Derive platform exit-status normalization from real Node, including boundary values.
    const exitMismatches = []
    for (const value of [-1, 255, 256, 257]) {
      for (const action of [`process.exitCode = ${value}`, `process.exit(${value})`]) {
        const script = `await new Promise(resolve => process.stdout.write('exit-boundary', resolve)); ${action}; return null;`
        const expected = await reference(script)
        for (const mode of ['node', 'electron']) {
          const actual = await start(mode, script).promise
          if (actual.code !== expected.code) exitMismatches.push({ mode, action, expected: expected.code, actual: actual.code })
          assert.deepEqual(bytes(actual.stdout, 'stdout'), expected.stdout, `${mode} ${action}: direct Node stdout`)
          assert.deepEqual(bytes(actual.stderr, 'stderr'), expected.stderr, `${mode} ${action}: direct Node stderr`)
          assert.equal(process.exitCode, saved.exitCode, `${mode} ${action}: host exitCode restored`)
        }
      }
    }
    assert.deepEqual(exitMismatches, [], 'exit status must match direct Node on this platform')

    const thrown = `process.stdout.write('before throw'); throw new Error('command-check thrown marker');`
    const expectedError = await reference(thrown)
    for (const mode of ['node', 'electron']) {
      const actual = await start(mode, thrown).promise
      assert.equal(actual.code, expectedError.code, `${mode}: thrown body is unsuccessful`)
      assert.deepEqual(bytes(actual.stdout, 'stdout'), expectedError.stdout)
      assert.equal(withoutFrames(bytes(actual.stderr, 'stderr')), withoutFrames(expectedError.stderr), `${mode}: direct Node error text excluding stack locations`)
    }

    for (const mode of ['node', 'electron']) {
      const job = start(mode, `process.stdout.write(Buffer.from([0, 255, 195])); await new Promise(resolve => setTimeout(resolve, 350)); process.stderr.write(Buffer.from([128, 10])); process.stdout.write('tail'); return { done: true };`, { stream: true })
      let finished = false
      job.promise.finally(() => { finished = true }).catch(() => {})
      await until(() => chunksFor(job.taskId).length > 0 || finished, `${mode} first live chunk`)
      assert.equal(finished, false, `${mode}: first chunk must arrive BEFORE completion`)
      const result = await job.promise
      assert.equal(result.code, 0)
      assert.deepEqual(bytes(result.stdout, 'stdout'), Buffer.from([0, 255, 195, 116, 97, 105, 108]))
      assert.deepEqual(bytes(result.stderr, 'stderr'), Buffer.from([128, 10]))
      streamed(job.taskId, result)
      const count = chunksFor(job.taskId).length
      await sleep(40)
      assert.equal(chunksFor(job.taskId).length, count, 'no output events after result')
    }

    // Four overlapping jobs exercise async-local routing in both directions.
    const concurrent = ['node', 'electron', 'node', 'electron'].map((mode, index) => {
      const token = `job-${index}-${mode}`
      return { token, ...start(mode, `for (let i = 0; i < 4; i++) { console.log(${JSON.stringify(token)} + ':' + i); await new Promise(resolve => setTimeout(resolve, 20)); process.stderr.write(${JSON.stringify(token)} + '-err:' + i + '\\n'); } return ${JSON.stringify(token)};`, { stream: true }) }
    })
    await until(() => concurrent.every(job => chunksFor(job.taskId).length), 'all concurrent jobs started')
    await write('stdout', hostOut[1])
    await write('stderr', hostErr[1])
    const concurrentResults = await deadline(Promise.all(concurrent.map(job => job.promise)), 'concurrent jobs')
    for (const [index, job] of concurrent.entries()) {
      const actual = concurrentResults[index]
      assert.equal(actual.code, 0)
      assert.equal(bytes(actual.stdout, 'stdout').toString(), Array.from({ length: 4 }, (_, i) => `${job.token}:${i}\n`).join(''))
      assert.equal(bytes(actual.stderr, 'stderr').toString(), Array.from({ length: 4 }, (_, i) => `${job.token}-err:${i}\n`).join(''))
      streamed(job.taskId, actual)
    }

    // The host's exitCode must survive a main-thread job that changes its own.
    process.exitCode = 23
    const mainExit = await start('electron', `process.exitCode = 17; await new Promise(resolve => setTimeout(resolve, 10)); return null;`).promise
    assert.equal(mainExit.code, 17)
    assert.equal(process.exitCode, 23, 'main job exitCode must not overwrite host exitCode')
    process.exitCode = saved.exitCode

    const cancel = start('node', `process.stdout.write('cancel-ready'); await new Promise(resolve => setTimeout(resolve, 20)); while (true) {}`, { stream: true })
    await until(() => chunksFor(cancel.taskId).length > 0, 'cancel worker readiness')
    await sleep(60) // Let the Worker enter the synchronous loop before cancelling it.
    await deadline(Promise.resolve(service.cancel({ taskId: cancel.taskId })), 'cancel request')
    const cancelled = await cancel.promise
    assert.equal(cancelled.code, 130, 'cancel terminates CPU-bound Worker')
    streamed(cancel.taskId, cancelled)
    const timeout = await start('node', `while (true) {}`, { timeoutMs: 150 }).promise
    assert.equal(timeout.code, 124, 'timeout terminates CPU-bound Worker')
    assert.equal(bytes((await start('node', `process.stdout.write('still usable');`).promise).stdout, 'stdout').toString(), 'still usable')

    for (const mode of ['node', 'electron']) {
      for (const stream of ['stdout', 'stderr']) {
        const overflow = start(mode, `process.${stream}.write(Buffer.alloc(4096, 120)); return 'must not silently truncate';`, { maxOutputBytes: 64 })
        let result, failure
        try { result = await overflow.promise } catch (error) { failure = error }
        if (failure) {
          assert.notEqual(failure.code, 'CHECK_DEADLINE', 'cap overflow must settle without reaching the test deadline')
          assert.match(String(failure), /output|limit|cap|overflow|exceed|64/i, `${mode}: explicit cap error`)
        } else {
          assert.notEqual(result.code, 0, `${mode}: cap overflow cannot report successful truncation`)
          assert.match(bytes(result.stderr, 'stderr').toString(), /output|limit|cap|overflow|exceed|64/i, `${mode}: explicit cap error`)
        }
      }
    }

    for (const mode of ['node', 'electron']) {
      const timerDeadline = await cli(mode, ['-e', `setInterval(() => {}, 20)`], { timeoutMs: 100 }).promise
      assert.equal(timerDeadline.code, 124, `${mode}: a normal CLI timer remains live until the deadline`)
      const timerCancel = cli(mode, ['-e', `console.log('timer-ready'); setInterval(() => {}, 20)`], { stream: true })
      await until(() => chunksFor(timerCancel.taskId).length, `${mode} timer readiness`)
      service.cancel({ taskId: timerCancel.taskId })
      assert.equal((await timerCancel.promise).code, 130, `${mode}: cancel ends a live CLI timer`)
    }

    const closing = start('node', `process.stdout.write('close-ready'); setInterval(() => process.stdout.write('tick'), 25);`, { stream: true })
    await until(() => chunksFor(closing.taskId).length > 0, 'close worker readiness')
    await deadline(Promise.resolve(service.close()), 'service.close')
    assert.equal((await closing.promise).code, 130, 'close settles and terminates active Worker')
    const eventCount = events.length
    await sleep(80)
    assert.equal(events.length, eventCount, 'close leaves no continuing worker output')
    assert.equal(process.exitCode, saved.exitCode, 'host exitCode restored')
    await write('stdout', hostOut[2])
    await write('stderr', hostErr[2])

    // The registered transport close callback must perform the same cleanup.
    assert.ok(closeHandlers.length > 0, 'service registers transport shutdown cleanup')
    const disconnected = new Executions(transport)
    const pendingId = 'disconnect-check'
    const pending = deadline(disconnected.execute({ taskId: pendingId, mode: 'node', args: bodyArgs(`process.stdout.write('disconnect-ready'); setInterval(() => {}, 25);`), timeoutMs: null, maxOutputBytes: 1024, stream: true }), 'transport-close Worker')
    pending.catch(() => {})
    try {
      await until(() => chunksFor(pendingId).length > 0, 'transport-close worker readiness')
      for (const handler of closeHandlers) handler()
      assert.equal((await pending).code, 130, 'transport close settles active Worker')
    } finally { await deadline(Promise.resolve(disconnected.close()), 'disconnected.close') }
  } finally {
    await deadline(Promise.resolve(service.close()), 'final cleanup')
    process.exitCode = saved.exitCode
  }
  console.log(success)
}

if (process.argv[2] === '--run') {
  await checks()
} else {
  const actual = await nodeProcess([self, '--run'], 60_000)
  assert.equal(actual.signal, null, 'suite must exit naturally without leaked Worker handles')
  assert.equal(actual.code, 0, `command suite failed:\n${actual.stdout}\n${actual.stderr}`)
  assert.equal(actual.stdout.toString(), [...hostOut, success, ''].join('\n'), 'jobs must not leak output to host; premature host exit must fail')
  assert.equal(actual.stderr.toString(), [...hostErr, ''].join('\n'), 'ordinary host stderr stays outside job capture')
  console.log(`${success} (direct CLI Node oracle, file/CJS/argv, main/worker identity, async lifecycle/routing, live streaming, cancel/timeout, limits, shutdown)`)
}
