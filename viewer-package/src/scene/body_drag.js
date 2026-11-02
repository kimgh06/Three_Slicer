import * as THREE from 'three'
import { isClick } from '../core/click.js'

const box = new THREE.Box3()
const BED_PLANE_AXIS = 'XZ'

// Dragging the selection itself, or the box drawn around it, moves it on the bed. It runs on TransformControls' own XZ
//  drag, so the commit, the re-seat and undo are a gizmo move's. It starts only once the pointer leaves the click
//  distance: a drag records an undo step, and a plain click on a model must not.
export function createBodyDrag({ transform, orbit }) {
  let pressed = null
  const overSelection = (ray) => {
    if (!transform.object) return false
    box.setFromObject(transform.object)
    return !box.isEmpty() && ray.intersectsBox(box)
  }
  return {
    overSelection,
    press(event, pointer, ray) {
      const plain = event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey
      if (!plain || transform.mode !== 'translate' || !transform.enabled || !overSelection(ray)) return
      pressed = { x: event.clientX, y: event.clientY, ndcX: pointer.x, ndcY: pointer.y }
      orbit.enabled = false
    },
    move(event) {
      if (!pressed || isClick(pressed, { x: event.clientX, y: event.clientY })) return
      const { ndcX, ndcY } = pressed
      pressed = null
      transform.axis = BED_PLANE_AXIS
      transform.updateMatrixWorld()     // the drag plane follows the axis, and it is laid out here
      transform.pointerDown({ x: ndcX, y: ndcY, button: 0 })
    },
    release() {
      if (!pressed) return
      pressed = null
      orbit.enabled = true
    },
  }
}
