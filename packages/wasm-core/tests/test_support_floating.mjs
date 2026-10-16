// Stage 33 regression: detects "support floating in mid-air".
//  The upstream project_support_to_grid diffs the model out of the downward projection before passing it down —
//  so a projection that hits the model dies there (bottom contact) and never comes back below it.
//  The old implementation only accumulated (union) and clipped per layer afterwards, so a region hidden by the model
//  came back on the layers below where the model no longer exists, leaving support hanging in the air.
//
// Criterion: support stacks up from the bed. For a support cell on layer j (j>0), if the layer directly **below** (j-1) has
//  neither support nor model (wall/solid/infill) at that cell, there is nothing holding it up = **floating**.
//  j=0 sits on the bed and is excluded. Judged on a raster grid (0.5mm) — stable without reassembling polygons.
import createSlicer from '../../engine/src/slicer_core.js'
import { boxTrianglesWithInwardBottom, trianglesToSTL } from './stl_fixtures.mjs'

// Stepped overhang: a shape whose cross-section jumps between layers, which easily induces floating support.
//  Three tiers: a small lower column -> a large middle plate -> a small offset upper column.
// Note: the z boundaries deliberately overlap by 0.5mm. Making them exactly flush (plate 6~9, column 9~15) means
//   intersect_triangle_with_plane's [zmin, zmax) test catches no triangle at that plane, producing an **empty layer**,
//   and all support above it is misjudged as "nothing below" (confirmed by measurement).
const model = [
  ...boxTrianglesWithInwardBottom(-4,-4,0, 8,8,6.5),       // lower column, z 0~6.5
  ...boxTrianglesWithInwardBottom(-15,-15,6, 30,30,3),     // middle plate, z 6~9 (overhangs all around -> support beneath)
  ...boxTrianglesWithInwardBottom(6,6,8.5, 8,8,6.5),       // upper column, z 8.5~15 (on the plate, offset in XY)
  ...boxTrianglesWithInwardBottom(-15,-15,14.5, 30,30,3),  // upper plate, z 14.5~17.5 (overhangs all around again)
]
const stl = new Uint8Array(trianglesToSTL(model))

const slicer = await createSlicer()
const params = {
  layer_height:0.2, first_layer_height:0.2, line_width:0.42, wall_loops:2, infill_density:0.15,
  nozzle_diameter:0.4, filament_diameter:1.75, bed_width:220, bed_depth:220,
  enable_support:true, support_style:'grid', support_threshold_angle:45,
  support_top_z_distance:0.2, support_xy_distance:0.35, support_interface_top_layers:2,
}
const result = slicer.slice(stl, JSON.stringify(params), () => {})
if (result.error) {
  console.log('FAIL slice error:', result.error)
  process.exit(1)
}

const CELL = 0.5
const key = (x,y) => `${Math.round(x/CELL)},${Math.round(y/CELL)}`
// Support cells per layer / all (support + model) cells
const supportCells = [], allCells = []
for (const layer of result.layers || []) {
  const supportSet = new Set(), allSet = new Set()
  const paths = layer.paths
  if (paths) for (let i=0;i<paths.length;i+=8) {
    const type = paths[i+3]
    if (type === 0) continue                     // skip travels
    // Sample the segment at CELL intervals
    const x0=paths[i], y0=paths[i+1], x1=paths[i+4], y1=paths[i+5]
    const steps = Math.max(1, Math.ceil(Math.hypot(x1-x0,y1-y0)/CELL))
    for (let k=0;k<=steps;k++) {
      const cellKey = key(x0+(x1-x0)*k/steps, y0+(y1-y0)*k/steps)
      allSet.add(cellKey)
      if (type===5||type===6) supportSet.add(cellKey)
    }
  }
  supportCells.push(supportSet)
  allCells.push(allSet)
}

// The below-layer test allows up to the 8 neighbors: support sitting over the support_xy_distance (0.35mm) gap,
//  and grid discretization boundaries, protrude by less than one cell (0.5mm) and are physically printable.
//  Without that tolerance the whole gap ring around the model counts as "floating" and the metric becomes meaningless.
const hasBelow = (below, cell) => {
  const [cellX, cellY] = cell.split(',').map(Number)
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
    if (below.has(`${cellX+dx},${cellY+dy}`)) return true
  return false
}
let floating = 0, totalSupportCells = 0, worstLayer = -1, worstCount = 0
for (let j = 1; j < supportCells.length; j++) {           // j=0 rests on the bed -> excluded
  const current = supportCells[j], below = allCells[j-1]      // all support + model on the layer below
  if (!current.size) continue
  let floatingInLayer = 0
  for (const cell of current) {
    totalSupportCells++
    if (!hasBelow(below, cell)) {
      floating++
      floatingInLayer++
    }
  }
  if (floatingInLayer > worstCount) {
    worstCount = floatingInLayer
    worstLayer = j
  }
}
let percent = 0
if (totalSupportCells) percent = (floating/totalSupportCells*100)
console.log(`support cells ${totalSupportCells.toLocaleString()}  cells with nothing below ${floating.toLocaleString()} (${percent.toFixed(1)}%)  worst layer ${worstLayer}(${worstCount})`)

// Threshold 5%: a measured baseline — 8.0% before the fix (the model was not subtracted in the downward projection), 3.2% after.
//  Most of the remaining 3.2% is a known bias of the metric: the raster holds only extrusion "lines", not the filled
//  interior of a model cross-section, so support that landed properly on the model's top surface (= bottom contact) also counts as "nothing below".
//  Use it as a regression ceiling, not an absolute number.
const LIMIT = 5
if (percent > LIMIT) {
  console.log(`\nFLOATING SUPPORT TEST FAILED — ${percent.toFixed(1)}% > ${LIMIT}%`)
  process.exit(1)
}
console.log(`\nFLOATING SUPPORT TEST PASSED — ${percent.toFixed(1)}% ≤ ${LIMIT}%`)
