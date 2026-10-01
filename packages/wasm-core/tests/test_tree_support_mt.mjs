// Tree support (slim / strong / hybrid) runs its loops threaded on mt: detect_overhangs' layer passes, draw_circles,
//  generate_toolpaths, the avoidance precompute, and drop_nodes' spanning trees and move pass. Each has to give the
//  serial loop's result, so the mt G-code must equal the st G-code, run after run. The move pass is where this broke first: the SupportNode constructor also points
//  the nodes merged into its parent at the new node, one node can be merged into several parents, and the last of those
//  writes followed the thread order (measured on a 1.13M-facet hybrid plate: a different G-code on every mt run).
//  The model is built to reach that code: stacked slabs whose branches merge on the way down, and build-plate-only
//  support, so branches that land on a lower slab are pruned through those links.
import assert from 'node:assert/strict'
import createSlicer from '../../engine/src/slicer_core.js'
import createSlicerMt from '../../engine/src/slicer_core.mt.js'

function boxTriangles(originX, originY, originZ, sizeX, sizeY, sizeZ) {
  const corners = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]]
    .map(([x, y, z]) => [originX + x * sizeX, originY + y * sizeY, originZ + z * sizeZ])
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  return faces.map(face => face.map(index => corners[index]))
}

function toSTL(triangles) {
  const buffer = Buffer.alloc(84 + triangles.length * 50)
  buffer.writeUInt32LE(triangles.length, 80)
  triangles.forEach((triangle, index) => {
    let offset = 84 + index * 50 + 12
    for (const vertex of triangle) for (const value of vertex) {
      buffer.writeFloatLE(value, offset)
      offset += 4
    }
  })
  return new Uint8Array(buffer)
}

// A tower with three slabs sticking out at different heights and directions, and a wide roof over all of them.
const model = toSTL([
  ...boxTriangles(-4, -4, 0, 8, 8, 24),
  ...boxTriangles(-20, -4, 6, 16, 12, 1.2),
  ...boxTriangles(4, -18, 10, 12, 22, 1.2),
  ...boxTriangles(-16, 2, 15, 20, 16, 1.2),
  ...boxTriangles(-24, -22, 24, 44, 44, 1.2),
])

const params = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15,
  bed_width: 180, bed_depth: 180, printable_height: 180, skirt_loops: 0,
  enable_support: true, support_style: 'tree', support_on_build_plate_only: true,
}

const st = await createSlicer()
const mt = await createSlicerMt()
let failures = 0
for (const treeStyle of ['slim', 'strong', 'hybrid']) {
  const styled = JSON.stringify({ ...params, tree_style: treeStyle })
  const serial = st.slice(model, styled, () => {})
  assert.ok(!serial.error, `${treeStyle}: st slices (${serial.error})`)
  for (let run = 1; run <= 3; run++) {
    const threaded = mt.slice(model, styled, () => {})
    const same = threaded.gcode === serial.gcode
    let verdict = 'ok'
    if (!same) { verdict = 'FAIL'; failures++ }
    console.log(`  ${verdict}: ${treeStyle} mt run ${run} equals st (${serial.gcode.length} bytes)`)
  }
}
// Arachne walls are written by the threaded G-code writers too (slicer_core.cpp parEmit). The toolpath stream and its
//  per-segment widths are what the preview draws, so they are compared as well as the text.
const layerBytes = (result) => result.layers.map((layer) => [layer.z, Array.from(layer.paths), Array.from(layer.widths)])
{
  const arachne = JSON.stringify({ ...params, tree_style: 'hybrid', wall_generator: 'arachne' })
  const serial = st.slice(model, arachne, () => {})
  assert.ok(!serial.error, `arachne: st slices (${serial.error})`)
  const threaded = mt.slice(model, arachne, () => {})
  const sameText = threaded.gcode === serial.gcode
  let sameLayers = true
  try { assert.deepStrictEqual(layerBytes(threaded), layerBytes(serial)) } catch { sameLayers = false }
  let verdict = 'ok'
  if (!sameText || !sameLayers) { verdict = 'FAIL'; failures++ }
  let textWord = 'equals'
  if (!sameText) textWord = 'differs from'
  let layersWord = 'equal'
  if (!sameLayers) layersWord = 'differ'
  console.log(`  ${verdict}: arachne walls, mt G-code ${textWord} st, toolpaths and widths ${layersWord}`)
}
if (failures) { console.log(`${failures} TREE SUPPORT MT CHECK(S) FAILED`); process.exit(1) }
console.log('ALL TREE SUPPORT MT CHECKS PASSED')
process.exit(0)
