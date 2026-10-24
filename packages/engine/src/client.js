// three-slicer/client — a promise wrapper over the slice worker's message protocol.
//
// Why it exists: the worker is the recommended way to slice in a browser (the kernel blocks its thread for
// seconds), but driving it meant hand-writing a `cmd` string protocol, assembling the streamed layers, knowing
// that a slice request is the one message with NO cmd and that its params must already be a JSON string, and
// reaching into a SharedArrayBuffer at an offset the worker posts once to cancel anything. All of that lived in
// the viewer and was not published.
//
// What it deliberately does NOT do: the viewer's progress weighting (its 15/5/40/40 phase budget is measured
// against ITS models) and its out-of-memory retry ladder (re-slicing simplified, then in economy mode). Those are
// UI policy — a host wanting them should own them, and lifting them here would make this a copy of the viewer.
//
// Requests are answered in order. The worker's onmessage handler processes one message at a time and each command
// replies exactly once, so a FIFO of pending requests is enough to match a reply to its caller — the protocol
// carries no request ids and does not need them.
import { parseSlaJob, SlaRequestError } from './sla_request.js'

export { SLA_CAPABILITIES, SLA_JOB_VERSION, SlaRequestError } from './sla_request.js'

// Which reply type ends which command. A slice has no cmd (that is what selects slicing) and ends on 'done'.
const REPLY_OF = {
  warmup: 'warm', prepare: 'prepared', paint: 'painted', erase: 'painted', clear: 'painted',
  importPaint: 'painted', exportPaint: 'paintExport', overlay: 'overlay', slice: 'done', sla: 'done',
  fillPreview: 'fillPreview', paintMode: 'paintMode',
}

const asBuffer = (data) => (data instanceof ArrayBuffer ? data : data?.buffer ?? data)
const slaTransferables = (job) => job.objects.flatMap(object => [object, ...(object.modifierVolumes ?? [])])
  .map(record => asBuffer(record.stl)).filter(buffer => buffer instanceof ArrayBuffer)

/**
 * @param {Worker} [worker] an existing worker to drive. Omit to create one — which only works in a browser,
 *   since Node has no global Worker; a Node caller should use createSlicer() from the root entry instead.
 */
// The default is written as the full `new Worker(new URL('literal', import.meta.url), { type: 'module' })`
//  expression rather than through engineWorkerURL(), and that is the whole reason the no-argument form works
//  after `vite build`. Bundlers recognize this exact shape as a worker ENTRY and emit it with its own chunk
//  graph (the st/mt kernels it dynamically imports); split across a function call, the same file matched Vite's
//  plain-asset rule instead and was copied verbatim, still importing an unhashed `./slicer_core.js` that dist
//  did not contain — a 404 on the first message, visible only in a production build. Same reason the viewer
//  keeps make_worker.js out of its own bundle. Do not factor this expression out.
/**
 * The WASM kernel's worker, as a factory. This is the one thing a slicing viewer needs that the permissive
 * package cannot ship: `three-slicer-viewer`'s `useSlicer` takes it as `deps.makeWorker`, and a
 * host binds it there. Written as the full literal expression for the same reason as below.
 */
export function makeSlicerWorker() {
  return new Worker(new URL('./slicer.worker.js', import.meta.url), { type: 'module' })
}

