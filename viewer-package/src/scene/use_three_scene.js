import { useEffect, useRef } from 'react'
import { buildSlaGroup, disposeSceneGroup as disposeGroup } from './sla_preview_mesh.js'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { platePosition, plateIndexAtXZ, plateLayoutHetero, nextPlacement } from '../core/plate_layout.js'; import { uniformPlateDims } from '../core/plate_settings.js'; import { makeSlaRaster } from './sla_raster.js'
import { buildMergedSTL, exportObjects } from '../core/model_geometry.js'
import { buildOverhangGeometry } from './overhang_view.js'; import { makeNozzleMarker } from './nozzle_marker.js'; import { rebuildPlates, followPlateLayout, refitCameraToPlates } from './plate_scene.js'
import { createScaleBox, clampMeshScale } from './scale_box.js'
import { createBoxSelect } from './box_select.js'
import { createPaintInput } from './paint_input.js'
import { createSectionPlane } from './section_plane.js'
import { DEFAULT_BED, DEFAULT_FILAMENT_COLORS } from '../core/viewer_defaults.js'
import { THEME } from '../core/theme.js'

// Model loading (STL/OBJ/3MF/AMF/PLY) moved to model_loaders.js (stage 26). Only the model->three local transform remains here.
// model -> three-local (R=RotX(-90°)), centered in XZ, minY=0
function bakeLocal(modelPos) {
  const n = modelPos.length, p = new Float32Array(n)
  for (let i = 0; i < n; i += 3) { p[i] = modelPos[i]; p[i + 1] = modelPos[i + 2]; p[i + 2] = -modelPos[i + 1] }
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (let i = 0; i < n; i += 3) { minx = Math.min(minx, p[i]); maxx = Math.max(maxx, p[i]); miny = Math.min(miny, p[i + 1]); maxy = Math.max(maxy, p[i + 1]); minz = Math.min(minz, p[i + 2]); maxz = Math.max(maxz, p[i + 2]) }
  const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2
  for (let i = 0; i < n; i += 3) { p[i] -= cx; p[i + 1] -= miny; p[i + 2] -= cz }
  return { localPos: p, size: { w: maxx - minx, d: maxz - minz, h: maxy - miny } }
}

