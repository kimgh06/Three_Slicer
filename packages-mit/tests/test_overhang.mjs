// Overhang facet selection — the rule has to match the kernel's, and the visual check cannot tell a correct
// threshold from a wrong one (a box looks the same at 30° and 85°, since a vertical wall never qualifies).
//   Run: node packages/viewer/test_overhang.mjs
import * as THREE from 'three'
import { buildOverhangGeometry } from './src/scene/overhang_view.js'

let failed = 0
const check = (name, got, want) => {
  const ok = got === want
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name} (got ${got}, want ${want})`)
  if (!ok) failed++
}
// A single triangle whose normal is `normal`, wrapped in a mesh so the world-matrix path is exercised too.
function triangleFacing(normal) {
  const n = new THREE.Vector3(...normal).normalize()
  // any two vectors orthogonal to n
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(n.dot(u)) > 0.9) u.set(0, 1, 0)
  const e1 = new THREE.Vector3().crossVectors(n, u).normalize()
  const e2 = new THREE.Vector3().crossVectors(n, e1).normalize()
  // winding chosen so that (b-a) x (c-a) points along n
  const a = new THREE.Vector3(), b = e2.clone(), c = e1.clone().negate()
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], 3))
  const mesh = new THREE.Mesh(geo)
  mesh.updateWorldMatrix(true, false)
  // sanity: the facet really does face `n`
  const ab = b.clone().sub(a), ac = c.clone().sub(a)
  const actual = new THREE.Vector3().crossVectors(ab, ac).normalize()
  if (actual.dot(n) < 0.99) throw new Error('test fixture built the wrong winding')
  return mesh
}
const tris = (mesh, deg) => {
  const g = buildOverhangGeometry(mesh, deg)
  return g ? g.getAttribute('position').count / 3 : 0
}

console.log('[slope angle: 90 = vertical wall, 0 = horizontal ceiling; support when slope < threshold]')
const ceiling = triangleFacing([0, -1, 0])          // slope 0  — always needs support
check('horizontal ceiling @30', tris(ceiling, 30), 1)
check('horizontal ceiling @5', tris(ceiling, 5), 1)

const floor = triangleFacing([0, 1, 0])             // faces up — never
check('upward face @85', tris(floor, 85), 0)

const wall = triangleFacing([1, 0, 0])              // slope 90 — a vertical wall never needs support
check('vertical wall @85', tris(wall, 85), 0)

// A facet whose normal is 45° below horizontal has slope 45: supported below a 50° threshold, not below 40°.
const slope45 = triangleFacing([Math.SQRT1_2, -Math.SQRT1_2, 0])
check('45 deg slope @40 (steeper than threshold)', tris(slope45, 40), 0)
check('45 deg slope @50 (gentler than threshold)', tris(slope45, 50), 1)

// Rotating the object must change the verdict — the test runs on world normals, not local ones.
const rotated = triangleFacing([0, 1, 0])           // faces up...
rotated.rotation.x = Math.PI                        // ...flipped over, so now it faces down
rotated.updateWorldMatrix(true, false)
check('upward face flipped 180 deg @30', tris(rotated, 30), 1)

// A threshold of 0 disables shading (nothing is gentler than 0)
check('horizontal ceiling @0', tris(ceiling, 0), 0)

console.log(failed ? `\n${failed} FAILED` : '\nALL OVERHANG TESTS PASSED')
process.exitCode = failed ? 1 : 0
