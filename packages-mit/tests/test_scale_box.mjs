// The two pieces of logic that are not obvious by reading: the uniform-scale drag ratio, and matching a letter
// shortcut on the physical key so a Korean (or any non-Latin) layout still triggers it.
//   node packages/viewer/test_scale_box.mjs
import assert from 'node:assert'
import * as THREE from 'three'
import { dragRatio, clampMeshScale } from './src/scene/scale_box.js'
import { makeKeyHandler } from './src/core/shortcut_keymap.js'

const centre = { x: 100, y: 100 }
const at = (x, y) => ({ x, y })

// Pulling twice as far from the centre doubles the size; halfway back halves it.
assert.strictEqual(dragRatio(centre, at(150, 100), at(200, 100), 0, 1e9), 2)
assert.strictEqual(dragRatio(centre, at(150, 100), at(125, 100), 0, 1e9), 0.5)
// Direction does not matter, only distance — a corner dragged around the box keeps its size.
assert.strictEqual(dragRatio(centre, at(150, 100), at(100, 150), 0, 1e9), 1)
// Clamps hold at both ends.
assert.strictEqual(dragRatio(centre, at(150, 100), at(1e6, 100), 0, 4), 4)
assert.strictEqual(dragRatio(centre, at(150, 100), at(100, 100), 0.25, 4), 0.25)
// A grab on the projected centre (camera straight down an axis) must not divide by ~0.
assert.ok(Number.isFinite(dragRatio(centre, at(100, 100), at(400, 100), 0, 1e9)))

// The gizmo's XYZ handle can start a drag at ~0 distance from the centre and hand back a runaway scale (measured:
// 4e7 on a 20mm cube). The clamp bounds every axis by the world size it produces, in both directions.
const cube = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20))
cube.scale.set(4e7, 1, 1); clampMeshScale(cube)
assert.strictEqual(cube.scale.x, 250)                 // 5000mm / a 20mm edge
cube.scale.set(1e-9, 1, 1); clampMeshScale(cube)
assert.strictEqual(cube.scale.x, 0.01)                // 0.2mm / a 20mm edge
cube.scale.set(3, 2, 1); clampMeshScale(cube)
assert.deepStrictEqual(cube.scale.toArray(), [3, 2, 1])    // in range: untouched
cube.scale.set(-3, 2, 1); clampMeshScale(cube)
assert.deepStrictEqual(cube.scale.toArray(), [3, 2, 1])    // a drag through the centre must not leave a mirrored mesh

// A Korean layout reports e.key 'ㅅ' for the S key; the shortcut has to fire on e.code all the same.
const press = (event) => {
  const fired = []
  makeKeyHandler({
    isPreview: () => false, setGizmo: (m) => fired.push('gizmo:' + m), duplicate: () => fired.push('duplicate'),
    zoomAll: () => fired.push('zoomAll'), zoomBed: () => {}, remove: () => {}, cancelTool: () => {},
    rotateSelected: () => {}, nudgeSelected: () => {}, toggleHelp: () => {}, slice: () => {}, copy: () => {},
    paste: () => {},
  })({ preventDefault() {}, stopPropagation() {}, composedPath: () => [{ tagName: 'CANVAS' }], ...event })
  return fired
}
assert.deepStrictEqual(press({ key: 'ㅅ', code: 'KeyS' }), ['gizmo:scale'])
assert.deepStrictEqual(press({ key: 'ㅁ', code: 'KeyM' }), ['gizmo:translate'])
assert.deepStrictEqual(press({ key: 'ㅋ', code: 'KeyK', ctrlKey: true }), ['duplicate'])
assert.deepStrictEqual(press({ key: 'z', code: 'KeyZ' }), ['zoomAll'])          // Latin layout still works
assert.deepStrictEqual(press({ key: 'z', code: '' }), ['zoomAll'])              // and so does a remapped layout with no usable code
assert.deepStrictEqual(press({ key: 's', code: 'KeyS', composedPath: () => [{ tagName: 'INPUT' }] }), [])

console.log('scale_box + shortcut_keymap: ok')
