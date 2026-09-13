import * as THREE from 'three'
import { paintStateColor } from '../core/paint_colors.js'
import { MAX_PAINT_EXTRUDERS } from '../core/viewer_defaults.js'

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

// The component keeps owning the refs/state; this factory only receives what it uses and is rebuilt each render.
export function makeSupportPaint(deps) {
  const {
    three, objectsRef, apiRef, getWorker, selectedPlateRef, selectorGeomRef,
    paintXformRef, paintOverlayRef, paintModeRef, materialExtruderRef, extruderColorsRef,
    setError, setPaintModeState, setPaintCounts, setPaintStateCounts, setSliceNotice,
  } = deps

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
      setPaintStateCounts?.(message.counts)
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
    // Importing a 3mf draws an overlay while the mode is still 'off' — nobody has entered a brush yet — so the mode
    //  cannot say which kind of paint is on screen. The import records what it loaded for exactly this reason:
    //  material paint drawn in the support blue/red is the one thing the overlay must never be.
    const material = mode === 'material' || (mode !== 'enforcer' && mode !== 'blocker' && getWorker()?.__paintImportKind === 'color')
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
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent:true, opacity:0.55, side:THREE.DoubleSide,
        polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-1,
        clippingPlanes: apiRef.current?.paintClipPlanes?.() ?? null }))
      m.renderOrder = 999; t.objectsGroup.add(m); return m
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
  // Hand the kernel the mesh the brush is about to work on. Called on entering a brush AND on every transform
  //  commit while one is active — a model that moved under the cursor would otherwise be painted where it was.
  function registerSelector(prebuiltMerged = null) {
    const merged = prebuiltMerged ?? apiRef.current?.buildMergedSTL(selectedPlateRef.current); if (!merged) return
    // The selector holds plate-local coordinates, so a raycast hit (world) subtracts the plate origin to match it.
    //  This used to be the model's own bbox centre, which changed the moment the model was dragged — every stroke
    //  after a move landed at the offset the model had when it was last sliced. A plate origin does not move.
    paintXformRef.current = { cx: merged.offX, cy: -merged.offZ, minz: 0 }
    // Re-register ONLY when the mesh really differs from the one the selector holds. Same mesh -> the selector
    //  already has the right facets and every mark on them, so the brush resumes where it left off.
    const held = selectorGeomRef.current
    const identity = geomIdentity(merged.buf)
    if (held?.identity !== identity) {
      // "had paint", not "had a selector": swapping the model with nothing painted resets nothing worth saying.
      const seen = lastCounts(getWorker())
      const hadPaint = Object.values(seen).some(count => count > 0)
      // Same objects with the same faces at new coordinates is a MOVE, not a different model. The selector is
      //  rebuilt either way — the brush and the layer projection both work on real positions — but a move has no
      //  business costing the paint, so the marks are carried across the rebuild by facet index.
      const moved = held != null && held.topology === merged.topology
      const worker = paintStateAwareWorker()
      worker.postMessage({ cmd: 'prepare', stl: merged.buf, keepPaint: moved })
      selectorGeomRef.current = { identity, topology: merged.topology }
      if (moved) {
        // The marks came across; their geometry did not. Every overlay triangle still describes where the model
        //  used to be, and no facet count changed, so nothing else would ask for the redraw.
        if (hadPaint) worker.postMessage({ cmd: 'overlay' })
      } else {
        // A fresh selector holds nothing, so every number and every mesh derived from the old one has to go with
        //  it — including the enf/blk pair, whose stale value used to keep showing a count the kernel no longer had.
        setPaintStateCounts?.({})
        setPaintCounts?.({ enf: 0, blk: 0 })
        clearPaintOverlay()
        for (const state of Object.keys(seen)) delete seen[state]
        // Losing paint to a genuine model change is unavoidable (the facets it was attached to are gone), but it
        //  must not be silent — that is indistinguishable from the bug this replaced.
        if (hadPaint) setSliceNotice?.('The model changed, so the painted regions were reset — the paint is tied to '
                                     + 'the facets it was brushed onto.')
        importProjectPaint(worker, merged)
      }
    }
  }

  // Hand a freshly loaded 3mf's painting to the kernel. Only ever on a FRESH selector: the kernel's import calls
  //  upstream's deserialize, which resets before loading, so running it over a selector the user has painted on
  //  would silently discard their work. The one-shot is enforced by clearing the pending paint right after.
  //
  // One facet carries one state (see paintStateFor), and a 3mf keeps material paint and support paint in two
  //  independent annotations — `paint_color` and `paint_supports` — that CAN both mark the same facet. There is no
  //  representation here that holds both, so material paint wins and the support paint is reported as dropped
  //  rather than half-applied.
  function importProjectPaint(worker, merged) {
    const pending = merged?.paint
    if (!pending) return
    const chosen = pending.color ?? pending.supports
    if (!chosen) { apiRef.current?.clearPaintImport?.(); return }
    // Which kind was loaded, for the overlay colour — see overlayColorFor. It hangs off the WORKER for the same
    //  reason lastCounts does: this factory is rebuilt on every render, so a plain local would not survive.
    worker.__paintImportKind = pending.color ? 'color' : 'supports'
    // No overlay request follows: the reply carries `counts`, and the message listener above already asks for the
    //  overlay of every state whose count moved — which after an import is every state it loaded.
    worker.postMessage({ cmd: 'importPaint', facets: chosen.facets, hex: chosen.hex, states: reportedPaintStates() })
    apiRef.current?.clearPaintImport?.()
    if (pending.color && pending.supports)
      setSliceNotice?.('This project paints both material and support. One facet holds one paint state, so the '
                     + 'material painting was imported and the support painting was dropped.')
  }
  // mode: 'off' | 'enforcer' | 'blocker' | 'material'. Entering either brush leaves the other, because one facet
  //  carries one selector state (see paintStateFor above).
  function setPaintMode(mode) {
    if (mode !== 'off' && objectsRef.current.length === 0) { setError('Upload an STL first'); return }
    if (mode !== 'off') { apiRef.current?.detachTransform(); registerSelector() }
    paintModeRef.current = mode; setPaintModeState(mode)
    apiRef.current?.refreshCursor()   // refresh the cursor hint when entering/leaving paint mode
  }
  // `clear` wipes every state at once, so the per-state map is emptied here rather than read back — the worker's
  //  clear reply only carries `counts` when the request asked for states, and the answer would be all-zero anyway.
  function clearPaint() { getWorker().postMessage({ cmd: 'clear' }); clearPaintOverlay(); setPaintCounts({ enf:0, blk:0 }); setPaintStateCounts?.({}) }

  return { rebuildPaintOverlay, clearPaintOverlay, setPaintMode, clearPaint, registerSelector }
}
