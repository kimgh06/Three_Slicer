import * as THREE from 'three'
import { log } from '../core/log.js'
import { paintStateColor } from '../core/paint_colors.js'
import { MAX_PAINT_EXTRUDERS } from '../core/viewer_defaults.js'
import { splitPaintByObject, storePaint, mergedPaint, paintKindFor, paintTriangles, storedPaintKind } from '../core/paint_store.js'
import { request } from '../core/worker_reply.js'

// Stage 20: manual support painting (enforcer/blocker), extended to material painting — brushing a region so it
//  prints with another extruder. Both brushes drive the same selector, which is why they are one mode variable.

// Upstream's EnforcerBlockerType (libslic3r/TriangleSelector.hpp) is a single enum with two readings:
//  NONE=0, ENFORCER=1, BLOCKER=2, Extruder3..16 — ENFORCER *is* Extruder1 and BLOCKER *is* Extruder2. One integer
//  per facet, so a material mark and a support mark cannot coexist on the same facet; that is the reason the two
//  painting modes are mutually exclusive here rather than a UI simplification.
export const PAINT_STATE_NONE = 0
export const PAINT_STATE_ENFORCER = 1   // also "extruder 1"
export const PAINT_STATE_BLOCKER = 2    // also "extruder 2"
export { MAX_PAINT_EXTRUDERS }   // defined in core/viewer_defaults.js; re-exported for existing importers

// Paint mode -> the integer the selector stores on every brushed facet. `materialExtruderIndex` is 0-based (T1 = 0);
//  null/absent means the eraser is selected, which writes NONE — the same value that clears a support mark.
export function paintStateFor(paintMode, materialExtruderIndex) {
  if (paintMode === 'enforcer') return PAINT_STATE_ENFORCER
  if (paintMode === 'blocker') return PAINT_STATE_BLOCKER
  if (paintMode !== 'material') return PAINT_STATE_NONE
  if (!Number.isInteger(materialExtruderIndex) || materialExtruderIndex < 0) return PAINT_STATE_NONE   // eraser
  return Math.min(materialExtruderIndex + 1, MAX_PAINT_EXTRUDERS)
}

// How a paint overlay is drawn, for the kernel's overlay and the stored one alike: translucent over the model, and
//  pulled toward the camera by a polygon offset because it is coplanar with the surface it marks (see mk below).
const PAINT_OVERLAY_OPACITY = 0.55
const PAINT_OVERLAY_POLYGON_OFFSET = -1
const paintOverlayMaterial = (color, clippingPlanes = null) => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity: PAINT_OVERLAY_OPACITY, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: PAINT_OVERLAY_POLYGON_OFFSET, polygonOffsetUnits: PAINT_OVERLAY_POLYGON_OFFSET,
  clippingPlanes })
const PAINT_OVERLAY_RENDER_ORDER = 999   // after the model, so the translucent overlay blends over it

// The worker's painting as {facets, hex} in the held selector's numbering, or null when there is none to have
//  (no worker, a kernel without the export binding, an error reply, a worker that died — worker_reply.js ends the
//  wait on each). `timeoutMs` bounds it for a caller that can live without the answer; the store's write-back passes
//  none, because the reply queues behind whatever the worker is doing — a long slice — and giving up there would
//  prepare the next mesh over paint never saved.
export const PAINT_EXPORT_TIMEOUT_MS = 4000
export async function requestPaintExport(worker, timeoutMs = PAINT_EXPORT_TIMEOUT_MS) {
  const reply = await request(worker, { cmd: 'exportPaint' }, { types: ['paintExport'], timeoutMs })
  if (!reply?.supported) return null
  return reply
}

