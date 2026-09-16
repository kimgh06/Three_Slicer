import * as THREE from 'three'
import { createBrushCursor } from './brush_cursor.js'
import { SUPPORT_OVERLAY_COLOR, UNPAINTED_COLOR } from '../core/paint_colors.js'

// The painting half of the pointer handling: the raycast -> kernel-coordinate conversion, the brush cursor preview,
// the stroke's own state (anchor, previous sample) and the wheel bindings. Split out of use_three_scene.js when the
// brush grew a preview and modifiers — that file is the renderer shell and is capped at 900 lines by test_layers.mjs
// precisely so work like this lands in its own module instead.
//
// Upstream reference: GLGizmoPainterBase::gizmo_event (GLGizmoPainterBase.cpp:658).

const FILL_TOOLS = new Set(['smart', 'bucket', 'triangle'])
const RADIUS_MIN = 1, RADIUS_MAX = 15, RADIUS_STEP = 0.5
const FILL_ANGLE_MIN = 1, FILL_ANGLE_MAX = 90, FILL_ANGLE_STEP = 1

export function createPaintInput({ camera, raycaster, pointer, toPointer, activeMeshes, cursorParent, invalidate, sectionPlane, deps }) {
  const {
    workerRef, paintModeRef, paintXformRef, paintToolRef, brushRadiusRef,
    materialExtruderRef, extruderColorsRef, setBrushRadius, setFillAngle,
  } = deps
  const cursor = createBrushCursor(cursorParent, invalidate)

  const isFill = () => FILL_TOOLS.has(paintToolRef?.current?.tool)
  const brushOf = () => paintToolRef?.current ?? { tool: 'brush', cursor: 'circle', angle: 30 }
  // The cursor is drawn in the colour the stroke will actually produce — see core/paint_colors.js for why the state
  //  number cannot answer that on its own. The eraser has no colour of its own, so it borrows the unpainted grey.
  const brushColor = () => {
    const mode = paintModeRef.current
    if (mode === 'enforcer') return SUPPORT_OVERLAY_COLOR[1]
    if (mode === 'blocker') return SUPPORT_OVERLAY_COLOR[2]
    const extruderIndex = materialExtruderRef?.current
    if (!Number.isInteger(extruderIndex)) return UNPAINTED_COLOR
    return extruderColorsRef?.current?.[extruderIndex] || UNPAINTED_COLOR
  }
  // The FIRST hit the section plane has not cut away. three.js clipping only discards fragments, so without this
  //  the ray keeps landing on the surface that is no longer drawn and the stroke silently marks nothing (the kernel
  //  clips too, and refuses it). Skipping those hits is what lets the ray fall through to the interior surface.
  const pickHit = () => {
    raycaster.setFromCamera(pointer, camera)
    for (const hit of raycaster.intersectObjects(activeMeshes(), false))
      if (!sectionPlane?.isClipped(hit.point)) return hit
    return null
  }

  // Stroke state. `anchor` is where the press landed (the axis lock pivots on it); `previous` is the last sample's
  //  kernel-space hit, which the capsule stroke below spans to.
  let anchor = null, previous = null, drawing = false

  // Upstream's Vertical/Horizontal checkboxes (GLGizmoMmuSegmentation.cpp:541-566): the dragged position is clamped
  //  to the anchor on one screen axis before it is projected, so the stroke runs straight. Upstream clamps against
  //  the previous sample; clamping against the press is the same line and does not drift over a long drag.
  const lockedEvent = (ev) => {
    const lock = brushOf().axisLock
    if (!anchor || (lock !== 'vertical' && lock !== 'horizontal')) return ev
    return lock === 'vertical' ? { clientX: anchor.x, clientY: ev.clientY } : { clientX: ev.clientX, clientY: anchor.y }
  }

  const paintAt = (ev, { erase = false } = {}) => {
    const X = paintXformRef.current; if (!X) return
    toPointer(lockedEvent(ev))
    const hit = pickHit()
    if (!hit || hit.faceIndex == null) { cursor.hide(); return }
    const toK = v => [v.x - X.cx, -v.z - X.cy, v.y - X.minz]   // viewer(Y-up) -> STL(Z-up) -> kernel
    const hk = toK(hit.point), ck = toK(camera.position)
    const brush = brushOf()
    // The tool travels with the stroke rather than being stamped later: a fill takes an angle where a brush takes a
    //  radius, so the message has to say which of the two it is at the point the hit is taken. `radius`/`cx..cz`
    //  ride along for the brush; the worker's fill dispatch simply does not read them.
    const message = {
      cmd: erase ? 'erase' : 'paint', facet: hit.faceIndex, hx: hk[0], hy: hk[1], hz: hk[2],
      cx: ck[0], cy: ck[1], cz: ck[2], radius: brushRadiusRef.current,
      enforcer: paintModeRef.current === 'enforcer',
      tool: brush.tool, cursor: brush.cursor, angle: brush.angle,
    }
    // A capsule from the previous sample to this one, which is what upstream paints between two consecutive mouse
    //  positions (DoublePointCursor, GLGizmoPainterBase.cpp:878). It is what makes a drag one continuous stroke:
    //  pointermove is coalesced to one sample per animation frame, so without it a fast drag lands as a row of
    //  separate blobs with gaps between them. Only for the real brush — a fill has no swept shape.
    if (previous && !FILL_TOOLS.has(brush.tool)) { message.px = previous[0]; message.py = previous[1]; message.pz = previous[2] }
    workerRef.current?.postMessage(message)
    if (!FILL_TOOLS.has(brush.tool)) previous = hk
    // The cursor follows the stroke: while the button is down the hit under it is already computed, so redrawing it
    //  here costs nothing and keeps the ball on the surface instead of stranded where the pointer last hovered.
    cursor.update({ point: hit.point, radius: brushRadiusRef.current, shape: brush.cursor, color: brushColor(), camera })
  }

  // A pointermove can fire several times per frame (and far above 60Hz on a high-rate mouse), and each one costs a
  //  worker round trip plus an overlay rebuild. Coalescing to one stroke per animation frame keeps the brush at the
  //  cursor without queueing work the frame cannot show anyway — and since the samples that survive are joined by a
  //  capsule, the dropped ones no longer leave a gap the way they did when each sample was its own ball.
  let pending = null, frame = 0
  const flush = () => { frame = 0; const ev = pending; pending = null; if (ev) paintAt(ev.event, { erase: ev.erase }) }
  const queue = (ev, options) => {
    pending = { event: { clientX: ev.clientX, clientY: ev.clientY }, erase: !!options?.erase }
    if (!frame) frame = requestAnimationFrame(flush)
  }
  const flushNow = () => { if (frame) { cancelAnimationFrame(frame); flush() } }

  // Hover: no stroke, just the preview. A fill has no radius, so its cursor is the pointer itself and nothing is drawn.
  const hover = (ev) => {
    toPointer(ev)
    const brush = brushOf()
    if (isFill()) { cursor.hide(); queueFillPreview(); return }
    const hit = pickHit()
    cursor.update({ point: hit?.point ?? null, radius: brushRadiusRef.current, shape: brush.cursor, color: brushColor(), camera })
  }

  // ── The fill preview ──────────────────────────────────────────────────────────
  // A fill is one click that can mark thousands of facets, and until it lands there is nothing on screen saying
  // which ones. Upstream answers that by running the selection on every mouse move and drawing it in a lighter
  // shade (GLGizmoPainterBase.cpp:929-965, get_seed_fill_color brightens the base colour by 1.25). The kernel does
  // the select-without-applying half; this is the drawing half.
  let previewMesh = null
  const clearFillPreview = () => {
    if (!previewMesh) return
    cursorParent.remove(previewMesh); previewMesh.geometry.dispose(); previewMesh.material.dispose()
    previewMesh = null
    invalidate?.()
  }
  // Upstream's own brightening, so the preview reads as "this colour, not yet applied" rather than as a new colour.
  const previewColor = () => new THREE.Color(brushColor()).multiplyScalar(1.25)
  const showFillPreview = (triangles) => {
    clearFillPreview()
    const X = paintXformRef.current
    if (!X || !triangles || triangles.length < 9) return
    const positions = new Float32Array(triangles.length)
    for (let i = 0; i < triangles.length; i += 3) {   // kernel -> STL -> viewer(Y-up), the inverse of paintAt's toK
      positions[i] = triangles[i] + X.cx
      positions[i + 1] = triangles[i + 2] + X.minz
      positions[i + 2] = -(triangles[i + 1] + X.cy)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    // Same coplanar decal as the paint overlay, and depth-tested for the same reason: a preview that shows through
    //  the model would say a click is about to fill the far side as well.
    previewMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: previewColor(), transparent: true, opacity: 0.45, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }))
    previewMesh.renderOrder = 998   // under the brush cursor's ring, over the paint overlay
    cursorParent.add(previewMesh)
    invalidate?.()
  }
  // Registered on the WORKER rather than passed in, because the worker outlives this factory and the factory is
  //  rebuilt on every render — the same reason support_paint.js hangs its own listener there.
  const listeningWorker = () => {
    const worker = workerRef.current
    if (!worker || worker.__fillPreviewBound) return worker
    worker.addEventListener('message', event => {
      if (event.data?.type === 'fillPreview') showFillPreview(event.data.tris)
    })
    worker.__fillPreviewBound = true
    return worker
  }
  // Coalesced like the stroke is, and for the same reason: a preview is one kernel flood per pointer sample.
  let previewFrame = 0
  const requestFillPreview = () => {
    previewFrame = 0
    const X = paintXformRef.current; if (!X) return
    const hit = pickHit()
    const worker = listeningWorker(); if (!worker) return
    if (!hit || hit.faceIndex == null) { clearFillPreview(); worker.postMessage({ cmd: 'fillPreview', clear: true }); return }
    const brush = brushOf()
    const hk = [hit.point.x - X.cx, -hit.point.z - X.cy, hit.point.y - X.minz]
    worker.postMessage({ cmd: 'fillPreview', facet: hit.faceIndex, hx: hk[0], hy: hk[1], hz: hk[2],
                         tool: brush.tool, angle: brush.angle })
  }
  const queueFillPreview = () => { if (!previewFrame) previewFrame = requestAnimationFrame(requestFillPreview) }

  const beginStroke = (ev) => { drawing = true; anchor = { x: ev.clientX, y: ev.clientY }; previous = null; clearFillPreview() }
  const endStroke = () => { flushNow(); drawing = false; anchor = null; previous = null }
  const isDrawing = () => drawing

  // Upstream's wheel bindings (GLGizmoPainterBase.cpp:661-706): CTRL + wheel sizes the brush (or the fill angle),
  //  plain wheel stays the camera zoom. It used to be the bare wheel here, which took zooming away for as long as a
  //  brush was open — the one camera move you want most while painting a detail.
  const onWheel = (ev) => {
    if (paintModeRef.current === 'off') return false
    // Alt + wheel scrubs the section plane, which is upstream's binding for it and the only reachable gesture that
    //  does not already mean something else here: plain wheel is the zoom, Ctrl the brush size.
    if (ev.altKey) {
      ev.preventDefault(); ev.stopPropagation()
      sectionPlane?.scrub(ev.deltaY < 0 ? 1 : -1)
      return true
    }
    if (!(ev.ctrlKey || ev.metaKey)) return false
    ev.preventDefault(); ev.stopPropagation()
    const up = ev.deltaY < 0
    if (isFill()) {
      const angle = Math.min(FILL_ANGLE_MAX, Math.max(FILL_ANGLE_MIN, brushOf().angle + (up ? FILL_ANGLE_STEP : -FILL_ANGLE_STEP)))
      setFillAngle?.(angle)
    } else {
      const radius = Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, brushRadiusRef.current + (up ? RADIUS_STEP : -RADIUS_STEP)))
      brushRadiusRef.current = radius; setBrushRadius(radius)
      hover(ev)   // the preview is the point of the size control — show the new radius under the pointer at once
    }
    return true
  }

  // Does a press here land on the model at all? Upstream answers the same question before deciding whether the
  //  brush consumes the event, and a miss is what leaves the camera free (see the caller in use_three_scene.js).
  //  It goes through pickHit, so a surface the section plane has cut away counts as a miss too — pressing on
  //  something that is not drawn should move the camera, not start a stroke the kernel will refuse.
  const hitsModel = (ev) => { toPointer(ev); return !!pickHit() }

  const hideAll = () => { cursor.hide(); clearFillPreview() }
  return { paintAt, queue, flushNow, hover, hideCursor: hideAll, beginStroke, endStroke, isDrawing, isFill, onWheel, hitsModel,
           dispose: () => { clearFillPreview(); cursor.dispose() } }
}
