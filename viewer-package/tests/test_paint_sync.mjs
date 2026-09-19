// Every wait the paint store has on a worker ends — on its reply, on the worker's error reply, on an error event,
//  on terminate(), or on a timeout — and never on another request's answer.
//   Run: node viewer-package/tests/test_paint_sync.mjs
// The two hangs this pins (both measured in the browser before core/worker_reply.js): a save pressed during a slice
//  the watchdog then killed stayed on "Saving…" for good with the viewport blank (rendering is suspended until the
//  export finishes), and a failed importPaint answered {type:'error'}, which no wait listened for.
import assert from 'node:assert'
import { request, makeTerminationObservable } from '../src/core/worker_reply.js'
import { requestPaintExport } from '../src/actions/support_paint.js'

// A worker that records what it is sent and answers when the test says so. Event and EventTarget are node built-ins.
class FakeWorker extends EventTarget {
  constructor() { super(); this.sent = []; this.terminated = false }
  postMessage(message) { this.sent.push(message) }
  terminate() { this.terminated = true }
  reply(data) { const event = new Event('message'); event.data = data; this.dispatchEvent(event) }
}
const NEVER = Symbol('still waiting')
const settledWithin = (promise, milliseconds = 50) =>
  Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(NEVER), milliseconds))])
const lastRequestId = (worker) => worker.sent.at(-1).requestId

// ---- the reply to THIS request ----
{
  const worker = new FakeWorker()
  const waiting = request(worker, { cmd: 'importPaint' }, { types: ['painted'] })
  assert.equal(typeof lastRequestId(worker), 'number', 'the request carries an id')
  worker.reply({ type: 'painted', counts: { 2: 5 }, requestId: lastRequestId(worker) })
  assert.deepEqual((await waiting).counts, { 2: 5 })
}

// ---- an error reply ends the wait — but only this request's ----
{
  const worker = new FakeWorker()
  const waiting = request(worker, { cmd: 'importPaint' }, { types: ['painted'] })
  const ours = lastRequestId(worker)
  worker.reply({ type: 'error', error: 'an earlier slice failed' })                   // no id: someone else's
  worker.reply({ type: 'error', error: 'another request', requestId: ours + 1000 })
  assert.equal(await settledWithin(waiting), NEVER, "another command's error does not end this wait")
  worker.reply({ type: 'error', error: 'memory access out of bounds', requestId: ours })
  assert.equal(await waiting, null, "this request's error ends it with null")
}

// ---- a worker that dies: an error event, or terminate() ----
{
  const erroring = new FakeWorker()
  const byError = request(erroring, { cmd: 'exportPaint' }, { types: ['paintExport'] })
  erroring.dispatchEvent(new Event('error'))
  assert.equal(await byError, null, 'a worker error event ends the wait')

  const killed = makeTerminationObservable(new FakeWorker())
  const byTerminate = request(killed, { cmd: 'exportPaint' }, { types: ['paintExport'] })   // no timeout at all
  killed.terminate()
  assert.equal(await settledWithin(byTerminate), null, 'terminate() ends a wait that has no timeout')
  assert.equal(killed.terminated, true, 'and still terminates the worker')
  assert.equal(await request(killed, { cmd: 'exportPaint' }, { types: ['paintExport'] }), null, 'a terminated worker is not asked again')
}

// ---- a worker that predates the id echo still answers ----
{
  const worker = new FakeWorker()
  const waiting = request(worker, { cmd: 'exportPaint' }, { types: ['paintExport'] })
  worker.reply({ type: 'paintExport', supported: true, facets: [], hex: '' })
  assert.equal((await waiting).type, 'paintExport')
}

// ---- a bounded wait gives up ----
{
  const TIMEOUT_MS = 10
  assert.equal(await request(new FakeWorker(), { cmd: 'exportPaint' }, { types: ['paintExport'], timeoutMs: TIMEOUT_MS }), null)
}

// ---- the store's export request on top of it: supported, unsupported, killed ----
{
  const worker = makeTerminationObservable(new FakeWorker())
  const supported = requestPaintExport(worker, Infinity)
  worker.reply({ type: 'paintExport', supported: true, facets: [3], hex: '8', requestId: lastRequestId(worker) })
  assert.deepEqual((await supported).facets, [3])
  const unsupported = requestPaintExport(worker, Infinity)
  worker.reply({ type: 'paintExport', supported: false, facets: [], hex: '', requestId: lastRequestId(worker) })
  assert.equal(await unsupported, null, 'a kernel without the export binding answers null')
  const orphaned = requestPaintExport(worker, Infinity)
  worker.terminate()
  assert.equal(await settledWithin(orphaned), null, 'the write-back of a killed worker ends instead of hanging the save')
}

console.log('paint_sync: ok')
