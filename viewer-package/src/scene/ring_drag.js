import * as THREE from 'three'
import { FINE_RING_SPEED, wrapAngle } from '../core/fine_adjust.js'

// A rotate ring turns by the angle the pointer sweeps around it. TransformControls takes the pointer's travel across the
//  ring's axis instead, so one 30 degree sweep along the Y ring measured 56 to 146 degrees by where it began, and a travel
//  along the axis measured nothing. It still runs a drag whose ring faces edge-on, where the plane gives no usable hit.
const SCENE_AXES = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) }
const MODEL_TURNS = { X: { axis: 0, sign: 1 }, Y: { axis: 2, sign: 1 }, Z: { axis: 1, sign: -1 } }
const EDGE_ON_DOT = 0.15

const raycaster = new THREE.Raycaster()
const plane = new THREE.Plane()
const hit = new THREE.Vector3()
const turn = new THREE.Quaternion()

export function createRingDrag(transform, { turned }) {
  const stockDown = transform.pointerDown.bind(transform)
  const stockMove = transform.pointerMove.bind(transform)
  let drag = null

  function pointerAngle(pointer) {
    raycaster.setFromCamera(pointer, transform.camera)
    plane.setFromNormalAndCoplanarPoint(drag.normal, drag.centre)
    if (!raycaster.ray.intersectPlane(plane, hit)) return null
    hit.sub(drag.centre)
    return Math.atan2(hit.dot(drag.v), hit.dot(drag.u))
  }
  function begin(pointer) {
    const normal = SCENE_AXES[transform.axis]
    drag = null
    if (transform.mode !== 'rotate' || !transform.dragging || !normal) return
    raycaster.setFromCamera(pointer, transform.camera)
    if (Math.abs(raycaster.ray.direction.dot(normal)) < EDGE_ON_DOT) return
    const u = new THREE.Vector3(normal.y, normal.z, normal.x)
    const started = {
      normal, u, v: new THREE.Vector3().crossVectors(normal, u), centre: transform.worldPosition.clone(),
      start: transform.object.quaternion.clone(), swept: 0, shown: 0, previous: 0, name: transform.axis,
    }
    drag = started
    started.previous = pointerAngle(pointer) ?? 0
  }
  transform.pointerDown = (pointer) => { stockDown(pointer); begin(pointer) }
  transform.pointerMove = (pointer) => {
    if (!drag || !transform.dragging || pointer.button !== -1) { stockMove(pointer); return }
    const angle = pointerAngle(pointer)
    if (angle === null) return
    const snap = transform.rotationSnap
    let speed = 1
    if (snap) speed = FINE_RING_SPEED
    drag.swept += wrapAngle(angle - drag.previous) * speed
    drag.previous = angle
    let shown = drag.swept
    if (snap) shown = Math.round(shown / snap) * snap
    const { axis, sign } = MODEL_TURNS[drag.name]
    const object = transform.object
    turned(object, axis, THREE.MathUtils.radToDeg(shown - drag.shown) * sign, () => {
      object.quaternion.copy(turn.setFromAxisAngle(drag.normal, shown)).multiply(drag.start).normalize()
    })
    drag.shown = shown
    transform.dispatchEvent({ type: 'change' })
    transform.dispatchEvent({ type: 'objectChange' })
  }
}