// Toolpath colors/geometry/shaders moved to toolpath_gpu.js (port of the upstream libvgcode) — the CPU ribbon builder is gone (stage 24).
// The renderer/scene/camera/OrbitControls/TransformControls, the pointer/key handlers and the imperative apiRef surface.
//  A real hook: it owns the refs nobody else touches (mount/three/paint drag/bed size) and receives the refs shared with
//  the other concerns (apiRef, objectsRef, plate selection, paint mode, …). The effect runs once, exactly as before.
export function useThreeScene(deps) {
  const {
    apiRef, objectsRef, keyRef, workerRef, selectedPlateRef, placeXRef, plateCountRef,
    plateTpRef, plateOffsetsRef,
    canvasModeRef, paintModeRef, brushRadiusRef, paintToolRef, paintXformRef, extruderColorsRef,
    setOk, setStatus, setGmode, setCtxMenu, setBrushRadius, setFillAngle,   // the last two are the Ctrl+wheel targets (paint_input.js)
    contextMenu,   // features.contextMenu — false leaves the right-click menu unregistered
  } = deps

  const mountRef = useRef(null)
  const three = useRef({})
  const paintDrawingRef = useRef(false)
  const plateBWRef = useRef(DEFAULT_BED.width)        // plate (bed) width/depth — used for PX_i and membership calculations
  const plateBDRef = useRef(DEFAULT_BED.depth)
  const plateHeteroRef = useRef(null)   // { dims, layout } only when plates carry DIFFERENT beds; null keeps the closed form

  // The grid itself is plate_layout.js (pure, tested). These two only bind it to the refs that hold the live plate
  //  count and bed size, so every call site in this file keeps reading exactly as it did — heterogeneous beds
  //  swap in the cumulative layout through the same two names.
  const platePos = (i) => plateHeteroRef.current?.layout.position(i) ?? platePosition(i, plateCountRef.current, plateBWRef.current, plateBDRef.current)
  const plateOfXZ = (wx, wz) => plateHeteroRef.current?.layout.indexAt(wx, wz) ?? plateIndexAtXZ(wx, wz, plateCountRef.current, plateBWRef.current, plateBDRef.current)
  const plateGrid = () => ({ plateCount: plateCountRef.current, bedWidth: plateBWRef.current, bedDepth: plateBDRef.current, plateDims: plateHeteroRef.current?.dims ?? null })
  // Objects as model_geometry.js takes them: plain data with the world matrix already up to date. WHICH objects go
  //  in is the scene's own call (visibility, selection), so the filter stays here and the geometry work does not.
  const geometryInput = (keep) => objectsRef.current.filter(keep).map(o => {
    o.mesh.updateMatrixWorld(true)
    return { id: o.id, name: o.name, extruder: o.extruder, localPos: o.localPos, paint: o.paint, matrixWorld: o.mesh.matrixWorld }
  })

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const probe = document.createElement('canvas')
    if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) {
      setOk(false); setStatus('Cannot create a WebGL context in this environment (headless / no GPU).'); return
    }
    let w = mount.clientWidth || 800, h = mount.clientHeight || 480
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h); renderer.setClearColor(THEME.sceneBackground, 1)
    renderer.domElement.setAttribute('data-webgl', renderer.getContext() ? 'ok' : 'fail')
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    // 22-fix(H3): depth range shrunk drastically (was 0.1/6000 -> now 1/3000). far/near ratio 60000 -> 3000 gives ~20x better 24-bit depth precision
    //  -> removes the z-fighting where sub-surface infill pokes through the surface ("giant diagonal polygons"). Measured depth resolution: 0.08mm@d974, 0.13mm@d1500
    //  (within the 0.2mm layer height). logarithmicDepthBuffer was rejected: gl_FragDepth disables early-Z -> 3x fps drop at 489k overdraw.
    const camera = new THREE.PerspectiveCamera(50, w / h, 1, 3000)
    camera.position.set(210, 180, 260)
    scene.add(new THREE.HemisphereLight(THEME.lightSky, THEME.lightGround, 1.0))
    const dir = new THREE.DirectionalLight(THEME.lightSky, 1.1); dir.position.set(120, 220, 160); scene.add(dir)

    // Stage 29-2: bed (plate) rendering is managed by apiRef.setPlates (the bed useEffect initializes it). The initial single grid was removed.

    // Stage 26: the hardcoded demo meshes (cube/cylinder/torus) were removed — an empty scene plus the drop overlay guides the user instead.
    const objectsGroup = new THREE.Group(); scene.add(objectsGroup)
    // Toolpath root (an unrotated container, the target of mode visibility gating). Each plate's subgroup carries its own
    //  rotation.x=-90° (shader-local z-up) + position(offX,0,offZ), so all plates render simultaneously.
    const toolpathGroup = new THREE.Group(); scene.add(toolpathGroup)

    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.target.set(0, 22, 0); orbit.enableDamping = false; orbit.update()   // no inertia — desktop slicer convention (stops on release, kills the glide-tail stutter at the source)
    orbit.rotateSpeed = 1.6; orbit.panSpeed = 1.6   // mouse rotate/pan responsiveness (the default 1.0 felt sluggish)
    const transform = new TransformControls(camera, renderer.domElement)
    transform.setMode('translate'); transform.setSize(0.8)
    // No lifting: a part prints off the bed, so the only moves that mean anything are on it. Hiding Y in translate
    //  mode takes the up arrow AND the XY/YZ plane handles with it (TransformControls hides a plane whose axes are
    //  not all shown), leaving X, Z and the XZ plane. Rotate and scale still show every axis — hence per mode,
    //  set here for the initial mode and in setMode for every switch. seatMesh below stays either way: rotating or
    //  scaling still moves the lowest point, so the re-seat on commit is what actually keeps the part on the bed.
    transform.showY = false
    // The scale gizmo's XYZ handle is removed outright — both the drawn octahedron and its picker. It is the
    //  "all three axes" grip the bounding-box corners now provide at a size that can be hit, and it is actively
    //  harmful where it is: it sits AT the gizmo's origin, so a press starts the drag ~0 away from the centre and
    //  the ratio TransformControls divides by that is unbounded. Measured on a 20mm cube, one small drag took it to
    //  4e7, and past the centre it comes back negative (a mirrored mesh, which inverts the winding the kernel
    //  slices). Removing the object is what sticks: the per-frame update rewrites `visible` and `scale` on every
    //  handle it still owns, so the flags this control uses on itself are not usable from outside. 'XYZ' names only
    //  exist in the scale gizmo (translate has no such handle, rotate's is 'XYZE'), so the axis handles are untouched.
    for (const root of transform.children) {
      for (const modeGroup of root.children ?? []) {
        for (const handle of [...(modeGroup.children ?? [])]) if (handle.name === 'XYZ') modeGroup.remove(handle)
      }
    }
    // Stage 29-1: re-seat on the bed after every transform commit (drag end) — measured from the desktop GLCanvas3D::do_move/rotate/scale
    //  "snaps object to buildplate" (ensure_on_bed). Applies to move/rotate/scale, only on commit (no need for it live during rotation).
    //  Upstream: flying (minZ>0) snaps to the bed, sinking (minZ<0) is kept down to SINKING_Z_THRESHOLD. **Difference (documented)**: our kernel
    //  cannot slice negative z, so sinking is unsupported -> any minZ≠0 snaps to 0 in either direction. World bbox minY (three height) -> 0.
    const _seatBox = new THREE.Box3()
    const seatMesh = (m) => { if (!m) return; m.updateMatrixWorld(true); _seatBox.setFromObject(m); const minY = _seatBox.min.y; if (Number.isFinite(minY) && Math.abs(minY) > 1e-4) { m.position.y -= minY; m.updateMatrixWorld(true) } }
    // The paint overlay is baked in world coordinates and rebuilt from the kernel only on commit, so between grab
    //  and drop it would sit still while the mesh moves under it. Instead, the delta from the grab pose rides on
    //  the overlay meshes every objectChange — position, rotation and scale all fold into one matrix — and the
    //  commit's kernel rebuild then replaces the approximation with the truth.
    //  ponytail: the WHOLE overlay follows the dragged object; with paint on several objects the others' marks
    //  ride along for the duration of the drag (snapped right on drop). Splitting per object needs the kernel to
    //  report each overlay triangle's source facet.
    const paintDragStartInverse = new THREE.Matrix4(), paintDragDelta = new THREE.Matrix4()
    const paintDragBase = new Map()   // overlay mesh -> its matrix at grab (a prior drag's delta may still be on it)
    let paintDragging = false
    transform.addEventListener('objectChange', () => {
      if (transform.mode === 'scale' && transform.object) clampMeshScale(transform.object)
      if (!paintDragging || !transform.object) return
      transform.object.updateMatrixWorld(true)
      paintDragDelta.copy(transform.object.matrixWorld).multiply(paintDragStartInverse)
      for (const [mesh, base] of paintDragBase) {
        mesh.matrixAutoUpdate = false
        mesh.matrix.multiplyMatrices(paintDragDelta, base)
      }
    })
    transform.addEventListener('dragging-changed', e => {
      orbit.enabled = !e.value
      if (e.value) {
        deps.onTransformStarted?.()   // undo records the state BEFORE the drag; the commit below only says it ended
        paintDragBase.clear()
        const overlays = deps.paintOverlayRef?.current
        paintDragging = !!(overlays && overlays.size && transform.object && !transform.object.userData?.isPrimeTower)
        if (paintDragging) {
          transform.object.updateMatrixWorld(true)
          paintDragStartInverse.copy(transform.object.matrixWorld).invert()
          for (const mesh of overlays.values()) paintDragBase.set(mesh, mesh.matrix.clone())
        }
      } else paintDragging = false
      if (!e.value) {
        // The tower stands on the bed by definition and has no geometry to seat — it reports its new XY instead.
        if (transform.object && transform.object.userData?.isPrimeTower) {
          transform.object.position.y = transform.object.userData.halfHeight
          // The kernel reads prime_tower_x/y as the tower's CORNER (ptx .. ptx+side), so the box's centre has to
          //  give up half its footprint on the way out — otherwise a dropped tower re-renders half a width away.
          const half = transform.object.scale.x / 2
          // Which plate's box was dragged decides which origin comes back off the world coordinates — the
          //  setting itself is one shared scalar, so a drag on any plate moves every plate's tower alike.
          deps.onTowerMoved?.(transform.object.position.x - half, -transform.object.position.z - half,
                              transform.object.userData.plate)
        } else if (transform.object === pivot) {
          // A multi-selection drag moved the pivot, not the meshes. Release it so each mesh carries the new world
          //  transform for real, seat them individually (they land at different heights after a rotation), then
          //  rebuild the pivot around where they ended up — the selection itself must survive its own drag.
          releasePivot()
          for (const mesh of selection) seatMesh(mesh)
          refreshGizmo()
          deps.onTransformCommitted?.()
        } else { seatMesh(transform.object); deps.onTransformCommitted?.() }
      }
      three.current.invalidate?.()
    })
    scene.add(transform)

    three.current = { scene, camera, renderer, orbit, transform, objectsGroup, toolpathGroup, plateBeds: [] }
    if (typeof window !== 'undefined') { window.__vpThree = three.current; window.__vpApi = () => apiRef.current }   // dev/test aid

    // Render on demand (upstream desktop convention) — a static frame is not redrawn every frame, removing constant GPU load and thermal throttling.
    //  Every path that can change the scene calls invalidate(): orbit/gizmo change, pointer, keys, resize, React re-render.
    //  ponytail: a 500ms heartbeat render (2fps) as a safety net against a missed path leaving a stale frame.
    let renderPending = true
    // Set while an export runs (suspendRendering below). The heartbeat above is what makes this worth having: it
    //  fires every 500ms regardless of whether anything changed, so a long export always collides with at least one.
    let renderSuspended = false
    const invalidate = () => { renderPending = true }
    three.current.invalidate = invalidate
    orbit.addEventListener('change', invalidate)
    transform.addEventListener('change', invalidate)
    renderer.domElement.addEventListener('pointermove', invalidate)

    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2()
    let hovered = null, objIdCounter = 0   // the placement cursor is placeXRef (plate-relative)
    // Selection is a SET, following upstream (Selection.hpp holds an IndicesList). `selected` is the primary of
    //  that set — the last mesh added — and stays a single mesh because everything that needs "the one object"
    //  (the scale box, the status line, the tower's own drag) is genuinely singular. Upstream's rules, from
    //  GLCanvas3D.cpp:4412: a plain click replaces the selection, Ctrl+click adds, Ctrl+click on something already
    //  selected removes it, and clicking empty space clears — but a plain click on something ALREADY selected
    //  keeps the set, which is what makes dragging several objects at once possible.
    const selection = new Set()
    let selected = null
    // The selection bounding box + its uniform-scale corner handles. It is fed the current selection once per
    //  rendered frame instead of being attached and detached, so the eight places that change `selected` do not
    //  each need a second call to keep in step. The prime tower is excluded: its size is a setting, not a drag.
    let gizmoMode = 'translate', overScaleHandle = false
    const scaleBox = createScaleBox({ scene, camera, domElement: renderer.domElement })
    // The scale box is single-object by construction (it reads one mesh's box and writes one mesh's scale), so a
    //  multi-selection simply does not offer it — the move/rotate gizmo still drives the whole set through pivot.
    const scaleBoxTarget = () => (selection.size === 1 && selected && !selected.userData?.isPrimeTower ? selected : null)

    // TransformControls attaches to ONE Object3D, so a multi-selection is driven through a pivot the selected
    //  meshes are temporarily re-parented onto. Object3D.attach() preserves world transforms in both directions,
    //  which is the whole reason this works without any matrix arithmetic here. The pivot lives INSIDE
    //  objectsGroup so that hiding that group (onSliced) hides its children too.
    const pivot = new THREE.Group()
    pivot.name = 'selection-pivot'
    objectsGroup.add(pivot)
    const releasePivot = () => {
      if (!pivot.children.length) return
      for (const mesh of [...pivot.children]) objectsGroup.attach(mesh)
      pivot.position.set(0, 0, 0); pivot.quaternion.identity(); pivot.scale.set(1, 1, 1)
      pivot.updateMatrixWorld(true)
    }
    // Point the gizmo at whatever the selection currently is. Always releases the pivot first, so the meshes are
    //  back under objectsGroup with their world transforms baked before anything reads them.
    const refreshGizmo = () => {
      releasePivot()
      if (selection.size === 0) { transform.detach(); return }
      if (selection.size === 1) { transform.attach([...selection][0]); return }
      const box = new THREE.Box3()
      for (const mesh of selection) { mesh.updateMatrixWorld(true); box.expandByObject(mesh) }
      pivot.position.copy(box.getCenter(new THREE.Vector3()))
      pivot.updateMatrixWorld(true)
      for (const mesh of selection) pivot.attach(mesh)
      transform.attach(pivot)
    }
    const selectOnly = (mesh) => {
      selection.clear()
      if (mesh) selection.add(mesh)
      selected = mesh || null
      refreshGizmo()
    }
    const toggleSelect = (mesh) => {
      if (selection.has(mesh)) {
        selection.delete(mesh)
        if (selected === mesh) selected = [...selection].pop() ?? null
      } else { selection.add(mesh); selected = mesh }
      refreshGizmo()
    }
    const clearSelection = () => { selection.clear(); selected = null; refreshGizmo() }
    // Everything that changes the selection ends here: the tint, the status line, and the host's own list UI all
    //  have to follow, and a caller forgetting one of them is how a stale highlight survives a click.
    const announceSelection = () => { paint(); setStatus(statusText()); deps.onSelectionChanged?.() }
    // In scale mode a corner handle can land on the same pixels as one of the gizmo's own axes — measured: the
    //  top-far corner of a 20mm cube sits right on the tip of the Y arrow. The handles are drawn over everything, so
    //  the handle has to be the thing that reacts there; without this the press went to the gizmo instead and a
    //  corner drag came out as a single-axis scale ([1, 3.04, 1] on a corner that should have given [3, 3, 3]).
    //  TransformControls chooses its axis on HOVER and its pointerdown listener is registered before ours (it is
    //  built first), so no ordering trick in onDown can outrun it — the gizmo is switched off for as long as the
    //  pointer is over a handle instead. onDown then tests the handles before the gizmo guard, because that guard
    //  reads transform.axis, which stays stale while the gizmo is disabled.
    // Removing the XYZ handle was not enough on its own: what runs away is any scale drag that STARTS at the gizmo's
    //  origin, because the ratio is (distance now / distance at the press) and every axis picker is a cylinder that
    //  reaches the origin. With XYZ gone the same press landed on the Y picker and took a 20mm cube to 5000mm tall.
    //  So the origin itself is dead in scale mode — a small radius, well inside where the arrows are actually
    //  grabbed, and the size it would have produced is not a size anyone is aiming for.
    const GIZMO_DEAD_ZONE_PX = 16
    const _originNdc = new THREE.Vector3()
    const nearGizmoOrigin = (ev, target) => {
      target.updateMatrixWorld(true)
      _originNdc.setFromMatrixPosition(target.matrixWorld).project(camera)
      const rect = renderer.domElement.getBoundingClientRect()
      const ox = rect.left + (_originNdc.x * 0.5 + 0.5) * rect.width
      const oy = rect.top + (-_originNdc.y * 0.5 + 0.5) * rect.height
      return Math.hypot(ev.clientX - ox, ev.clientY - oy) < GIZMO_DEAD_ZONE_PX
    }
    const updateHandleHover = (ev) => {
      const wasOver = overScaleHandle, wasEnabled = transform.enabled
      const target = scaleBoxTarget()
      overScaleHandle = false
      let suppressGizmo = false
      if (!transform.dragging && !scaleBox.dragging() && gizmoMode === 'scale' && target) {
        toPointer(ev); raycaster.setFromCamera(pointer, camera)
        overScaleHandle = !!scaleBox.hitTest(raycaster)
        suppressGizmo = overScaleHandle || nearGizmoOrigin(ev, target)
      }
      transform.enabled = !suppressGizmo
      if (overScaleHandle !== wasOver) applyCursor()
      if (overScaleHandle !== wasOver || transform.enabled !== wasEnabled) invalidate()
      return overScaleHandle
    }
    // The prime tower as a scene object, the way upstream carries it (a GLVolume with is_wipe_tower). Before this
    //  the tower existed only in the sliced result, so "does it collide with the model?" could not be answered
    //  until after slicing. It is pickable and moves on the same TransformControls the objects use; dragging it
    //  writes wipe_tower_x/y, which is what turns the placement from automatic into chosen.
    //  One mesh per plate: the position setting is a single shared scalar (plate-local), so every plate's tower
    //  sits at the same local spot, but each stand-in must still be drawn at its own plate's world offset.
    let towerMeshes = []
    const activeMeshes = () => {
      const list = objectsRef.current.map(o => o.mesh)
      for (const m of towerMeshes) if (m.visible) list.push(m)
      return list
    }
    // Selection tint. The tower is pickable but is drawn with an unlit material, which has no emissive channel —
    //  tinting it threw on every hover and left the click handler half-run (a paint stroke after it never
    //  registered). It shows selection through its own opacity instead.
    const paint = () => { for (const m of activeMeshes()) {
      const isSelected = selection.has(m)
      if (m.material.emissive) m.material.emissive.set(isSelected ? THEME.accent : m === hovered ? THEME.accentHover : 0x000000)
      else if (m.userData?.isPrimeTower) m.material.opacity = isSelected ? 0.6 : m === hovered ? 0.5 : 0.35
    } }
    // With several objects selected the name of one of them says less than the count does.
    const selectionLabel = () => (selection.size > 1 ? `${selection.size} objects`
      : selected ? selected.userData.name : '—')
    const statusText = () => objectsRef.current.length
      // The keyboard half of the hint is dropped when features.shortcuts is off — a status bar advertising a key
      //  that has been switched off is worse than a shorter status bar.
      ? `${objectsRef.current.length} object(s) · selected: ${selectionLabel()}`
        + (keyRef.current ? ' | M/R/S · Ctrl+click to add · Shift+drag to box-select · ? for shortcuts' : ' | Ctrl+click to add · Shift+drag to box-select')
      : `hover: ${hovered ? hovered.userData.name : '—'} · selected: ${selectionLabel()} | left-drag to orbit`
        + (keyRef.current ? ' · ? for shortcuts' : '')
    const toPointer = ev => { const r = renderer.domElement.getBoundingClientRect(); pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1; pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1 }
    const pick = () => { raycaster.setFromCamera(pointer, camera); const hits = raycaster.intersectObjects(activeMeshes(), false); return hits.length ? hits[0].object : null }
    // Stage 20: painting — the raycast -> kernel-coordinate conversion, the brush cursor preview and the stroke's
    //  own state live in paint_input.js. `paintDrawingRef` stays here because the other pointer handlers read it.
    //  A fill is one click (it selects by mesh topology, so repeating it per pointermove would redo the same flood
    //  over the same facets); the brush is the opposite — dragging is how it covers an area.
    const sectionPlane = createSectionPlane({ renderer, camera, objectsRef, workerRef, paintXformRef, invalidate })
    const paintInput = createPaintInput({
      camera, raycaster, pointer, toPointer, activeMeshes, cursorParent: scene, invalidate, sectionPlane, deps,
    })
    const paintToolIsFill = () => paintInput.isFill()
    // Cursor hints: crosshair in paint mode, pointer when hovering an object, default otherwise (camera control).
    const applyCursor = () => {
      const el = renderer.domElement
      el.style.cursor = canvasModeRef.current === 'preview' ? ''
        : paintModeRef.current !== 'off' ? 'crosshair'
        : overScaleHandle ? 'nwse-resize'
        : hovered ? 'pointer' : ''
    }
    const onMove = ev => {
      if (canvasModeRef.current === 'preview') return   // S2: no hover/selection in preview
      if (boxSelect.dragging()) { boxSelect.move(ev); return }
      if (scaleBox.dragging()) { scaleBox.move(ev); invalidate(); return }
      // Shift is the eraser while a brush is open, which is upstream's modifier (`if (!shift_down) new_state = …`,
      //  GLGizmoPainterBase.cpp:743) and the reason the box select below refuses to start in paint mode.
      if (paintModeRef.current !== 'off') {
        if (paintDrawingRef.current) { if (!paintToolIsFill()) paintInput.queue(ev, { erase: ev.shiftKey }) }
        else paintInput.hover(ev)
        return
      }
      if (updateHandleHover(ev)) return                 // over a corner handle: no hover change under it either
      if (transform.dragging || transform.axis) return; toPointer(ev); const hit = pick(); if (hit !== hovered) { hovered = hit; paint(); applyCursor(); setStatus(statusText()) } }
    // Which plate the pointer is over: a clicked object belongs to its own plate, otherwise it is wherever the ray
    //  meets the bed plane. A camera looking exactly along the plane never meets it — then there is no answer.
    const _bedPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _bedHit = new THREE.Vector3()
    const plateUnderPointer = (hit) => {
      if (hit) { hit.updateMatrixWorld(true); const p = new THREE.Vector3().setFromMatrixPosition(hit.matrixWorld); return plateOfXZ(p.x, p.z) }
      raycaster.setFromCamera(pointer, camera)
      return raycaster.ray.intersectPlane(_bedPlane, _bedHit) ? plateOfXZ(_bedHit.x, _bedHit.z) : null
    }
    // ---- Box select (box_select.js holds the band and the projection; this is what it means here) --------------
    const boxSelect = createBoxSelect({ camera, domElement: renderer.domElement, mount })
    const endBand = () => {
      const picked = boxSelect.end(objectsRef.current.filter(o => o.visible !== false).map(o => o.mesh))
      orbit.enabled = true
      // Additive, like upstream's Select state: a box drag adds to what was already selected rather than replacing
      //  it, which is what makes several drags in a row build one set.
      for (const mesh of picked) selection.add(mesh)
      if (picked.length) selected = picked[picked.length - 1]
      refreshGizmo()
      announceSelection()
    }

    // Press position + the plate under it, resolved on release: a left-drag over the beds is how you orbit, so
    //  switching plates on press would change plate every time the camera moves. Only a press that does not travel
    //  counts as a click.
    let downAt = null, downPlate = null
    const onDown = ev => {
      if (ev.button !== 0) return                       // left click only — right/middle clicks belong to OrbitControls pan/zoom (prevents stray selection/painting)
      if (canvasModeRef.current === 'preview') return   // S2: no gizmo/painting in preview
      if (paintModeRef.current !== 'off') {
        // A press that MISSES the model is not the brush's — upstream returns false there (GLGizmoPainterBase.cpp
        //  :833) and the canvas orbits, which is how a brush survives a camera move. OrbitControls' own pointerdown
        //  listener is registered first and has already begun its drag, so this only decides whether to kill it.
        if (!paintInput.hitsModel(ev)) return
        paintDrawingRef.current = true; orbit.enabled = false
        paintInput.beginStroke(ev); paintInput.paintAt(ev, { erase: ev.shiftKey }); return
      }
      // Before the gizmo guard and before the model is picked: a handle grab must beat both the gizmo axis it may
      //  overlap and the part it sits on top of. Pointer capture keeps the drag alive outside the canvas.
      if (!transform.dragging && gizmoMode === 'scale' && scaleBoxTarget()) {
        toPointer(ev); raycaster.setFromCamera(pointer, camera)
        if (scaleBox.hitTest(raycaster) && scaleBox.begin(ev, scaleBoxTarget())) {
          deps.onTransformStarted?.()
          orbit.enabled = false
          renderer.domElement.setPointerCapture?.(ev.pointerId)
          return
        }
      }
      if (transform.dragging || transform.axis) return
      // Shift+drag starts a box select instead of an orbit. Upstream gates this on the painting gizmos being off
      //  (GLCanvas3D.cpp:4398) for the same reason it matters here: shift is the eraser modifier while painting.
      if (ev.shiftKey && paintModeRef.current === 'off') {
        boxSelect.begin(ev)
        orbit.enabled = false
        renderer.domElement.setPointerCapture?.(ev.pointerId)
        return
      }
      toPointer(ev)
      const hit = pick()
      downAt = { x: ev.clientX, y: ev.clientY }; downPlate = plateUnderPointer(hit)
      if (hit) {
        // Ctrl/⌘ toggles; a plain click on something already selected leaves the set alone so the whole set can be
        //  dragged. Both are upstream's rules — `add(idx, !ctrl_down, true)` plus the already-selected branch.
        if (ev.ctrlKey || ev.metaKey) toggleSelect(hit)
        else if (!selection.has(hit)) selectOnly(hit)
      } else if (!ev.shiftKey) clearSelection()
      announceSelection()
    }
    // Paint release is handled on window — so releasing the button outside the canvas cannot leave paintDrawing/orbit.enabled stuck.
    const onUp = (ev) => {
      if (boxSelect.dragging()) { endBand(); return }
      // A corner drag commits the same way a gizmo drag does — re-seat on the bed, then let the component rebuild
      //  the paint/kernel coordinates the new size invalidates.
      if (scaleBox.dragging()) {
        const scaled = scaleBox.end()
        orbit.enabled = true
        seatMesh(scaled); deps.onTransformCommitted?.()
        // Re-decide from where the pointer actually ended up: the handles moved with the new size, so leaving the
        //  gizmo disabled (or re-enabling it blindly) would decide the next press on a stale hover.
        if (ev) updateHandleHover(ev); else { overScaleHandle = false; transform.enabled = true }
        invalidate()
        return
      }
      // A press that stayed put is a click: select the plate it landed on. 4px of slop covers the wobble of a
      //  physical click without letting an orbit drag through.
      if (downAt) {
        const still = Math.abs((ev?.clientX ?? downAt.x) - downAt.x) < 4 && Math.abs((ev?.clientY ?? downAt.y) - downAt.y) < 4
        if (still && downPlate != null) deps.onPlateClicked?.(downPlate)
        downAt = null; downPlate = null
      }
      if (!paintDrawingRef.current) return
      paintDrawingRef.current = false; orbit.enabled = true
      paintInput.endStroke()   // flushes the pending sample: the last position is the one the user aimed at
    }
    // Double click: on an object = zoom to it, on empty space = clear the selection (3D app convention)
    const onDblClick = ev => {
      if (ev.button !== 0 || canvasModeRef.current === 'preview' || paintModeRef.current !== 'off') return
      toPointer(ev)
      if (pick()) frameObjects()
      else { clearSelection(); announceSelection() }
    }
    // Wheel: Ctrl/⌘ + wheel sizes the brush (or the fill angle) in paint mode, exactly as upstream binds it — the
    //  bare wheel stays the camera zoom, which taking it away used to make painting a detail impossible.
    const onWheel = ev => {
      if (canvasModeRef.current === 'preview') return
      paintInput.onWheel(ev)
    }
    // Right-click context menu — selects the object under the press, then hands the menu coordinates to the component.
    //  (OrbitControls calls preventDefault on contextmenu, so there is no clash with the native menu.)
    //  Note: distinguish from a right-drag pan — if the pointer moved 4px or more since pointerdown, the menu does not open.
    let rmbDown = null
    const onRmbDown = ev => { if (ev.button === 2) rmbDown = { x: ev.clientX, y: ev.clientY } }
    const onCtxMenu = ev => {
      ev.preventDefault()
      if (canvasModeRef.current === 'preview' || paintModeRef.current !== 'off') return
      if (rmbDown && Math.hypot(ev.clientX - rmbDown.x, ev.clientY - rmbDown.y) > 4) return   // that was a pan drag
      toPointer(ev); const hit = pick()
      // Right-clicking INSIDE an existing multi-selection keeps it — otherwise "export selected" from the menu
      //  could only ever mean the one object under the cursor.
      if (hit) { if (!selection.has(hit)) selectOnly(hit) } else clearSelection()
      announceSelection()
      const r = renderer.domElement.getBoundingClientRect()
      setCtxMenu({ x: ev.clientX - r.left, y: ev.clientY - r.top, onObject: !!hit })
    }
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerdown', onRmbDown)
    if (contextMenu !== false) renderer.domElement.addEventListener('contextmenu', onCtxMenu)
    renderer.domElement.addEventListener('dblclick', onDblClick)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false, capture: true })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)

    // Leaving scale mode with the pointer parked on a handle would otherwise keep the gizmo switched off until the
    //  next pointermove — which never comes if the next thing the user does is click without moving.
    const setMode = m => {
      transform.setMode(m); transform.showY = (m !== 'translate'); gizmoMode = m
      overScaleHandle = false; transform.enabled = true; applyCursor(); setGmode(m)
    }
    const frameObjects = () => {
      const arr = objectsRef.current
      const box = new THREE.Box3()
      if (arr.length) arr.forEach(o => box.expandByObject(o.mesh)); else box.setFromCenterAndSize(new THREE.Vector3(0, 25, 0), new THREE.Vector3(100, 50, 100))
      const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3())
      const d = Math.max(s.x, s.y, s.z, 20) * 1.9 + 40
      orbit.target.copy(c); camera.position.set(c.x + d * 0.7, c.y + d * 0.55 + s.y * 0.3, c.z + d); camera.updateProjectionMatrix(); orbit.update()
    }

    // Shared path for registering an object mesh — used by addObject (fresh load) and spawnSnapshot (duplicate/paste).
    //  Stage 26 R4 + 29-2: places them side by side on the selected plate (placeXRef = plate-relative cursor, PX = plate offset).
    //  When pos is given, the object goes there instead of the placement cursor (split: parts must stay where they were).
    //  `opts` is the undo path's entry: it restores an object under its ORIGINAL id, because the id is half of the
    //  paint topology key (`${id}:${ext}:${faces}` below) — a re-created object with a fresh id reads as a different
    //  mesh and its painting is dropped. `quiet` skips the camera reframe, which is welcome on a load and jarring
    //  when it fires on every undo. (The placement cursor needs no such guard: it only advances when `pos` is
    //  absent, and a restore always carries one.)
    const spawnMesh = (name, localPos, rot = null, scale = null, pos = null, opts = null) => {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(localPos, 3)); geo.computeVertexNormals()
      geo.computeBoundingBox()
      const col0 = extruderColorsRef.current[0] || DEFAULT_FILAMENT_COLORS[0]   // apply the T1 filament color
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(col0), roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide }))
      if (rot) mesh.rotation.copy(rot)
      if (scale) mesh.scale.copy(scale)
      if (pos) {
        mesh.position.copy(pos)                       // split and friends: keep the original position (no placement cursor)
      } else {
        const w = (geo.boundingBox.max.x - geo.boundingBox.min.x) * (scale ? Math.abs(scale.x) : 1)
        if (objectsRef.current.length === 0) placeXRef.current = 0
        const pp = platePos(selectedPlateRef.current)
        const place = nextPlacement(placeXRef.current, pp.x, w)
        mesh.position.set(place.x, 0, pp.z)
        placeXRef.current = place.cursor
      }
      mesh.userData = { name }
      objectsGroup.add(mesh)
      const id = opts?.id ?? ++objIdCounter
      if (opts?.id != null) objIdCounter = Math.max(objIdCounter, opts.id)   // never hand a restored id out again
      const extruder = opts?.extruder ?? 1
      const visible = opts?.visible !== false
      if (extruder !== 1) { const c = extruderColorsRef.current[extruder - 1]; if (c) mesh.material.color.set(c) }
      mesh.visible = visible
      objectsRef.current.push({ id, name, mesh, localPos, extruder, visible })   // MM: extruder 1 by default
      objectsGroup.visible = true
      if (overhangDeg != null) rebuildOverhang()      // a newly added object gets shaded too
      setStatus(statusText())
      if (!opts?.quiet) frameObjects()
      return { id, name }
    }

    // Removing an object is its own function rather than only an api entry, because restoreScene has to call it too.
    const removeObjectById = (id) => {
      const arr = objectsRef.current
      const k = arr.findIndex(o => o.id === id); if (k < 0) return
      const o = arr[k]
      if (selection.has(o.mesh)) { selection.delete(o.mesh); if (selected === o.mesh) selected = [...selection].pop() ?? null; refreshGizmo() }
      if (hovered === o.mesh) hovered = null
      for (const child of [...o.mesh.children]) {      // the overhang overlay rides along as a child
        o.mesh.remove(child); child.geometry?.dispose(); child.material?.dispose()
      }
      objectsGroup.remove(o.mesh); o.mesh.geometry.dispose(); o.mesh.material.dispose()
      arr.splice(k, 1)
      if (arr.length === 0) placeXRef.current = 0
      paint(); setStatus(statusText())
    }

    // Overhang shading: an overlay child per object holding just the facets that will need support. Being a child
    //  means it inherits the object's transform for free; only the facet test itself has to be redone after a
    //  rotation, which is what the dragging-changed hook below covers.
    let overhangDeg = null
    function rebuildOverhang() {
      for (const o of objectsRef.current) {
        const prev = o.mesh.children.find(c => c.userData?.overhang)
        if (prev) { o.mesh.remove(prev); prev.geometry.dispose(); prev.material.dispose() }
        if (overhangDeg == null) continue
        o.mesh.updateWorldMatrix(true, false)
        const geo = buildOverhangGeometry(o.mesh, overhangDeg)
        if (!geo) continue
        const overlay = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: THEME.overhang, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        }))
        overlay.userData.overhang = true
        o.mesh.add(overlay)
      }
      invalidate()
    }
    transform.addEventListener('dragging-changed', e => { if (!e.value && overhangDeg != null) rebuildOverhang() })

    // ---- SLA solid preview (upstream's architecture: the preview renders MESHES — the processed model, the
    //  support tree and the pad — never layer outlines; the layer stream is raster-only). One group in the
    //  kernel frame (z-up, plate offset), model clone lifted by the elevation, materials clip-plane aware so
    //  the layer slider becomes a section cut (upstream SlaCap, minus the filled cap face).
    let slaGroup = null
    const slaStatics = new Map()   // plateIdx -> { group, source }: the OTHER resin plates, drawn unclipped
    const slaClipPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e9),   // keep world y <= constant
                           new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e9)]    // keep world y >= -constant
    function clearSlaPreview() {
      if (!slaGroup) return
      disposeGroup(slaGroup)
      slaGroup = null
      invalidate()
    }

    const slaRaster = makeSlaRaster(toolpathGroup, invalidate); const nozzle = makeNozzleMarker(toolpathGroup, invalidate)   // sla_raster.js / nozzle_marker.js

    apiRef.current = {
      /** SLA preview: replace the outline toolpath with SOLID meshes — the plate's model geometry (lifted by
       *  the elevation), the kernel's support tree mesh and the pad mesh, all in the kernel frame at the
       *  plate's offset. `null` tears the group down (leaving Preview, switching to an FFF plate). */
      setSlaPreview: (payload) => {
        clearSlaPreview()
        if (!payload) return
        renderer.localClippingEnabled = true
        slaClipPlanes[0].constant = 1e9; slaClipPlanes[1].constant = 1e9
        slaGroup = buildSlaGroup(payload, slaClipPlanes)
        // Inside toolpathGroup, so Prepare/Preview visibility toggling covers the solid preview for free.
        toolpathGroup.add(slaGroup)
        invalidate()
      },
      // A resin plate that is NOT the focus: drawn whole, unclipped, beside the others — the resin counterpart of
      //  the toolpaths every FFF plate keeps in the scene after slice-all. Two resin plates used to show only the
      //  focused one, the other reading as "missing". Idempotent on the result's identity.
      setSlaStatic: (idx, payload) => {
        const have = slaStatics.get(idx)
        if (have && payload && have.source === payload.source) return
        if (have) { disposeGroup(have.group); slaStatics.delete(idx) }
        if (!payload) { invalidate(); return }
        const group = buildSlaGroup(payload, null)
        toolpathGroup.add(group)
        slaStatics.set(idx, { group, source: payload.source })
        invalidate()
      },
      clearSlaStatics: () => { for (const [, e] of slaStatics) disposeGroup(e.group); slaStatics.clear(); invalidate() },
      /** Section-cut the SLA preview to [zLo, zHi] (kernel z, mm) — what the layer slider means for meshes.
       *  null/undefined on either side opens that side fully. */
      setSlaClip: (zLo, zHi) => {
        slaClipPlanes[0].constant = zHi == null ? 1e9 : zHi
        slaClipPlanes[1].constant = zLo == null ? 1e9 : -zLo
        invalidate()
      },
      // Imported SL1 raster preview (scene/sla_raster.js): set(payload|null), setLayer(i) — contract in that file.
      setSlaRaster: slaRaster.set, setSlaRasterLayer: slaRaster.setLayer, setNozzle: nozzle.set,
      setMode,
      /** Highlight facets below `thresholdDeg` (the support threshold angle); null turns the shading off. */
      setOverhang: (thresholdDeg) => { overhangDeg = thresholdDeg; rebuildOverhang() },
      // Keeps the cursor hint in sync when the paint mode changes — and takes the brush preview down with the mode,
      //  since nothing else fires once the pointer handlers stop routing to it.
      // The section plane is a painting tool, so it goes with the brush: leaving a brush restores the whole model,
      //  which is what stops a cut from silently outliving the mode that made it.
      // The overlay meshes are built by actions/support_paint.js on every stroke, so they ask for the section
      //  plane rather than being walked: an unclipped overlay floats where the model was cut away.
      paintClipPlanes: () => sectionPlane.activePlanes(),
      refreshCursor: () => {
        applyCursor()
        if (paintModeRef.current === 'off') { paintInput.hideCursor(); sectionPlane.reset() } else sectionPlane.refresh()
      },
      detachTransform: () => { clearSelection(); announceSelection() },   // stage 20: release the gizmo when entering painting
      // `paint` is a 3mf's painted facets ({color,supports,…}: Map(localTriangleIndex -> split-tree hex)), held on the
      //  object until something registers the selector — only then is the merged facet numbering they must be rebased
      //  onto known. bakeLocal is a per-vertex transform, so the triangle ORDER the indices refer to survives it.
      addObject: (name, modelPos, paint = null) => {
        const added = spawnMesh(name, bakeLocal(modelPos).localPos)
        if (paint) { const o = objectsRef.current.find(x => x.id === added.id); if (o) o.paint = paint }
        return added
      },
      // ---- Shortcut support (duplicate/nudge/rotate/zoom-to) ----
      getSnapshot: (id) => {           // snapshot for copy/duplicate — localPos is immutable, so the reference is shared
        const o = objectsRef.current.find(x => x.id === id); if (!o) return null
        return { name: o.name, localPos: o.localPos, rot: o.mesh.rotation.clone(), scale: o.mesh.scale.clone(), pos: o.mesh.position.clone() }
      },
      // keepPos=true keeps the snapshot's original position (split). false (default) places it beside via the placement cursor (duplicate/paste).
      //  `quiet`: a duplicate/paste/split must not reframe the camera — a fresh LOAD is the only spawn where it is the point.
      spawnSnapshot: (snap, keepPos = false) => snap ? spawnMesh(snap.name, snap.localPos, snap.rot, snap.scale, keepPos ? (snap.pos || null) : null, { quiet: true }) : null,
      nudgeSelected: (dx, dz) => { if (!selected) return; selected.position.x += dx; selected.position.z += dz },
      rotateSelectedY: (rad) => { if (!selected) return; selected.rotation.y += rad },
      frame: () => frameObjects(),                                   // Z: zoom to all objects
      frameBed: () => {                                              // B: zoom to the selected plate
        const pp = platePos(selectedPlateRef.current)
        const d = Math.max(plateBWRef.current, plateBDRef.current) * 1.1 + 40
        orbit.target.set(pp.x, 0, pp.z); camera.position.set(pp.x + d * 0.55, d * 0.8, pp.z + d); orbit.update()
      },
      removeObject: (id) => removeObjectById(id),
      /** The undo snapshot: everything about the objects that a viewport action can change. The geometry rides
       *  along BY REFERENCE (`localPos` is immutable), so a whole entry is a few hundred bytes per object and a
       *  50-deep history costs kilobytes. Paint is not in here — see history.js. */
      sceneSnapshot: () => objectsRef.current.map(o => ({
        id: o.id, name: o.name, localPos: o.localPos,
        extruder: o.extruder || 1, visible: o.visible !== false,
        pos: o.mesh.position.clone(), rot: o.mesh.rotation.clone(), scale: o.mesh.scale.clone(),
      })),
      /** Put the scene back the way a snapshot found it, as a diff by id: drop what is gone, re-create what is
       *  missing under its ORIGINAL id, and re-apply the rest. The caller still has to run the transform-commit
       *  work afterwards (the kernel selector's coordinates and the bed check) — restoring is a move like any
       *  other, and skipping that is how a paint overlay ends up in the wrong place. */
      restoreScene: (snapshot) => {
        if (!Array.isArray(snapshot)) return
        const wanted = new Map(snapshot.map(s => [s.id, s]))
        for (const o of [...objectsRef.current]) if (!wanted.has(o.id)) removeObjectById(o.id)
        for (const s of snapshot) {
          let o = objectsRef.current.find(x => x.id === s.id)
          if (!o) {
            spawnMesh(s.name, s.localPos, s.rot, s.scale, s.pos,
                      { id: s.id, extruder: s.extruder, visible: s.visible, quiet: true })
            o = objectsRef.current.find(x => x.id === s.id)
            if (!o) continue
          }
          o.mesh.position.copy(s.pos); o.mesh.rotation.copy(s.rot); o.mesh.scale.copy(s.scale)
          o.mesh.updateMatrixWorld(true)
          o.extruder = s.extruder; o.visible = s.visible; o.mesh.visible = s.visible
          const col = extruderColorsRef.current[(s.extruder || 1) - 1]; if (col) o.mesh.material.color.set(col)
        }
        // Merge order is the viewer's knowledge (buildMergedSTL sorts by extruder over THIS array), so the array is
        //  put back in the snapshot's order rather than in whatever order the re-creations happened to append in.
        const rank = new Map(snapshot.map((s, i) => [s.id, i]))
        objectsRef.current.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
        if (objectsRef.current.length) objectsGroup.visible = true
        if (overhangDeg != null) rebuildOverhang()
        paint(); setStatus(statusText()); invalidate()
      },
      // MM: merges triangles sorted by ascending extruder -> group0 (ext1) followed by group1 (ext2); returns split.
      platePos: (i) => platePos(i),   // three (x,z) offset of plate i
      plateOfObject: (o) => {                                // membership by position = nearest plate center
        o.mesh.updateMatrixWorld(true)
        const wp = new THREE.Vector3().setFromMatrixPosition(o.mesh.matrixWorld)
        return plateOfXZ(wp.x, wp.z)
      },
      /** Put an object on plate `plateIdx` at an explicit offset from that plate's centre, in MODEL mm.
       *  This is how an imported project's layout is restored: spawnMesh placed the object with the side-by-side
       *  placement cursor (it has no idea a project is being loaded) and bakeLocal already centred its geometry, so
       *  the author's arrangement only exists in the offsets the importer computes — nothing here can recover it.
       *  Model y maps to three -z, the same convention buildMergedSTL uses in the other direction.
       *  Requires plateCountRef to already hold the final plate count: platePos() lays plates out against it. */
      placeObjectOnPlate: (id, plateIdx, offsetModelX, offsetModelY) => {
        const o = objectsRef.current.find(x => x.id === id); if (!o) return
        const origin = platePos(plateIdx)
        o.mesh.position.set(origin.x + offsetModelX, o.mesh.position.y, origin.z - offsetModelY)
      },
      // When plateIdx != null, only objects on that plate are used and coordinates are converted to plate-local (three-x -= PX) (keeps the stage-28 contract).
      //  The work is model_geometry.js; this only decides WHICH objects go in (visibility is scene state) and
      //  hands over the world matrices, which have to be current before anything reads them.
      buildMergedSTL: (plateIdx = null) => buildMergedSTL(geometryInput(o => o.visible !== false),
        { plateIndex: plateIdx, selectedPlate: selectedPlateRef.current, ...plateGrid() }),
      /** Stop drawing the scene while something long and non-visual runs (an export). The scene cannot change
       *  during it, so the frames would be identical — and on a large model each one is a main-thread block that
       *  delays the very worker replies the export is waiting on. Resuming redraws once. */
      suspendRendering: (on) => { renderSuspended = !!on; if (!on) invalidate() },
      /** Every object as the 3mf writer needs it: world MODEL-space triangles (three (x,y,z) -> model (x,-z,y),
       *  the same convention buildMergedSTL uses), plus the plate it sits on and its facet count. Per object and
       *  NOT merged, because a 3mf keeps one <object> per model and its facet indices are per object.
       *  The merge order is the writer's problem, not this one's — it needs the same sort buildMergedSTL applies
       *  to line the selector's facet numbering back up, so that sort is spelled out here as well. */
      // `selectedOnly` is upstream's `export_stl(..., selection_only, ...)`. Upstream additionally refuses anything
      //  that is not a whole object (Plater.cpp:16244 — it rejects volume-level selections); this viewer has no
      //  parts, so every selection is already a set of whole objects and there is nothing to reject.
      exportObjects: ({ selectedOnly = false } = {}) => exportObjects(
        geometryInput(o => o.visible !== false && (!selectedOnly || selection.has(o.mesh))), plateGrid()),
      /** Drop the pending 3mf painting after it has been handed to the kernel — the import is one-shot, and a
       *  second one would resurrect marks the user has since erased. */
      clearPaintImport: () => { for (const o of objectsRef.current) o.paint = null },
      hasPaintImport: () => objectsRef.current.some(o => o.paint),
      setObjectExtruder: (id, e) => { const o = objectsRef.current.find(x => x.id === id); if (o) { o.extruder = e; const c = extruderColorsRef.current[e - 1]; if (c) o.mesh.material.color.set(c) } },
      setObjectVisible: (id, v) => { const o = objectsRef.current.find(x => x.id === id); if (o) { o.visible = v; o.mesh.visible = v } },   // stage 27: print toggle (eye icon)
      recolorObjects: () => { for (const o of objectsRef.current) { const c = extruderColorsRef.current[(o.extruder || 1) - 1]; if (c) o.mesh.material.color.set(c) } },   // reflect filament color changes
      selectedObjectId: () => selected ? (objectsRef.current.find(o => o.mesh === selected)?.id ?? null) : null,   // stage 27: viewport toolbar "delete selected"
      /** Every selected object's id, in scene order. The primary (`selectedObjectId`) is one OF these — callers
       *  that act on "the selection" want this one; callers that need a single subject want that one. */
      selectedObjectIds: () => objectsRef.current.filter(o => selection.has(o.mesh)).map(o => o.id),
      selectObject: (id) => {   // stage 33: select the object clicked in the list (for selection-driven actions such as split)
        const o = objectsRef.current.find(x => x.id === id); if (!o) return
        selectOnly(o.mesh); announceSelection()
      },
      /** Select several by id. `additive` toggles each against the current set, matching Ctrl+click in the scene,
       *  so the object list and the viewport cannot disagree about what a modifier means. */
      selectObjects: (ids, additive = false) => {
        const wanted = objectsRef.current.filter(o => ids.includes(o.id))
        if (!additive) { selection.clear(); selected = null }
        for (const o of wanted) {
          if (additive && selection.has(o.mesh)) { selection.delete(o.mesh); if (selected === o.mesh) selected = null }
          else { selection.add(o.mesh); selected = o.mesh }
        }
        if (!selection.has(selected)) selected = [...selection].pop() ?? null
        refreshGizmo(); announceSelection()
      },
      selectAllObjects: () => {   // Ctrl+A, upstream's EVT_GLCANVAS_SELECT_ALL
        selection.clear()
        for (const o of objectsRef.current) if (o.visible !== false) { selection.add(o.mesh); selected = o.mesh }
        refreshGizmo(); announceSelection()
      },
      clearSelection: () => { clearSelection(); announceSelection() },
      // Stage 28 P1: seat on the bed — local geometry is baked to minZ->0 by bakeLocal (once on load). Re-seat after a gizmo Z move.
      //  (The upstream ensure_on_bed sinking allowance [allow_negative_z] is out of scope — we only seat by -min_z.)
      placeOnBed: () => { for (const o of objectsRef.current) o.mesh.position.y = 0; if (selected) transform.update?.() },
      onSliced: () => { objectsGroup.visible = false; clearSelection(); paint() },
      showObjects: () => { objectsGroup.visible = true },
      // Footprint + height of everything currently on the plate, in the same coordinates the tower box uses.
      modelBounds: (plateIdx = null) => {
        let objs = objectsRef.current.filter(o => o.visible !== false)
        if (plateIdx != null) objs = objs.filter(o => { o.mesh.updateMatrixWorld(true); const wp = new THREE.Vector3().setFromMatrixPosition(o.mesh.matrixWorld); return plateOfXZ(wp.x, wp.z) === plateIdx })
        const meshes = objs.map(o => o.mesh)
        if (!meshes.length) return null
        const box = new THREE.Box3()
        for (const m of meshes) { m.updateMatrixWorld(true); box.expandByObject(m) }
        if (!Number.isFinite(box.min.x)) return null
        return { minX: box.min.x, maxX: box.max.x, minY: -box.max.z, maxY: -box.min.z, height: box.max.y - box.min.y }
      },
      // Draw (or move) the tower stand-ins — one per plate that gets a tower. Takes an array of
      //  {plate, x, y, size, height} (a single box still works), size/height in mm, x/y in the same bed-centred
      //  world coordinates the objects use. Passing null/[] removes them all — a single-filament print has no tower.
      setPrimeTower: (boxes) => {
        const t = three.current
        const list = !boxes ? [] : (Array.isArray(boxes) ? boxes : [boxes])
        while (towerMeshes.length > list.length) {
          const m = towerMeshes.pop()
          if (selection.has(m)) { selection.delete(m); if (selected === m) selected = [...selection].pop() ?? null; refreshGizmo() }
          t.scene.remove(m); m.geometry.dispose(); m.material.dispose()
        }
        list.forEach((box, i) => {
          const { plate = 0, x, y, size, height } = box
          let m = towerMeshes[i]
          if (!m) {
            const geo = new THREE.BoxGeometry(1, 1, 1)
            // Translucent and unlit so it reads as a placeholder rather than a part to be printed, and so the model
            //  behind it stays visible when the two overlap — which is exactly the case worth seeing.
            const mat = new THREE.MeshBasicMaterial({ color: THEME.primeTower, transparent: true, opacity: 0.35, depthWrite: false })
            m = new THREE.Mesh(geo, mat)
            m.userData = { name: 'Prime tower', isPrimeTower: true }
            t.scene.add(m)
            towerMeshes[i] = m
          }
          m.userData.plate = plate
          m.userData.halfHeight = height / 2
          m.scale.set(size, height, size)
          m.position.set(x, height / 2, -y)      // model(x,y) -> three(x, up, -y)
          m.visible = true
        })
        t.invalidate?.()
      },
      // Stage 29-2: render N plates (grid + border + number label; heterogeneous bed cells — an SLA plate's
      //  cell IS its display) — plate_scene.js. `dims` non-uniform swaps membership onto the cumulative layout.
      setPlates: (n, bw, bd, sel, dims) => {
        const t = three.current
        // Objects keep their PLATE when the layout changes — followPlateLayout (plate_scene.js) translates
        //  them, the cached toolpaths and the display offsets by their old plate's origin delta.
        const prev = { n: plateCountRef.current, bw: plateBWRef.current, bd: plateBDRef.current, het: plateHeteroRef.current }
        plateBWRef.current = bw; plateBDRef.current = bd; plateCountRef.current = n; selectedPlateRef.current = sel
        plateHeteroRef.current = dims && !uniformPlateDims(dims) ? { dims, layout: plateLayoutHetero(dims) } : null
        const moved = followPlateLayout(THREE, { objects: objectsRef?.current ?? [], count: n, prev, platePos,
          plateOffsets: plateOffsetsRef?.current, plateTp: plateTpRef?.current })
        rebuildPlates(THREE, t, { n, bw, bd, sel, platePos, dims: plateHeteroRef.current?.dims })   // the refs above already hold n/bw/bd, so platePos is the same grid
        refitCameraToPlates(THREE, t, { n, bw, bd, platePos, dims: plateHeteroRef.current?.dims })   // a grown footprint reframes the view (plate_scene.js)
        return moved   // caller re-registers the paint selector when geometry moved (same as a drag commit)
      },
      setBed: (bw, bd) => { apiRef.current?.setPlates(plateCountRef.current, bw, bd, selectedPlateRef.current) },   // backwards compatible
    }

    // The shortcut body lives in component scope (keyRef — captures the latest state/functions each render). The effect only forwards.
    const onKey = e => { keyRef.current?.(e); invalidate() }
    window.addEventListener('keydown', onKey)
    const ro = new ResizeObserver(() => { w = mount.clientWidth || w; h = mount.clientHeight || h; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); invalidate() })
    ro.observe(mount)
    setStatus(statusText())
    let raf = 0, lastRender = 0
    const loop = (now = 0) => {
      raf = requestAnimationFrame(loop)
      // Drawing during an export is work nobody sees — the scene cannot change while it runs — and it is not free:
      //  the keep-alive branch below redraws every 500ms no matter what, which on a 980k-facet model is one long
      //  main-thread block. That block was landing between the export's postMessage and the worker's reply and
      //  reading as 400ms of "kernel time" that the worker spent 0ms on. Skipping frames costs nothing here.
      if (renderSuspended) return
      orbit.update()
      if (renderPending || now - lastRender > 500) {
        renderPending = false; lastRender = now
        // Per rendered frame, not per change: the handles are sized in screen pixels, so they have to be re-sized
        //  whenever the camera moves, and that is exactly the set of frames that get drawn.
        scaleBox.update(canvasModeRef.current === 'preview' ? null : scaleBoxTarget(), gizmoMode === 'scale')
        renderer.render(scene, camera)
      }
    }
    loop()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect(); window.removeEventListener('keydown', onKey)
      renderer.domElement.removeEventListener('pointermove', onMove); renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerdown', onRmbDown); renderer.domElement.removeEventListener('contextmenu', onCtxMenu)
      renderer.domElement.removeEventListener('dblclick', onDblClick); renderer.domElement.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp)
      clearSlaPreview()
      apiRef.current = null
      transform.detach(); transform.dispose(); orbit.dispose(); scaleBox.dispose(); boxSelect.dispose()
      scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose() })
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
  }, [])

  return { mountRef, three }
}
