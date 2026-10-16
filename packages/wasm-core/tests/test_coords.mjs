// Stage 28 verification (node): P1 seating · P2 coordinate contract (toolpath overlaps model) · over_bed · the P4 support ∩ solid = 0 invariant.
import createSlicer from '../../engine/src/slicer_core.js'
import { readFileSync } from 'node:fs'
import { trianglesToSTL } from './stl_fixtures.mjs'
const slicer = await createSlicer()
let fail = 0
const ok = (condition, message) => {
  if (condition) {
    console.log('  ok: ' + message)
    return
  }
  console.log('  FAIL: ' + message)
  fail++
}

function readSTLTriangles(stlBytes) {
  const view = new DataView(stlBytes.buffer.slice(stlBytes.byteOffset, stlBytes.byteOffset + stlBytes.byteLength))
  const triangleCount = view.getUint32(80, true)
  const triangles = []
  let offset = 84
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
    offset += 12
    const vertices = []
    for (let k = 0; k < 3; k++) {
      vertices.push([view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)])
      offset += 12
    }
    triangles.push(vertices)
    offset += 2
  }
  return triangles
}
function boundsOf(triangles) {
  let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9]
  for (const triangle of triangles) for (const vertex of triangle) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], vertex[k])
    max[k] = Math.max(max[k], vertex[k])
  }
  return { min, max }
}
// Like the viewer: XY bbox center at the origin, seated at minz=0. dx,dy relocate it.
function place(triangles, dx = 0, dy = 0) {
  const bounds = boundsOf(triangles)
  const centerX = (bounds.min[0] + bounds.max[0]) / 2, centerY = (bounds.min[1] + bounds.max[1]) / 2, minZ = bounds.min[2]
  return triangles.map(triangle => triangle.map(vertex => [vertex[0] - centerX + dx, vertex[1] - centerY + dy, vertex[2] - minZ]))
}
const slice = (triangles, extra = {}) => slicer.slice(new Uint8Array(trianglesToSTL(triangles)), JSON.stringify({ layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0, print_speed: 60, first_layer_speed: 20, travel_speed: 150, nozzle_temp: 210, bed_temp: 60, top_shell_layers: 3, bottom_shell_layers: 3, skirt_loops: 0, brim_width: 0, infill_angle: 45, bed_width: 256, bed_depth: 256, ...extra }), () => {})
// XY bbox of the extrusion (non-travel) toolpath
function extrusionBounds(result) {
  let min = [1e9, 1e9], max = [-1e9, -1e9], minZ = 1e9
  for (const layer of result.layers) for (let i = 0; i < layer.paths.length; i += 8) {
    if (layer.paths[i + 3] === 0) continue
    for (const [xOffset, yOffset] of [[0, 1], [4, 5]]) {
      min[0] = Math.min(min[0], layer.paths[i + xOffset])
      max[0] = Math.max(max[0], layer.paths[i + xOffset])
      min[1] = Math.min(min[1], layer.paths[i + yOffset])
      max[1] = Math.max(max[1], layer.paths[i + yOffset])
    }
    minZ = Math.min(minZ, layer.paths[i + 2])
  }
  return { min, max, minZ }
}
// Is point (x,y) inside the layer's wall (type1) polygon — horizontal ray crossings (odd = inside). Wall segments are the polygon edges.
function insideWalls(layer, x, y) {
  let crossings = 0
  for (let i = 0; i < layer.paths.length; i += 8) {
    if (layer.paths[i + 3] !== 1) continue
    const x0 = layer.paths[i], y0 = layer.paths[i + 1], x1 = layer.paths[i + 4], y1 = layer.paths[i + 5]
    if ((y0 > y) !== (y1 > y)) {
      const crossingX = x0 + (y - y0) / (y1 - y0) * (x1 - x0)
      if (crossingX > x) crossings++
    }
  }
  return (crossings & 1) === 1
}

const benchy = readSTLTriangles(readFileSync(new URL('../testing_files/pseudo_benchy.stl', import.meta.url)))

