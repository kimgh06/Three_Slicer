// Runs slicing off the main thread (non-blocking UI) plus stage-30 layer streaming.
// Vite module worker: new Worker(new URL('./slicer.worker.js', import.meta.url), { type: 'module' }).
// SINGLE_FILE means the wasm is inlined into slicer_core.js -> no external fetch from the worker either.
//
// Stage 30 (OOM tolerance): set_layer_sink lets the kernel emit layers as it produces them; each is transferred to main
//  immediately (Float32Array buffers moved -> the worker copy is released at once) and the kernel frees that layer buffer
//  from the heap. The resident result (the full gw.s + the full layersArr) disappears, so the WASM heap peak drops sharply
//  -> large models avoid OOM. The final 'done' carries stats only.
//  In economy mode (params.economy) only G-code chunks are emitted, without toolpaths (finishes without a preview).
//  The MM / real-PE paths fall back to batch mode.
// Automatic multithreaded kernel selection: with crossOriginIsolated (sites serving COOP/COEP) it uses mt (-pthread, PASS1
//  layers in parallel — measured 2.2x), otherwise st (zero-config). The dynamic import makes bundlers emit both as chunks,
//  but only one is loaded at runtime. On mt init failure (SAB blocked, …) it falls back to st.
// Which kernel loaded is worth saying once — mt vs st is a 2x difference and the fallback is silent otherwise.
//  A host embedding the viewer in its own product can switch it off (`<Viewport features={{ logs: false }} />`,
//  which sets `quiet` on the messages it sends): this is a separate module instance from the viewer's log.js and
//  cannot read a flag set over there.
import { assertLegacySlaFallback, parseSlaJob } from './sla_request.js'
import { withSliceWarnings } from './warnings.js'
import { withSliceThroughput } from './throughput.js'
import { FILL_TOOLS } from 'three-slicer-viewer/paint'

// The kernel parses `params` as JSON text, so the raw protocol used to require a string — while the direct handle
//  and createSlicerClient both take an object and stringify it for you. One object, two shapes, and the difference
//  showed up only at the boundary. The worker now accepts either; the SLA branch always did, which is what made
//  the split arbitrary rather than principled.
const paramsText = (params) => (typeof params === 'string' ? params : JSON.stringify(params ?? {}))

let quiet = false
const say = (level, ...args) => { if (!quiet) console[level](...args) }

// Which variant loaded is also REPORTED (the 'warm' reply carries `kernel`), not just logged: mt vs st is a
//  measured 9.8x on a 3M-facet model, and the viewer sizes its plate-parallel worker pool by it.
let kernelKind = null
const loadCore = async () => {
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
  if (isolated) {
    try {
      const M = await (await import('./slicer_core.mt.js')).default()
      say('info', '[slicer.worker] core: mt (threads)')
      kernelKind = 'mt'
      return M
    } catch (e) { say('warn', '[slicer.worker] mt load failed — falling back to st:', e) }
  }
  const M = await (await import('./slicer_core.js')).default()
  say('info', '[slicer.worker] core: st')
  kernelKind = 'st'
  return M
}

let modPromise = null

// Stage 20 painting states = upstream's EnforcerBlockerType (see packages/wasm-core/selector_bridge.h):
//  0=NONE, 1=ENFORCER(==Extruder1), 2=BLOCKER(==Extruder2), 3..16=Extruder3..Extruder16.
// The kernel exposes both a boolean pair (selector_paint/…_count/…_overlay) and integer-state twins (…_state);
//  the boolean wrappers are NOT redundant, they are what maps false -> BLOCKER(2) on the C++ side.
const PAINT_STATE_ENFORCER = 1
const PAINT_STATE_BLOCKER = 2
const PAINT_STATE_MAX = 16

// A state is only a state when it is literally an integer in [1,16]. This predicate is the hazard guard: embind
//  coerces a JS `false` to the int 0 == NONE, so a boolean that leaked into the state path would paint nothing and
//  silently turn blocker painting into a no-op. `Number.isInteger(false)` is false, so a boolean can never pass here
//  and never reaches the *_state entry points — it stays on the boolean binding that means BLOCKER.
const isPaintState = (value) => Number.isInteger(value) && value >= PAINT_STATE_ENFORCER && value <= PAINT_STATE_MAX

// Stands in for an overlay the request did not ask for. Shared and never transferred (the transfer list drops
//  zero-length buffers), so the one instance stays valid for every reply that needs a placeholder.
const EMPTY_OVERLAY = new Float32Array(0)

