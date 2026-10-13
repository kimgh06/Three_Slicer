// Stage 28 verification (node): P1 seating · P2 coordinate contract (toolpath overlaps model) · over_bed · the P4 support ∩ solid = 0 invariant.
import createSlicer from '../../engine/src/slicer_core.js'
import { readFileSync } from 'node:fs'
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

function stlTris(stlBytes) {
  const view = new DataView(stlBytes.buffer.slice(stlBytes.byteOffset, stlBytes.byteOffset + stlBytes.byteLength))
  const triangleCount = view.getUint32(80, true)
  const tris = []
  let offset = 84
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
    offset += 12
    const vertices = []
    for (let k = 0; k < 3; k++) {
      vertices.push([view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)])
      offset += 12
    }
    tris.push(vertices)
    offset += 2
  }
  return tris
}
function trisToSTL(tris) {
  const buffer = Buffer.alloc(84 + tris.length * 50)
  buffer.writeUInt32LE(tris.length, 80)
  let offset = 84
  for (const triangle of tris) {
    offset += 12
    for (const point of triangle) {
      buffer.writeFloatLE(point[0], offset)
      buffer.writeFloatLE(point[1], offset + 4)
      buffer.writeFloatLE(point[2], offset + 8)
      offset += 12
    }
    buffer.writeUInt16LE(0, offset)
    offset += 2
  }
  return buffer
}
function bbox(tris) {
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]
  for (const triangle of tris) for (const vertex of triangle) for (let k = 0; k < 3; k++) {
    mn[k] = Math.min(mn[k], vertex[k])
    mx[k] = Math.max(mx[k], vertex[k])
  }
  return { mn, mx }
}
// Like the viewer: XY bbox center at the origin, seated at minz=0. dx,dy relocate it.
function place(tris, dx = 0, dy = 0) {
  const bounds = bbox(tris)
  const centerX = (bounds.mn[0] + bounds.mx[0]) / 2, centerY = (bounds.mn[1] + bounds.mx[1]) / 2, minZ = bounds.mn[2]
  return tris.map(triangle => triangle.map(vertex => [vertex[0] - centerX + dx, vertex[1] - centerY + dy, vertex[2] - minZ]))
}
const slice = (tris, extra = {}) => slicer.slice(new Uint8Array(trisToSTL(tris)), JSON.stringify({ layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0, print_speed: 60, first_layer_speed: 20, travel_speed: 150, nozzle_temp: 210, bed_temp: 60, top_shell_layers: 3, bottom_shell_layers: 3, skirt_loops: 0, brim_width: 0, infill_angle: 45, bed_width: 256, bed_depth: 256, ...extra }), () => {})
// XY bbox of the extrusion (non-travel) toolpath
function extrBBox(result) {
  let mn = [1e9, 1e9], mx = [-1e9, -1e9], mnz = 1e9
  for (const layer of result.layers) for (let i = 0; i < layer.paths.length; i += 8) {
    if (layer.paths[i + 3] === 0) continue
    for (const [xOffset, yOffset] of [[0, 1], [4, 5]]) {
      mn[0] = Math.min(mn[0], layer.paths[i + xOffset])
      mx[0] = Math.max(mx[0], layer.paths[i + xOffset])
      mn[1] = Math.min(mn[1], layer.paths[i + yOffset])
      mx[1] = Math.max(mx[1], layer.paths[i + yOffset])
    }
    mnz = Math.min(mnz, layer.paths[i + 2])
  }
  return { mn, mx, mnz }
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

const benchy = stlTris(readFileSync(new URL('../testing_files/pseudo_benchy.stl', import.meta.url)))

// (1) P1 seating + P2 overlap — placed like the viewer (centered, seated); after slicing the toolpath XY ≈ the input XY and z is seated
const placed = place(benchy)   // centered + seated
const modelBounds = bbox(placed)
const placedResult = slice(placed)
const placedToolpath = extrBBox(placedResult)
console.log(`  centered: model X[${modelBounds.mn[0].toFixed(1)},${modelBounds.mx[0].toFixed(1)}] Y[${modelBounds.mn[1].toFixed(1)},${modelBounds.mx[1].toFixed(1)}]  toolpath X[${placedToolpath.mn[0].toFixed(1)},${placedToolpath.mx[0].toFixed(1)}] Y[${placedToolpath.mn[1].toFixed(1)},${placedToolpath.mx[1].toFixed(1)}]`)
ok(Math.abs(placedToolpath.mn[0] - modelBounds.mn[0]) < 1 && Math.abs(placedToolpath.mx[0] - modelBounds.mx[0]) < 1 && Math.abs(placedToolpath.mn[1] - modelBounds.mn[1]) < 1 && Math.abs(placedToolpath.mx[1] - modelBounds.mx[1]) < 1, 'P2: toolpath XY bbox ≈ model XY bbox (<1mm) — overlaps the on-screen position')
ok(modelBounds.mn[2] < 1e-4, 'P1: model seated minz=0 (place() -min_z)')
ok(placedToolpath.mnz < 0.25, `P1/P2: toolpath bottom z≈0 (${placedToolpath.mnz.toFixed(3)})`)

// (2) P2 also follows an off-center placement verbatim (no realignment)
const offCenter = place(benchy, 40, -25)
const offCenterBounds = bbox(offCenter), offCenterResult = slice(offCenter), offCenterToolpath = extrBBox(offCenterResult)
ok(Math.abs(offCenterToolpath.mx[0] - offCenterBounds.mx[0]) < 1 && Math.abs(offCenterToolpath.mn[1] - offCenterBounds.mn[1]) < 1, 'P2: the toolpath follows an off-center (+40,-25) placement verbatim (no realignment)')

// (3) over_bed: placed off the bed
const overs = slice(place(benchy, 130, 0))   // push x past half the bed (128)
ok(!!overs.stats.over_bed, 'over_bed: stays true when placed off the bed')

// (4) auto_center=true backwards compatibility: realigns (centered on the origin)
const legacy = slice(offCenter, { auto_center: true }), legacyToolpath = extrBBox(legacy)
ok(Math.abs((legacyToolpath.mn[0] + legacyToolpath.mx[0]) / 2) < 2 && Math.abs((legacyToolpath.mn[1] + legacyToolpath.mx[1]) / 2) < 2, 'auto_center=true: legacy origin realignment preserved')

// (5) P4 invariant: no support (type5) midpoint lies inside the model solid (inside a wall) (∩ = 0). The arm overhang generates support.
const supportResult = slice(placed, { enable_support: true, support_threshold_angle: 40, support_density: 0.15, support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2, support_style: 'grid' })
let supCount = 0, inside = 0
for (const layer of supportResult.layers) for (let i = 0; i < layer.paths.length; i += 8) {
  if (layer.paths[i + 3] !== 5) continue
  supCount++
  const midX = (layer.paths[i] + layer.paths[i + 4]) / 2, midY = (layer.paths[i + 1] + layer.paths[i + 5]) / 2
  if (insideWalls(layer, midX, midY)) inside++
}
console.log(`  support segments=${supCount}  inside-model-solid=${inside}`)
ok(supCount > 0, 'P4: support generated under the arm overhang')
ok(inside === 0, 'P4 invariant: support ∩ model solid (inside walls) = 0 (support inside a cavity is fine; only piercing solid is forbidden)')

if (fail === 0) {
  console.log('\nCOORDS/SUPPORT TEST PASSED')
  process.exit(0)
}
console.log(`\n${fail} FAIL`)
process.exit(1)