// (1) P1 seating + P2 overlap — placed like the viewer (centered, seated); after slicing the toolpath XY ≈ the input XY and z is seated
const placed = place(benchy)   // centered + seated
const modelBounds = boundsOf(placed)
const placedResult = slice(placed)
const placedToolpath = extrusionBounds(placedResult)
console.log(`  centered: model X[${modelBounds.min[0].toFixed(1)},${modelBounds.max[0].toFixed(1)}] Y[${modelBounds.min[1].toFixed(1)},${modelBounds.max[1].toFixed(1)}]  toolpath X[${placedToolpath.min[0].toFixed(1)},${placedToolpath.max[0].toFixed(1)}] Y[${placedToolpath.min[1].toFixed(1)},${placedToolpath.max[1].toFixed(1)}]`)
ok(Math.abs(placedToolpath.min[0] - modelBounds.min[0]) < 1 && Math.abs(placedToolpath.max[0] - modelBounds.max[0]) < 1 && Math.abs(placedToolpath.min[1] - modelBounds.min[1]) < 1 && Math.abs(placedToolpath.max[1] - modelBounds.max[1]) < 1, 'P2: toolpath XY bbox ≈ model XY bbox (<1mm) — overlaps the on-screen position')
ok(modelBounds.min[2] < 1e-4, 'P1: model seated minz=0 (place() -min_z)')
ok(placedToolpath.minZ < 0.25, `P1/P2: toolpath bottom z≈0 (${placedToolpath.minZ.toFixed(3)})`)

// (2) P2 also follows an off-center placement verbatim (no realignment)
const offCenter = place(benchy, 40, -25)
const offCenterBounds = boundsOf(offCenter), offCenterResult = slice(offCenter), offCenterToolpath = extrusionBounds(offCenterResult)
ok(Math.abs(offCenterToolpath.max[0] - offCenterBounds.max[0]) < 1 && Math.abs(offCenterToolpath.min[1] - offCenterBounds.min[1]) < 1, 'P2: the toolpath follows an off-center (+40,-25) placement verbatim (no realignment)')

// (3) over_bed: placed off the bed
const overs = slice(place(benchy, 130, 0))   // push x past half the bed (128)
ok(!!overs.stats.over_bed, 'over_bed: stays true when placed off the bed')

// (4) auto_center=true backwards compatibility: realigns (centered on the origin)
const legacy = slice(offCenter, { auto_center: true }), legacyToolpath = extrusionBounds(legacy)
ok(Math.abs((legacyToolpath.min[0] + legacyToolpath.max[0]) / 2) < 2 && Math.abs((legacyToolpath.min[1] + legacyToolpath.max[1]) / 2) < 2, 'auto_center=true: legacy origin realignment preserved')

// (5) P4 invariant: no support (type5) midpoint lies inside the model solid (inside a wall) (∩ = 0). The arm overhang generates support.
const supportResult = slice(placed, { enable_support: true, support_threshold_angle: 40, support_density: 0.15, support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2, support_style: 'grid' })
let supportSegmentCount = 0, inside = 0
for (const layer of supportResult.layers) for (let i = 0; i < layer.paths.length; i += 8) {
  if (layer.paths[i + 3] !== 5) continue
  supportSegmentCount++
  const midX = (layer.paths[i] + layer.paths[i + 4]) / 2, midY = (layer.paths[i + 1] + layer.paths[i + 5]) / 2
  if (insideWalls(layer, midX, midY)) inside++
}
console.log(`  support segments=${supportSegmentCount}  inside-model-solid=${inside}`)
ok(supportSegmentCount > 0, 'P4: support generated under the arm overhang')
ok(inside === 0, 'P4 invariant: support ∩ model solid (inside walls) = 0 (support inside a cavity is fine; only piercing solid is forbidden)')

if (fail === 0) {
  console.log('\nCOORDS/SUPPORT TEST PASSED')
  process.exit(0)
}
console.log(`\n${fail} FAIL`)
process.exit(1)
