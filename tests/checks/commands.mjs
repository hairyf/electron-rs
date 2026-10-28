// Run after building assets. The supervisor catches leaked task timers and accidental host exits.
import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
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
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms) }),
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

async function reference(script) {
  // The same async-function body runs in an independent real Node process, not a mock executor.
  const result = await nodeProcess(['-e', `
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    new AsyncFunction('signal', 'require', 'process', 'console', ${JSON.stringify(script)})(
      new AbortController().signal, require, process, console
    ).catch(error => { console.error(error && error.stack || String(error)); process.exitCode = 1; });
  `])
  return { ...result, code: process.platform === 'win32' ? (result.code | 0) : result.code }
}

function bytes(value, label) {
  assert.equal(typeof value, 'string', `${label} must be base64`)
  const decoded = Buffer.from(value, 'base64')
  assert.equal(decoded.toString('base64'), value, `${label} must be canonical base64`)
  return decoded
}

const withoutFrames = buffer => buffer.toString('utf8').replace(/^\s+at .*\r?\n?/gm, '')

async function checks() {
  const write = (stream, text) => deadline(new Promise((resolve, reject) => {
    process[stream].write(text + '\n', error => error ? reject(error) : resolve())
  }), `host ${stream} write`)
  const saved = { exitCode: process.exitCode, argv: process.argv, argvValue: [...process.argv], exit: process.exit, stdout: process.stdout.write, stderr: process.stderr.write }
  await write('stdout', hostOut[0])
  await write('stderr', hostErr[0])
  const { Executions } = createRequire(import.meta.url)('../../assets/runtime/execution.cjs')
  const events = [], completed = new Set(), closeHandlers = []
  const transport = {
    send(event, params) { events.push({ event, params: structuredClone(params), afterResult: completed.has(params.taskId) }) },
    onClose(handler) { closeHandlers.push(handler) },
  }
  const service = new Executions(transport)
  let nextId = 0
  const chunksFor = taskId => events.filter(entry => entry.event === 'command.output' && entry.params.taskId === taskId).flatMap(entry => entry.params.chunks)
  const start = (script, overrides = {}) => {
    const taskId = `command-check-${++nextId}`
    const promise = deadline(service.execute({ taskId, script, maxOutputBytes: 256 * 1024, stream: false, ...overrides }), taskId).then(result => {
      completed.add(taskId)
      assert.deepEqual(Object.keys(result).sort(), ['code', 'stderr', 'stdout'], `${taskId}: output-only wire contract`)
      assert.ok(Number.isInteger(result.code), `${taskId}: integer exit code`)
      bytes(result.stdout, 'stdout')
      bytes(result.stderr, 'stderr')
      return result
    })
    promise.catch(() => {})
    return { taskId, promise }
  }
  const streamed = (taskId, result) => {
    const entries = events.filter(entry => entry.params.taskId === taskId)
    assert.ok(entries.length > 0, `${taskId}: output events`)
    assert.ok(entries.every(entry => entry.event === 'command.output' && !entry.afterResult), `${taskId}: flush before result`)
    const chunks = chunksFor(taskId)
    assert.deepEqual(chunks.map(chunk => chunk.sequence), chunks.map((_, index) => index), 'contiguous per-task sequences')
    for (const chunk of chunks) assert.ok(['stdout', 'stderr'].includes(chunk.stream), 'valid stream')
    for (const stream of ['stdout', 'stderr']) {
      assert.deepEqual(Buffer.concat(chunks.filter(chunk => chunk.stream === stream).map(chunk => bytes(chunk.data, 'chunk'))), bytes(result[stream], stream), `${taskId}: streamed ${stream} reconstructs final bytes`)
    }
  }
  try {
    for (const [name, script] of [
      ['text and return', `console.log('hello'); console.error('error text'); return { ok: true };`],
      ['console formatting', `console.log('%s %d %j', 'value', 12, { a: 1 }); console.dir({ list: [1, 'two'], nested: { yes: true } }); console.warn('warn', null, undefined, { value: 3 }); return null;`],
      ['no newline', `process.stdout.write('left'); process.stdout.write('right', 'utf8'); process.stderr.write('err');`],
      ['raw bytes', `process.stdout.write(Buffer.from([0, 255, 128, 195, 40, 10])); process.stderr.write(new Uint8Array([254, 0, 129, 13])); process.stdout.write('ff00', 'hex');`],
      ['await and signal', `await new Promise(resolve => setTimeout(resolve, 10)); console.log(signal.aborted); return 'not stdout';`],
    ]) {
      const expected = await reference(script)
      const { taskId, promise } = start(script)
      const actual = await promise
      assert.equal(actual.code, expected.code, `${name}: exit code`)
      assert.deepEqual(bytes(actual.stdout, 'stdout'), expected.stdout, `${name}: direct Node stdout`)
      assert.deepEqual(bytes(actual.stderr, 'stderr'), expected.stderr, `${name}: direct Node stderr`)
      assert.equal(chunksFor(taskId).length, 0, 'stream:false emits no output event')
    }

    const shortTimeout = 25
    for (const timeoutMs of [undefined, null, shortTimeout]) {
      const scheduled = []
      const hook = createHook({ init(_id, kind, _trigger, resource) { if (kind === 'Timeout') scheduled.push(resource._idleTimeout) } })
      let pending
      hook.enable()
      try {
        pending = service.execute({ taskId: `deadline-${++nextId}`, script: `await new Promise(resolve => setTimeout(resolve, 100)); console.log('completed');`, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      } finally { hook.disable() }
      pending.catch(() => {})
      assert.deepEqual(scheduled, timeoutMs == null ? [] : [shortTimeout], 'null/omitted timeout allocates no deadline timer')
      const actual = await deadline(pending, 'deadline check')
      assert.equal(actual.code, timeoutMs == null ? 0 : 124)
      assert.equal(bytes(actual.stdout, 'stdout').toString(), timeoutMs == null ? 'completed\n' : '')
      assert.equal(bytes(actual.stderr, 'stderr').length, 0)
    }
    for (const timeoutMs of [0, -1, 0.5, Infinity, -Infinity, NaN, 2147483648, '25', false, {}]) {
      await assert.rejects(start('', { timeoutMs }).promise, /invalid command.execute parameters/)
    }
    assert.equal((await start('', { timeoutMs: 2147483647 }).promise).code, 0)
    for (const script of [undefined, null, [], 1]) await assert.rejects(start(script).promise, /invalid command.execute parameters/)
    for (const maxOutputBytes of [0, -1, 0.5, Infinity, 268435457, '25']) await assert.rejects(start('', { maxOutputBytes }).promise, /invalid command maxOutputBytes/)
    await assert.rejects(start('', { stream: 'true' }).promise, /invalid command.execute parameters/)

    for (const returned of [`(() => { const value = {}; value.self = value; return value })()`, `1n`, `({ nested: 1n })`, `({ toJSON() { throw new Error('return must not be serialized') } })`]) {
      const script = `process.stdout.write('written stdout'); process.stderr.write('written stderr'); return ${returned};`
      const expected = await reference(script)
      const job = start(script, { stream: true })
      const actual = await job.promise
      assert.equal(actual.code, 0, 'non-JSON return is ignored')
      assert.deepEqual(bytes(actual.stdout, 'stdout'), expected.stdout)
      assert.deepEqual(bytes(actual.stderr, 'stderr'), expected.stderr)
      streamed(job.taskId, actual)
    }
    const identity = await start(`const { isMainThread, threadId } = require('node:worker_threads'); console.log(JSON.stringify({ pid: process.pid, isMainThread, threadId }));`).promise
    assert.deepEqual(JSON.parse(bytes(identity.stdout, 'stdout')), { pid: process.pid, isMainThread: true, threadId: 0 }, 'run executes on the existing main thread')

    for (const value of [-1, 7, 255, 256, 257]) {
      for (const action of [`process.exitCode = ${value}`, `process.exit(${value})`]) {
        const script = `await new Promise(resolve => process.stdout.write('exit-boundary', resolve)); ${action}; return null;`
        const expected = await reference(script)
        const actual = await start(script).promise
        assert.equal(actual.code, expected.code, action)
        assert.deepEqual(bytes(actual.stdout, 'stdout'), expected.stdout)
        assert.deepEqual(bytes(actual.stderr, 'stderr'), expected.stderr)
        assert.equal(process.exitCode, saved.exitCode, 'host exitCode is unchanged')
      }
    }
    for (const specifier of ['process', 'node:process']) {
      const actual = await start(`const native = require(${JSON.stringify(specifier)}); native.exitCode = 17; await new Promise(resolve => setTimeout(resolve, 10)); native.exit(); console.log('must not run');`).promise
      assert.equal(actual.code, 17, 'required process exit is task-scoped')
      assert.equal(bytes(actual.stdout, 'stdout').length, 0)
      assert.equal(process.exitCode, saved.exitCode)
    }
    process.exitCode = 23
    assert.equal((await start(`process.exitCode = 17; await new Promise(resolve => setTimeout(resolve, 10));`).promise).code, 17)
    assert.equal(process.exitCode, 23, 'host nonzero exitCode survives task changes')
    process.exitCode = saved.exitCode

    const thrown = `process.stdout.write('before throw'); throw new Error('command-check thrown marker');`
    const expectedError = await reference(thrown)
    const actualError = await start(thrown).promise
    assert.equal(actualError.code, expectedError.code)
    assert.deepEqual(bytes(actualError.stdout, 'stdout'), expectedError.stdout)
    assert.equal(withoutFrames(bytes(actualError.stderr, 'stderr')), withoutFrames(expectedError.stderr))
    for (const script of [`Promise.reject(new Error('detached rejection'));`, `setTimeout(() => { throw new Error('timer rejection') }, 10); await new Promise(() => {});`]) {
      const actual = await start(script).promise
      assert.equal(actual.code, 1, 'async errors are routed to their task')
      assert.match(bytes(actual.stderr, 'stderr').toString(), /rejection/)
    }

    const live = start(`process.stdout.write(Buffer.from([0, 255, 195])); await new Promise(resolve => setTimeout(resolve, 100)); process.stderr.write(Buffer.from([128, 10])); process.stdout.write('tail'); return { done: true };`, { stream: true })
    let finished = false
    live.promise.finally(() => { finished = true }).catch(() => {})
    await until(() => chunksFor(live.taskId).length > 0 || finished, 'first live chunk')
    assert.equal(finished, false, 'first chunk arrives before completion')
    const liveResult = await live.promise
    assert.equal(liveResult.code, 0)
    assert.deepEqual(bytes(liveResult.stdout, 'stdout'), Buffer.from([0, 255, 195, 116, 97, 105, 108]))
    assert.deepEqual(bytes(liveResult.stderr, 'stderr'), Buffer.from([128, 10]))
    streamed(live.taskId, liveResult)

    const concurrent = Array.from({ length: 4 }, (_, index) => {
      const token = `job-${index}`
      return { token, ...start(`for (let i = 0; i < 4; i++) { console.log(${JSON.stringify(token)} + ':' + i); await new Promise(resolve => setTimeout(resolve, 20)); process.stderr.write(${JSON.stringify(token)} + '-err:' + i + '\\n'); }`, { stream: true }) }
    })
    await until(() => concurrent.every(job => chunksFor(job.taskId).length), 'all concurrent jobs started')
    await write('stdout', hostOut[1])
    await write('stderr', hostErr[1])
    const results = await deadline(Promise.all(concurrent.map(job => job.promise)), 'concurrent jobs')
    for (const [index, job] of concurrent.entries()) {
      assert.equal(results[index].code, 0)
      assert.equal(bytes(results[index].stdout, 'stdout').toString(), Array.from({ length: 4 }, (_, i) => `${job.token}:${i}\n`).join(''))
      assert.equal(bytes(results[index].stderr, 'stderr').toString(), Array.from({ length: 4 }, (_, i) => `${job.token}-err:${i}\n`).join(''))
      streamed(job.taskId, results[index])
    }
    const detached = start(`console.log('body done'); setTimeout(() => console.log('detached timeout'), 20); setImmediate(() => console.error('detached immediate')); setInterval(() => console.log('detached interval'), 20); return 'done';`, { stream: true })
    const detachedResult = await detached.promise
    assert.equal(bytes(detachedResult.stdout, 'stdout').toString(), 'body done\n')
    assert.equal(bytes(detachedResult.stderr, 'stderr').length, 0)
    const eventCount = events.length
    await sleep(60)
    assert.equal(events.length, eventCount, 'body completion clears detached timers and leaves no late output')

    const cancel = start(`console.log('cancel-ready'); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); console.log('after cancel');`, { stream: true })
    await until(() => chunksFor(cancel.taskId).length > 0, 'cancel readiness')
    assert.equal(service.cancel({ taskId: cancel.taskId }), null)
    const cancelled = await cancel.promise
    assert.equal(cancelled.code, 130)
    assert.equal(bytes(cancelled.stdout, 'stdout').toString(), 'cancel-ready\n')
    streamed(cancel.taskId, cancelled)
    assert.equal(service.cancel({ taskId: 'already-finished' }), null)
    assert.equal(bytes((await start(`console.log('still usable');`).promise).stdout, 'stdout').toString(), 'still usable\n')
    for (const stream of ['stdout', 'stderr']) {
      await assert.rejects(start(`process.${stream}.write(Buffer.alloc(4096, 120));`, { maxOutputBytes: 64 }).promise, /output exceeds maxOutputBytes \(64\)/)
    }
    assert.equal(process.argv, saved.argv, 'run does not replace host argv')
    assert.deepEqual(process.argv, saved.argvValue)
    const closing = start(`console.log('close-ready'); await new Promise(() => {});`, { stream: true })
    await until(() => chunksFor(closing.taskId).length > 0, 'close readiness')
    await deadline(service.close(), 'service.close')
    assert.equal((await closing.promise).code, 130)
    assert.equal(process.exit, saved.exit, 'close restores host exit')
    assert.equal(process.stdout.write, saved.stdout, 'close restores host stdout')
    assert.equal(process.stderr.write, saved.stderr, 'close restores host stderr')
    await assert.rejects(start('').promise, /executions are closed/)
    await write('stdout', hostOut[2])
    await write('stderr', hostErr[2])

    const disconnected = new Executions(transport)
    const pendingId = 'disconnect-check'
    const pending = deadline(disconnected.execute({ taskId: pendingId, script: `console.log('disconnect-ready'); await new Promise(() => {});`, stream: true }), 'transport-close task')
    pending.catch(() => {})
    try {
      await until(() => chunksFor(pendingId).length > 0, 'transport-close readiness')
      for (const handler of closeHandlers) handler()
      assert.equal((await pending).code, 130)
    } finally { await deadline(disconnected.close(), 'disconnected.close') }
  } finally {
    await deadline(service.close(), 'final cleanup')
    process.exitCode = saved.exitCode
  }
  console.log(success)
}

if (process.argv[2] === '--run') {
  await checks()
} else {
  const actual = await nodeProcess([self, '--run'], 60_000)
  assert.equal(actual.signal, null, 'suite exits naturally without leaked task timers')
  assert.equal(actual.code, 0, `command suite failed:\n${actual.stdout}\n${actual.stderr}`)
  assert.equal(actual.stdout.toString(), [...hostOut, success, ''].join('\n'), 'jobs never leak output or exit the host')
  assert.equal(actual.stderr.toString(), [...hostErr, ''].join('\n'), 'ordinary host stderr stays outside capture')
  console.log(`${success} (async-script Node oracle, main routing, live streaming, cancel/timeout, limits, shutdown)`)
}
