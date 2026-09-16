import * as THREE from 'three'
import { kernelClipPlane, clipConstantForRatio } from '../core/paint_clip.js'

// Upstream's object clipper (GLGizmoPainterBase.cpp:709 — Alt + wheel while a painting gizmo is open). It cuts the
// model away between the camera and the plane, which is the only way a brush reaches a surface INSIDE the model:
// a raycast can only ever hit the outside, so without it the inner wall of a hull or the floor of a cavity is
// unpaintable however the cursor is aimed.
//
// Two consumers of one plane, and they clip in different frames and opposite directions — the conversion lives in
// core/paint_clip.js, where it can be asserted. Getting it wrong is invisible in the render and wrong in the paint:
// the cut would look right while the stroke marked the half that was cut away.
const RATIO_STEP = 0.01
const OFF = -1   // upstream's own "no plane" value (set_position_by_ratio(-1., false))

export function createSectionPlane({ renderer, camera, objectsRef, workerRef, paintXformRef, invalidate }) {
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)
  const normal = new THREE.Vector3(0, 0, -1)   // frozen when the plane is switched on, like upstream's keep_normal
  const planes = [plane]
  let ratio = OFF

  const bounds = () => {
    const box = new THREE.Box3()
    let any = false
    for (const object of objectsRef.current) {
      if (object.visible === false) continue
      object.mesh.updateMatrixWorld(true); box.expandByObject(object.mesh); any = true
    }
    if (!any) return null
    return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] }
  }
  // The materials are re-pointed at the plane list rather than handed a copy, so a scrub changes `plane` in place
  //  and every mesh follows without another walk. `null` is three's "not clipped", not an empty array — an empty
  //  array still marks the material as needing the clipping shader chunks.
  const applyToMaterials = (active) => {
    renderer.localClippingEnabled = true
    for (const object of objectsRef.current) {
      const material = object.mesh.material
      if (!material) continue
      material.clippingPlanes = active ? planes : null
      material.clipShadows = active
      material.needsUpdate = true
      // The overhang overlay and any other child ride along, or the cut shows the shading of a surface that is gone.
      for (const child of object.mesh.children) if (child.material) { child.material.clippingPlanes = active ? planes : null; child.material.needsUpdate = true }
    }
  }
  // The kernel has to clip against the same half-space or the brush paints what the render just cut away.
  const syncKernel = (active) => {
    const worker = workerRef.current; if (!worker) return
    if (!active) { worker.postMessage({ cmd: 'paintMode', clipPlane: null }); return }
    const converted = kernelClipPlane([plane.normal.x, plane.normal.y, plane.normal.z], plane.constant,
                                      paintXformRef.current ?? { cx: 0, cy: 0, minz: 0 })
    worker.postMessage({ cmd: 'paintMode', clipPlane: [...converted.normal, converted.offset] })
  }

  const reset = () => {
    if (ratio < 0) return
    ratio = OFF
    applyToMaterials(false); syncKernel(false); invalidate?.()
  }
  // `delta` is in wheel notches, positive = cut more. The plane switches on at the first scrub and takes the
  //  camera's current direction as its normal, which is what makes "cut towards me" mean the same thing from
  //  wherever you are looking.
  //  It arms at ratio 0 — NOTHING cut — and scrubs up from there, which is upstream's own convention (its clipper
  //  position 0 clips nothing, and wheel-up raises it). Arming at the other end instead makes the whole model
  //  vanish on the first notch and take about a hundred more to come back, which reads as a bug rather than a tool.
  //  Scrubbing back down to 0 switches it off rather than leaving an inert plane on every material.
  const scrub = (delta) => {
    const box = bounds(); if (!box) return false
    if (ratio < 0) { camera.getWorldDirection(normal); plane.normal.copy(normal); ratio = 0 }
    ratio = Math.min(1, ratio + delta * RATIO_STEP)
    if (ratio <= 0) { reset(); return true }
    const constant = clipConstantForRatio([plane.normal.x, plane.normal.y, plane.normal.z], box, ratio)
    plane.constant = constant ?? 0
    applyToMaterials(true); syncKernel(true); invalidate?.()
    return true
  }
  // Re-applied when a brush opens and when the object set changes: a mesh spawned while the plane was on would
  //  otherwise render uncut over a scene that is cut.
  const refresh = () => { if (ratio >= 0) applyToMaterials(true) }
  const isActive = () => ratio >= 0
  // The paint overlay is rebuilt from the kernel on every stroke, so it cannot be walked once and left alone —
  //  whoever builds one asks for the list instead. Unclipped, it hangs in the air where the model was cut away.
  const activePlanes = () => (ratio >= 0 ? planes : null)
  // three.js clipping is a fragment operation: the geometry is still there, so a raycast still hits the surface
  //  that was cut away. Skipping those hits is what makes the plane USEFUL rather than just decorative — the ray
  //  falls through to the surface behind, which is the interior the brush could not otherwise reach.
  const isClipped = (point) => ratio >= 0 && plane.distanceToPoint(point) < 0

  return { scrub, reset, refresh, isActive, activePlanes, isClipped }
}
