import * as THREE from 'three'
import { FINE_MOVE_SNAP_MM, FINE_ROTATE_SNAP_DEGREES, FINE_SCALE_SNAP, resizedScales, twistDegrees } from '../core/fine_adjust.js'
import { clampMeshScale } from './scale_box.js'
import { createRingDrag } from './ring_drag.js'

// Model X, Y, Z in the scene's axes: the scene is Y up, and model Y runs along scene -Z.
const SCALE_KEYS = ['x', 'z', 'y']
const SAME_TURN_RADIANS = 1e-4
const KEPT_TURNS = 50          // the undo history's own limit
const WORLD_AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)]

const box = new THREE.Box3()
const centre = new THREE.Vector3()
const localSize = new THREE.Vector3()

// Typed values reach the selection through the gizmo's own 'dragging-changed' pair, so a typed move commits as a dragged
//  one does: undo, re-seat, pivot release, paint re-registration and slice staleness.
// The turns shown per axis are kept beside the rotation they led to, so X 90 then Y 90 reads 90 and 90, and an undo finds
//  the entry it went back to. A rotation that came from elsewhere (Orient, PageUp) matches none and is read from the
//  quaternion instead.
export function createFineTransform({ transform }) {
  const turns = new WeakMap()
  function turnsOf(object) {
    const kept = turns.get(object)?.find(entry => entry.quaternion.angleTo(object.quaternion) < SAME_TURN_RADIANS)
    if (kept) return kept.degrees
    return WORLD_AXES.map(axis => twistDegrees(object.quaternion, axis.toArray()))
  }
  function turned(object, axis, degrees, rotate) {
    const next = [...turnsOf(object)]
    rotate()
    next[axis] += degrees
    const entries = turns.get(object) ?? []
    turns.set(object, [{ quaternion: object.quaternion.clone(), degrees: next }, ...entries].slice(0, KEPT_TURNS))
  }
  createRingDrag(transform, { turned })
  const target = () => {
    const object = transform.object
    if (!object || object.userData?.isPrimeTower) return null
    return object
  }
  function sizesOf(object) {
    box.setFromObject(object)
    if (!object.isMesh) {
      box.getSize(localSize)
    } else {
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox()
      object.geometry.boundingBox.getSize(localSize).multiply(object.scale)
    }
    return SCALE_KEYS.map(key => localSize[key])
  }
  function commit(change) {
    const object = target()
    if (!object) return
    transform.dispatchEvent({ type: 'dragging-changed', value: true })
    change(object)
    if (object.isMesh) clampMeshScale(object)
    object.updateMatrixWorld(true)
    transform.dispatchEvent({ type: 'dragging-changed', value: false })
  }
  return {
    read(origin) {
      const object = target()
      if (!object) return null
      const sizes = sizesOf(object)
      box.setFromObject(object).getCenter(centre)
      let percents = null, degrees = null
      if (object.isMesh) {
        percents = SCALE_KEYS.map(key => object.scale[key] * 100)
        degrees = turnsOf(object)
      }
      return {
        position: [centre.x - origin.x, origin.z - centre.z],
        height: box.min.y, keepsHeight: !!object.userData.keepHeight, sizes, percents, degrees,
      }
    },
    move(axis, value, origin) {
      commit((object) => {
        box.setFromObject(object).getCenter(centre)
        if (axis === 0) object.position.x += value - (centre.x - origin.x)
        else object.position.z -= value - (origin.z - centre.z)
      })
    },
    setHeight(value) {
      commit((object) => { object.position.y += value - box.setFromObject(object).min.y })
    },
    rotate(axis, degrees) {
      commit(object => turned(object, axis, degrees, () => object.rotateOnWorldAxis(WORLD_AXES[axis], THREE.MathUtils.degToRad(degrees))))
    },
    // A multi-selection scales as a block: its pivot can only take one ratio without shearing a rotated member.
    resize(axis, size, uniform) {
      commit((object) => {
        const sizes = sizesOf(object)
        if (!object.isMesh) { object.scale.multiplyScalar(size / sizes[axis]); return }
        const scales = resizedScales(SCALE_KEYS.map(key => object.scale[key]), sizes, axis, size, uniform)
        SCALE_KEYS.forEach((key, index) => { object.scale[key] = scales[index] })
      })
    },
    reset(kind) {
      commit((object) => {
        if (kind === 'rotate') object.rotation.set(0, 0, 0)
        else object.scale.set(1, 1, 1)
      })
    },
    setSnap(on) {
      if (on) {
        transform.setTranslationSnap(FINE_MOVE_SNAP_MM)
        transform.setRotationSnap(THREE.MathUtils.degToRad(FINE_ROTATE_SNAP_DEGREES))
        transform.setScaleSnap(FINE_SCALE_SNAP)
        return
      }
      transform.setTranslationSnap(null)
      transform.setRotationSnap(null)
      transform.setScaleSnap(null)
    },
  }
}