// Throws (-> the catch below posts {type:'error'}) rather than clamping: a bad state is a caller bug, and silently
//  substituting one would paint the wrong extruder, which is far harder to notice than an error banner.
const validatedPaintStates = (states) => {
  for (const state of states)
    if (!isPaintState(state)) throw new Error(`paint state must be an integer 1..${PAINT_STATE_MAX} (got ${JSON.stringify(state)})`)
  return states
}

// Which states a message wants reported per-state. null == a legacy message (no `state`/`states` field) -> the reply
//  must stay exactly {enf, blk} / {enf, blk} as it was before the protocol was widened, because the in-app support
//  flow (viewer use_slicer.js) reads those two fields and nothing else.
const reportedPaintStates = (message, paintedState) => {
  if (Array.isArray(message.states)) return validatedPaintStates(message.states)
  return paintedState === null ? null : [paintedState]
}

// The state a paint message asks for: an explicit `state` wins, otherwise null meaning "use the legacy boolean path".
//  Note the check is on presence-and-integerness, never on truthiness — see isPaintState above.
const explicitPaintState = (message) => {
  if (message.state === undefined || message.state === null) return null
  validatedPaintStates([message.state])
  return message.state
}

// Brush cursor shape (selector_bridge.h CURSOR_*). Sent as a name because the message is a protocol a host writes
//  by hand; the integer stays on this side of it. Anything unknown is the sphere the brush has always used.
const cursorShapeOf = (message) => (message.cursor === 'circle' ? 1 : 0)

// The tools that are not the radius brush: upstream's Smart fill and Bucket fill, plus its single-triangle POINTER
//  cursor — which is literally bucket fill with propagation off, so the three share one dispatch. None of them takes
//  a radius or a camera: what they select comes from the mesh's own topology, which is why they are a branch rather
//  than more optional fields on the brush call. `state === null` means erase (the entry points with no state
//  argument), matching how the brush splits paint from erase.
// The previous sample of the current stroke, when the message carries one. Upstream paints the CAPSULE between two
//  consecutive mouse positions (DoublePointCursor, GLGizmoPainterBase.cpp:878) — a pointer stream is sampled, not
//  continuous, so a ball per sample leaves a fast drag as a row of blobs with gaps between them. Optional on the
//  wire and feature-detected on the kernel, so a caller or a build without it keeps painting single points.
const strokeFrom = (message) =>
  Number.isFinite(message.px) && Number.isFinite(message.py) && Number.isFinite(message.pz)

// The fill modes the kernel's fill_preview takes (selector_bridge.h FILL_*), by the tool name the protocol uses.
const FILL_PREVIEW_MODE = { smart: 0, bucket: 1, triangle: 2 }

const applyFill = (Module, message, state) => {
  const angle = Number.isFinite(message.angle) ? message.angle : 30
  if (message.tool === 'smart') {
    if (state === null) Module.selector_seed_fill_erase(message.facet, message.hx, message.hy, message.hz, angle)
    else Module.selector_seed_fill(message.facet, message.hx, message.hy, message.hz, angle, state)
    return
  }
  // Upstream passes -1 as the angle when it is not propagating (GLGizmoPainterBase.cpp ~861): with a single facet
  //  there is no neighbour to measure an angle against, and -1 is how that call says "no angle limit".
  const propagate = message.tool === 'bucket'
  const bucketAngle = propagate ? angle : -1
  if (state === null) Module.selector_bucket_fill_erase(message.facet, message.hx, message.hy, message.hz, bucketAngle, propagate)
  else Module.selector_bucket_fill(message.facet, message.hx, message.hy, message.hz, bucketAngle, propagate, state)
}

// paint and erase both mutate the same selector, so both have to re-read every count the caller asked about: an
//  erase over a T3 region lowers T3 exactly the way overpainting it with T2 would, and a reply carrying only the
//  state that was written would leave the other chips showing stale numbers. `enf`/`blk` stay unconditional so a
//  listener predating the per-state map keeps working; `counts` appears only when the message asked for states,
//  which is what keeps a legacy paint reply byte-identical to what it was before the protocol was widened.
const paintedReply = (Module, message, paintedState) => {
  const answer = { type: 'painted', enf: Module.selector_painted_count(true), blk: Module.selector_painted_count(false) }
  const states = reportedPaintStates(message, paintedState)
  if (states) answer.counts = Object.fromEntries(states.map(state => [state, Module.selector_painted_count_state(state)]))
  return answer
}

