import * as THREE from 'three'

// The brush preview upstream draws every frame a painting gizmo is open (GLGizmoPainterBase::render_cursor,
// GLGizmoPainterBase.cpp:134) — a translucent ball for the SPHERE cursor, a ring at the pointer for CIRCLE.
//
// Without it the radius slider is a number with no referent: the stroke is the first place you find out how far 5mm
// reaches, and with the sphere cursor on a thin wall it has already painted the far side by then. Measured on the
// 3DBenchy hull, a few 5mm sphere strokes across the bow marked 21933 facets, most of them on surfaces the user was
// not looking at.
//
// Two deliberate differences from upstream, both forced by the renderer rather than chosen:
//  (1) Upstream's circle is a screen-space dashed line loop scaled by the camera zoom, which works because its
//      camera is orthographic. Under a perspective camera the same thing is a ring of the REAL radius placed at the
//      hit and turned to face the camera — which is also exactly the disc the CIRCLE cursor selects with, since
//      `TriangleSelector::Circle` projects along the view direction.
//  (2) The sphere keeps depth testing (upstream renders it inside its own GL_DEPTH_TEST block) so the half inside
//      the model is hidden — that occlusion is the only on-screen cue that the ball reaches through the surface.
//      The ring switches depth testing off, as upstream does, or it disappears into the face it is lying on.
const RING_SEGMENTS = 48

export function createBrushCursor(parent, invalidate) {
  // Unit-sized geometry, scaled per frame: the radius changes on every wheel notch and rebuilding a ring 48 segments
  //  wide for each one is work the GPU already does for free through the model matrix.
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3, depthWrite: false }))
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.97, 1, RING_SEGMENTS),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }))
  ring.renderOrder = 1000
  for (const mesh of [sphere, ring]) { mesh.visible = false; mesh.frustumCulled = false; parent.add(mesh) }

  let shown = false
  const hide = () => {
    if (!shown) return
    shown = false
    sphere.visible = false; ring.visible = false
    invalidate?.()
  }
  // `point` is the world-space raycast hit. A null point (the pointer left the model) hides the cursor rather than
  //  freezing it at the last hit, because a cursor that stays put reads as "the brush is still here".
  const update = ({ point, radius, shape, color, camera }) => {
    if (!point) { hide(); return }
    const target = shape === 'circle' ? ring : sphere
    const other = shape === 'circle' ? sphere : ring
    other.visible = false
    target.position.copy(point)
    target.scale.setScalar(Math.max(radius, 1e-3))
    if (target === ring) ring.quaternion.copy(camera.quaternion)   // face the camera: the disc the CIRCLE cursor cuts
    target.material.color.set(color)
    target.visible = true
    shown = true
    invalidate?.()
  }
  const dispose = () => {
    for (const mesh of [sphere, ring]) { parent.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose() }
  }
  return { update, hide, dispose }
}
