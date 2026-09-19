// Consistent facet winding: the condition under which the mesh-direct SLA mask (sl1_parity_gpu.js, per-facet signed
//  count) and the kernel's contours (oriented loops, a mostly-backwards loop reversed) agree — the export routes a
//  mesh that fails it to the contour raster instead. Measured on the flipped-top table below: the mesh-direct mask
//  lit 6400 px at mid-leg height, the slice holds the 256 px leg.
//   Run: node viewer-package/tests/test_mesh_winding.mjs
import assert from 'node:assert'
import { meshWindingConsistent } from '../src/core/mesh_winding.js'

const STL_COUNT_OFFSET = 80, STL_FACETS_OFFSET = 84, STL_FACET_BYTES = 50, STL_NORMAL_BYTES = 12, STL_FLOAT_BYTES = 4
const stl = (triangles) => {
  const bytes = new Uint8Array(STL_FACETS_OFFSET + triangles.length * STL_FACET_BYTES), view = new DataView(bytes.buffer)
  view.setUint32(STL_COUNT_OFFSET, triangles.length, true)
  triangles.forEach((triangle, index) => {
    let writeAt = STL_FACETS_OFFSET + index * STL_FACET_BYTES + STL_NORMAL_BYTES
    for (const vertex of triangle) for (const coordinate of vertex) { view.setFloat32(writeAt, coordinate, true); writeAt += STL_FLOAT_BYTES }
  })
  return bytes
}
// An outward-wound box, by face group, so single groups can be flipped.
const box = (x0, y0, z0, x1, y1, z1) => {
  const corners = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]]
  const faces = { bottom: [[0,2,1],[0,3,2]], top: [[4,5,6],[4,6,7]], sides: [[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]] }
  return (flip = {}) => Object.entries(faces).flatMap(([group, list]) =>
    list.map(([first, second, third]) => (flip[group] ? [first, third, second] : [first, second, third]).map(corner => corners[corner])))
}
const cube = box(0, 0, 0, 20, 20, 20)
const EVERY_GROUP_FLIPPED = { bottom: true, top: true, sides: true }

assert.equal(meshWindingConsistent(stl(cube())), true, 'an outward-wound box')
assert.equal(meshWindingConsistent(stl(cube(EVERY_GROUP_FLIPPED))), true, 'a fully inverted box is consistent too — the mask and the slice agree on it')
assert.equal(meshWindingConsistent(stl([...cube(), ...cube()])), true, 'two coincident copies: each edge still balances')
assert.equal(meshWindingConsistent(stl(cube({ top: true }))), false, 'some facets flipped')
assert.equal(meshWindingConsistent(stl(cube().slice(1))), false, 'an open mesh (a missing facet) goes the safe way')
const leg = box(0, 0, 0, 4, 4, 12), shelf = box(0, 0, 12, 20, 20, 16)
assert.equal(meshWindingConsistent(stl([...leg(), ...shelf({ top: true })])), false, 'the measured table: flipped top faces')
assert.equal(meshWindingConsistent(stl([...leg(), ...shelf()])), true, 'the same table wound consistently')
assert.equal(meshWindingConsistent(new Uint8Array(10)), false, 'a truncated STL is not trusted')

// Cost: it runs once per SL1 export on the GPU path. A large mesh must stay well under a second.
{
  const COPIES = 60000                                 // 60000 boxes x 12 facets = 720k facets
  const triangles = []
  for (let copy = 0; copy < COPIES; copy++) triangles.push(...box(copy * 30, 0, 0, copy * 30 + 20, 20, 20)())
  const large = stl(triangles)
  const started = performance.now()
  assert.equal(meshWindingConsistent(large), true)
  const elapsed = performance.now() - started
  console.log(`  ${triangles.length} facets checked in ${elapsed.toFixed(0)} ms`)
}

console.log('mesh_winding: ok')
