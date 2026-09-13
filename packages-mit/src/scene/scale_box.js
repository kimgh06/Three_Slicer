import * as THREE from 'three'
import { THEME } from '../core/theme.js'

// The selection's bounding box, and uniform (all three axes at once) scaling by dragging one of its corners.
// Two jobs in one object because they share the same geometry: the box is drawn whenever something is selected —
//  it is the only place the viewer shows how much room the part actually takes — and its eight corner handles
//  become grabbable in scale mode.
// It does NOT replace the TransformControls scale gizmo, it sits on top of it: the gizmo keeps per-axis scaling,
//  the corners add "XYZ together". The gizmo's own XYZ handle exists but is a small octahedron at the object's
//  origin, i.e. inside the model and at gizmo size — which is why it was unusable and this exists.
// The box is oriented (it rides the object's own rotation) rather than an axis-aligned world box, so a rotated
//  part still gets a tight box instead of a loose one that overstates its footprint.

const CORNERS = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]]
const HANDLE_PX = 12          // handles keep a constant SCREEN size, so a 5mm part and a 300mm part grab alike
const COLOR = THEME.accent   // the selection green used by the emissive tint

// How much bigger the object gets: the pointer's distance from the box centre now, over its distance at the grab.
//  Measured in SCREEN space rather than on a drag plane because a plane seen nearly edge-on makes the ray
//  intersection — and with it the scale — run away. `lo`/`hi` are the caller's size clamps.
export function dragRatio(centre, start, now, lo, hi) {
  // 8px floor: a grab that lands on the projected centre (looking straight down an axis) must not divide by ~0.
  const d0 = Math.max(8, Math.hypot(start.x - centre.x, start.y - centre.y))
  const d1 = Math.hypot(now.x - centre.x, now.y - centre.y)
  return Math.min(hi, Math.max(lo, d1 / d0))
}

// Size limits, shared with the gizmo's own scale drag. Measured on the stock TransformControls: pressing its XYZ
//  handle (the small octahedron at the object's origin, the one the corner handles exist to replace) starts the
//  drag at a distance of ~0 from the centre, and the ratio it divides by that leaves the part at 4e7 — off any bed
//  and impossible to grab back. Corner drags clamp the RATIO instead (below), which keeps all three axes equal;
//  this per-component form is for the gizmo, where the axes are meant to move independently.
const MIN_MM = 0.2, MAX_MM = 5000
export function clampMeshScale(mesh) {
  const geometry = mesh?.geometry
  if (!geometry) return
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const size = geometry.boundingBox.getSize(new THREE.Vector3())
  for (const axis of ['x', 'y', 'z']) {
    const extent = Math.max(1e-6, size[axis])
    // Positive, not just bounded: dragging an axis handle through the centre comes back negative, and a negative
    //  scale mirrors the mesh — which inverts its triangle winding, and the winding is what the kernel slices.
    //  There is no mirror feature here for that to be, so it can only be an accident.
    const magnitude = Math.min(MAX_MM / extent, Math.max(MIN_MM / extent, Math.abs(mesh.scale[axis])))
    if (Number.isFinite(magnitude)) mesh.scale[axis] = magnitude
  }
}

