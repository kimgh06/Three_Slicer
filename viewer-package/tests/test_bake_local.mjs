// The load-time geometry the 3mf parse worker now makes instead of the main thread: it must equal what three.js
//  computed on the main thread before, byte for byte, or a worker-loaded mesh would shade differently from a
//  duplicated one.
//   Run: node viewer-package/tests/test_bake_local.mjs
import assert from 'node:assert'
import * as THREE from 'three'
import { bakeLocal, bakeModel, flatNormals, positionBounds } from '../src/core/bake_local.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else {
    let suffix = ''
    if (detail) suffix = ' — ' + detail
    console.log(`  FAIL: ${label}${suffix}`); failures++
  }
}

// Random triangles at print scale, plus a degenerate one (all corners equal) and a sliver (collinear corners).
let seed = 7
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const triangles = 20000
const modelPos = new Float32Array(triangles * 9 + 18)
for (let i = 0; i < triangles * 9; i++) modelPos[i] = (random() - 0.3) * 250
modelPos.set([5, 5, 5, 5, 5, 5, 5, 5, 5], triangles * 9)
modelPos.set([0, 0, 0, 1, 1, 1, 2, 2, 2], triangles * 9 + 9)

console.log('[bake: normals and bounds equal three.js on the same positions]')
const { localPos } = bakeLocal(modelPos)
const geometry = new THREE.BufferGeometry()
geometry.setAttribute('position', new THREE.Float32BufferAttribute(localPos, 3))
geometry.computeVertexNormals()
geometry.computeBoundingBox()
const expected = new Uint8Array(geometry.attributes.normal.array.buffer)
const actual = new Uint8Array(flatNormals(localPos).buffer)
let firstDifference = -1
for (let i = 0; i < expected.length && firstDifference < 0; i++) if (expected[i] !== actual[i]) firstDifference = i
check('flatNormals is byte-identical to computeVertexNormals', expected.length === actual.length && firstDifference < 0,
  `first differing byte ${firstDifference}`)
const bounds = positionBounds(localPos), box = geometry.boundingBox
check('positionBounds equals computeBoundingBox', bounds.min.join() === box.min.toArray().join() && bounds.max.join() === box.max.toArray().join(),
  `${JSON.stringify(bounds)} vs ${JSON.stringify([box.min, box.max])}`)

console.log('\n[bake: the local frame — y up, seated, centred]')
check('seated: lowest y is 0', bounds.min[1] === 0)
check('centred in x and z', Math.abs(bounds.min[0] + bounds.max[0]) < 1e-3 && Math.abs(bounds.min[2] + bounds.max[2]) < 1e-3)
check('model z becomes local y', Math.abs(localPos[1] - (modelPos[2] - Math.min(...modelPos.filter((_v, i) => i % 3 === 2)))) < 1e-3)

console.log('\n[bake: bakeModel is the three pieces together]')
const baked = bakeModel(modelPos)
check('same localPos, normals and bounds', baked.localPos.every((v, i) => v === localPos[i])
  && baked.normals.every((v, i) => v === geometry.attributes.normal.array[i]) && baked.bounds.max.join() === bounds.max.join())

if (failures) console.log(`\n${failures} CHECK(S) FAILED`)
else console.log('\nALL BAKE CHECKS PASSED')
assert.equal(failures, 0)