// The component keeps owning the refs/state; this factory only receives what it uses and is rebuilt each render.
export function makeSupportPaint(deps) {
  const {
    three, objectsRef, apiRef, getWorker, selectedPlateRef, selectorGeomRef,
    paintXformRef, paintOverlayRef, paintModeRef, materialExtruderRef, extruderColorsRef,
    setError, setPaintModeState, setPaintCounts, setPaintStateCounts, setSliceNotice, paintStateCountsRef,
    isSelectorSlicing = () => false,
  } = deps
  // The counts a slice reads (use_slicer.js buildParams) — written here synchronously as well as through React
  //  state, because a slice posted right after a selector swap cannot wait for a render to carry them into the ref.
  const publishCounts = (counts) => { if (paintStateCountsRef) paintStateCountsRef.current = counts; setPaintStateCounts?.(counts) }

  // Identity of the mesh the kernel's selector currently holds. `prepare` builds a NEW TriangleSelector, which
  //  discards every mark on it, so re-sending it for unchanged geometry silently deletes the user's paint. Entering
  //  the brush is not rare — Esc, the Close button, any gizmo button and every slice leave paint mode, so the
  //  natural "paint T2, slice to check, come back and paint T3" order used to wipe T2 (measured: T3 2225 -> 0).
  //  Cheap identity, not a hash: byte length plus a strided sample of the merged STL. It has to catch a move or a
  //  rotate, which change vertex coordinates all over the buffer, so a fixed stride over the whole thing does it
  //  without walking megabytes on every brush entry.
  const geomIdentity = (buf) => {
    const view = new Uint8Array(buf)
    let signature = view.length
    const stride = Math.max(1, Math.floor(view.length / 4096))
    for (let i = 0; i < view.length; i += stride) signature = (signature * 31 + view[i]) | 0
    return `${view.length}:${signature}`
  }

  // Facet count per state as of the last reply, so the next one can name only the states that moved. It hangs off
  //  the WORKER, not off this factory: the factory is rebuilt on every render while the message listener is
  //  registered once, so a plain local would leave the listener writing one object and everyone else reading a
  //  fresh empty one — which is exactly why the reset notice below never fired the first time round.
  const lastCounts = (worker) => (worker.__paintLastCounts ??= {})

  // Which selector states a reply should report a count for: every configured extruder, not just the one the brush
  //  is writing. One facet holds one state (see paintStateFor), so brushing T3 over a T2 region *lowers* T2's count —
  //  a reply carrying only the painted state would leave every other chip showing the number it had before it was
  //  overpainted. Asking for all of them costs one kernel count call per extruder per stroke sample (<=4 here).
  function reportedPaintStates() {
    const extruderCount = Array.isArray(extruderColorsRef?.current) ? extruderColorsRef.current.length : 0
    const states = []
    for (let extruderIndex = 0; extruderIndex < Math.min(extruderCount, MAX_PAINT_EXTRUDERS); extruderIndex++)
      states.push(extruderIndex + 1)
    // The support brush runs with the same stamping and needs states 1/2 present even before a second filament exists.
    if (!states.includes(PAINT_STATE_ENFORCER)) states.push(PAINT_STATE_ENFORCER)
    if (!states.includes(PAINT_STATE_BLOCKER)) states.push(PAINT_STATE_BLOCKER)
    return states.sort((a, b) => a - b)
  }

  // The pointer handler that builds the `paint` message lives in use_three_scene.js and knows only the original
  //  boolean (`enforcer`), because paintModeRef is the single thing it reads about the brush. The worker handle is
  //  the one seam every brush stroke passes through, so the integer state is stamped on here instead of duplicating
  //  the raycast. `enforcer` is kept and recomputed from that state: for the two support modes it is exactly the
  //  value that was sent before (state 1 -> true, state 2 -> false), so a kernel that does not read `state` yet
  //  still paints support byte-for-byte as it did. Such a kernel can only express states 1 and 2, so material paint
  //  on T3+ needs the new integer argument to have landed — the support path never does. Measured against the
  //  current worker on a T3 stroke: it sends {state:3} and gets {type:'painted', enf:0, blk:0, counts:{3:3762}}
  //  back, so the integer argument HAS landed and only the reply's `counts` was going unread.
  //
  // The same seam also reads the reply, for the same reason it writes the request: `counts` is the only place an
  //  extruder above T2 is ever counted (`enf`/`blk` are states 1 and 2 by definition), and the shared worker
  //  message handler in use_slicer.js forwards nothing but those two fields. This listener and that handler are
  //  two independent listeners writing two independent state atoms, so neither can clobber the other whichever
  //  order the browser dispatches them in, and React batches both into a single render.
  function paintStateAwareWorker() {
    const worker = getWorker()
    if (!worker || worker.__paintStateStamped) return worker
    const post = worker.postMessage.bind(worker)
    worker.postMessage = (...args) => {
      const message = args[0]
      // The overlay request needs the same state list for the same reason the paint request does: without it the
      //  worker answers with `enf`/`blk` only, which ARE states 1 and 2, so every extruder above T2 was painted in
      //  the kernel (its counter moved) and had no geometry to draw. Stamped here rather than at the call site
      //  because the reply's consumer lives in use_slicer.js and knows nothing about how many extruders exist.
      if (message && message.cmd === 'overlay' && !message.states) {
        args[0] = { ...message, states: reportedPaintStates() }
        return post(...args)
      }
      // Shift+drag sends 'erase' from the pointer handler itself (paint_input.js), because the modifier is a
      //  property of the STROKE and not of the selected chip. It still needs the state list stamped on, or the
      //  reply carries no `counts` and the overlay of whatever was just erased stays on screen.
      if (message && message.cmd === 'erase' && !message.states) {
        args[0] = { ...message, states: reportedPaintStates() }
        return post(...args)
      }
      if (message && message.cmd === 'paint') {
        const state = paintStateFor(paintModeRef.current, materialExtruderRef?.current)
        // The eraser resolves to NONE, which is not a paint state and never will be: the worker rejects an integer
        //  0 on the state path on purpose, because embind turns a JS `false` into 0 and a boolean must not be able
        //  to erase. So the stroke changes COMMAND instead of state — 'erase' carries no state at all, and the
        //  kernel binding behind it has no state parameter either. `enforcer` is dropped with it: on the paint path
        //  that boolean means BLOCKER, and an erase writes no state, so carrying it would only invite a misread.
        if (state === PAINT_STATE_NONE) {
          const eraseStroke = { ...message, cmd: 'erase', states: reportedPaintStates() }
          delete eraseStroke.enforcer
          args[0] = eraseStroke
        } else {
          args[0] = { ...message, state, states: reportedPaintStates(), enforcer: state === PAINT_STATE_ENFORCER }
        }
      }
      return post(...args)
    }
    // The overlay refresh is driven from here, and only for the states whose facet count actually moved. A stroke
    //  changes at most the state being written plus whichever states it overpainted, but the request used to name
    //  every configured extruder — and the reply carries EVERY painted facet of each, so the cost per stroke sample
    //  grew with the total painted area rather than with what the stroke touched. Measured on a 40k-triangle mesh:
    //  2.7 ms/sample at 7.4k painted facets, 7.0 ms at 14.3k, against a 16.7 ms frame.
    worker.addEventListener('message', event => {
      const message = event.data
      if (!message || message.type !== 'painted' || !message.counts) return
      publishCounts(message.counts)
      const seen = lastCounts(worker)
      const changed = Object.entries(message.counts)
        .filter(([state, count]) => seen[state] !== count)
        .map(([state]) => Number(state))
      for (const [state, count] of Object.entries(message.counts)) seen[state] = count
      if (changed.length) post({ cmd: 'overlay', states: changed })
    })
    worker.__paintStateStamped = true
    return worker
  }

  // One facet holds one state, so the SAME state number means "support enforcer" under one brush and "print with
  //  T1" under the other — the overlay colour therefore comes from the active brush, not from the state. Support
  //  keeps its two fixed colours (blue/red is what that mode has always looked like); material painting reads the
  //  filament palette, because an overlay in a colour the filament is not is exactly the thing it must not be.
  //  The mapping itself is core/paint_colors.js, shared with the brush cursor: the preview of what the next stroke
  //  will paint has to be the colour that stroke actually produces.
  function overlayColorFor(state) {
    const mode = paintModeRef.current
    // With no brush open the mode cannot say which kind of paint is on screen, so the kind RECORDED on the held
    //  selector does — set by what was loaded and by the strokes that landed, never by merely opening a brush.
    //  (Opening the support brush without painting used to relabel it: T2 orange redrawn in the blocker red after the
    //  next move.) Material paint drawn in the support blue/red is the one thing the overlay must never be.
    const material = mode === 'material' || (mode !== 'enforcer' && mode !== 'blocker' && selectorGeomRef.current?.kind === 'color')
    return paintStateColor(state, material, extruderColorsRef?.current)
  }
  function disposeOverlayMesh(state) {
    const t = three.current, meshes = paintOverlayRef.current
    const mesh = meshes?.get?.(state)
    if (!mesh) return
    if (t.objectsGroup) t.objectsGroup.remove(mesh)
    mesh.geometry.dispose(); mesh.material.dispose()
    meshes.delete(state)
  }
  function disposeOverlayMeshes() {
    const meshes = paintOverlayRef.current
    if (!meshes?.keys) return
    for (const state of [...meshes.keys()]) disposeOverlayMesh(state)
  }
  // `overlaysByState` is the per-state map the worker sends when the request carried a state list; `enf`/`blk`
  //  remain the fallback for a reply that predates it, and for the support brush the two are the same two meshes.
  //  One mesh per painted state is what makes T3+ visible at all — the previous two-slot version had nowhere to
  //  put them, so painting a third filament changed the counters and nothing on screen.
  function rebuildPaintOverlay(enfArr, blkArr, overlaysByState) {
    const t = three.current; if (!t.objectsGroup) return
    const X = paintXformRef.current || { cx:0, cy:0, minz:0 }
    if (!paintOverlayRef.current?.set) paintOverlayRef.current = new Map()
    const mk = (arr, color) => {
      if (!arr || arr.length < 9) return null
      const pos = new Float32Array(arr.length)
      for (let i=0;i<arr.length;i+=3){ const kx=arr[i],ky=arr[i+1],kz=arr[i+2];  // kernel -> STL -> viewer(Y-up)
        pos[i]=kx+X.cx; pos[i+1]=kz+X.minz; pos[i+2]=-(ky+X.cy) }
      // No computeVertexNormals: MeshBasicMaterial is unlit and never reads them, and computing them is by far the
      //  most expensive part of this rebuild — measured on an M5 Pro at 0.2 ms for 5k triangles, 4.1 ms at 100k and
      //  8.0 ms at 200k, against 1.0-1.4 ms for everything else put together. It runs once per stroke sample.
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3))
      // Depth-tested, and pulled towards the camera by a polygon offset. The overlay is COPLANAR with the surface
      //  it marks, so without the offset it z-fights the model; the offset is the decal fix for that, and it is the
      //  only one that keeps the depth test — which is what hides paint on the far side. It used to run with
      //  `depthTest: false` instead, and the side effect was exactly the thing an overlay must not do: a mark on
      //  the back of the hull drew straight through the front of it. (Upstream never has this problem because its
      //  MMU gizmo REPLACES the object's own rendering with a per-state coloured pass over the whole selector
      //  — GLGizmoPainterBase.cpp:76 — so nothing is ever drawn twice at one depth.)
      const m = new THREE.Mesh(g, paintOverlayMaterial(color, apiRef.current?.paintClipPlanes?.() ?? null))
      m.renderOrder = PAINT_OVERLAY_RENDER_ORDER; t.objectsGroup.add(m); return m
    }
    // Only the states this reply carries are touched; every other state keeps the mesh it already has. That is what
    //  lets a stroke ask for one state and still leave the rest of the paint on screen, and it is why the reply's
    //  cost is now the stroke's own area rather than everything painted so far.
    const states = overlaysByState
      ? Object.keys(overlaysByState).map(Number).sort((a, b) => a - b).map(state => [state, overlaysByState[state]])
      : [[PAINT_STATE_ENFORCER, enfArr], [PAINT_STATE_BLOCKER, blkArr]]
    for (const [state, arr] of states) {
      disposeOverlayMesh(state)
      const mesh = mk(arr, overlayColorFor(state))
      if (mesh) paintOverlayRef.current.set(state, mesh)
    }
    three.current.invalidate?.()   // worker message path (scene changed without a React re-render)
  }
  function clearPaintOverlay() { disposeOverlayMeshes(); paintOverlayRef.current = null }
  // Every object the selector does NOT hold draws its paint from the store, so a plate keeps its paint on screen
  //  while another one is painted — the kernel overlay above only ever covers the held mesh, and painting a second
  //  plate used to make the first plate's paint look erased (it was only undrawn). The triangles are the kernel's
  //  own split geometry replayed in JS (paintTriangles, pinned against the kernel overlay in test_paint_export.mjs),
  //  in the object's LOCAL frame and attached as children of its mesh, so they move, hide and delete with it.
  function refreshStoredOverlays() {
    const record = selectorGeomRef.current
    const held = new Set(record?.members?.map(member => member.id) ?? [])
    for (const object of objectsRef.current) {
      for (const child of [...object.mesh.children]) {
        if (!child.userData?.storedPaint) continue
        object.mesh.remove(child); child.geometry.dispose(); child.material.dispose()
      }
      // An object the selector holds is drawn by the kernel overlay — for the annotation the selector holds. While
      //  that is the support annotation (a support brush is or was open), its material paint sits in the store only,
      //  and is drawn from there: opening the support brush must not make the material paint vanish from view.
      let kind = storedPaintKind(object.paint)
      if (held.has(object.id)) {
        if (record.kind === 'color' || !object.paint?.color?.size) continue
        kind = 'color'
      }
      if (!kind) continue
      for (const [state, triangles] of paintTriangles(object.localPos, object.paint[kind])) {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3))
        const mesh = new THREE.Mesh(geometry, paintOverlayMaterial(paintStateColor(state, kind === 'color', extruderColorsRef?.current)))
        mesh.userData.storedPaint = true
        mesh.renderOrder = PAINT_OVERLAY_RENDER_ORDER
        object.mesh.add(mesh)
      }
    }
    three.current?.invalidate?.()
  }
  // The selector is one mesh at a time, and swapping it is a round trip: the marks it holds have to come OUT of the
  //  worker (exportPaint) into the per-object store before the next mesh goes in, or they are lost with the old
  //  selector. Every swap, flush and slice-time sync is therefore a job on one chain per worker — a stroke, a slice
  //  or a second swap that slipped into the gap would land on the wrong selector. The chain hangs off the worker
  //  for the same reason lastCounts does: this factory is rebuilt on every render.
  const serial = (worker, job) => {
    const run = (worker.__selectorChain ?? Promise.resolve()).then(job, job)
    // A failed job must not stall every later one, and must not vanish either.
    worker.__selectorChain = run.catch(err => log.warn('[paint] selector job failed:', err))
    return run
  }
  const objectsById = () => new Map(objectsRef.current.map(o => [o.id, o]))
  // Which annotation the held selector's marks are: the active brush's while one is open, else what was loaded or
  //  last brushed. One selector holds one enum (see paintStateFor), so this is a property of the selector.
  // The record of what the selector holds belongs to ONE worker. The watchdog and the memory ladder replace the
  //  worker, and the new one's selector is empty — reading it as "the paint now" wrote empty maps over the store
  //  (measured: an imported plate's 208 painted facets -> 0 on the next save). A record from another worker is no
  //  record: nothing is written back from it, and the next registration loads the store into the new selector.
  const heldBy = (worker) => {
    const held = selectorGeomRef.current
    if (held && held.worker === worker) return held
    return null
  }
  // Which annotation a brush writes — the kind setPaintMode asks the selector to hold.
  const kindOfMode = (mode) => {
    if (mode === 'material') return 'color'
    if (mode === 'enforcer' || mode === 'blocker') return 'supports'
    return null
  }
  // Write the held selector's marks back to the objects it was built from, under the kind RECORDED for them — what
  //  was loaded, or what was last brushed — never the brush mode at write time: a mode switch queues this and flips
  //  the mode before it runs, which filed plate 1's material paint as support paint (measured: color 208 -> supports
  //  208, its tower box gone, drawn in the blocker red). A kernel without the export binding answers null: the store
  //  is then left as it was rather than emptied.
  async function writeBack(worker, timeoutMs = Infinity) {
    const held = heldBy(worker)
    // A record without a kind never had anything loaded or brushed: there is nothing to file, and filing its empty
    //  export under a guessed kind would erase that kind's stored marks.
    if (!held?.members || !held.kind) return false
    const exported = await requestPaintExport(worker, timeoutMs)
    if (!exported) return false
    storePaint(objectsById(), splitPaintByObject(exported, held.members), held.kind)
    return true
  }
  /** Bring every object's stored paint up to date with the selector — before anything reads `object.paint` for an
   *  object the selector holds (a 3mf save, a copy, a slice on another worker). */
  //  `timeoutMs` bounds the wait for a caller that can fall back on the store as it is — a save during a slice: the
  //  selector worker's plate was flushed right before that slice started (syncPaintSelector), so only strokes made
  //  while it runs can be missing. Resolves 'timeout' when the bound ran out, true when written, false otherwise.
  //  While the selector worker slices, it answers nothing until the slice ends — and there is nothing to fetch: the
  //  store was flushed right before the slice (syncPaintSelector), and no stroke reaches the selector during one (the
  //  brush is closed when a slice starts). So a flush then resolves 'busy' at once instead of queueing behind the
  //  slice — a save, a copy or a duplicate used to sit there for the whole slice.
  function flushPaint(timeoutMs = Infinity) {
    const worker = getWorker()
    if (!worker) return Promise.resolve(false)
    if (isSelectorSlicing()) return Promise.resolve('busy')
    return serial(worker, async () => {
      const started = performance.now()
      const written = await writeBack(worker, timeoutMs)
      if (!written && Number.isFinite(timeoutMs) && performance.now() - started >= timeoutMs) return 'timeout'
      return written
    })
  }

  // Hand the kernel the mesh the brush is about to work on — on entering a brush, on every transform commit while
  //  a selector exists, and before the selector worker slices a plate. Returns the chain's promise; a caller that
  //  posts to the worker afterwards (a slice) must await it.
  //  `kind` says which annotation the selector must hold afterwards: 'color' or 'supports' (a brush of that kind was
  //  opened), 'auto' (a slice is about to read it: material paint wins, the import-time rule), or absent (keep the
  //  held one). One selector holds ONE annotation — upstream keeps material and support paint as two annotations of
  //  a volume — so a different kind is a swap: the held marks go back under their own kind and the requested kind is
  //  loaded. Brushing material over a loaded support annotation used to file every support mark as material paint
  //  (measured: supports 0, color 278 after one material stroke).
  function registerSelector(prebuiltMerged = null, { kind: requestedKind } = {}) {
    const worker = paintStateAwareWorker()
    if (!worker) return Promise.resolve()
    return serial(worker, async () => {
      const result = await swapTo(worker, prebuiltMerged, requestedKind)
      refreshStoredOverlays()
      return result
    })
  }
  async function swapTo(worker, prebuiltMerged, requestedKind) {
    const merged = prebuiltMerged ?? apiRef.current?.buildMergedSTL(selectedPlateRef.current); if (!merged) return
    // The selector holds plate-local coordinates, so a raycast hit (world) subtracts the plate origin to match it.
    //  This used to be the model's own bbox centre, which changed the moment the model was dragged — every stroke
    //  after a move landed at the offset the model had when it was last sliced. A plate origin does not move.
    const transform = { cx: merged.offX, cy: -merged.offZ, minz: 0 }
    const held = heldBy(worker)
    const identity = geomIdentity(merged.buf)
    // The kind the selector must end up holding; null means "whatever is there / nothing".
    let wantedKind = held?.kind ?? null
    if (requestedKind === 'color' || requestedKind === 'supports') wantedKind = requestedKind
    if (requestedKind === 'auto') wantedKind = paintKindFor(objectsById(), merged.members) ?? held?.kind ?? null
    const kindChanges = held != null && wantedKind !== null && wantedKind !== held.kind
    const next = { identity, topology: merged.topology, members: merged.members, plate: merged.plate, worker, kind: held?.kind ?? null }
    // Same bytes AND the same objects -> the selector already holds this mesh and every mark on it. Bytes alone
    //  are not enough: a copy on another plate, placed where the original sits on its own plate, merges to the
    //  same plate-local bytes — and was taken for the original, so its plate inherited the original's paint.
    if (held?.identity === identity && held.topology === merged.topology && !kindChanges) {
      selectorGeomRef.current = next; paintXformRef.current = transform; return
    }
    // Same objects with the same faces at new coordinates is a MOVE: the selector is rebuilt on the real positions
    //  (the brush and the layer projection both need them) and the marks are carried across by facet index.
    if (held != null && held.topology === merged.topology && !kindChanges) {
      worker.postMessage({ cmd: 'prepare', stl: merged.buf, keepPaint: true })
      selectorGeomRef.current = next; paintXformRef.current = transform
      // The marks came across; their geometry did not, and no facet count changed to ask for the redraw.
      if (Object.values(lastCounts(worker)).some(count => count > 0)) worker.postMessage({ cmd: 'overlay' })
      return
    }
    // A different set of objects (another plate, an object added or removed), or another annotation of the same
    //  ones: the held marks go back to their objects, and the new mesh is loaded from what its objects hold. No
    //  stroke may land in between — a null transform is what the pointer handler already treats as "no selector".
    paintXformRef.current = null
    const seen = lastCounts(worker)
    const hadPaint = Object.values(seen).some(count => count > 0)
    const kept = await writeBack(worker)
    worker.postMessage({ cmd: 'prepare', stl: merged.buf })
    selectorGeomRef.current = next
    // A fresh selector holds nothing, so every number and every mesh derived from the old one goes with it.
    publishCounts({})
    setPaintCounts?.({ enf: 0, blk: 0 })
    clearPaintOverlay()
    for (const state of Object.keys(seen)) delete seen[state]
    // Only a kernel that cannot export loses paint here now — and that must not be silent.
    if (hadPaint && !kept) setSliceNotice?.('The painted regions were reset: this kernel cannot hand its painting '
                                           + 'back, so it does not survive switching the painted mesh.')
    const loaded = await loadStoredPaint(worker, merged, wantedKind)
    if (loaded === null) {
      // The worker answered the load with an error or died: the selector is empty while the store is not. Nothing may
      //  be written back from it (that would erase the store), no stroke may land on it, and a slice must not run on
      //  it as if the plate were unpainted — the caller that slices turns this into a failed slice.
      if (selectorGeomRef.current) selectorGeomRef.current.kind = null
      setSliceNotice?.('The painting could not be loaded into the slicer; the plate was not sliced with it. Try again.')
      return 'load-failed'
    }
    paintXformRef.current = transform
  }

  // Load a fresh selector from the per-object store (a project's painting arrives the same way: the import puts it
  //  on the objects). Only ever on a FRESH selector: the kernel's import calls upstream's deserialize, which resets
  //  before loading.
  //
  // One facet carries one state (see paintStateFor), and material and support paint are two independent
  //  annotations that CAN both mark the same facet. There is no representation here that holds both, so material
  //  paint wins and the support paint is reported as left out rather than half-applied.
  function loadStoredPaint(worker, merged, requestedKind = null) {
    const objects = objectsById()
    const kind = requestedKind ?? paintKindFor(objects, merged.members)
    // Which kind the selector holds from now on — even with nothing of it to load: the overlay colour reads it
    //  (overlayColorFor), and the write-back files the marks under it.
    if (selectorGeomRef.current) selectorGeomRef.current.kind = kind
    const chosen = mergedPaint(objects, merged.members, kind)
    if (!chosen) return Promise.resolve(true)   // nothing to load is a success
    if (!requestedKind && kind === 'color' && mergedPaint(objects, merged.members, 'supports'))
      setSliceNotice?.('These objects are painted for both material and support. One facet holds one paint state, so '
                     + 'the material painting was loaded and the support painting was left out.')
    // No overlay request follows: the reply carries `counts`, and the message listener above already asks for the
    //  overlay of every state whose count moved — which after an import is every state it loaded. The swap waits
    //  for that reply, so a slice queued behind it reads this mesh's counts, not the previous one's.
    return request(worker, { cmd: 'importPaint', facets: chosen.facets, hex: chosen.hex, states: reportedPaintStates() }, { types: ['painted'] })
  }
  // mode: 'off' | 'enforcer' | 'blocker' | 'material'. Entering either brush leaves the other, because one facet
  //  carries one selector state (see paintStateFor above).
  function setPaintMode(mode) {
    if (mode !== 'off' && objectsRef.current.length === 0) { setError('Upload an STL first'); return }
    if (mode !== 'off') { apiRef.current?.detachTransform(); registerSelector(null, { kind: kindOfMode(mode) }) }
    paintModeRef.current = mode; setPaintModeState(mode)
    apiRef.current?.refreshCursor()   // refresh the cursor hint when entering/leaving paint mode
  }
  // `clear` wipes every state at once, so the per-state map is emptied here rather than read back — the worker's
  //  clear reply only carries `counts` when the request asked for states, and the answer would be all-zero anyway.
  function clearPaint() { getWorker().postMessage({ cmd: 'clear' }); clearPaintOverlay(); setPaintCounts({ enf:0, blk:0 }); publishCounts({}) }

  return { rebuildPaintOverlay, clearPaintOverlay, setPaintMode, clearPaint, registerSelector, flushPaint, refreshStoredOverlays }
}