export function createScaleBox({ scene, camera, domElement }) {
  const group = new THREE.Group()
  group.renderOrder = 999
  // depthTest off on both: the box and its handles must stay visible (and grabbable) where the model is in front
  //  of them, which for a corner of a convex part is most of the time.
  const boxMaterial = new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true, opacity: 0.85 })
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), boxMaterial)
  box.matrixAutoUpdate = false; box.frustumCulled = false; box.renderOrder = 999
  group.add(box)

  const handleGeometry = new THREE.BoxGeometry(1, 1, 1)
  const handleMaterial = new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false, transparent: true, opacity: 0.95 })
  const handles = CORNERS.map(() => {
    const mesh = new THREE.Mesh(handleGeometry, handleMaterial)
    mesh.frustumCulled = false; mesh.renderOrder = 1000; mesh.visible = false
    group.add(mesh); return mesh
  })
  scene.add(group)

  const _boxCentre = new THREE.Vector3(), _boxSize = new THREE.Vector3(), _corner = new THREE.Vector3()
  const _localToUnit = new THREE.Matrix4(), _noRotation = new THREE.Quaternion()
  let current = null, drag = null

  const boundsOf = (mesh) => {
    const geometry = mesh.geometry
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    return geometry.boundingBox
  }
  // World size of one screen pixel at that point — the perspective divide, so the handle keeps its pixel size.
  const worldPerPixel = (point) => {
    const height = domElement.clientHeight || 1
    return 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.position.distanceTo(point) / height
  }
  const toScreen = (point) => {
    const projected = point.clone().project(camera)
    const rect = domElement.getBoundingClientRect()
    return { x: rect.left + (projected.x * 0.5 + 0.5) * rect.width, y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height }
  }
  const cornerAt = (bounds, index, matrixWorld) => {
    const flag = CORNERS[index]
    return _corner.set(flag[0] ? bounds.max.x : bounds.min.x,
                       flag[1] ? bounds.max.y : bounds.min.y,
                       flag[2] ? bounds.max.z : bounds.min.z).applyMatrix4(matrixWorld)
  }

  // Called once per rendered frame with whatever is selected: no attach/detach for every selection path to keep in
  //  step, and the cost is eight corners rather than a Box3 sweep over the mesh (which would be per-vertex).
  const update = (target, handlesVisible) => {
    current = target || null
    box.visible = !!current
    for (const handle of handles) handle.visible = !!current && !!handlesVisible
    if (!current) return
    current.updateMatrixWorld(true)
    const bounds = boundsOf(current)
    bounds.getCenter(_boxCentre); bounds.getSize(_boxSize)
    _boxSize.set(Math.max(_boxSize.x, 1e-6), Math.max(_boxSize.y, 1e-6), Math.max(_boxSize.z, 1e-6))
    _localToUnit.compose(_boxCentre, _noRotation, _boxSize)
    box.matrix.multiplyMatrices(current.matrixWorld, _localToUnit)
    box.matrixWorldNeedsUpdate = true
    if (!handlesVisible) return
    for (let i = 0; i < handles.length; i++) {
      handles[i].position.copy(cornerAt(bounds, i, current.matrixWorld))
      handles[i].scale.setScalar(HANDLE_PX * worldPerPixel(handles[i].position))
    }
  }

  const hitTest = (raycaster) => {
    const visible = handles.filter(h => h.visible)
    if (!visible.length) return null
    const hits = raycaster.intersectObjects(visible, false)
    return hits.length ? hits[0].object : null
  }

  const begin = (event, target) => {
    if (!target) return false
    target.updateMatrixWorld(true)
    const bounds = boundsOf(target)
    bounds.getCenter(_boxCentre); bounds.getSize(_boxSize)
    const world = _boxSize.clone().multiply(new THREE.Vector3(
      Math.abs(target.scale.x), Math.abs(target.scale.y), Math.abs(target.scale.z)))
    const smallest = Math.max(1e-6, Math.min(world.x, world.y, world.z))
    const largest = Math.max(1e-6, Math.max(world.x, world.y, world.z))
    drag = {
      target,
      scale: target.scale.clone(),
      centre: toScreen(_boxCentre.clone().applyMatrix4(target.matrixWorld)),
      start: { x: event.clientX, y: event.clientY },
      lo: MIN_MM / smallest,   // never shrink a dimension past this — below it the part is gone and cannot be grabbed back
      hi: MAX_MM / largest,
    }
    return true
  }

  const move = (event) => {
    if (!drag) return false
    const ratio = dragRatio(drag.centre, drag.start, { x: event.clientX, y: event.clientY }, drag.lo, drag.hi)
    drag.target.scale.copy(drag.scale).multiplyScalar(ratio)
    drag.target.updateMatrixWorld(true)
    return true
  }

  const end = () => { const was = drag; drag = null; return was?.target || null }

  return {
    update, hitTest, begin, move, end,
    dragging: () => !!drag,
    dispose: () => {
      scene.remove(group)
      box.geometry.dispose(); boxMaterial.dispose(); handleGeometry.dispose(); handleMaterial.dispose()
    },
  }
}