export function createSlicerClient(worker = new Worker(new URL('./slicer.worker.js', import.meta.url), { type: 'module' })) {
  const pending = []          // FIFO of {expect, resolve, reject, onProgress, onLayer, chunks, layers}
  let cancelFlag = null       // Uint32Array over the worker's SharedArrayBuffer — mt kernel only
  let closed = false

  worker.addEventListener('message', ({ data }) => {
    // Unprompted and not a reply to anything: the addresses of the progress counter and the cancel flag.
    if (data.type === 'supsab') {
      try { if (data.cancelPtr) cancelFlag = new Uint32Array(data.buf, data.cancelPtr, 1) } catch { /* not shared */ }
      return
    }
    const head = pending[0]
    if (!head) return
    if (data.type === 'progress') { head.onProgress?.(data.done, data.total); return }
    if (data.type === 'layer') {
      head.onLayer?.({ z: data.z, idx: data.idx, gcode: data.gcode, paths: data.paths, widths: data.widths })
      // Accumulated only when the caller did not take the layers itself — otherwise a streamed slice would hold
      //  the whole model in memory here, which is the one thing streaming exists to avoid.
      if (!head.onLayer) { if (data.gcode) head.chunks.push(data.gcode); head.layers.push(data) }
      return
    }
    pending.shift()
    if (data.type === 'error') {
      head.reject(data.code ? new SlaRequestError(data.code, data.error) : new Error(data.error)); return
    }
    if (data.type !== head.expect) { head.reject(new Error(`expected '${head.expect}', got '${data.type}'`)); return }
    // What the layer messages accumulated, if this caller did not take them itself.
    if (data.type === 'done' && head.layers.length) data.assembled = { gcode: head.chunks.join(''), layers: head.layers }
    head.resolve(data)
  })
  worker.addEventListener('error', (event) => {
    const head = pending.shift()
    head?.reject(new Error(event.message || 'worker failed'))
  })

  const send = (message, { transfer = [], onProgress, onLayer } = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('slicer client terminated')); return }
    pending.push({ expect: REPLY_OF[message.cmd ?? 'slice'], resolve, reject, onProgress, onLayer, chunks: [], layers: [] })
    worker.postMessage(message, transfer)
  })

  const brush = (cmd, args) => send({ ...args, cmd }).then(reply => ({
    enforcer: reply.enf, blocker: reply.blk, counts: reply.counts, applied: reply.applied,
  }))

  return {
    worker,

    /** Load the kernel ahead of the first slice, so the first one is not also a 4MB download. Says which variant
     *  loaded — mt (threads) or st — because the two are a measured 9.8x apart and a host may want to say so. */
    warmup: () => send({ cmd: 'warmup' }).then(reply => ({ kernel: reply?.kernel ?? null })),

    /**
     * Slice. `params` may be an object — it is stringified here, which the raw protocol does not do for you.
     * With `onLayer` the layers are yours and the result carries stats only; without it they are assembled and
     * the result looks like the direct handle's.
     */
    async slice(stl, params, { onProgress, onLayer } = {}) {
      const buffer = asBuffer(stl)
      const entry = { stl: buffer, params: typeof params === 'string' ? params : JSON.stringify(params ?? {}) }
      const reply = await send(entry, { transfer: [buffer], onProgress, onLayer })
      const result = reply.result ?? {}
      // A streamed slice returns stats only, with the content delivered as `layer` messages. Unless the caller
      //  took those itself, hand back the same shape a batch slice produces.
      if (!reply.assembled) return result
      return { ...result, gcode: reply.assembled.gcode, layers: reply.assembled.layers }
    },

    /**
     * Legacy single-object SLA slice: per-layer closed contours instead of toolpaths. It uses WASM when available;
     * its contour-only JS fallback rejects requested supports and pads. Same streaming shape as slice(): `onLayer` hands you the layers and the result
     * carries stats only; without it they are assembled onto the result.
     */
    async sliceSla(stl, params, { onProgress, onLayer } = {}) {
      const buffer = asBuffer(stl)
      const entry = { cmd: 'sla', stl: buffer, params: typeof params === 'string' ? params : JSON.stringify(params ?? {}) }
      const reply = await send(entry, { transfer: [buffer], onProgress, onLayer })
      const result = reply.result ?? {}
      if (!reply.assembled) return result
      return { ...result, layers: reply.assembled.layers }
    },

    async sliceSlaJob(job, { onProgress, onLayer } = {}) {
      const parsed = parseSlaJob(job)
      const reply = await send({ cmd: 'slaJob', job: parsed }, { transfer: slaTransferables(parsed), onProgress, onLayer })
      const result = reply.result ?? {}
      if (!reply.assembled) return result
      return { ...result, layers: reply.assembled.layers }
    },

    /** Register a mesh for painting. `keepPaint` carries existing marks across a move. */
    prepare: (stl, { keepPaint = false } = {}) => {
      const buffer = asBuffer(stl)
      return send({ cmd: 'prepare', stl: buffer, keepPaint }, { transfer: [buffer] })
        .then(reply => ({ facets: reply.facets, kept: reply.kept }))
    },

    /** Paint. `{state: 1..16}` addresses any extruder; `{enforcer: false}` is the legacy blocker brush. */
    paint: (args) => brush('paint', args),
    /** Return the brushed facets to the default extruder. Not `paint` with state 0 — see types/worker.d.ts. */
    erase: (args) => brush('erase', args),
    clear: (states) => brush('clear', states ? { states } : {}),

    overlay: (states) => send({ cmd: 'overlay', ...(states ? { states } : {}) })
      .then(reply => ({ enforcer: reply.enf, blocker: reply.blk, overlays: reply.overlays })),

    /** What a fill would select under `{tool, facet, hx, hy, hz, angle}`, without applying it. `{clear:true}`
     *  drops the standing selection. `supported` is false on a kernel built before the preview existed. */
    fillPreview: (args) => send({ cmd: 'fillPreview', ...args })
      .then(reply => ({ supported: reply.supported, triangles: reply.tris })),
    /** Brush-wide options: `{overhangDeg}` restricts every stroke to overhangs (0 = off), `{clipPlane:[nx,ny,nz,d]}`
     *  sets the section plane every cursor clips against (null turns it off). */
    paintMode: (args) => send({ cmd: 'paintMode', ...args }).then(() => undefined),

    /** Load a 3mf's painting. Replaces every mark, so run it directly after `prepare`. */
    importPaint: (facets, hex, states) => brush('importPaint', { facets, hex, ...(states ? { states } : {}) }),
    exportPaint: () => send({ cmd: 'exportPaint' })
      .then(reply => ({ supported: reply.supported, facets: reply.facets, hex: reply.hex })),

    /**
     * Stop the running slice. The kernel polls this flag from inside its C++ loop, so it works while the worker
     * is blocked in WASM — but the flag lives in a SharedArrayBuffer, so it exists only on the multithreaded
     * kernel, i.e. on a cross-origin-isolated page. Returns false when there is nothing to write to; terminate
     * the worker instead.
     */
    cancel() {
      if (!cancelFlag) return false
      try { Atomics.store(cancelFlag, 0, 1) } catch { cancelFlag[0] = 1 }
      return true
    },

    terminate() {
      closed = true
      while (pending.length) pending.shift().reject(new Error('slicer client terminated'))
      worker.terminate()
    },
  }
}

export default createSlicerClient
