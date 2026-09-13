// Box select — the screen projection that decides what a Shift+drag catches.
//   Run: node packages/viewer/test_box_select.mjs
// The maths moved out of use_three_scene.js verbatim; only the renderer half stayed behind. A real
//  PerspectiveCamera runs fine under node (no WebGL involved), which is the reason this is testable at all.
import assert from 'node:assert'
import * as THREE from 'three'
import { projectToScreenRect, rectsOverlap, dragToRect, meshesInRect } from './src/scene/box_select.js'

// The canvas the scene actually uses, as a DOMRect-shaped plain object.
const RECT = { left: 0, top: 0, width: 800, height: 480 }
const camera = new THREE.PerspectiveCamera(50, RECT.width / RECT.height, 1, 3000)
camera.position.set(0, 200, 400)
camera.lookAt(0, 0, 0)
camera.updateMatrixWorld(true)

const cube = (x, z, size = 20) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size))
  mesh.position.set(x, size / 2, z)
  mesh.updateMatrixWorld(true)
  return mesh
}

// ---- a drag normalises whichever way it was dragged ----
assert.deepEqual(dragToRect({ x0: 100, y0: 50, x1: 20, y1: 200 }), { minX: 20, maxX: 100, minY: 50, maxY: 200 })
assert.deepEqual(dragToRect({ x0: 20, y0: 200, x1: 100, y1: 50 }), { minX: 20, maxX: 100, minY: 50, maxY: 200 })

// ---- overlap, including the grazing case ----
const at = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY })
assert.ok(rectsOverlap(at(0, 0, 10, 10), at(5, 5, 15, 15)))
assert.ok(rectsOverlap(at(0, 0, 10, 10), at(10, 10, 20, 20)), 'touching edges count as caught')
assert.ok(!rectsOverlap(at(0, 0, 10, 10), at(11, 0, 20, 10)))
assert.ok(!rectsOverlap(at(0, 0, 10, 10), at(0, 11, 10, 20)))

// ---- projection: an object at the origin lands near the middle of the canvas ----
{
  const screen = projectToScreenRect(cube(0, 0), camera, RECT)
  assert.ok(screen, 'a cube projects to a rectangle')
  const cx = (screen.minX + screen.maxX) / 2
  assert.ok(Math.abs(cx - RECT.width / 2) < 1, `centred object should project near x=400, got ${cx}`)
  assert.ok(screen.maxX > screen.minX && screen.maxY > screen.minY, 'a non-degenerate rectangle')
}

// ---- an object further from the camera projects smaller ----
{
  const near = projectToScreenRect(cube(0, 100), camera, RECT)
  const far = projectToScreenRect(cube(0, -100), camera, RECT)
  assert.ok(near.maxX - near.minX > far.maxX - far.minX, 'perspective: nearer is wider on screen')
}

// ---- an object with no geometry projects to nothing rather than to NaN ----
assert.equal(projectToScreenRect(new THREE.Group(), camera, RECT), null)

// ---- the canvas offset is honoured: a canvas at left=100 shifts every projection by 100 ----
{
  const base = projectToScreenRect(cube(0, 0), camera, RECT)
  const offset = projectToScreenRect(cube(0, 0), camera, { ...RECT, left: 100, top: 30 })
  assert.ok(Math.abs((offset.minX - base.minX) - 100) < 1e-6)
  assert.ok(Math.abs((offset.minY - base.minY) - 30) < 1e-6)
}

// ---- meshesInRect: catches what the band covers, keeps the given order, drops the rest ----
{
  const left = cube(-60, 0), middle = cube(0, 0), right = cube(60, 0)
  const meshes = [left, middle, right]
  const screens = meshes.map(m => projectToScreenRect(m, camera, RECT))

  // A band drawn exactly around the middle cube catches only it.
  const tight = { x0: screens[1].minX + 1, y0: screens[1].minY + 1, x1: screens[1].maxX - 1, y1: screens[1].maxY - 1 }
  assert.deepEqual(meshesInRect(meshes, tight, camera, RECT), [middle])

  // Dragged the other way round, the same band catches the same thing.
  const reversed = { x0: tight.x1, y0: tight.y1, x1: tight.x0, y1: tight.y0 }
  assert.deepEqual(meshesInRect(meshes, reversed, camera, RECT), [middle])

  // A band over the whole canvas catches all three, in the order they were given.
  const all = { x0: 0, y0: 0, x1: RECT.width, y1: RECT.height }
  assert.deepEqual(meshesInRect(meshes, all, camera, RECT), [left, middle, right])

  // A band in an empty corner catches nothing.
  assert.deepEqual(meshesInRect(meshes, { x0: 0, y0: 0, x1: 2, y1: 2 }, camera, RECT), [])
}

// ---- a fully occluded object inside the band IS caught: the documented difference from upstream ----
{
  // Both on the camera's own view ray (it sits at (0,200,400) looking at the origin), so the nearer, larger cube
  //  really does hide the further, smaller one — the case upstream's GPU picking pass would reject and this
  //  bbox-projection approach accepts. Not bed-seated: occlusion needs depth, not a floor.
  const onViewRay = (t, size) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size))
    mesh.position.set(0, 200 - 200 * t, 400 - 400 * t)
    mesh.updateMatrixWorld(true)
    return mesh
  }
  const front = onViewRay(0.25, 40)
  const behind = onViewRay(0.75, 10)
  const screens = [front, behind].map(m => projectToScreenRect(m, camera, RECT))
  assert.ok(rectsOverlap(screens[0], screens[1]), 'the two really do overlap on screen')
  assert.ok(screens[0].maxX - screens[0].minX > screens[1].maxX - screens[1].minX, 'the front one is the larger')
  const band = { x0: screens[0].minX, y0: screens[0].minY, x1: screens[0].maxX, y1: screens[0].maxY }
  assert.deepEqual(meshesInRect([front, behind], band, camera, RECT), [front, behind])
}

console.log('box_select: ok')
