// One request to a worker, one answer — and an answer even when the worker cannot give one.
//
// The paint store waits on the worker at three points (the selector's write-back, its load, a pool worker's load),
// and each wait used to listen for its reply type and nothing else. Two things made that hang for good: the worker
// answers a failed command with `{type: 'error'}` (its catch-all, slicer.worker.js), which no wait was listening
// for; and a worker the watchdog or the memory ladder terminates sends nothing at all — `terminate()` fires no
// event. Measured: a save pressed during a slice the watchdog then killed stayed on "Saving…" for good, and since
// the export suspends rendering until it finishes, the whole viewport stayed blank until a reload.
//
// Pure (no DOM globals): the worker is passed in, and EventTarget/Event exist in node too, which is what lets
// test_paint_sync.mjs drive this with a fake worker.

let nextRequestId = 1

/** Make a worker's end observable: its `terminate()` dispatches a `terminated` event first, so anything waiting on
 *  it can stop waiting. Idempotent; returns the worker. */
export function makeTerminationObservable(worker) {
  if (!worker || worker.__terminationObservable) return worker
  const terminate = worker.terminate.bind(worker)
  worker.terminate = () => {
    worker.__terminated = true
    try { worker.dispatchEvent(new Event('terminated')) } catch { /* a worker without dispatchEvent still terminates */ }
    terminate()
  }
  worker.__terminationObservable = true
  return worker
}

/**
 * Post `message` with a fresh `requestId` and resolve with the first reply to it whose type is one of `types`.
 * Resolves `null` — never hangs — when the reply is the worker's error reply, when the worker errors or is
 * terminated, or when `timeoutMs` passes (Infinity: no timeout, for a reply that may legitimately queue behind a
 * long slice). A worker that predates the `requestId` echo still answers: a reply WITHOUT an id is accepted by its
 * type, but an error reply must carry this request's id — an earlier command's error must not end this wait.
 */
export function request(worker, message, { types, timeoutMs = Infinity, transfer } = {}) {
  if (!worker || worker.__terminated) return Promise.resolve(null)
  const requestId = nextRequestId++
  return new Promise((resolve) => {
    let finished = false, timer = 0
    const finish = (value) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onGone)
      worker.removeEventListener('terminated', onGone)
      resolve(value)
    }
    const onMessage = (event) => {
      const data = event.data
      const ours = data?.requestId === requestId
      const unnumbered = data?.requestId === undefined
      if (ours && data.type === 'error') { finish(null); return }
      if ((ours || unnumbered) && types.includes(data?.type)) finish(data)
    }
    const onGone = () => finish(null)
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onGone)
    worker.addEventListener('terminated', onGone)
    if (Number.isFinite(timeoutMs)) timer = setTimeout(() => finish(null), timeoutMs)
    worker.postMessage({ ...message, requestId }, transfer)
  })
}
