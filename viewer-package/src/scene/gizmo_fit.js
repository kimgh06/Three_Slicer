import * as THREE from 'three'
import { gizmoLayout, handleOffset } from '../core/gizmo_layout.js'

const SINGLE_AXES = { X: 0, Y: 1, Z: 2 }
const ARM_PICK_RADIUS = 0.09     // the grab area of an arm's end, in handle units
const ARM_END_UNITS = 0.55

const box = new THREE.Box3()
const offset = new THREE.Vector3()

function boundsOf(geometry) {
  geometry.computeBoundingBox()
  return geometry.boundingBox
}

// An arm's stem would cross the selection, and its picker reaches the centre, where it would take clicks meant for the
//  model. So a stem is removed from the object graph (the per-frame update rewrites `visible`, so a flag does not stick),
//  and a picker shrinks to the arm's end. The plane handles go too: a drag on the selection moves it on the bed
//  (body_drag.js), and the box corners scale it.
function prepareHandles(group, isPicker) {
  for (const handle of [...group.children]) {
    if (handle.name.length === 2) { group.remove(handle); continue }
    const axis = SINGLE_AXES[handle.name]
    if (axis !== undefined) {
      const { min, max } = boundsOf(handle.geometry)
      const axisKey = 'xyz'[axis]
      const isStem = !isPicker && Math.min(Math.abs(min[axisKey]), Math.abs(max[axisKey])) < 0.02
      if (isStem) { group.remove(handle); continue }
      if (isPicker) {
        const end = [0, 0, 0]
        end[axis] = Math.sign(min[axisKey] + max[axisKey]) * ARM_END_UNITS
        handle.geometry = new THREE.SphereGeometry(ARM_PICK_RADIUS).translate(...end)
      }
    }
    const { min, max } = boundsOf(handle.geometry)
    handle.userData.centre = ['x', 'y', 'z'].map(key => (min[key] + max[key]) / 2)
  }
}

// TransformControls resets every handle's place and size in its own updateMatrixWorld, so the layout goes on right after.
export function fitGizmoToSelection(transform, camera, domElement) {
  const gizmo = transform._gizmo
  const placedModes = ['translate', 'scale']
  for (const mode of placedModes) {
    prepareHandles(gizmo.gizmo[mode], false)
    prepareHandles(gizmo.picker[mode], true)
  }
  const updateHandles = gizmo.updateMatrixWorld.bind(gizmo)
  gizmo.updateMatrixWorld = (force) => {
    updateHandles(force)
    const mode = transform.mode
    if (!transform.object || !(transform.object.visible ?? true)) return
    box.setFromObject(transform.object)
    if (box.isEmpty()) return
    const origin = gizmo.worldPosition
    const distance = origin.distanceTo(gizmo.cameraPosition)
    const pixelsPerMm = domElement.clientHeight / (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * camera.zoom
    const layout = gizmoLayout({
      low: [origin.x - box.min.x, origin.y - box.min.y, origin.z - box.min.z],
      high: [box.max.x - origin.x, box.max.y - origin.y, box.max.z - origin.z],
      pixelsPerMm, mode,
    })
    for (const handle of [...gizmo.gizmo[mode].children, ...gizmo.picker[mode].children]) {
      handle.scale.setScalar(layout.scale)
      if (placedModes.includes(mode)) handle.position.add(offset.fromArray(handleOffset(handle.userData.centre, layout)))
      handle.updateMatrixWorld(true)
    }
  }
}
