import * as THREE from 'three'
import { THEME } from '../core/theme.js'

// Box select (upstream's rectangle selection, GLCanvas3D.cpp:4404) — the rubber band and what it catches.
// Shift + left-drag, exactly as upstream binds it — Alt is NOT a de-select there either (`//BBS: don't use alt
//  as de-select`), it switches to volume mode, which this viewer has no equivalent for.
// Upstream decides what is inside with a GPU picking pass over a framebuffer the size of the rectangle. That
//  buys per-pixel accuracy (an object hidden behind another is not caught) at the cost of a second render path.
//  Here each object's world bounding box is projected to screen and its 2D extent is intersected with the
//  rectangle instead — the same idea upstream uses for its point-based gizmos (GLSelectionRectangle::contains).
//  The difference is visible in one case only: a fully occluded object inside the rectangle is selected here
//  and would not be upstream. For picking whole objects that is the harmless direction to err in.
//
// Same shape as scale_box.js: the projection maths is exported on its own so it can be tested under node, and
//  the DOM/pointer half is a controller the scene drives. What the picked meshes then DO to the selection stays
//  with the scene — that is scene state, not this module's.

const _corner = new THREE.Vector3(), _box = new THREE.Box3()

/** An object's world bounding box projected to the screen, as a client-pixel rectangle.
 *  Null when the box is empty (an object with no geometry projects to nothing). */
export function projectToScreenRect(object3D, camera, rect) {
  object3D.updateMatrixWorld(true)
  _box.setFromObject(object3D)
  if (!Number.isFinite(_box.min.x)) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let corner = 0; corner < 8; corner++) {
    _corner.set(corner & 1 ? _box.max.x : _box.min.x,
                corner & 2 ? _box.max.y : _box.min.y,
                corner & 4 ? _box.max.z : _box.min.z).project(camera)
    const sx = rect.left + (_corner.x * 0.5 + 0.5) * rect.width
    const sy = rect.top + (-_corner.y * 0.5 + 0.5) * rect.height
    if (sx < minX) minX = sx
    if (sx > maxX) maxX = sx
    if (sy < minY) minY = sy
    if (sy > maxY) maxY = sy
  }
  return { minX, minY, maxX, maxY }
}

/** Screen-rectangle overlap. Touching edges count as overlapping, which is what a drag that just grazes an
 *  object reads as to the user. */
export const rectsOverlap = (a, b) =>
  a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY

/** Normalise a drag (which can run in any direction) into a rectangle. */
export const dragToRect = ({ x0, y0, x1, y1 }) => ({
  minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minY: Math.min(y0, y1), maxY: Math.max(y0, y1),
})

/** Which of `meshes` the drag rectangle catches, in the order they were given. */
export function meshesInRect(meshes, drag, camera, rect) {
  const band = dragToRect(drag)
  const out = []
  for (const mesh of meshes) {
    const screen = projectToScreenRect(mesh, camera, rect)
    if (screen && rectsOverlap(screen, band)) out.push(mesh)
  }
  return out
}

/** The controller the scene drives: owns the band element and the in-flight drag, nothing else. */
export function createBoxSelect({ camera, domElement, mount }) {
  const band = document.createElement('div')
  band.dataset.testid = 'box-select-band'
  band.style.cssText = `position:absolute;border:1px solid ${THEME.accent};background:color-mix(in srgb, ${THEME.accent} 12%, transparent);`
    + 'pointer-events:none;display:none;z-index:5'
  mount.appendChild(band)
  let drag = null

  const draw = () => {
    const r = domElement.getBoundingClientRect()
    const box = dragToRect(drag)
    band.style.left = `${box.minX - r.left}px`; band.style.top = `${box.minY - r.top}px`
    band.style.width = `${box.maxX - box.minX}px`
    band.style.height = `${box.maxY - box.minY}px`
    band.style.display = 'block'
  }

  return {
    dragging: () => drag != null,
    begin: (ev) => { drag = { x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY }; draw() },
    move: (ev) => { if (drag) { drag.x1 = ev.clientX; drag.y1 = ev.clientY; draw() } },
    /** Ends the drag and returns the meshes it caught. The caller decides what that means for the selection. */
    end: (meshes) => {
      if (!drag) return []
      const picked = meshesInRect(meshes, drag, camera, domElement.getBoundingClientRect())
      band.style.display = 'none'
      drag = null
      return picked
    },
    dispose: () => { band.remove() },
  }
}
