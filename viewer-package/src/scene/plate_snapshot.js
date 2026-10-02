// What the export reads off a plate's objects in the scene: the printer's thumbnail image and the footprint seen from
//  above. Split out of use_three_scene.js, which hands in its scene state.
import { convexHull } from '../core/convex_hull.js'

function objectsOnPlate(THREE, objects, plateOf, plateIdx) {
  const position = new THREE.Vector3()
  return objects.filter(o => {
    if (o.visible === false) return false
    if (plateIdx == null) return true
    o.mesh.updateMatrixWorld(true)
    position.setFromMatrixPosition(o.mesh.matrixWorld)
    return plateOf(position.x, position.z) === plateIdx
  })
}

// The printer's thumbnail of a plate (core/thumbnails.js): its objects alone, on a transparent background, seen from
//  the front and above as upstream's thumbnail camera does, rendered offscreen at width x height. RGBA, top row first;
//  null without objects on the plate.
export function renderPlateThumbnail(THREE, t, { objects, objectsGroup, plateOf, plateIdx, width, height }) {
  const shown = objectsOnPlate(THREE, objects, plateOf, plateIdx)
  if (!shown.length) return null
  const box = new THREE.Box3()
  for (const o of shown) box.expandByObject(o.mesh)
  const center = box.getCenter(new THREE.Vector3()), radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1
  const camera = new THREE.PerspectiveCamera(30, width / height, radius * 0.1, radius * 20)
  const distance = radius / Math.sin((30 / 2) * Math.PI / 180)
  camera.position.copy(center).add(new THREE.Vector3(0, 0.6, 1).normalize().multiplyScalar(distance))
  camera.lookAt(center)
  // Only the plate's objects: everything else in the scene is hidden for the one render and put back.
  const hidden = []
  for (const child of t.scene.children) {
    if (child === objectsGroup || child.isLight || !child.visible) continue
    child.visible = false; hidden.push(child)
  }
  const objectsShown = objectsGroup.visible
  objectsGroup.visible = true
  const others = objects.filter(o => !shown.includes(o) && o.mesh.visible)
  for (const o of others) o.mesh.visible = false
  const target = new THREE.WebGLRenderTarget(width, height)
  const clear = t.renderer.getClearColor(new THREE.Color()), clearAlpha = t.renderer.getClearAlpha()
  t.renderer.setRenderTarget(target)
  t.renderer.setClearColor(0x000000, 0)
  t.renderer.clear()
  t.renderer.render(t.scene, camera)
  const pixels = new Uint8Array(width * height * 4)
  t.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
  t.renderer.setRenderTarget(null)
  t.renderer.setClearColor(clear, clearAlpha)
  target.dispose()
  for (const child of hidden) child.visible = true
  for (const o of others) o.mesh.visible = true
  objectsGroup.visible = objectsShown
  t.invalidate?.()
  // WebGL reads bottom row first; the image formats start at the top.
  const rgba = new Uint8Array(width * height * 4), row = width * 4
  for (let y = 0; y < height; y++) rgba.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row)
  return rgba
}

// The convex hull of everything on the plate seen from above, world [x, y] points like modelBounds — what a bed that
//  is not a rectangle is checked against (bed_bounds.js). Per object first, so the merge stays small.
export function plateFootprint(THREE, objects, plateOf, plateIdx) {
  const shown = objectsOnPlate(THREE, objects, plateOf, plateIdx)
  if (!shown.length) return null
  const vertex = new THREE.Vector3(), hulls = []
  for (const o of shown) {
    o.mesh.updateMatrixWorld(true)
    const points = [], localPositions = o.localPos
    for (let i = 0; i < localPositions.length; i += 3) {
      vertex.set(localPositions[i], localPositions[i + 1], localPositions[i + 2]).applyMatrix4(o.mesh.matrixWorld)
      points.push([vertex.x, -vertex.z])
    }
    hulls.push(...convexHull(points))
  }
  return convexHull(hulls)
}
