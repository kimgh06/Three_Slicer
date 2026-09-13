import * as THREE from 'three'
import { THEME } from '../core/theme.js'

// The nozzle marker — upstream's SequentialView::Marker (GCodeViewer.hpp), reduced to what this viewer needs.
// Two cones of the same shape and colour: the CURRENT position solid, the layer's END position as a ghost. Same
// shape and colour on purpose — the end position is not a different kind of thing, it is the same nozzle later,
// and a second colour would read as a second object.
//
// Three properties upstream spells out and that are easy to lose:
//  · the tip touches the point exactly and the body sits above it (upstream's m_model_z_offset) — a cone centred
//    on the position points at nothing in particular;
//  · fixed SCREEN size (m_fixed_screen_size), because a millimetre-sized marker is a speck zoomed out and fills
//    the view zoomed in. Recomputed per frame from the camera distance;
//  · it must not be occluded. The nozzle is by definition on top of the geometry just drawn, so depth testing
//    buries half of it — this is a UI overlay that happens to live in the scene, not part of the scene.

const BASE_HEIGHT = 1                  // unit cone; the per-frame scale is what sets the real size
const SCREEN_FRACTION = 0.055          // of the viewport height
const COLOR = THEME.nozzle

function makeCone(opacity) {
  // Apex at the origin pointing DOWN the group's local -z (the group is z-up), body extending +z above it.
  const geo = new THREE.ConeGeometry(BASE_HEIGHT * 0.32, BASE_HEIGHT, 20)
    .rotateX(-Math.PI / 2)
    .translate(0, 0, BASE_HEIGHT / 2)
  const mat = new THREE.MeshBasicMaterial({
    color: COLOR, transparent: opacity < 1, opacity,
    depthTest: false, depthWrite: false,          // always on top — see the note above
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 10                            // above the toolpath and the SLA preview
  mesh.frustumCulled = false                       // it is small and always wanted; culling it costs more than drawing it
  mesh.visible = false
  return mesh
}

/**
 * `toolpathGroup` is the same parent the plate toolpaths hang off, so Prepare/Preview visibility covers the
 * marker for free. `invalidate` re-renders an on-demand frame.
 */
export function makeNozzleMarker(toolpathGroup, invalidate) {
  let group = null, current = null, ghost = null

  function ensure() {
    if (group) return
    group = new THREE.Group()
    group.rotation.x = -Math.PI / 2                // kernel z-up, as every plate group does
    current = makeCone(1)
    ghost = makeCone(0.28)
    group.add(current); group.add(ghost)
    // Fixed screen size: the world height one viewport spans at this distance is 2*d*tan(fov/2), so a marker of
    //  SCREEN_FRACTION of that stays the same size on screen at every zoom. Riding onBeforeRender keeps it on the
    //  render loop the toolpath material already uses rather than adding a second per-frame hook.
    const eye = new THREE.Vector3(), here = new THREE.Vector3()
    current.onBeforeRender = (renderer, scene, camera) => {
      camera.getWorldPosition(eye)
      for (const mesh of [current, ghost]) {
        if (!mesh.visible) continue
        mesh.getWorldPosition(here)
        const d = eye.distanceTo(here)
        const span = camera.isPerspectiveCamera
          ? 2 * d * Math.tan((camera.fov * Math.PI / 180) / 2)
          : (camera.top - camera.bottom) / (camera.zoom || 1)
        const s = Math.max(1e-3, SCREEN_FRACTION * span / BASE_HEIGHT)
        mesh.scale.setScalar(s)
      }
    }
    toolpathGroup.add(group)
  }

  /**
   * `payload` = { current: [x,y,z]|null, end: [x,y,z]|null, offX, offZ } in the plate's kernel frame; null hides
   * the marker. The ghost is dropped when it coincides with the current position — while the whole layer is
   * shown the two ARE the same point, and drawing a ghost inside the solid cone just makes it look dirty.
   */
  function set(payload) {
    if (!payload || !payload.current) { hide(); return }
    ensure()
    group.position.set(payload.offX || 0, 0, payload.offZ || 0)
    current.position.set(payload.current[0], payload.current[1], payload.current[2])
    current.visible = true
    const end = payload.end
    const apart = end && (Math.abs(end[0] - payload.current[0]) > 1e-3
                       || Math.abs(end[1] - payload.current[1]) > 1e-3
                       || Math.abs(end[2] - payload.current[2]) > 1e-3)
    if (apart) { ghost.position.set(end[0], end[1], end[2]); ghost.visible = true }
    else ghost.visible = false
    invalidate()
  }

  function hide() {
    if (!group) return
    current.visible = false; ghost.visible = false
    invalidate()
  }

  function dispose() {
    if (!group) return
    for (const mesh of [current, ghost]) { mesh.geometry.dispose(); mesh.material.dispose() }
    group.parent?.remove(group)
    group = current = ghost = null
  }

  return { set, hide, dispose }
}