self.onmessage = async (e) => {
  const d = e.data
  // Every reply to a request that carried a `requestId` carries it back, the error reply included — so a caller
  //  waiting on one request cannot take another request's answer (or another command's error) for its own. A
  //  request without one gets exactly the replies it always got.
  const reply = (message, transfer) => {
    if (d?.requestId === undefined) { self.postMessage(message, transfer); return }
    self.postMessage({ ...message, requestId: d.requestId }, transfer)
  }
  // Read before the kernel loads: loadCore() below is what prints, so a `quiet` arriving with the first message
  //  (the warmup) has to take effect before that call, not after it.
  if (d.quiet !== undefined) quiet = !!d.quiet
  try {
    // Asking for the painting must not be what LOADS the kernel. Every other command needs it, but if this worker
    //  has never loaded it then selector_prepare has never run either, so there is no painting to report — and
    //  making a save wait on a 4MB WASM load before the first slice is seconds of nothing, for an empty answer.
    if (d.cmd === 'exportPaint' && !modPromise) {
      reply({ type: 'paintExport', supported: false, facets: [], hex: '' }); return
    }
    if (d.cmd === 'slaJob') {
      const job = parseSlaJob(d.job)
      if (!modPromise) modPromise = loadCore()
      const Kernel = await modPromise
      const onProgress = (done, total) => reply({ type: 'progress', done, total })
      if (Kernel.slice_sla_job) {
        Kernel.set_layer_sink((z, idx, gcode, paths, widths) => {
          const transfer = []
          if (paths?.buffer) transfer.push(paths.buffer)
          if (widths?.buffer) transfer.push(widths.buffer)
          reply({ type: 'layer', z, idx, gcode: '', paths, widths }, transfer)
        })
        let r
        const started = performance.now()
        try { r = Kernel.slice_sla_job(job, onProgress) }
        finally { Kernel.clear_layer_sink() }
        if (r?.error) { reply({ type: 'error', error: String(r.error) }); return }
        reply({ type: 'done', result: withSliceThroughput(r, performance.now() - started) }); return
      }
      reply({ type: 'error', code: 'SLA_UNSUPPORTED_OBJECT_AWARE',
                        error: 'Object-aware SLA slicing requires WASM kernel support' })
      return
    }
    // SLA slicing runs in the WASM kernel (slice_sla — contours + generated supports, C++ Clipper speed), through
    //  the same layer-sink streaming a kernel slice uses. The pure-JS contour slicer (sla_core.js) stays as the
    //  fallback for a loaded kernel that predates the binding — it produces the same stream, minus the supports.
    if (d.cmd === 'sla') {
      const params = paramsText(d.params)
      if (!modPromise) modPromise = loadCore()
      const Kernel = await modPromise
      const onProgress = (done, total) => reply({ type: 'progress', done, total })
      if (Kernel.slice_sla) {
        Kernel.set_layer_sink((z, idx, gcode, paths, widths) => {
          const transfer = []
          if (paths && paths.buffer) transfer.push(paths.buffer)
          if (widths && widths.buffer) transfer.push(widths.buffer)
          reply({ type: 'layer', z, idx, gcode: '', paths, widths }, transfer)
        })
        let r
        const started = performance.now()
        try { r = Kernel.slice_sla(new Uint8Array(d.stl), params, onProgress) }
        finally { Kernel.clear_layer_sink() }
        if (r && r.error) { reply({ type: 'error', error: String(r.error) }); return }
        reply({ type: 'done', result: withSliceThroughput(r, performance.now() - started) })
        return
      }
      const { sliceSla } = await import('./sla_core.js')
      const fallbackParams = JSON.parse(params)
      assertLegacySlaFallback(fallbackParams)
      // The JS fallback reports no phase timings at all, so its `kernelMs` comes back null rather than 0 — the
      //  wall time and the two rates are still the honest figures for what it did.
      const startedFallback = performance.now()
      const r = sliceSla(new Uint8Array(d.stl), fallbackParams, {
        onProgress,
        onLayer: (L) => {
          const transfer = []
          if (L.paths?.buffer) transfer.push(L.paths.buffer)
          if (L.widths?.buffer) transfer.push(L.widths.buffer)
          reply({ type: 'layer', z: L.z, idx: L.idx, gcode: '', paths: L.paths, widths: L.widths }, transfer)
        },
      })
      if (r && r.error) { reply({ type: 'error', error: String(r.error) }); return }
      reply({ type: 'done', result: withSliceThroughput(r, performance.now() - startedFallback) })
      return
    }
    if (!modPromise) modPromise = loadCore()
    const Module = await modPromise
    // Warmup: only load the kernel (+ spawn the mt pthread pool) ahead of time — removes the perceived load on the first slice
    if (d.cmd === 'warmup') { reply({ type: 'warm', kernel: kernelKind }); return }
    // Stage 20: manual support painting — selector state persists in this worker Module (slicing uses the same Module).
    // `keepPaint` says the mesh is the same model in a new place, so the marks carry over — the reply reports whether
    //  they actually did, since a face-count change makes the kernel fall back to a clean registration.
    if (d.cmd === 'prepare') {
      const kept = d.keepPaint ? Module.selector_reprepare(new Uint8Array(d.stl)) : (Module.selector_prepare(new Uint8Array(d.stl)), false)
      reply({ type: 'prepared', facets: Module.selector_facet_count(), kept })
      return
    }
    // paint: legacy {enforcer:boolean} stays on the boolean binding (false == BLOCKER); {state:1..16} reaches any
    //  extruder through the state binding. `enf`/`blk` are always reported so an old listener keeps working, and the
    //  per-state `counts` map is added ONLY when the message asked for states (keeps the legacy reply byte-identical).
    if (d.cmd === 'paint')   {
      const paintedState = explicitPaintState(d)
      if (FILL_TOOLS.has(d.tool)) {
        // The fills are newer than the boolean protocol, so there is no legacy reading to fall back to — a fill
        //  without an explicit integer state is a malformed message, not an enforcer stroke.
        if (paintedState === null) throw new Error(`a '${d.tool}' fill needs an explicit integer state`)
        applyFill(Module, d, paintedState)
      }
      else if (paintedState === null) Module.selector_paint(d.facet, d.hx, d.hy, d.hz, d.cx, d.cy, d.cz, d.radius, d.enforcer)
      else if (strokeFrom(d) && Module.selector_paint_stroke)
        Module.selector_paint_stroke(d.facet, d.px, d.py, d.pz, d.hx, d.hy, d.hz, d.cx, d.cy, d.cz, d.radius, paintedState, cursorShapeOf(d))
      else Module.selector_paint_shape(d.facet, d.hx, d.hy, d.hz, d.cx, d.cy, d.cz, d.radius, paintedState, cursorShapeOf(d))
      reply(paintedReply(Module, d, paintedState)); return
    }
    // erase: the brush writes NONE, returning the brushed facets to the default extruder (upstream's shift+drag).
    //  It is its OWN command and NOT `{cmd:'paint', state:0}`, because 0 is the one integer a boolean can become:
    //  embind coerces a JS `false` to 0 == NONE, so widening isPaintState to admit 0 would let a stray boolean on
    //  the state path erase silently — the exact failure that guard was written to stop (see isPaintState above).
    //  A boolean cannot forge the string 'erase', and the kernel binding it reaches takes no state argument at all,
    //  so there is nothing left for a coercion to slip through. The reply is a normal 'painted' one: an erase is a
    //  change to the same counts, and the viewer's listeners must not need to know which brush produced it.
    if (d.cmd === 'erase')   {
      if (FILL_TOOLS.has(d.tool)) applyFill(Module, d, null)
      else if (strokeFrom(d) && Module.selector_erase_stroke)
        Module.selector_erase_stroke(d.facet, d.px, d.py, d.pz, d.hx, d.hy, d.hz, d.cx, d.cy, d.cz, d.radius, cursorShapeOf(d))
      // The eraser gets the cursor shape too, or a shift+drag with the circle brush rubs out the far side of a wall
      //  the paint brush never touched. `selector_erase` (no shape) stays the fallback for an older kernel.
      else if (Module.selector_erase_shape) Module.selector_erase_shape(d.facet, d.hx, d.hy, d.hz, d.cx, d.cy, d.cz, d.radius, cursorShapeOf(d))
      else Module.selector_erase(d.facet, d.hx, d.hy, d.hz, d.cx, d.cy, d.cz, d.radius)
      reply(paintedReply(Module, d, null)); return
    }
    // importPaint: load painting out of a 3mf. `facets` is an Int32Array of facet indices in the CURRENT selector's
    //  numbering and `hex` the newline-joined per-facet split-tree strings the 3mf carried, in the same order.
    //  It REPLACES every mark (the kernel's deserialize resets first), so it belongs immediately after a 'prepare'
    //  and nowhere else — an import in the middle of a session would silently discard what the user had painted.
    //  A kernel built before this binding existed simply has no selector_import_paint; the reply says applied:0
    //  rather than throwing, because losing a 3mf's paint must not also lose its geometry.
    if (d.cmd === 'importPaint') {
      const applied = Module.selector_import_paint ? Module.selector_import_paint(d.facets, d.hex ?? '') : 0
      const importedReply = paintedReply(Module, d, null)
      importedReply.applied = applied
      reply(importedReply); return
    }
    // exportPaint: the reverse of importPaint — every marked facet's split tree as {facets, hex} in the CURRENT
    //  selector's numbering, the same parallel-array pairing importPaint takes (hex is one newline-joined blob).
    //  The caller (3mf save) rebases the facet indices back onto per-object numbering; this worker cannot, because
    //  which objects were merged in what order is the viewer's knowledge. A kernel built before the binding existed
    //  reports supported:false rather than throwing — the save then falls back to the paint it imported.
    if (d.cmd === 'exportPaint') {
      const exported = Module.selector_export_paint ? Module.selector_export_paint() : null
      reply({ type: 'paintExport', supported: !!Module.selector_export_paint,
                         facets: exported?.facets ?? [], hex: exported?.hex ?? '' })
      return
    }
    // clear wipes every state at once, so each requested count is 0 by construction — no need to ask the kernel back.
    if (d.cmd === 'clear')   {
      Module.selector_clear()
      const clearedReply = { type: 'painted', enf: 0, blk: 0 }
      const states = reportedPaintStates(d, null)
      if (states) clearedReply.counts = Object.fromEntries(states.map(state => [state, 0]))
      reply(clearedReply); return
    }
    // overlay: `enf`/`blk` (states 1/2) are always sent because the viewer's overlay rebuild consumes exactly those two;
    //  `overlays` adds the requested states, so an MMU caller can ask for 3..16 without losing the support overlays.
    //  The kernel already hands back a detached Float32Array (bindings.cpp to_f32 does typed_memory_view().slice()),
    //  so the arrays are posted as they are and their buffers TRANSFERRED. The previous Array.from() turned each one
    //  into a plain JS Array, which the structured clone then had to copy element by element — measured at 1.1 ms of
    //  a 3.6 ms stroke sample on a 40k-triangle mesh, and growing with the painted area because the whole overlay is
    //  resent every sample. Transferring costs nothing and the arrays are this worker's own copies, so nothing here
    //  can observe them being neutered.
    if (d.cmd === 'overlay')  {
      const states = reportedPaintStates(d, null)
      // enf/blk stay unconditional for the listener that predates the per-state map. When the request names states,
      //  they are the ONLY ones read, so building the other two would be pure waste on the hot path.
      const wanted = states && !states.includes(PAINT_STATE_ENFORCER) && !states.includes(PAINT_STATE_BLOCKER)
      const overlayReply = { type: 'overlay',
        enf: wanted ? EMPTY_OVERLAY : Module.selector_overlay(true),
        blk: wanted ? EMPTY_OVERLAY : Module.selector_overlay(false) }
      if (states) overlayReply.overlays = Object.fromEntries(states.map(state => [state, Module.selector_overlay_state(state)]))
      const transfer = [overlayReply.enf, overlayReply.blk, ...Object.values(overlayReply.overlays ?? {})]
        .filter(a => a?.buffer && a.byteLength > 0).map(a => a.buffer)
      reply(overlayReply, transfer); return
    }

    // fillPreview: what a fill WOULD select, without applying it. Upstream runs this on every mouse move while a
    //  fill tool is active and draws the result in a lighter shade (GLGizmoPainterBase.cpp:929) — a preview marks
    //  nothing, so it needs no state at all and there is no NONE for a stray boolean to become. `{clear:true}`
    //  drops the standing selection, which is what leaving the model under the pointer means.
    if (d.cmd === 'fillPreview') {
      if (!Module.selector_fill_preview) { reply({ type: 'fillPreview', supported: false, tris: EMPTY_OVERLAY }); return }
      if (d.clear) { Module.selector_fill_preview_clear(); reply({ type: 'fillPreview', supported: true, tris: EMPTY_OVERLAY }); return }
      const angle = Number.isFinite(d.angle) ? d.angle : 30
      const mode = FILL_PREVIEW_MODE[d.tool] ?? FILL_PREVIEW_MODE.smart
      // Upstream's -1 for the non-propagating case, the same value applyFill sends: one facet has no neighbour to
      //  measure an angle against.
      const tris = Module.selector_fill_preview(d.facet, d.hx, d.hy, d.hz, mode === FILL_PREVIEW_MODE.triangle ? -1 : angle, mode)
      reply({ type: 'fillPreview', supported: true, tris },
                       tris?.buffer && tris.byteLength > 0 ? [tris.buffer] : [])
      return
    }
    // paintMode: the brush-wide options upstream keeps on the gizmo — the overhang restriction and the section
    //  plane. Both are set once and read by every stroke, so they are their own command rather than fields on one.
    if (d.cmd === 'paintMode') {
      if (Number.isFinite(d.overhangDeg) && Module.selector_set_overhang_limit) Module.selector_set_overhang_limit(d.overhangDeg)
      if (Module.selector_set_clip_plane) {
        const plane = d.clipPlane
        if (plane) Module.selector_set_clip_plane(plane[0], plane[1], plane[2], plane[3], true)
        else if (d.clipPlane === null) Module.selector_set_clip_plane(0, 0, 1, 0, false)
      }
      reply({ type: 'paintMode', ok: true }); return
    }

    if (d.stall) return   // stage-30 test hook: simulate a hang -> verifies the main-thread watchdog fires (not set in production)
    // mt (SAB): share the address of the real support progress counter (u32) with main once — even while the kernel is
    //  blocked inside C++, the UI thread polls the SAB directly to show support progress. st (non-shared buffer) is unsupported -> not sent.
    if (!self.__supSabSent) {
      self.__supSabSent = true
      try {
        // Module.HEAPU8 is not exposed by the emscripten 6.x glue — obtain the buffer via embind typed_memory_view
        const v = Module.sup_progress_view && Module.sup_progress_view()
        const c = Module.cancel_flag_view && Module.cancel_flag_view()
        if (v && v.buffer instanceof SharedArrayBuffer)
          reply({ type: 'supsab', buf: v.buffer, ptr: v.byteOffset, cancelPtr: c?.byteOffset ?? 0 })
      } catch {}
    }
    // Default: slice. Register the layer sink -> the kernel calls back per layer (z, idx, gcodeChunk, pathsF32, widthsF32).
    //  Each layer is transferred to main immediately (toolpath buffers moved) -> the worker copy is freed -> heap headroom before the next layer.
    const onProgress = (done, total) => reply({ type: 'progress', done, total })
    Module.set_layer_sink((z, idx, gcode, paths, widths) => {
      const transfer = []
      if (paths && paths.buffer) transfer.push(paths.buffer)     // economy mode yields empty arrays (no .buffer) -> nothing to transfer
      if (widths && widths.buffer) transfer.push(widths.buffer)
      reply({ type: 'layer', z, idx, gcode, paths, widths }, transfer)
    })
    let r
    // Timed around the kernel call INCLUDING the layer sink, which posts each layer to the main thread from inside
    //  it — that transfer is part of what a streamed slice costs and leaving it out would flatter the number.
    const started = performance.now()
    try { r = Module.slice(new Uint8Array(d.stl), paramsText(d.params), onProgress) }
    finally { Module.clear_layer_sink() }
    if (r && r.error) { reply({ type: 'error', error: String(r.error) }); return }
    // streamed=true -> g-code/layers were already emitted as 'layer' (result holds stats only). batch/MM keep them in result.
    // withSliceWarnings names what the slice got away with (an off-bed model) on the result itself, and
    //  withSliceThroughput how fast it ran — the raw protocol carries both, so createSlicerClient's callers get
    //  them without the client having to re-derive anything.
    reply({ type: 'done', result: withSliceThroughput(withSliceWarnings(r), performance.now() - started) })
  } catch (err) {
    // Includes the WASM abort("memory access out of bounds") — the main thread's OOM ladder decides on re-creation / economy retry.
    const errorReply = { type: 'error', error: String((err && err.message) || err) }
    if (err?.code) errorReply.code = err.code
    reply(errorReply)
  }
}
