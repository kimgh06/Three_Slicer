// node self-test (track C stage 3): cube (binary + ASCII) + table (overhang) -> slice() -> invariant checks.
//   Run: node reverse_engineering/wasm-core/test.mjs   (final judgement still comes from the browser / vite preview)
import createSlicer from '../../engine/src/slicer_core.js'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { concatSTL, flipSTL, moveSTL, outwardBoxTriangles, tableTriangles, trianglesToSTL } from './stl_fixtures.mjs'

// --- Box geometry ---
export function makeBoxSTL(sizeX, sizeY, sizeZ) {              // binary cube
  return trianglesToSTL(outwardBoxTriangles(0, 0, 0, sizeX, sizeY, sizeZ))
}
export function makeAsciiBoxSTL(sizeX, sizeY, sizeZ) {         // ASCII cube
  let text = 'solid cube\n'
  for (const triangle of outwardBoxTriangles(0, 0, 0, sizeX, sizeY, sizeZ)) {
    text += ' facet normal 0 0 0\n  outer loop\n'
    for (const vertex of triangle) text += `   vertex ${vertex[0]} ${vertex[1]} ${vertex[2]}\n`
    text += '  endloop\n endfacet\n'
  }
  text += 'endsolid cube\n'
  return Buffer.from(text, 'utf8')
}
// Table / T shape (overhang): a wide 20x20x4 cap on a narrow 6x6x10 column -> the cap's underside overhangs into thin air
export function makeTableSTL() {
  return trianglesToSTL(tableTriangles(outwardBoxTriangles))
}
// Cylinder (for arc fitting checks) — with the side split into segments the wall becomes an arc
export function makeCylinderSTL(radius, height, segments) {
  const triangles = []
  const top = height
  const bottom = 0
  for (let i = 0; i < segments; i++) {
    const startAngle = 2 * Math.PI * i / segments
    const endAngle = 2 * Math.PI * (i + 1) / segments
    const x0 = radius * Math.cos(startAngle)
    const y0 = radius * Math.sin(startAngle)
    const x1 = radius * Math.cos(endAngle)
    const y1 = radius * Math.sin(endAngle)
    triangles.push([[x0, y0, bottom], [x1, y1, bottom], [x1, y1, top]])
    triangles.push([[x0, y0, bottom], [x1, y1, top], [x0, y0, top]])
    triangles.push([[0, 0, bottom], [x1, y1, bottom], [x0, y0, bottom]])
    triangles.push([[0, 0, top], [x0, y0, top], [x1, y1, top]])
  }
  return trianglesToSTL(triangles)
}
// Models for stage 5 -------------------------------------------------------------
// Thin cross (thin wall): a thick hub (3x3, >=2w) with 4 thin arms (0.6mm ≈ 1.5w). Hub = 2 wall loops; an arm gets one
//  outer loop by default and a medial-axis thin wall with detect_thin_wall, as upstream's process_classic does.
export function makeCrossSTL() {
  const hub = 3
  const arm = 0.6
  const armLength = 5
  const height = 3
  return trianglesToSTL([
    ...outwardBoxTriangles(-hub / 2, -hub / 2, 0, hub, hub, height),
    ...outwardBoxTriangles(hub / 2, -arm / 2, 0, armLength, arm, height),
    ...outwardBoxTriangles(-hub / 2 - armLength, -arm / 2, 0, armLength, arm, height),
    ...outwardBoxTriangles(-arm / 2, hub / 2, 0, arm, armLength, height),
    ...outwardBoxTriangles(-arm / 2, -hub / 2 - armLength, 0, arm, armLength, height),
  ])
}
// Thin ring/tube (gap fill): a square frame with 2.5w (≈1.05mm) walls -> 1 wall loop + a 0.5w leftover gap.
export function makeRingSTL() {
  const lineWidth = 0.42
  const wallThickness = 2.5 * lineWidth
  const outer = 10
  const height = 3
  return trianglesToSTL([
    ...outwardBoxTriangles(-outer / 2, -outer / 2, 0, outer, wallThickness, height),
    ...outwardBoxTriangles(-outer / 2, outer / 2 - wallThickness, 0, outer, wallThickness, height),
    ...outwardBoxTriangles(-outer / 2, -outer / 2 + wallThickness, 0, wallThickness, outer - 2 * wallThickness, height),
    ...outwardBoxTriangles(outer / 2 - wallThickness, -outer / 2 + wallThickness, 0, wallThickness, outer - 2 * wallThickness, height),
  ])
}
// L shape (wall-avoiding travel): a concave notch -> a straight travel between the arms crosses the outer wall.
export function makeLShapeSTL() {
  return trianglesToSTL([...outwardBoxTriangles(0, 0, 0, 24, 8, 4), ...outwardBoxTriangles(0, 0, 0, 8, 24, 4)])
}
// Two boxes side by side (multi-material): the first 12 triangles = group 0, the next 12 = group 1 (split=12).
export function makeTwoBoxSTL() {
  const firstBox = outwardBoxTriangles(0, 0, 0, 10, 10, 6)
  const secondBox = outwardBoxTriangles(16, 0, 0, 10, 10, 6)
  return { stl: trianglesToSTL([...firstBox, ...secondBox]), split: firstBox.length }
}

// Three boxes in triangle order, one per extruder — the N-way grouping fixture.
export function makeThreeBoxSTL() {
  const firstBox = outwardBoxTriangles(0, 0, 0, 10, 10, 6)
  const secondBox = outwardBoxTriangles(16, 0, 0, 10, 10, 6)
  const thirdBox = outwardBoxTriangles(32, 0, 0, 10, 10, 6)
  return { stl: trianglesToSTL([...firstBox, ...secondBox, ...thirdBox]), splits: [firstBox.length, firstBox.length + secondBox.length] }
}
// --- Painted multi-material fixtures ---------------------------------------------------------------------------
// The facet projection behind painting (project_custom_facets_footprint) drops vertical faces — they project to a
//  zero-area sliver — and a horizontal face only reaches the one slicing plane it sits on. A painted region that is
//  fat on many layers therefore needs a big SLANTED face. The wedge is a 20x20x10 base carrying one slanted face
//  rising from z=10 (at y=0) to z=20 (at y=20): painting that single face marks the whole 20x20 footprint on every
//  layer above z=10, so the painted region is the full cross-section there and none of it below.
export const WEDGE_FACETS = 18
export const WEDGE_SLOPE_FACET = 12
export const WEDGE_PITCH = 25
function wedgeTriangles(offsetX) {
  const point = (x, y, z) => [x + offsetX, y, z]
  return [
    ...outwardBoxTriangles(offsetX, 0, 0, 20, 20, 10),                                                   // 0..11 base (top face = 2,3)
    [point(0,0,10), point(20,0,10), point(20,20,20)], [point(0,0,10), point(20,20,20), point(0,20,20)],      // 12,13 slanted face
    [point(0,20,10), point(20,20,10), point(20,20,20)], [point(0,20,10), point(20,20,20), point(0,20,20)],   // 14,15 back wall
    [point(0,0,10), point(0,20,20), point(0,20,10)], [point(20,0,10), point(20,20,10), point(20,20,20)],     // 16,17 ends
  ]
}
export function makeWedgeSTL(count) {
  return trianglesToSTL(Array.from({ length: count }, (_, k) => wedgeTriangles(k * WEDGE_PITCH)).flat())
}
// Overlap fixture: a 6x6 leg and a 20x20 cap meeting at z=10.15. Both faces on that plane project onto the z=10.2
//  slicing plane (0.05 away — inside the projector's half-layer tolerance) and the contour there is the whole cap,
//  so the leg's square sits strictly inside the cap's square: two painted extruders claiming the same area.
//  The plane is 10.15 and not 10.0 because a plane where the geometry changes solids slices to nothing at all.
// A layer is cut at its middle (slice_planes.h plan_layers), so the first layer the leg (top at 10.15) no longer
//  reaches is the one whose top is 10.4, cut at 10.3. The z=10.2 layer is cut at 10.1, inside the leg.
export const OVERLAP_LEG_FACET = 2
export const OVERLAP_CAP_FACET = 12
export const OVERLAP_Z = 10.4
export function makeOverlapSTL() {
  return trianglesToSTL([...outwardBoxTriangles(7, 7, 0, 6, 6, 10.15), ...outwardBoxTriangles(0, 0, 10.15, 20, 20, 3.85)])
}

const params = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2,
  infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0,
  print_speed: 60, first_layer_speed: 20, travel_speed: 150, nozzle_temp: 210, bed_temp: 60,
  top_shell_layers: 4, bottom_shell_layers: 3, skirt_loops: 1, skirt_distance: 2, brim_width: 0,
  retract_length: 0.8, retract_speed: 30, z_hop: 0.4, infill_angle: 45,
}

let failed = 0
function ok(condition, message) {
  if (!condition) {
    console.error('  FAIL:', message)
    failed++
  } else console.log('  ok:', message)
}
// The stride-8 role field carries the printing extruder in its high bits (value = role + tool*16, decoded by the
//  viewer's toolpath_segments.js). Untooled output is entirely below 16 so the mask is a no-op there, but a slice
//  that switches tools would otherwise drop every tooled segment out of the role histogram.
const ROLE_OF = (field) => field & 15
const TOOL_OF = (field) => field >>> 4
function countByType(paths) {
  const counts = {0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0,10:0,11:0}
  for (let i = 0; i < paths.length; i += 8) counts[ROLE_OF(paths[i+3])]++
  return counts
}
const typeTotal = (result, role) => result.layers.reduce((sum, layer) => sum + countByType(layer.paths)[role], 0)
const topLayerWithType = (result, role) => {
  let top = -1
  result.layers.forEach((layer, i) => { if (countByType(layer.paths)[role] > 0) top = i })
  return top
}

const Module = await createSlicer()
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')   // the package root, one above tests/
const cubeBinarySTL = makeBoxSTL(20, 20, 20)
writeFileSync(join(packageRoot, 'cube20.stl'), cubeBinarySTL)
writeFileSync(join(packageRoot, 'cube20_ascii.stl'), makeAsciiBoxSTL(20, 20, 20))
writeFileSync(join(packageRoot, 'table.stl'), makeTableSTL())

let progressCalls = 0
let lastDone = 0
let lastTotal = 0
const onProgress = (done, total) => {
  progressCalls++
  lastDone = done
  lastTotal = total
}

const rCube = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify(params), onProgress)
if (rCube.error) { console.error('FAIL: slice error:', rCube.error); process.exit(1) }
const expectedLayers = Math.round(20 / params.layer_height)
console.log(`[cube] layers=${rCube.stats.layers}, segments=${rCube.stats.path_segments}, filament=${rCube.stats.filament_mm.toFixed(2)}mm, progress=${progressCalls}`)

// ===== The original 22 (stage 2) — kept =====
ok(Math.abs(rCube.stats.layers - expectedLayers) <= 1, `layer count ${rCube.stats.layers} within ±1 of ${expectedLayers}`)
ok(rCube.stats.path_segments > 0, `path_segments > 0 (${rCube.stats.path_segments})`)
ok(rCube.stats.filament_mm > 0, `total filament > 0 (${rCube.stats.filament_mm.toFixed(2)}mm)`)
ok(/G1 [^\n]*E[0-9]/.test(rCube.gcode), 'G-code contains G1 ... E<num> extrusion lines')
ok(rCube.gcode.includes('M83'), 'G-code has relative-E (M83)')
ok(rCube.layers.length === rCube.stats.layers, 'layers array length == stats.layers')
let wallFound = false
let infillFound = false
for (const layer of rCube.layers) {
  const counts = countByType(layer.paths)
  if (counts[1]) wallFound = true
  if (counts[2] || counts[3]) infillFound = true
}
ok(wallFound, 'toolpaths contain wall segments (type=1)')
ok(infillFound, 'toolpaths contain infill segments (type=2/3)')
const layerCount = rCube.layers.length
const infillCount = (layer) => {
  const counts = countByType(layer.paths)
  return counts[2] + counts[3]
}
const solidCount = (layer) => countByType(layer.paths)[3]
const middleLayerIndex = Math.floor(layerCount / 2)
const midInfill = infillCount(rCube.layers[middleLayerIndex])
for (const layerIndex of [0, 1, 2]) ok(solidCount(rCube.layers[layerIndex]) > 0, `bottom shell layer ${layerIndex} solid (type=3): ${solidCount(rCube.layers[layerIndex])}`)
for (const layerIndex of [layerCount-1, layerCount-2, layerCount-3]) ok(solidCount(rCube.layers[layerIndex]) > 0, `top shell layer ${layerIndex} solid (type=3): ${solidCount(rCube.layers[layerIndex])}`)
ok(infillCount(rCube.layers[0]) > midInfill * 2, `layer0 infill density (${infillCount(rCube.layers[0])}) >> mid (${midInfill})`)
ok(solidCount(rCube.layers[middleLayerIndex]) === 0, `mid layer ${middleLayerIndex} sparse only`)
ok(countByType(rCube.layers[0].paths)[4] > 0, `layer 0 skirt (type=4): ${countByType(rCube.layers[0].paths)[4]}`)
ok(/^; skirt/m.test(rCube.gcode), 'G-code has "; skirt" marker')
const gcodeLines = rCube.gcode.split('\n')
ok(gcodeLines.some((gcodeLine, i) => /^G1 Z[\d.]+ F\d+$/.test(gcodeLine) && /^G0 /.test(gcodeLines[i + 1] || '')), 'z_hop: G1 Z lift precedes G0 travel')
ok(progressCalls > 0 && lastDone === lastTotal, `progress 100% (${lastDone}/${lastTotal})`)
const rAscii = Module.slice(new Uint8Array(makeAsciiBoxSTL(20, 20, 20)), JSON.stringify(params), onProgress)
ok(rAscii.stats.layers === rCube.stats.layers, `ASCII same layer count (${rAscii.stats.layers})`)
ok(Math.abs(rAscii.stats.filament_mm - rCube.stats.filament_mm) < 0.5, `ASCII same filament`)

// ===== New in stage 3 =====
console.log('\n[stage3]')
// A cube has vertical walls -> no support (defaults: enable_support=false, raft=0, bed=256)
ok(typeTotal(rCube, 5) === 0, `cube (default) has no support (type5=0)`)

// --- Support: the overhang table ---
const supportParams = { ...params, enable_support: true, support_threshold_angle: 30, support_density: 0.15, support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2 }
const rSupport = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(supportParams), () => {})
const rNoSupport  = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supportParams, enable_support: false }), () => {})
if (rSupport.error) { console.error('FAIL: table slice error', rSupport.error); process.exit(1) }
console.log(`  table layers=${rSupport.stats.layers}, support(type5) total=${typeTotal(rSupport, 5)}, topSupLayer=${topLayerWithType(rSupport, 5)}`)
// (1) Support exists in the z band under the overhang (cap = z10, ~layer 49), and never inside or above the cap
ok(typeTotal(rSupport, 5) > 0, `overhang model generates support (type5=${typeTotal(rSupport, 5)})`)
const belowCap = rSupport.layers.filter(layer => layer.z > 2 && layer.z < 9.5).some(layer => countByType(layer.paths)[5] > 0)
ok(belowCap, 'support present in layers below the overhang (2<z<9.5)')
const topCapNoSupport = [rSupport.layers.length-1, rSupport.layers.length-2].every(layerIndex => countByType(rSupport.layers[layerIndex].paths)[5] === 0)
ok(topCapNoSupport, 'no support inside the solid cap (top layers type5=0)')
ok(/^; support/m.test(rSupport.gcode), 'G-code has "; support" marker')
// (2) Higher support_top_z_distance -> larger contact z gap -> the support top sits lower
const rGap = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supportParams, support_top_z_distance: 0.6 }), () => {})
ok(topLayerWithType(rGap, 5) < topLayerWithType(rSupport, 5),
   `larger top_z_distance lowers support top (gap0.6 top=${topLayerWithType(rGap, 5)} < gap0.2 top=${topLayerWithType(rSupport, 5)})`)
// ③ enable_support=false → type5 == 0
ok(typeTotal(rNoSupport, 5) === 0, `enable_support=false → no support (type5=${typeTotal(rNoSupport, 5)})`)

// --- Raft ---
const rRaft = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, raft_layers: 2 }), () => {})
ok(rRaft.stats.raft_layers === 2 && rRaft.stats.model_layers === rCube.stats.model_layers,
   `raft_layers=2, model_layers=${rRaft.stats.model_layers} (== no-raft ${rCube.stats.model_layers})`)
ok(countByType(rRaft.layers[0].paths)[6] > 0 && countByType(rRaft.layers[1].paths)[6] > 0,
   `first 2 layers are raft (type6): ${countByType(rRaft.layers[0].paths)[6]}, ${countByType(rRaft.layers[1].paths)[6]}`)
ok(/^; raft/m.test(rRaft.gcode), 'G-code has "; raft" marker')
ok(rRaft.layers[2].z > 0.5 && rCube.layers[0].z < 0.5,
   `model z shifted up by raft (raft model layer0 z=${rRaft.layers[2].z.toFixed(2)} vs no-raft ${rCube.layers[0].z.toFixed(2)})`)
ok(rRaft.layers.length === rRaft.stats.layers, `raft: layers array (${rRaft.layers.length}) == stats.layers (${rRaft.stats.layers})`)

// --- Bed parameterization ---
const rBed = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, bed_width: 200, bed_depth: 200 }), () => {})
ok(/off=100\.0,100\.0/.test(rBed.gcode), 'bed 200 → offset 100 (header off=100.0,100.0)')
ok(/off=128\.0,128\.0/.test(rCube.gcode), 'default bed 256 → offset 128')
// bed200 coordinates sit around 100, bed256 around 128
const firstX = (gcode) => {
  const match = gcode.match(/^G1 X([\d.]+)/m)
  if (!match) return NaN
  return parseFloat(match[1])
}
ok(firstX(rBed.gcode) < 115 && firstX(rCube.gcode) > 115, `X offset applied (bed200 X=${firstX(rBed.gcode).toFixed(1)} < bed256 X=${firstX(rCube.gcode).toFixed(1)})`)

// ===== New in stage 4 (path and G-code level) =====
console.log('\n[stage4]')
const travelCount = (gcode) => (gcode.match(/^G0 /gm) || []).length
// (1) Every infill pattern slices successfully with segments > 0
for (const pattern of ['rectilinear', 'grid', 'triangles', 'zigzag', 'gyroid']) {
  const rPattern = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, sparse_infill_pattern: pattern }), () => {})
  let segmentsText = 'ERR'
  if (!rPattern.error) segmentsText = rPattern.stats.path_segments
  ok(!rPattern.error && rPattern.stats.path_segments > 0, `pattern ${pattern}: slices ok, segments=${segmentsText}`)
}
// (2) zigzag travel < rectilinear
const rRectilinear = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, sparse_infill_pattern: 'rectilinear' }), () => {})
const rZigzag  = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, sparse_infill_pattern: 'zigzag' }), () => {})
ok(travelCount(rZigzag.gcode) < travelCount(rRectilinear.gcode), `zigzag travels (${travelCount(rZigzag.gcode)}) < rectilinear (${travelCount(rRectilinear.gcode)})`)

// (3) Cooling fan: 0 on the first layer, then a ramp, then M107
const fanSpeeds = [...rCube.gcode.matchAll(/^M106 S(\d+)$/gm)].map(match => +match[1])
ok(fanSpeeds.length > 0 && fanSpeeds[0] === 0, `first layer fan = 0 (first M106 S${fanSpeeds[0]})`)
ok(fanSpeeds.includes(255), `fan ramps to full 255 (distinct: ${[...new Set(fanSpeeds)].join(',')})`)
ok(fanSpeeds[0] < fanSpeeds[fanSpeeds.length - 1], `fan monotonic ramp ${fanSpeeds[0]}→${fanSpeeds[fanSpeeds.length - 1]}`)
ok(/^M107$/m.test(rCube.gcode), 'M107 present (fan off at end)')

// (4) Slowdown: small layers are slowed (default 8s) vs disabled (0)
const layerFeed = (gcode, layerIndex) => {   // F of the layer's first XY extrusion move (skipping retract/unretract E-only lines)
  const lines = gcode.split('\n')
  const layerStart = lines.findIndex(line => line.startsWith(`; LAYER ${layerIndex} `))
  if (layerStart < 0) return NaN
  for (let j = layerStart + 1; j < lines.length && !lines[j].startsWith('; LAYER'); j++) {
    const match = lines[j].match(/^G1 X[\d.-]+ Y[\d.-]+ E[\d.]+ F(\d+)$/)
    if (match) return +match[1]
  }
  return NaN
}
const rNoSlowdown = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, slow_down_layer_time: 0 }), () => {})
ok(layerFeed(rNoSlowdown.gcode, 10) === 3600, `no-slowdown layer10 feed=${layerFeed(rNoSlowdown.gcode, 10)} (=print 3600)`)
ok(layerFeed(rCube.gcode, 10) < 3600 && layerFeed(rCube.gcode, 10) >= 1200, `slowdown layer10 feed=${layerFeed(rCube.gcode, 10)} (<3600, >=1200 floor)`)

// (5) Arc fitting: cylinder -> G2/G3 present + extrusion volume preserved within ±1%
//  gcode_resolution 0.0125 (upstream's RESOLUTION): upstream's ArcFitter also checks each chord against the circle, and
//  this 64-facet r=10 wall's chords sag 0.012mm from it, past the default 0.01mm, where the walls stay straight moves as
//  upstream prints them.
const cylinderSTL = makeCylinderSTL(10, 6, 64)
writeFileSync(join(packageRoot, 'cylinder.stl'), cylinderSTL)
const rArcOff = Module.slice(new Uint8Array(cylinderSTL), JSON.stringify({ ...params, gcode_resolution: 0.0125, enable_arc_fitting: false }), () => {})
const rArcOn  = Module.slice(new Uint8Array(cylinderSTL), JSON.stringify({ ...params, gcode_resolution: 0.0125, enable_arc_fitting: true }), () => {})
ok(/^G[23] /m.test(rArcOn.gcode), `arc fitting on → G2/G3 present (${(rArcOn.gcode.match(/^G[23] /gm) || []).length} arcs)`)
ok(!/^G[23] /m.test(rArcOff.gcode), 'arc fitting off → no G2/G3')
const arcDeviation = Math.abs(rArcOn.stats.filament_mm - rArcOff.stats.filament_mm) / rArcOff.stats.filament_mm
ok(arcDeviation < 0.01, `arc extrusion within ±1% (Δ=${(arcDeviation * 100).toFixed(3)}%)`)
// [arc fidelity] Every arc the G-code text carries follows the path it stands for. The kernel's own fitter accepted a
//  run when its VERTICES lay on one circle, so the sparse-infill zigzag inside this cylinder, whose turning points sit
//  on the round boundary, became arcs along the wall (measured with crosshatch, whose lines are one connected run:
//  worst 0.66mm; on a Benchy with support, beyond 1mm). Upstream's ArcFitter (arcfit_bridge.cpp) checks the segments
//  too. The bound is the largest fitting tolerance (0.04mm, sparse infill) plus the chord sag of the parser's sampling.
{
  const { parseGcode: parseGcodeText } = await import('../../../viewer-package/src/core/gcode_parse.js')
  const bed = 200
  const arcResult = Module.slice(new Uint8Array(cylinderSTL), JSON.stringify({ ...params, enable_arc_fitting: true, sparse_infill_pattern: 'crosshatch', bed_width: bed, bed_depth: bed }), () => {})
  const parsed = parseGcodeText(arcResult.gcode)
  const segmentDistance = (pointX, pointY, startX, startY, endX, endY) => {
    const dx = endX - startX
    const dy = endY - startY
    const lengthSquared = dx * dx + dy * dy
    let t = 0
    if (lengthSquared > 0) t = Math.max(0, Math.min(1, ((pointX - startX) * dx + (pointY - startY) * dy) / lengthSquared))
    return Math.hypot(pointX - startX - t * dx, pointY - startY - t * dy)
  }
  let worst = 0
  for (let layerIndex = 0; layerIndex < arcResult.layers.length; layerIndex++) {
    const stream = arcResult.layers[layerIndex].paths
    const text = parsed.layers[layerIndex].paths
    for (let k = 0; k < text.length; k += 8) {
      if (!(text[k + 3] & 15)) continue
      const midX = (text[k] + text[k + 4]) / 2 - bed / 2
      const midY = (text[k + 1] + text[k + 5]) / 2 - bed / 2
      let nearest = Infinity
      for (let streamIndex = 0; streamIndex < stream.length; streamIndex += 8) {
        if (!(stream[streamIndex + 3] & 15)) continue
        nearest = Math.min(nearest, segmentDistance(midX, midY, stream[streamIndex], stream[streamIndex + 1], stream[streamIndex + 4], stream[streamIndex + 5]))
      }
      worst = Math.max(worst, nearest)
    }
  }
  ok(parsed.layers.length === arcResult.layers.length && worst < 0.1,
     `[arc fidelity] arc-fitted G-code stays on the toolpath (worst ${worst.toFixed(3)}mm < 0.1mm)`)
}

// (6) Seam position: back = fixed, random = scattered (and deterministic)
const firstWallStart = (layer) => {
  const paths = layer.paths
  for (let i = 0; i < paths.length; i += 8) if (paths[i + 3] === 1) return [paths[i], paths[i + 1]]
  return null
}
const seamSpread = (result) => {
  const xs = []
  const ys = []
  for (let layerIndex = 5; layerIndex < result.layers.length - 5; layerIndex++) {
    const start = firstWallStart(result.layers[layerIndex])
    if (start) {
      xs.push(start[0])
      ys.push(start[1])
    }
  }
  const spread = (values) => {
    if (!values.length) return 0
    return Math.max(...values) - Math.min(...values)
  }
  return spread(xs) + spread(ys)
}
const rSeamBack = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, seam_position: 'back' }), () => {})
const rSeamRandom = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, seam_position: 'random' }), () => {})
const rSeamRandomAgain = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, seam_position: 'random' }), () => {})
ok(seamSpread(rSeamBack) < 1.0, `seam back fixed (spread ${seamSpread(rSeamBack).toFixed(2)}mm)`)
ok(seamSpread(rSeamRandom) > 5.0, `seam random dispersed (spread ${seamSpread(rSeamRandom).toFixed(2)}mm)`)
ok(rSeamRandom.gcode === rSeamRandomAgain.gcode, 'seam random deterministic (identical gcode on rerun)')
ok(/seam=back/.test(rCube.gcode) && /pattern=rectilinear/.test(rCube.gcode), 'G-code header carries pattern/seam')

// (7) Spiral (vase): slices successfully and Z rises within a layer
const rSpiral = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, spiral_mode: true }), () => {})
ok(!rSpiral.error && /^G1 X[\d.]+ Y[\d.]+ Z[\d.]+ E/m.test(rSpiral.gcode), 'spiral: extrude moves carry rising Z')

// ===== New in stage 5 (gap fill · thin wall · scarf · pressure advance · tree-lite · bridge) =====
console.log('\n[stage5]')

// (1) Gap fill: a 2.5w ring (0.5w leftover gap) -> type7 present. Absent on a solid cube (backwards compatible).
const rRing = Module.slice(new Uint8Array(makeRingSTL()), JSON.stringify(params), () => {})
let ringGapFillText = 'ERR'
if (!rRing.error) ringGapFillText = typeTotal(rRing, 7)
ok(!rRing.error && typeTotal(rRing, 7) > 0, `gap-fill on 2.5w ring (type7=${ringGapFillText})`)
ok(typeTotal(rCube, 7) === 0, `solid cube has no gap-fill (type7=${typeTotal(rCube, 7)})`)

// (2) Thin wall (classic, the port of upstream process_classic): a 0.6mm arm is wide enough for one outer loop, so by
//  default it is walled like everything else (no type8); detect_thin_wall collapses it to a medial-axis thin wall (type8).
const rCross = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify(params), () => {})
ok(!rCross.error && typeTotal(rCross, 8) === 0, `thin cross, detect_thin_wall off → arms walled, no thin wall (type8=${rCross.error ?? typeTotal(rCross, 8)})`)
const rCrossThin = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify({ ...params, detect_thin_wall: true }), () => {})
ok(!rCrossThin.error && typeTotal(rCrossThin, 8) > 0, `thin cross, detect_thin_wall on → medial-axis thin walls (type8=${rCrossThin.error ?? typeTotal(rCrossThin, 8)})`)
ok(typeTotal(rCube, 8) === 0, `solid cube has no thin-wall (type8=${typeTotal(rCube, 8)})`)

// (2b) [thin wall orientation] A thin plate prints the same wall length however it is turned on the bed. The classic
//  path used to fill a region narrower than 2w with one straight line along the bbox's x or y axis, so a plate turned
//  30deg got a ~1mm stub across it (measured on a 20mm plate: 20mm of thin wall at 0deg, 1.2-1.6mm at 30deg).
{
  const plateSTL = (thickness, degrees) => {
    const angle = degrees * Math.PI / 180
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const turn = triangle => triangle.map(([x, y, z]) => [x * cosine - y * sine, x * sine + y * cosine, z])
    return trianglesToSTL(outwardBoxTriangles(-10, -thickness / 2, 0, 20, thickness, 4).map(turn))
  }
  const midWallLength = (result) => {
    const layer = result.layers[Math.floor(result.layers.length / 2)].paths
    let length = 0
    for (let k = 0; k < layer.length; k += 8) {
      const role = layer[k + 3] & 15
      if (role === 1 || role === 8) length += Math.hypot(layer[k + 4] - layer[k], layer[k + 5] - layer[k + 1])
    }
    return length
  }
  for (const thickness of [0.6, 0.8]) for (const detect_thin_wall of [false, true]) {
    const plateParams = { ...params, detect_thin_wall }
    const straight = midWallLength(Module.slice(new Uint8Array(plateSTL(thickness, 0)), JSON.stringify(plateParams), () => {}))
    const turned = midWallLength(Module.slice(new Uint8Array(plateSTL(thickness, 30)), JSON.stringify(plateParams), () => {}))
    ok(straight > 15 && Math.abs(turned / straight - 1) < 0.05,
       `[thin wall orientation] ${thickness}mm plate, detect_thin_wall=${detect_thin_wall}: wall length 0deg ${straight.toFixed(2)} vs 30deg ${turned.toFixed(2)}`)
  }
}
// Does the thick hub get a second wall: wall_loops 2 yields more wall segments than 1 (added only on the hub)
const rCrossOneWall = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify({ ...params, wall_loops: 1 }), () => {})
ok(typeTotal(rCross, 1) > typeTotal(rCrossOneWall, 1),
   `thick hub takes 2nd wall (wall2 type1=${typeTotal(rCross, 1)} > wall1 type1=${typeTotal(rCrossOneWall, 1)})`)

// (3) Scarf seam: seam_slope_type=external -> a ; scarf marker + the seam's z is midway (zE-h < z < zE).
const rScarf = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, seam_slope_type: 'external' }), () => {})
ok(/^; scarf$/m.test(rScarf.gcode), 'scarf: "; scarf" marker present')
ok(!/^; scarf$/m.test(rCube.gcode), 'no scarf marker when seam_slope_type=none (default)')
const scarfLayerZ = (gcode, layerIndex) => {   // extrusion Z values of layer layerIndex
  const lines = gcode.split('\n')
  const layerStart = lines.findIndex(line => line.startsWith(`; LAYER ${layerIndex} `))
  if (layerStart < 0) return []
  const out = []
  for (let j = layerStart + 1; j < lines.length && !lines[j].startsWith('; LAYER'); j++) {
    const match = lines[j].match(/Z([\d.]+) E/)
    if (match) out.push(+match[1])
  }
  return out
}
const layer5Zs = scarfLayerZ(rScarf.gcode, 5)   // layer5 zE=1.2, h=0.2 -> midway between (1.0, 1.2)
ok(layer5Zs.some(z => z > 1.0 + 1e-6 && z < 1.2 - 1e-6), `scarf ramp has intermediate z in (1.0,1.2): ${[...new Set(layer5Zs)].filter(z => z > 1.0 && z < 1.2).map(z => z.toFixed(3)).slice(0, 3).join(',')}`)

// (4) Pressure advance: enabled -> M900 K<v> in the preamble; disabled -> absent.
const rPressureAdvance = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, enable_pressure_advance: true, pressure_advance: 0.045 }), () => {})
ok(/^M900 K0\.045/m.test(rPressureAdvance.gcode), 'pressure advance: M900 K0.045 present when enabled')
ok(!/^M900/m.test(rCube.gcode), 'no M900 when pressure advance disabled (default)')

// (5) Tree-lite: tapers downward -> the lower support span < the upper one, narrower at the bottom than grid, and touches down. (overhang table)
const supportSpan = (layer) => {
  let minX = 1e9
  let maxX = -1e9
  let minY = 1e9
  let maxY = -1e9
  let count = 0
  const paths = layer.paths
  for (let i = 0; i < paths.length; i += 8) {
    if (paths[i + 3] === 5) {
      minX = Math.min(minX, paths[i])
      maxX = Math.max(maxX, paths[i])
      minY = Math.min(minY, paths[i + 1])
      maxY = Math.max(maxY, paths[i + 1])
      count++
    }
  }
  if (!count) return 0
  return Math.max(maxX - minX, maxY - minY)
}
const supportLayers = (result) => result.layers.map(layer => ({ z: layer.z, span: supportSpan(layer) })).filter(entry => entry.span > 0)
const rTree = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supportParams, support_style: 'tree_lite' }), () => {})
const rGridSupport = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supportParams, support_style: 'grid' }), () => {})
const treeLayers = supportLayers(rTree)
const gridLayers = supportLayers(rGridSupport)
const treeTop = treeLayers[treeLayers.length - 1].span
const treeBottom = treeLayers[0].span
const gridBottom = gridLayers[0].span
console.log(`  tree spans: top=${treeTop.toFixed(1)} bot=${treeBottom.toFixed(1)}  grid bot=${gridBottom.toFixed(1)}  tree grounds z=${treeLayers[0].z.toFixed(2)}`)
ok(treeTop > treeBottom + 1.0, `tree_lite tapers: top span ${treeTop.toFixed(1)} > bottom span ${treeBottom.toFixed(1)} (top > bottom)`)
ok(treeBottom < gridBottom - 0.5, `tree_lite narrower than grid at bottom (${treeBottom.toFixed(1)} < ${gridBottom.toFixed(1)})`)
ok(treeLayers[0].z < 1.0, `tree_lite grounds near bed (lowest support z=${treeLayers[0].z.toFixed(2)})`)
// Stage 33: the material comparison was corrected from "segment count" to "real path length".
//  The count is an inaccurate proxy — the narrower the region, the more direction changes and short segments,
//  so the count can rise even when tapering uses less material (measured: 705 vs 704, an inversion). Length is the real material usage.
const supportPathLength = (result) => (result.layers || []).reduce((sum, layer) => {
  const paths = layer.paths
  if (!paths) return sum
  let layerLength = 0
  for (let i = 0; i < paths.length; i += 8) if (paths[i+3] === 5 || paths[i+3] === 6) layerLength += Math.hypot(paths[i+4]-paths[i], paths[i+5]-paths[i+1])
  return sum + layerLength
}, 0)
const treeLength = supportPathLength(rTree)
const gridLength = supportPathLength(rGridSupport)
ok(treeLength <= gridLength, `tree_lite uses <= grid support material (path length ${treeLength.toFixed(0)}mm <= ${gridLength.toFixed(0)}mm)`)

// (6) Bridge: an unsupported bottom (the overhang cap's underside) -> type9 + ; bridge. Table without support. Absent on a solid cube.
const rBridge = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(params), () => {})
ok(typeTotal(rBridge, 9) > 0 && /^; bridge/m.test(rBridge.gcode), `unsupported overhang bottom → bridge (type9=${typeTotal(rBridge, 9)})`)
ok(typeTotal(rCube, 9) === 0, `solid cube has no bridge (type9=${typeTotal(rCube, 9)})`)

// Backwards compatible: with every stage-5 parameter at its default, the cube result is unchanged (layer count, filament)
const rStage5Defaults = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({
  ...params, seam_slope_type: 'none', enable_pressure_advance: false, support_style: 'grid',
}), () => {})
ok(rStage5Defaults.stats.layers === rCube.stats.layers && Math.abs(rStage5Defaults.stats.filament_mm - rCube.stats.filament_mm) < 1e-6,
   'stage-5 defaults keep cube result unchanged (backward compatible)')

// ===== New in stage 6 (ironing · wall avoidance · PE-lite · multi-material) =====
console.log('\n[stage6]')

// (1) Ironing: type10 exists on the cube's top layer with flow ~10% (comparing E/mm), and is absent when off.
const rIron = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, ironing_type: 'top' }), () => {})
ok(typeTotal(rIron, 10) > 0, `ironing on → top-surface re-pass (type10=${typeTotal(rIron, 10)})`)
ok(typeTotal(rCube, 10) === 0, `ironing off (default) → no type10 (${typeTotal(rCube, 10)})`)
const blockEperMM = (gcode, marker) => {   // E/mm of the first long extrusion in the marker block (position tracked via G0)
  const lines = gcode.split('\n')
  const blockStart = lines.findIndex(line => line.trim() === marker)
  if (blockStart < 0) return null
  let previousX = null
  let previousY = null
  for (let j = blockStart + 1; j < lines.length && !lines[j].startsWith('; LAYER') && lines[j].trim() !== '; end'; j++) {
    const travel = lines[j].match(/^G0 X([\d.-]+) Y([\d.-]+)/)
    if (travel) {
      previousX = +travel[1]
      previousY = +travel[2]
      continue
    }
    const match = lines[j].match(/^G1 X([\d.-]+) Y([\d.-]+) E([\d.]+)/)
    if (match) {
      const x = +match[1]
      const y = +match[2]
      const extrusion = +match[3]
      if (previousX !== null) {
        const distance = Math.hypot(x - previousX, y - previousY)
        if (distance > 1) return extrusion / distance
      }
      previousX = x
      previousY = y
    }
  }
  return null
}
const firstBigE = (gcode) => {
  const lines = gcode.split('\n')
  let previousX = null
  let previousY = null
  for (const line of lines) {
    const travel = line.match(/^G0 X([\d.-]+) Y([\d.-]+)/)
    if (travel) {
      previousX = +travel[1]
      previousY = +travel[2]
      continue
    }
    const match = line.match(/^G1 X([\d.-]+) Y([\d.-]+) E([\d.]+)/)
    if (match) {
      const x = +match[1]
      const y = +match[2]
      const extrusion = +match[3]
      if (previousX !== null) {
        const distance = Math.hypot(x - previousX, y - previousY)
        if (distance > 1) return extrusion / distance
      }
      previousX = x
      previousY = y
    }
  }
  return null
}
const ironE = blockEperMM(rIron.gcode, '; ironing')
const normalE = firstBigE(rCube.gcode)
ok(ironE && normalE && Math.abs(ironE / normalE - 0.1) < 0.02, `ironing flow ~10% of normal (ratio=${(ironE / normalE).toFixed(3)})`)

// (2) Wall-avoiding travel: on the L shape, reduce_crossing_wall=true lowers the number of travels crossing the outer wall.
const rWallAvoidOff = Module.slice(new Uint8Array(makeLShapeSTL()), JSON.stringify({ ...params, reduce_crossing_wall: false }), () => {})
const rWallAvoidOn = Module.slice(new Uint8Array(makeLShapeSTL()), JSON.stringify({ ...params, reduce_crossing_wall: true }), () => {})
console.log(`  L-shape wall crossings: off=${rWallAvoidOff.stats.wall_crossings} on=${rWallAvoidOn.stats.wall_crossings}`)
ok(rWallAvoidOff.stats.wall_crossings > 0, `L-shape has wall-crossing travels without avoidance (${rWallAvoidOff.stats.wall_crossings})`)
ok(rWallAvoidOn.stats.wall_crossings < rWallAvoidOff.stats.wall_crossings, `reduce_crossing_wall lowers crossings (${rWallAvoidOn.stats.wall_crossings} < ${rWallAvoidOff.stats.wall_crossings})`)

// (3) PE-lite: with slope set, the rate of change in volumetric flow between adjacent extrusions stays within the limit. (overhang table: bridge speed difference)
const maxPEslope = (gcode) => {   // maximum per-layer rate of change in volumetric flow (mm³/s²) between adjacent extrusions. Tracked across travels, reset at ; LAYER.
  const lines = gcode.split('\n')
  let maxSlope = 0
  let currentFeed = null
  let previousX = null
  let previousY = null
  let lastFlow = null
  const depositedArea = 0.2 * (0.42 - 0.2 * (1 - Math.PI / 4))   // deposited cross-section at h0.2 (mm²)
  for (const line of lines) {
    if (line.startsWith('; LAYER')) {
      lastFlow = null
      previousX = null
      previousY = null
      currentFeed = null
      continue
    }
    const travel = line.match(/^G0 X([\d.-]+) Y([\d.-]+)/)
    if (travel) {
      previousX = +travel[1]
      previousY = +travel[2]
      continue
    }
    const match = line.match(/^G1 X([\d.-]+) Y([\d.-]+) E[\d.]+/)
    if (!match) continue
    const feedMatch = line.match(/F(\d+)/)
    if (feedMatch) currentFeed = +feedMatch[1]
    const x = +match[1]
    const y = +match[2]
    if (previousX !== null && currentFeed) {
      const distance = Math.hypot(x - previousX, y - previousY)
      if (distance > 0.05) {
        const speed = currentFeed / 60
        const flow = depositedArea * speed
        const duration = distance / speed
        if (lastFlow !== null && duration > 0) {
          const slope = Math.abs(flow - lastFlow) / duration
          if (slope > maxSlope) maxSlope = slope
        }
        lastFlow = flow
      }
    }
    previousX = x
    previousY = y
  }
  return maxSlope
}
const rPEoff = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(params), () => {})
const rPEon = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...params, max_volumetric_extrusion_rate_slope: 40 }), () => {})
const peSlopeOff = maxPEslope(rPEoff.gcode)
const peSlopeOn = maxPEslope(rPEon.gcode)
console.log(`  PE flow-slope (mm³/s²): off=${peSlopeOff.toFixed(1)} on(limit40)=${peSlopeOn.toFixed(1)}`)
ok(peSlopeOff > 40, `without PE the flow-slope exceeds limit (${peSlopeOff.toFixed(1)} > 40)`)
ok(peSlopeOn <= 40 + 1.0, `PE-lite caps flow-slope to limit (${peSlopeOn.toFixed(1)} ≤ 40)`)
ok(Math.abs(rPEon.stats.filament_mm - rPEoff.stats.filament_mm) < 1e-6, `PE changes speed not E (filament identical)`)

// (4) Multi-material: T0/T1 + prime tower (type11). The single-material path is unchanged.
const { stl: multiMaterialSTL, split: multiMaterialSplit } = makeTwoBoxSTL()
const rMultiMaterial = Module.slice(new Uint8Array(multiMaterialSTL), JSON.stringify({ ...params, extruder_count: 2, mm_group_split: multiMaterialSplit }), () => {})
let multiMaterialLayersText = 'ERR'
if (!rMultiMaterial.error) multiMaterialLayersText = rMultiMaterial.stats.layers
ok(!rMultiMaterial.error, `multimaterial slices ok (layers=${multiMaterialLayersText})`)
ok(/^T0$/m.test(rMultiMaterial.gcode) && /^T1$/m.test(rMultiMaterial.gcode), `MM has tool changes T0 and T1`)
ok(typeTotal(rMultiMaterial, 11) > 0, `MM prime tower emitted (type11=${typeTotal(rMultiMaterial, 11)})`)
// The default is the fallback ring; the real WipeTower is opt-in (see the [wipe tower] section). Both markers are
//  asserted so a silent flip of the default in either direction fails here.
ok(/^; prime tower \(ring, \d+ loops/m.test(rMultiMaterial.gcode), `MM uses the deterministic ring by default`)
ok(!/wipe_tower_real: real ported WipeTower/.test(rMultiMaterial.gcode), `and does not reach for the real tower unasked`)
// With an explicit opt-out (wipe_tower_real=false) the old square ring path is kept
const rMultiMaterialRing = Module.slice(new Uint8Array(multiMaterialSTL), JSON.stringify({ ...params, extruder_count: 2, mm_group_split: multiMaterialSplit, wipe_tower_real: false }), () => {})
ok(/^; prime tower \(ring, \d+ loops/m.test(rMultiMaterialRing.gcode) && typeTotal(rMultiMaterialRing, 11) > 0, `wipe_tower_real=false keeps the ring fallback`)
const rSingle = Module.slice(new Uint8Array(multiMaterialSTL), JSON.stringify(params), () => {})
ok(!/^T[01]$/m.test(rSingle.gcode) && typeTotal(rSingle, 11) === 0, `single-material path unchanged (no T0/T1, no prime tower)`)

// Per-extruder filament: two materials mean two temperatures and two flow ratios. Without the arrays the MM
//  output must stay exactly what it was, so the same slice is compared both ways.
const multiMaterialBase = { ...params, extruder_count: 2, mm_group_split: multiMaterialSplit }
const rMultiMaterialPerExtruder = Module.slice(new Uint8Array(multiMaterialSTL), JSON.stringify({ ...multiMaterialBase,
  extruder_nozzle_temp: [270, 220], extruder_flow_ratio: [0.95, 0.98],
  extruder_retract_length: [0.8, 0.4], extruder_z_hop: [0.4, 0.2] }), () => {})
ok(!rMultiMaterialPerExtruder.error, `per-extruder filament slices ok`)
const startTemperature = rMultiMaterialPerExtruder.gcode.match(/^M109 S(\d+)/m)?.[1]
const afterT1 = rMultiMaterialPerExtruder.gcode.split(/^T1$/m)[1] ?? ''
ok(startTemperature === '270', `preamble heats to T0's material (M109 S${startTemperature}, expected 270)`)
ok(/^M109 S220$/m.test(afterT1), `switching to T1 heats to its own material (M109 S220)`)
ok(/^M109 S270$/m.test(afterT1.split(/^T0$/m)[1] ?? ''), `switching back to T0 restores its temperature`)
ok(Math.abs(rMultiMaterialPerExtruder.stats.filament_mm - rMultiMaterial.stats.filament_mm) > 1e-6,
   `per-extruder flow ratio changes the extruded amount (${rMultiMaterialPerExtruder.stats.filament_mm.toFixed(2)} vs ${rMultiMaterial.stats.filament_mm.toFixed(2)} mm)`)
const rMultiMaterialNoArrays = Module.slice(new Uint8Array(multiMaterialSTL), JSON.stringify(multiMaterialBase), () => {})
ok(rMultiMaterialNoArrays.gcode === rMultiMaterial.gcode, `MM without per-extruder arrays is byte-identical to before`)

// N-way grouping: three boxes, one per extruder. A single mm_group_split can only express two groups, so the
//  third box used to be folded into the second and printed with its material.
const { stl: threeMaterialSTL, splits: threeMaterialSplits } = makeThreeBoxSTL()
const rThreeMaterial = Module.slice(new Uint8Array(threeMaterialSTL), JSON.stringify({ ...params,
  extruder_count: 3, mm_group_splits: threeMaterialSplits, mm_group_tools: [0, 1, 2],
  extruder_nozzle_temp: [270, 220, 240], extruder_flow_ratio: [0.95, 0.98, 1.0] }), () => {})
let threeMaterialLayersText = 'ERR'
if (!rThreeMaterial.error) threeMaterialLayersText = rThreeMaterial.stats.layers
ok(!rThreeMaterial.error, `three-material slice ok (layers=${threeMaterialLayersText})`)
ok(/^T2$/m.test(rThreeMaterial.gcode), `third extruder gets its own tool (T2)`)
ok(/^M109 S240$/m.test(rThreeMaterial.gcode), `third extruder heats to its own material (M109 S240)`)
const threeMaterialTemperatures = [...rThreeMaterial.gcode.matchAll(/^M109 S(\d+)$/gm)].map(match => match[1])
ok(new Set(threeMaterialTemperatures).size === 3, `all three materials reach the G-code (temps: ${[...new Set(threeMaterialTemperatures)].join(', ')})`)
// The old single-boundary form on the same geometry proves what was broken: T2 never appears.
const rThreeMaterialSingleSplit = Module.slice(new Uint8Array(threeMaterialSTL), JSON.stringify({ ...params,
  extruder_count: 3, mm_group_split: threeMaterialSplits[0],
  extruder_nozzle_temp: [270, 220, 240] }), () => {})
ok(!/^T2$/m.test(rThreeMaterialSingleSplit.gcode), `a single boundary still yields two groups only (regression guard)`)

// Per-tool filament accounting: a single total cannot say "ABS 1820mm, PLA 980mm", and the filament profiles carry
//  cost/density per material — so the split is what a cost estimate is built from. It must reconcile exactly with
//  the unchanged filament_mm total, or the cost it feeds is wrong.
const byTool = rMultiMaterial.stats.filament_mm_by_tool
ok(Array.isArray(byTool) && byTool.length >= 2, `MM reports filament_mm_by_tool (${JSON.stringify(byTool)})`)
const byToolSum = byTool.reduce((sum, value) => sum + value, 0)
ok(Math.abs(byToolSum - rMultiMaterial.stats.filament_mm) < 1e-6,
   `per-tool filament sums to the total (${byToolSum.toFixed(4)} == ${rMultiMaterial.stats.filament_mm.toFixed(4)})`)
ok(byTool.every(length => length > 0), `both extruders consume filament (${byTool.map(length => length.toFixed(1)).join(', ')} mm)`)
// The purge is separated because painting multiplies tool changes and the purge total is the only number a user can act on.
ok(rMultiMaterial.stats.filament_mm_purge > 0 && rMultiMaterial.stats.filament_mm_purge < rMultiMaterial.stats.filament_mm,
   `prime tower purge reported on its own (${rMultiMaterial.stats.filament_mm_purge.toFixed(1)} of ${rMultiMaterial.stats.filament_mm.toFixed(1)} mm)`)
const threeMaterialByTool = rThreeMaterial.stats.filament_mm_by_tool
ok(threeMaterialByTool.length === 3 && Math.abs(threeMaterialByTool.reduce((sum, value) => sum + value, 0) - rThreeMaterial.stats.filament_mm) < 1e-6,
   `three-material: one slot per extruder and the sum still matches (${threeMaterialByTool.map(length => length.toFixed(1)).join(', ')} mm)`)
// The ring fallback purges too, so the figure is not tied to the real WipeTower path.
ok(rMultiMaterialRing.stats.filament_mm_purge > 0, `ring fallback also reports its purge (${rMultiMaterialRing.stats.filament_mm_purge.toFixed(1)}mm)`)

// ===== Painted multi-material: the paint splits the SLICED POLYGONS, not the triangle list ======================
//  A triangle group is a whole object, so grouping by triangle index can never give one object's layer two
//  materials. These checks are on the region split, the per-layer tool ordering, and the tool channel in the stream.
console.log('\n[paint MM]')
const paintParams = { ...params, extruder_count: 2 }
const wedge1 = makeWedgeSTL(1)
const paintSlope = (wedgeIndex, state) => Module.selector_paint_state(
  wedgeIndex * WEDGE_FACETS + WEDGE_SLOPE_FACET,
  wedgeIndex * WEDGE_PITCH + 10, 10, 15,        // hit: the middle of the slanted face
  wedgeIndex * WEDGE_PITCH + 10, 10, 60, 16,    // camera above it; radius 16 reaches the whole face
  state)
// Tools actually used by the extrusions of one layer (travels carry the tool too but print nothing; the prime
//  tower is excluded because it belongs to the purge, not to the model's regions).
const modelToolsOf = (layer) => {
  const tools = new Set()
  for (let i = 0; i < layer.paths.length; i += 8) {
    const role = ROLE_OF(layer.paths[i+3])
    if (role === 0 || role === 11) continue
    tools.add(TOOL_OF(layer.paths[i+3]))
  }
  return [...tools].sort()
}
const toolBoxOf = (layer, tool) => {
  const box = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, n: 0 }
  for (let i = 0; i < layer.paths.length; i += 8) {
    const role = ROLE_OF(layer.paths[i+3])
    if (role === 0 || role === 11) continue
    if (TOOL_OF(layer.paths[i+3]) !== tool) continue
    for (const [xOffset, yOffset] of [[0,1],[4,5]]) {
      box.x0 = Math.min(box.x0, layer.paths[i+xOffset])
      box.x1 = Math.max(box.x1, layer.paths[i+xOffset])
      box.y0 = Math.min(box.y0, layer.paths[i+yOffset])
      box.y1 = Math.max(box.y1, layer.paths[i+yOffset])
    }
    box.n++
  }
  return box
}

// Reference first: the same model with nothing painted must not touch the painted path at all.
Module.selector_prepare(new Uint8Array(wedge1))
Module.selector_clear()
const rWedgeClean = Module.slice(new Uint8Array(wedge1), JSON.stringify(paintParams), () => {})
ok(!/^T\d+$/m.test(rWedgeClean.gcode), `unpainted model with 2 extruders declared stays on the single-material path`)

// (1) The painted area prints with the painted extruder, and — this is what the exact segmentation buys — only the
//     part of the layer the paint actually covers. The wedge's slanted face is ONE of the four sides of every
//     cross-section above z=10, so those layers must come out SPLIT: the slope's own edge on T1, the back wall and
//     the two ends still on T0. The volume projector this replaced could not express that; it laid the facet's XY
//     shadow over the whole plane, so the same paint used to turn every layer above z=10 entirely into T1.
Module.selector_prepare(new Uint8Array(wedge1))
paintSlope(0, 2)                                  // state 2 == Extruder2 == T1
ok(Module.selector_painted_count_state(2) > 0, `painting the slanted face marks facets (${Module.selector_painted_count_state(2)})`)
const rWedge = Module.slice(new Uint8Array(wedge1), JSON.stringify(paintParams), () => {})
ok(!rWedge.error && /^T1$/m.test(rWedge.gcode), `painted single object reaches the multi-tool path (T1 emitted)`)
let belowPaintWrong = 0
let splitLayers = 0
let plainLayers = 0
for (const layer of rWedge.layers) {
  const tools = modelToolsOf(layer)
  if (tools.length === 0) continue          // z=10.00 and the very tip print nothing
  if (layer.z < 10.0 - 1e-6) {
    if (tools.includes(1)) belowPaintWrong++
    else plainLayers++
    continue
  }
  if (tools.length > 1) splitLayers++
}
ok(belowPaintWrong === 0 && plainLayers > 20,
   `no layer below the painted face is touched (${plainLayers} plain / ${belowPaintWrong} wrong)`)
ok(splitLayers > 20,
   `a layer whose contour is only partly painted comes out SPLIT between the two tools (${splitLayers} such layers)`)
// The split follows the geometry: the slope rises in +y, so at z the cross-section is y in [2(z-10), 20] and the
//  painted edge is its LOW-y side. T1 therefore has to start at the front edge and T0 has to reach the back wall.
const splitLayer = rWedge.layers.find(layer => Math.abs(layer.z - 15.0) < 1e-6)
const splitT1 = toolBoxOf(splitLayer, 1)
const splitT0 = toolBoxOf(splitLayer, 0)
ok(splitT1.n > 0 && splitT0.n > 0 && splitT1.y0 < splitT0.y0 && splitT0.y1 > 19,
   `and on the painted side: T1 starts at the slope edge (y0 ${splitT1.y0.toFixed(1)}) while T0 keeps the back wall (y1 ${splitT0.y1.toFixed(1)})`)
ok(rWedge.stats.filament_mm_by_tool[1] > 0 && rWedge.stats.filament_mm_by_tool[0] > 0,
   `both extruders consume filament (${rWedge.stats.filament_mm_by_tool.map(length => length.toFixed(1)).join(', ')} mm)`)

// (2) No painted facets -> byte-identical to the same slice before anything was painted.
Module.selector_clear()
const rWedgeCleared = Module.slice(new Uint8Array(wedge1), JSON.stringify(paintParams), () => {})
ok(rWedgeCleared.gcode === rWedgeClean.gcode, `clearing the paint restores the unpainted G-code byte for byte`)
// ... and an untooled stream never sets the tool bits, which is what keeps every older consumer reading it correctly.
const maxRoleField = (result) => result.layers.reduce((maximum, layer) => {
  for (let i = 0; i < layer.paths.length; i += 8) maximum = Math.max(maximum, layer.paths[i+3])
  return maximum
}, 0)
ok(maxRoleField(rWedgeCleared) < 16 && maxRoleField(rCube) < 16,
   `single-material streams stay bare role values (max role field ${maxRoleField(rCube)} < 16)`)
ok(maxRoleField(rWedge) >= 16, `the painted stream does carry the tool channel (max role field ${maxRoleField(rWedge)})`)

// (2b) The eraser: writing NONE over a brushed region returns those facets to the default extruder — exactly what
//      upstream does (slicer/src/slic3r/GUI/Gizmos/GLGizmoPainterBase.cpp ~732-748: new_state starts at NONE and a
//      shift+drag hands it straight to select_patch). Measured on the kernel as it shipped before this: painting
//      state 3 and then "painting" state 0 over it with radius 60 left the count at 3006 — the erase never reached
//      select_patch, because the bridge's one shared state predicate rejected 0 ahead of it.
const eraseSlope = (wedgeIndex, radius) => Module.selector_erase(
  wedgeIndex * WEDGE_FACETS + WEDGE_SLOPE_FACET,
  wedgeIndex * WEDGE_PITCH + 10, 10, 15,
  wedgeIndex * WEDGE_PITCH + 10, 10, 60, radius)
Module.selector_prepare(new Uint8Array(wedge1))
Module.selector_clear()
Module.selector_prepare(new Uint8Array(wedge1))
paintSlope(0, 2)
const facetsBeforeErase = Module.selector_painted_count_state(2)
// How much of the painted face still reaches the layers it covers. Under the exact segmentation a fully painted
//  slope already leaves those layers split (the slope is one side of the cross-section), so "a layer gained a
//  second tool" no longer tells an erase from a paint. What an erase must do is take AREA away from the painted
//  extruder while leaving some of it, so the measure is the painted tool's own share of the layer's extrusions.
const paintedShare = (result) => {
  let painted = 0
  let total = 0
  for (const layer of result.layers) {
    if (layer.z < 10.0 - 1e-6) continue
    for (let i = 0; i < layer.paths.length; i += 8) {
      const role = ROLE_OF(layer.paths[i+3])
      if (role === 0 || role === 11) continue
      total++
      if (TOOL_OF(layer.paths[i+3]) === 1) painted++
    }
  }
  if (!total) return 0
  return painted / total
}
const shareBeforeErase = paintedShare(Module.slice(new Uint8Array(wedge1), JSON.stringify(paintParams), () => {}))
eraseSlope(0, 4)                                  // a cursor smaller than the face -> only its middle is given back
const shareAfterErase = paintedShare(Module.slice(new Uint8Array(wedge1), JSON.stringify(paintParams), () => {}))
ok(facetsBeforeErase > 0 && shareAfterErase < shareBeforeErase && shareAfterErase > 0,
   `a partial erase gives the middle of the region back to the default tool (painted share ${(shareBeforeErase*100).toFixed(1)}% -> ${(shareAfterErase*100).toFixed(1)}%)`)
// Two things a partial erase does NOT do, both measured and both easy to misread as a regression:
//  - the facet COUNT rises (4 -> 1768 here, 3006 -> 3892 on the table fixture), because the cursor boundary splits
//    the painted triangles and what survives is more and smaller facets;
//  - the filament totals rise with it (T1 249.0 -> 1622.0mm), because a region cut into small pieces costs far more
//    perimeter. Overpainting the same circle with a different extruder instead of erasing produces the SAME 1768
//    facets and the SAME 1622.0mm, which is what says both figures belong to the split and not to the erase.
// Zero facets is therefore only meaningful after an erase that covers the whole brushed region:
eraseSlope(0, 16)                                 // the same radius the paint used -> the whole face is given back
ok(Module.selector_painted_count_state(2) === 0,
   `erasing the whole brushed region clears every painted facet (${facetsBeforeErase} -> ${Module.selector_painted_count_state(2)})`)
const rFullErase = Module.slice(new Uint8Array(wedge1), JSON.stringify(paintParams), () => {})
ok(rFullErase.gcode === rWedgeClean.gcode, `a fully erased model slices byte-identically to the never-painted one`)
// The hazard the erase had to be routed around: embind turns a JS `false` into the int 0 == NONE, so the
//  state-addressed entry point ignores 0 outright and only selector_erase — which has no state argument for a
//  boolean to become — can clear anything. Without this the blocker brush's `false` would erase instead of paint.
paintSlope(0, 2)
const facetsBeforeBoolean = Module.selector_painted_count_state(2)
Module.selector_paint_state(WEDGE_SLOPE_FACET, 10, 10, 15, 10, 10, 60, 16, false)
ok(facetsBeforeBoolean > 0 && Module.selector_painted_count_state(2) === facetsBeforeBoolean,
   `a boolean on the state path still cannot erase (${facetsBeforeBoolean} facets unchanged)`)
Module.selector_clear()

// (3) An enclosed painted surface colours the layers it is actually part of, and nothing above them. The exact
//     segmentation partitions each layer's own CONTOUR, so a surface that has ended by layer z cannot claim any of
//     it — there is no facet of it on that outline to claim it with. (The volume projector this replaced had a
//     priority rule for exactly this case, because its slabs DID overlap; segmentation makes the regions disjoint
//     by construction, so the rule has nothing left to arbitrate and is gone.)
const overlapSTL = makeOverlapSTL()
const paintOverlap = (legState, capState, legFirst) => {
  Module.selector_prepare(new Uint8Array(overlapSTL))
  Module.selector_clear()
  Module.selector_prepare(new Uint8Array(overlapSTL))
  const leg = () => Module.selector_paint_state(OVERLAP_LEG_FACET, 10, 10, 10.15, 10, 10,  50,  5, legState)
  const cap = () => Module.selector_paint_state(OVERLAP_CAP_FACET, 10, 10, 10.15, 10, 10, -40, 20, capState)
  if (legFirst) {
    leg()
    cap()
  } else {
    cap()
    leg()
  }
  return Module.slice(new Uint8Array(overlapSTL), JSON.stringify({ ...params, extruder_count: 3 }), () => {})
}
const rOverlapHighLeg = paintOverlap(3, 2, true)      // the leg (the smaller, enclosed area) carries Extruder3
const highLegLayer = rOverlapHighLeg.layers.find(layer => Math.abs(layer.z - OVERLAP_Z) < 1e-6)
const boxT2 = toolBoxOf(highLegLayer, 2)
const boxT1 = toolBoxOf(highLegLayer, 1)
// The leg (Extruder3 -> T2) stops at z=10.15, so on the z=10.4 layer — which is pure cap — it owns nothing.
ok(boxT2.n === 0, `the enclosed leg claims nothing on a layer it no longer reaches (T2 segments ${boxT2.n})`)
ok(boxT1.n > 0 && boxT1.x0 < 1 && boxT1.x1 > 19,
   `the surface that IS on that outline owns it: T1 spans the 20x20 cap (x[${boxT1.x0.toFixed(2)},${boxT1.x1.toFixed(2)}])`)
// Where the leg does exist it keeps its own 6x6 footprint — the paint is confined to the geometry that carries it.
const legMidLayer = rOverlapHighLeg.layers.find(layer => Math.abs(layer.z - 8.0) < 1e-6)
const legT2 = toolBoxOf(legMidLayer, 2)
ok(legT2.n > 0 && legT2.x0 > 6.4 && legT2.x1 < 13.6 && legT2.y0 > 6.4 && legT2.y1 < 13.6,
   `and on a layer it does reach, it stays inside the 6x6 leg (x[${legT2.x0.toFixed(2)},${legT2.x1.toFixed(2)}])`)
// Swap which surface carries which extruder: the winner follows the extruder NUMBER, not the surface or the order.
const rOverlapHighCap = paintOverlap(2, 3, true)
const highCapLayer = rOverlapHighCap.layers.find(layer => Math.abs(layer.z - OVERLAP_Z) < 1e-6)
ok(modelToolsOf(highCapLayer).join() === '2' && toolBoxOf(highCapLayer, 2).x1 > 19,
   `with Extruder3 on the enclosing surface the whole overlap layer is T2 (tools=${modelToolsOf(highCapLayer)})`)
// What the priority rule promises is that the TOOL ASSIGNMENT is order-independent, not that the G-code is
//  byte-identical. It cannot be: TriangleSelector subdivides a facet as it is painted, so brushing the leg before
//  the cap leaves a different split tree than the reverse, and a slightly different split projects to slightly
//  different region polygons (measured: same facet counts 12/2226 either way, identical per-layer tool sets and
//  identical filament to 3 decimals, but ~650 characters of G-code apart). Assert the promise, not the bytes.
const layerToolsOf = (result) => result.layers.map(modelToolsOf).map(tools => tools.join('/')).join(',')
const rOverlapCapFirst = paintOverlap(3, 2, false)
ok(layerToolsOf(rOverlapCapFirst) === layerToolsOf(rOverlapHighLeg),
   `which tool owns which layer does not depend on the order the two extruders were painted in`)
ok(Math.abs(rOverlapCapFirst.stats.filament_mm - rOverlapHighLeg.stats.filament_mm) < 1e-3,
   `and neither does how much of each filament it takes (${rOverlapHighLeg.stats.filament_mm.toFixed(3)} mm)`)
ok(paintOverlap(3, 2, true).gcode === rOverlapHighLeg.gcode, `the same paint slices to the same G-code twice`)

// (4) Per-layer tool ordering: a layer's regions are grouped by tool, so a tool is entered ONCE per layer.
//     Three wedges in one triangle group; #0 and #2 painted -> T1 owns two regions that are far apart in x, and
//     emitting them in geometric order would purge through the prime tower twice on every single layer.
const wedge3 = makeWedgeSTL(3)
Module.selector_prepare(new Uint8Array(wedge3))
Module.selector_clear()
Module.selector_prepare(new Uint8Array(wedge3))
paintSlope(0, 2)
paintSlope(2, 2)
const rWedge3 = Module.slice(new Uint8Array(wedge3), JSON.stringify(paintParams), () => {})
const layerBlocks = rWedge3.gcode.split(/^; LAYER /m).slice(1)
let repeatedToolLayers = 0
let maxToolCommands = 0
for (const block of layerBlocks) {
  const tools = [...block.matchAll(/^T(\d+)$/gm)].map(match => match[1])
  maxToolCommands = Math.max(maxToolCommands, tools.length)
  if (new Set(tools).size !== tools.length) repeatedToolLayers++
}
ok(layerBlocks.length > 50 && repeatedToolLayers === 0 && maxToolCommands <= 1,
   `no layer enters a tool twice (${layerBlocks.length} layers, at most ${maxToolCommands} tool change per layer)`)
const middleLayer = rWedge3.layers.find(layer => Math.abs(layer.z - 15.0) < 1e-6)
const midT1 = toolBoxOf(middleLayer, 1)
const midT0 = toolBoxOf(middleLayer, 0)
ok(midT1.x0 < WEDGE_PITCH && midT1.x1 > 2 * WEDGE_PITCH,
   `T1 really does hold two separate regions on that one entry (x[${midT1.x0.toFixed(1)},${midT1.x1.toFixed(1)}] spans wedge 0 and wedge 2)`)
// The middle wedge is untouched, so nothing of it may be printed with the painted tool. T0's own bounding box no
//  longer isolates it — under the exact segmentation T0 also owns the unpainted sides of wedges 0 and 2 — so the
//  claim is made per segment instead: inside the middle wedge's x band there must be T0 extrusions and no T1 ones.
const inMiddleWedge = (layer, tool) => {
  let count = 0
  for (let i = 0; i < layer.paths.length; i += 8) {
    const role = ROLE_OF(layer.paths[i+3])
    if (role === 0 || role === 11) continue
    if (TOOL_OF(layer.paths[i+3]) !== tool) continue
    const x = layer.paths[i]
    if (x > WEDGE_PITCH && x < 2 * WEDGE_PITCH) count++
  }
  return count
}
ok(inMiddleWedge(middleLayer, 0) > 0 && inMiddleWedge(middleLayer, 1) === 0,
   `the unpainted wedge keeps the group's own tool (T0 ${inMiddleWedge(middleLayer, 0)} segments there, T1 ${inMiddleWedge(middleLayer, 1)})`)
Module.selector_clear()   // leave the selector clean for whatever runs after this section

// support_filament / support_interface_filament (upstream coInt, 0 = "Default" = keep the loaded tool).
const rSupportFilamentNone = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supportParams, support_filament: 0, support_interface_filament: 0 }), () => {})
ok(rSupportFilamentNone.gcode === rSupport.gcode, `support_filament=0 leaves the support G-code byte-identical`)
ok(!/^T\d+$/m.test(rSupport.gcode), `default support emits no tool change at all`)
// filament index 2 -> tool T1 for both the base and the interface
const rSupportFilamentT1 = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supportParams, support_filament: 2, support_interface_filament: 2 }), () => {})
ok(/^T1$/m.test(rSupportFilamentT1.gcode), `support_filament=2 prints support with T1`)
ok(/^T0$/m.test(rSupportFilamentT1.gcode), `and switches back to the object tool afterwards`)
// The default support_style=grid goes through the upstream port, which emits one support body (supportTree) — so the
//  interface/base split, and with it a separate interface filament, only exists on the kernel's own grid path.
const kernelGridSupportParams = { ...supportParams, support_style: 'grid_kernel' }
const rSupportFilamentSplit = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...kernelGridSupportParams, support_filament: 3, support_interface_filament: 2 }), () => {})
ok(/^T2$/m.test(rSupportFilamentSplit.gcode) && /^T1$/m.test(rSupportFilamentSplit.gcode),
   `base and interface can use different filaments (T2 base / T1 interface)`)
const supportFirstLines = (rSupportFilamentSplit.gcode.split(/^; support$/m)[1] ?? '').split('\n')
ok(/^T[12]$/.test(supportFirstLines[1] ?? ''), `the tool change opens the support block (line after "; support" = ${JSON.stringify(supportFirstLines[1])})`)
const rKernelGridSupportNone = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(kernelGridSupportParams), () => {})
ok(!/^T\d+$/m.test(rKernelGridSupportNone.gcode), `the same path with the default 0 emits no tool change`)

// Backwards compatible: with every stage-6 parameter at its default, the cube result is unchanged
const rStage6Defaults = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({
  ...params, ironing_type: 'no ironing', reduce_crossing_wall: false, max_volumetric_extrusion_rate_slope: 0, extruder_count: 1,
}), () => {})
ok(rStage6Defaults.stats.layers === rCube.stats.layers && Math.abs(rStage6Defaults.stats.filament_mm - rCube.stats.filament_mm) < 1e-6,
   'stage-6 defaults keep cube result unchanged (backward compatible)')

// ===== Exact per-layer segmentation (the ported MultiMaterialSegmentation) ==========================================
//  What it replaced laid a painted facet's XY shadow over every slicing plane the facet spanned, so a small patch
//  came out as the whole band of layers it crossed, and a horizontal face came out as a slab. These check the two
//  properties that costs bought: a patch keeps its own OUTLINE, and a flat face lands in its SHELL.
console.log('\n[segmentation]')
const segmentationBox = makeBoxSTL(20, 20, 20)             // kernel coords: x,y in [0,20], z in [0,20]
const segmentationParams = { ...params, extruder_count: 3 }
const segmentationToolLayers = (result, tool) => {
  const layerZs = []
  for (const layer of result.layers) for (let i = 0; i < layer.paths.length; i += 8) {
    const role = ROLE_OF(layer.paths[i+3])
    if (role === 0 || role === 11) continue
    if (TOOL_OF(layer.paths[i+3]) === tool) {
      layerZs.push(+layer.z.toFixed(2))
      break
    }
  }
  return layerZs
}
// (1) A 5mm brush patch on one wall keeps its own footprint: it may not spread across the layer, and it may not
//     spread onto the other walls. Measured before this: T1 covered the full 0.2..19.8 extent of every layer it
//     touched, because the shadow of a wall facet is the whole wall.
Module.selector_prepare(new Uint8Array(segmentationBox))
Module.selector_paint_state(6, 20, 5, 5, 60, 5, 5, 5, 2)      // facet 6 = the x=20 wall, patch centred at (20,5,5)
const rSegmentationPatch = Module.slice(new Uint8Array(segmentationBox), JSON.stringify(segmentationParams), () => {})
const patchLayers = segmentationToolLayers(rSegmentationPatch, 1)
const patchBox = rSegmentationPatch.layers.filter(layer => Math.abs(layer.z - 5.0) < 1e-6).map(layer => toolBoxOf(layer, 1))[0]
ok(patchLayers.length > 0 && patchLayers[patchLayers.length - 1] < 11,
   `a wall patch stays within the layers it spans (T1 on z ${patchLayers[0]}..${patchLayers[patchLayers.length-1]})`)
ok(patchBox.n > 0 && patchBox.x0 > 9 && patchBox.y1 < 11,
   `and within its own corner of those layers (x[${patchBox.x0.toFixed(1)},${patchBox.x1.toFixed(1)}] y[${patchBox.y0.toFixed(1)},${patchBox.y1.toFixed(1)}])`)

// (2) Two patches on opposite walls stay two separate regions — the segmentation partitions the contour, so the
//     extruders are disjoint without any priority rule deciding between them.
Module.selector_prepare(new Uint8Array(segmentationBox))
Module.selector_paint_state(6, 20, 5, 5, 60, 5, 5, 5, 2)      // x=20 wall, low
Module.selector_paint_state(8, 5, 20, 15, 5, 60, 15, 5, 3)    // y=20 wall, high
const rSegmentationTwo = Module.slice(new Uint8Array(segmentationBox), JSON.stringify(segmentationParams), () => {})
const twoT1 = segmentationToolLayers(rSegmentationTwo, 1)
const twoT2 = segmentationToolLayers(rSegmentationTwo, 2)
ok(twoT1.length > 0 && twoT2.length > 0 && twoT1[twoT1.length-1] < twoT2[0],
   `two patches at different heights keep their own layers (T1 ..${twoT1[twoT1.length-1]}, T2 ${twoT2[0]}..)`)
const twoLow = rSegmentationTwo.layers.find(layer => Math.abs(layer.z - 5.0) < 1e-6)
const twoHigh = rSegmentationTwo.layers.find(layer => Math.abs(layer.z - 15.0) < 1e-6)
ok(toolBoxOf(twoLow, 1).x0 > 9 && toolBoxOf(twoHigh, 2).y0 > 9,
   `and their own corners (low patch x0 ${toolBoxOf(twoLow,1).x0.toFixed(1)}, high patch y0 ${toolBoxOf(twoHigh,2).y0.toFixed(1)})`)

// (3) A flat outer face lands in its SHELL, not in a slab: the number of layers it colours is exactly the shell
//     count. This is the pass upstream calls segmentation_top_and_bottom_layers, and it is what makes painting a
//     top surface mean anything at all — a horizontal facet cuts no slicing plane, so nothing else can carry it.
for (const [label, facet, hitZ, key] of [
  ['top', 2, 20, 'top_shell_layers'], ['bottom', 0, 0, 'bottom_shell_layers'],
]) {
  Module.selector_prepare(new Uint8Array(segmentationBox))
  Module.selector_seed_fill(facet, 10, 10, hitZ, 30, 2)      // smart fill: exactly the two facets of that face
  const rShell = Module.slice(new Uint8Array(segmentationBox), JSON.stringify({ ...segmentationParams, extruder_count: 2 }), () => {})
  const shellLayers = segmentationToolLayers(rShell, 1)
  ok(shellLayers.length === segmentationParams[key],
     `a painted ${label} face colours exactly ${key}=${segmentationParams[key]} layers (got ${shellLayers.length}: ${shellLayers.join(' ')})`)
}

// (4) The shell pass is not only about the model's outermost faces: an overhang's UNDERSIDE is a bottom surface
//     too, and painting it has to reach the bottom shell printed against the air below it. Same fixture as the
//     support tests — a 6x6 leg carrying a 20x20 cap — so the painted face is genuinely interior to the model's
//     bounding box while still being a real bottom surface.
//     (Note for anyone probing this by hand: the face must be wound the way an STL winds it. A bottom face given
//      counter-clockwise reads as an UPWARD facing one, lands in the top projection, and is then occluded away by
//      the layer above — which looks exactly like the paint being ignored.)
const overhang = makeTableSTL()
const overhangShell = (facet, hitZ) => {
  Module.selector_prepare(new Uint8Array(overhang))
  Module.selector_seed_fill(facet, 10, 10, hitZ, 30, 2)
  return segmentationToolLayers(Module.slice(new Uint8Array(overhang), JSON.stringify({ ...params, extruder_count: 2 }), () => {}), 1)
}
const capTopLayers = overhangShell(14, 14)
const capUnderLayers = overhangShell(12, 10)
ok(capTopLayers.length === params.top_shell_layers,
   `the cap's TOP face colours its top shell (${capTopLayers.length} layers: ${capTopLayers.join(' ')})`)
ok(capUnderLayers.length === params.bottom_shell_layers && capUnderLayers[0] > 10,
   `and its UNDERSIDE the bottom shell printed against the air (${capUnderLayers.length} layers: ${capUnderLayers.join(' ')})`)
Module.selector_clear()

// ===== Per-feature filament ids · filament_map · per-tool purge ====================================================
console.log('\n[filament assignment]')
const featureBox = makeBoxSTL(20, 20, 20)
const featureParams = { ...params, extruder_count: 2 }
const toolsOfRole = (result, role) => {                    // which tools printed a given role, over the whole result
  const tools = new Set()
  for (const layer of result.layers) for (let i = 0; i < layer.paths.length; i += 8)
    if (ROLE_OF(layer.paths[i+3]) === role) tools.add(TOOL_OF(layer.paths[i+3]))
  return [...tools].sort()
}
Module.selector_clear()
// (1) An unset id changes nothing: 0 is upstream's "Default", and 1 is the default extruder itself, so neither adds
//     a second tool and neither may reach the multi-tool path.
const rFeatureNone = Module.slice(new Uint8Array(featureBox), JSON.stringify(featureParams), () => {})
const rFeatureOne  = Module.slice(new Uint8Array(featureBox), JSON.stringify({ ...featureParams, outer_wall_filament_id: 1 }), () => {})
ok(rFeatureOne.gcode === rFeatureNone.gcode, `filament id 1 (the default extruder) leaves the G-code byte-identical`)

// (2) outer_wall_filament_id=2 moves the OUTER WALL to T1 and nothing else. Walls are role 1 and infill role 2, so
//     the claim is checked on the roles rather than on a bounding box.
const rOuter = Module.slice(new Uint8Array(featureBox), JSON.stringify({ ...featureParams, outer_wall_filament_id: 2 }), () => {})
ok(/^T1$/m.test(rOuter.gcode), `outer_wall_filament_id=2 reaches the multi-tool path (T1 emitted)`)
ok(toolsOfRole(rOuter, 1).join() === '0,1' && toolsOfRole(rOuter, 2).join() === '0',
   `the walls are split over both tools while the infill stays on T0 (walls ${toolsOfRole(rOuter,1)}, infill ${toolsOfRole(rOuter,2)})`)

// (3) sparse_infill_filament_id=2 moves the INFILL instead — the mirror image, which is what says the id is read
//     per feature and not just "something switched tools".
const rInfill = Module.slice(new Uint8Array(featureBox), JSON.stringify({ ...featureParams, sparse_infill_filament_id: 2 }), () => {})
ok(toolsOfRole(rInfill, 2).join() === '1' && toolsOfRole(rInfill, 1).join() === '0',
   `sparse_infill_filament_id=2 moves only the infill (walls ${toolsOfRole(rInfill,1)}, infill ${toolsOfRole(rInfill,2)})`)

// (4) The surface ids reach the solid infill now that this path detects shells. Solid is role 3, so the claim is
//     checked on the role rather than on the comment that used to say the id was ignored.
const rSurface = Module.slice(new Uint8Array(featureBox), JSON.stringify({ ...featureParams, top_surface_filament_id: 2 }), () => {})
ok(toolsOfRole(rSurface, 3).join() === '1' && toolsOfRole(rSurface, 1).join() === '0',
   `a surface filament id moves the solid infill and nothing else (solid ${toolsOfRole(rSurface,3)}, walls ${toolsOfRole(rSurface,1)})`)

// (5) filament_map: two filaments in ONE physical extruder still purge; in two extruders they never mix, so the
//     tower is skipped entirely. Without the option nothing changes — that is what keeps every existing slice safe.
const mapped = (map) => {
  const mappedParams = { ...featureParams, outer_wall_filament_id: 2 }
  if (map) mappedParams.filament_map = map
  return Module.slice(new Uint8Array(featureBox), JSON.stringify(mappedParams), () => {})
}
const rNoMap = mapped(null)
const rSameNozzle = mapped([1, 1])
const rTwoNozzles = mapped([1, 2])
// The map itself is echoed in the header, so the comparison is against everything below it: what must not change
//  is the PRINT — same tool changes, same purges, same extrusions.
const withoutMapHeader = (gcode) => gcode.split('\n').filter(line => !line.startsWith('; MM filament_map')).join('\n')
ok(withoutMapHeader(rSameNozzle.gcode) === rNoMap.gcode,
   `filament_map with both filaments on one extruder changes nothing but the header line that records it`)
ok(rNoMap.stats.filament_mm_purge > 0 && rTwoNozzles.stats.filament_mm_purge === 0,
   `two filaments on separate extruders need no purge at all (${rNoMap.stats.filament_mm_purge.toFixed(1)} -> ${rTwoNozzles.stats.filament_mm_purge.toFixed(1)} mm)`)
ok(/^; MM filament_map/m.test(rTwoNozzles.gcode), `and the map is written into the G-code header`)

// (6) Per-tool purge, so a caller can show upstream's Model/Tower split instead of one number that belongs to
//     nobody. It is a subset of filament_mm_by_tool, so model = by_tool - purge_by_tool must stay non-negative.
const purgeByTool = rNoMap.stats.filament_mm_purge_by_tool
ok(Array.isArray(purgeByTool) && purgeByTool.length === 2,
   `the kernel reports purge per tool (${JSON.stringify(purgeByTool)})`)
ok(Math.abs(purgeByTool.reduce((sum, value) => sum + value, 0) - rNoMap.stats.filament_mm_purge) < 1e-6,
   `the per-tool purge sums to the purge total (${purgeByTool.reduce((sum, value)=>sum+value,0).toFixed(3)} vs ${rNoMap.stats.filament_mm_purge.toFixed(3)})`)
ok(rNoMap.stats.filament_mm_by_tool.every((total, tool) => total - purgeByTool[tool] > -1e-6),
   `and never exceeds that tool's own total, so model = total - tower stays a real figure`)

// ===== Filament identity in the G-code (upstream GCode.cpp footer) ==================================================
//  Upstream always writes the per-filament totals and a config dump; here both are opt-in so the default output the
//  golden guard pins cannot move. These check that the opt-in produces upstream's shape, and that leaving it off
//  produces the byte-identical G-code it always did.
console.log('\n[filament identity]')
const identityBox = makeBoxSTL(20, 20, 20)
const identityBase = { ...params, extruder_count: 2, outer_wall_filament_id: 2 }
Module.selector_clear()
const rPlain = Module.slice(new Uint8Array(identityBox), JSON.stringify(identityBase), () => {})
ok(!/CONFIG_BLOCK_START/.test(rPlain.gcode) && !/filament used \[mm\]/.test(rPlain.gcode),
   `the footer blocks are off by default, so existing output is untouched`)

const identityFull = { ...identityBase, gcode_stats_block: true, gcode_config_block: true,
                 filament_type: ['PLA', 'ABS'], filament_settings_id: ['Generic PLA @X1', 'Generic ABS @X1'],
                 filament_density: [1.24, 1.04], filament_cost: [20, 30] }
const rFull = Module.slice(new Uint8Array(identityBox), JSON.stringify(identityFull), () => {})
const line = (pattern) => (rFull.gcode.match(pattern) ?? [])[0] ?? ''
ok(/^; filament used \[mm\] = [\d.]+, [\d.]+$/m.test(rFull.gcode),
   `per-filament millimetres, comma separated like upstream (${line(/^; filament used \[mm\].*$/m)})`)
ok(/^; filament used \[cm3\] = /m.test(rFull.gcode) && /^; filament used \[g\] = /m.test(rFull.gcode),
   `volume and weight too (${line(/^; filament used \[g\].*$/m)})`)
ok(/^; total filament used \[g\] = [\d.]+$/m.test(rFull.gcode) && /^; total filament cost = [\d.]+$/m.test(rFull.gcode),
   `totals for weight and cost (${line(/^; total filament cost.*$/m)})`)
ok(/^; total filament change = \d+$/m.test(rFull.gcode),
   `and the tool change count (${line(/^; total filament change.*$/m)})`)
ok(/^; filament 1 = PLA \(Generic PLA @X1\)$/m.test(rFull.gcode) && /^; filament 2 = ABS \(Generic ABS @X1\)$/m.test(rFull.gcode),
   `each filament says what material it is, not just how much it used`)
// Weight has to follow the density it was given, or the number is decoration.
const grams = (rFull.gcode.match(/^; filament used \[g\] = ([\d.]+), ([\d.]+)$/m) ?? []).slice(1).map(Number)
const millimetres = (rFull.gcode.match(/^; filament used \[mm\] = ([\d.]+), ([\d.]+)$/m) ?? []).slice(1).map(Number)
const area  = Math.PI * params.filament_diameter * params.filament_diameter / 4
ok(grams.length === 2 && Math.abs(grams[0] - millimetres[0] * area * 0.001 * 1.24) < 0.02
                      && Math.abs(grams[1] - millimetres[1] * area * 0.001 * 1.04) < 0.02,
   `weight is derived from that filament's own density (${grams.join(', ')} g)`)
// The config block has to be delimited and carry the values the slice ran with.
ok(/^; CONFIG_BLOCK_START$/m.test(rFull.gcode) && /^; CONFIG_BLOCK_END$/m.test(rFull.gcode),
   `the config dump is delimited the way upstream delimits its own`)
// The value is copied out of the params JSON verbatim, so its spacing is whatever the host serialised — the claim
//  is that the array survives as an array, not that it is re-formatted.
ok(/^; layer_height = 0\.2$/m.test(rFull.gcode) && /^; filament_type = \["PLA",\s*"ABS"\]$/m.test(rFull.gcode),
   `and holds the parameters, arrays included (${line(/^; filament_type = .*$/m)})`)
ok(!/^; \S+ = [^\n]*\n[^;]/m.test(rFull.gcode), `every config entry stays one comment line`)

// PETG is upstream's one material that changes the tool change itself (GCode.cpp:1321).
const rPetg = Module.slice(new Uint8Array(identityBox), JSON.stringify({ ...identityBase, filament_type: ['PLA', 'PETG'] }), () => {})
const rNoPetg = Module.slice(new Uint8Array(identityBox), JSON.stringify({ ...identityBase, filament_type: ['PLA', 'ABS'] }), () => {})
ok(/PETG extra unretract/.test(rPetg.gcode) && !/PETG extra unretract/.test(rNoPetg.gcode),
   `a tool change to PETG unretracts extra, and only for PETG`)
ok(rNoPetg.gcode === rPlain.gcode, `naming a material that needs no special handling changes nothing`)
// TPU on the first layer is a fact the machine's start G-code needs.
const rTpu = Module.slice(new Uint8Array(identityBox), JSON.stringify({ ...identityBase, filament_type: ['TPU', 'ABS'] }), () => {})
ok(/^; has_tpu_in_first_layer = 1$/m.test(rTpu.gcode) && !/has_tpu_in_first_layer/.test(rNoPetg.gcode),
   `TPU in the print is surfaced, and only when there is TPU`)

// ===== Purging volumes: the tower is sized from the filament pair ===================================================
//  Upstream computes the purge from flush_volumes_matrix — the volume needed to go from filament i to filament j —
//  so a dark colour following a light one costs more than a change between two similar ones. Without a table the
//  tower was a fixed three loops whatever the pair, which is either waste or not enough.
console.log('\n[purging volumes]')
const purgeBox = makeBoxSTL(20, 20, 20)
const purgeBase = { ...params, extruder_count: 2, outer_wall_filament_id: 2, wipe_tower_real: false }
Module.selector_clear()
const slicePurge = (extra) => Module.slice(new Uint8Array(purgeBox), JSON.stringify({ ...purgeBase, ...extra }), () => {})
const rNoTable = slicePurge({})
ok(/no purge table, fixed size/.test(rNoTable.gcode),
   `without a table the tower keeps its fixed size, and says so`)
// A small table and a large one, same model: the tower has to grow with the volume it is asked to purge.
const rSmall = slicePurge({ flush_volumes_matrix: [0, 40, 40, 0] })
const rLarge = slicePurge({ flush_volumes_matrix: [0, 400, 400, 0] })
ok(rLarge.stats.filament_mm_purge > rSmall.stats.filament_mm_purge * 1.3,
   `a bigger purging volume builds a bigger tower (${rSmall.stats.filament_mm_purge.toFixed(1)} -> ${rLarge.stats.filament_mm_purge.toFixed(1)} mm)`)
// …up to what the footprint can hold. A 15mm ring saturates long before 400mm³ per change, and the honest
//  response is to say the tower is too small rather than to under-purge in silence.
ok(/WARNING: the tower footprint is too small/.test(rLarge.gcode) && !/too small/.test(rSmall.gcode),
   `and reports the footprint as the limit once the ring closes on itself`)
const loopsOf = (result) => Number((result.gcode.match(/^; prime tower \(ring, (\d+) loops/m) ?? [])[1] ?? 0)
ok(loopsOf(rSmall) > 0 && loopsOf(rLarge) > loopsOf(rSmall),
   `and the ring reports how many loops that took (${loopsOf(rSmall)} -> ${loopsOf(rLarge)})`)
// The multiplier and the per-change prime volume are upstream's two scalars on top of the table.
const rMultiplied = slicePurge({ flush_volumes_matrix: [0, 40, 40, 0], flush_multiplier: 10 })
ok(rMultiplied.stats.filament_mm_purge > rSmall.stats.filament_mm_purge,
   `flush_multiplier scales the whole table (${rSmall.stats.filament_mm_purge.toFixed(1)} -> ${rMultiplied.stats.filament_mm_purge.toFixed(1)} mm)`)
const rPrimed = slicePurge({ flush_volumes_matrix: [0, 40, 40, 0], prime_volume: 200 })
ok(rPrimed.stats.filament_mm_purge > rSmall.stats.filament_mm_purge,
   `prime_volume adds to every change (${rPrimed.stats.filament_mm_purge.toFixed(1)} mm)`)
// A table too small to index must not be read — a two-filament print needs a 2x2 table.
const rShort = slicePurge({ flush_volumes_matrix: [0, 40] })
ok(rShort.gcode === rNoTable.gcode, `a table that cannot be indexed is ignored rather than half-read`)

// ===== Turning the prime tower off ==================================================================================
//  Upstream's own default is enable_prime_tower=false, because it can send the purge into the model instead. This
//  kernel keeps the tower on by default (it had nowhere else to put a purge until now), so what matters is that
//  turning it off really removes it, and that the alternative destination actually absorbs the material.
console.log('\n[tower off]')
const offBox = makeBoxSTL(20, 20, 20)
const offBase = { ...params, extruder_count: 2, outer_wall_filament_id: 2, wipe_tower_real: false,
                  flush_volumes_matrix: [0, 140, 140, 0] }
Module.selector_clear()
const sliceOff = (extra) => Module.slice(new Uint8Array(offBox), JSON.stringify({ ...offBase, ...extra }), () => {})
const rTowerOn = sliceOff({})
const rTowerOff = sliceOff({ enable_prime_tower: false })
ok(typeTotal(rTowerOn, 11) > 0, `the tower is on by default (${typeTotal(rTowerOn, 11)} tower segments)`)
ok(typeTotal(rTowerOff, 11) === 0, `enable_prime_tower=false removes every tower segment, sustain rings included`)
ok(rTowerOff.stats.filament_mm_purge === 0 && rTowerOff.stats.filament_mm < rTowerOn.stats.filament_mm,
   `and the purge with it (${rTowerOn.stats.filament_mm.toFixed(1)} -> ${rTowerOff.stats.filament_mm.toFixed(1)} mm)`)
ok(/WARNING: prime tower disabled and no flush destination/.test(rTowerOff.gcode),
   `with nowhere for the purge to go, the G-code says the colour will carry into the model`)

// Flushing into the infill: the purge becomes sparse infill printed by the tool that just took over. The material
//  is not saved — it is moved somewhere it is not seen — so the print does not get lighter, it gets a tower fewer.
const rFlush = sliceOff({ enable_prime_tower: false, flush_into_infill: true })
ok(typeTotal(rFlush, 11) === 0 && /purge goes into the model's sparse infill/.test(rFlush.gcode),
   `flush_into_infill replaces the tower rather than adding to it`)
ok(!/WARNING: prime tower disabled and no flush destination/.test(rFlush.gcode),
   `and the warning is gone once the purge has a destination`)
// The diverted lines are printed by the NEW tool: that tool's share has to grow against the no-flush case.
const toolShare = (result, tool) => (result.stats.filament_mm_by_tool ?? [])[tool] ?? 0
ok(toolShare(rFlush, 1) > toolShare(rTowerOff, 1),
   `the purging tool prints the diverted infill (T2 ${toolShare(rTowerOff,1).toFixed(1)} -> ${toolShare(rFlush,1).toFixed(1)} mm)`)
// Total extrusion is unchanged by WHERE the infill is printed — the lines were going to be laid either way.
ok(Math.abs(rFlush.stats.filament_mm - rTowerOff.stats.filament_mm) < rTowerOff.stats.filament_mm * 0.05,
   `and moving infill between tools does not change how much is extruded (${rTowerOff.stats.filament_mm.toFixed(1)} vs ${rFlush.stats.filament_mm.toFixed(1)} mm)`)

// ===== Wipe tower: both towers are reproducible =====================================================================
//  A slicer whose output changes between identical runs cannot be diffed, and an F0 feedrate is not something a
//  printer accepts. The fallback ring ships by default; the real tower is opt-in and must meet the same bar.
console.log('\n[wipe tower]')
const towerBox = makeBoxSTL(20, 20, 20)
const towerParams = { ...params, extruder_count: 2, outer_wall_filament_id: 2 }
const sliceTower = (real) => Module.slice(new Uint8Array(towerBox), JSON.stringify({ ...towerParams, wipe_tower_real: real }), () => {})
Module.selector_clear()
const ringRuns = [sliceTower(false), sliceTower(false), sliceTower(false)]
ok(ringRuns[0].gcode === ringRuns[1].gcode && ringRuns[1].gcode === ringRuns[2].gcode,
   `the fallback ring gives the same G-code every run`)
ok(!/ F0$/m.test(ringRuns[0].gcode), `and never emits an F0 feedrate`)
ok(!/wipe_tower_real/.test(JSON.stringify(params)) && !/real ported WipeTower/.test(ringRuns[0].gcode),
   `the kernel default is the deterministic ring, so an unconfigured caller gets reproducible output`)
const realRuns = [sliceTower(true), sliceTower(true), sliceTower(true)]
ok(realRuns.every(run => Math.abs(run.stats.filament_mm - realRuns[0].stats.filament_mm) < 1e-6),
   `the real tower is stable in WHAT it extrudes (${realRuns[0].stats.filament_mm.toFixed(4)} mm every run)`)
// Issue #69 (cause and fix in config_bridge.cpp wipe_tower_block) showed on the overlap fixture with three
//  extruders, and not on the two-extruder cube above.
const towerRun = () => {
  Module.selector_prepare(new Uint8Array(overlapSTL))
  Module.selector_clear()
  Module.selector_prepare(new Uint8Array(overlapSTL))
  Module.selector_paint_state(OVERLAP_LEG_FACET, 10, 10, 10.15, 10, 10, 50, 5, 3)
  Module.selector_paint_state(OVERLAP_CAP_FACET, 10, 10, 10.15, 10, 10, -40, 20, 2)
  return Module.slice(new Uint8Array(overlapSTL), JSON.stringify({ ...params, extruder_count: 3, wipe_tower_real: true }), () => {})
}
const towerRuns = [towerRun(), towerRun(), towerRun()]
const f0Counts = towerRuns.map(run => (run.gcode.match(/ F0$/gm) ?? []).length)
const reproducible = towerRuns[0].gcode === towerRuns[1].gcode && towerRuns[1].gcode === towerRuns[2].gcode
ok(towerRuns.every(run => Math.abs(run.stats.filament_mm - towerRuns[0].stats.filament_mm) < 1e-6),
   `and stable in its totals on the fixture that breaks it too (${towerRuns[0].stats.filament_mm.toFixed(4)} mm)`)
ok(reproducible, `the real tower gives the same G-code every run with three extruders (issue #69)`)
ok(f0Counts.every(count => count === 0), `and emits no F0 feedrate (F0 per run: ${f0Counts.join(', ')})`)
Module.selector_clear()

// ===== Grounded prime tower =========================================================================================
//  A tower that appears only on the layers that purge starts in mid-air. Measured before the fix: a patch painted
//  at z=35 on a 40mm box put the first tower ring at z=31.2 with nothing under it — unprintable. Now every layer
//  from the bed to the last purge layer carries tower material (the purge block where a change happens, a sustain
//  ring where none does), and the layers above the last change stay tower-free.
console.log('\n[grounded tower]')
const tallBox = makeBoxSTL(20, 20, 40)
Module.selector_prepare(new Uint8Array(tallBox))
Module.selector_paint_state(7, 20, 10, 35, 60, 10, 35, 4, 2)   // facet 7 = x=20 wall; a patch near the top
ok(Module.selector_painted_count_state(2) > 0, `high patch marks facets (${Module.selector_painted_count_state(2)})`)
const rTower = Module.slice(new Uint8Array(tallBox), JSON.stringify({ ...params, extruder_count: 2 }), () => {})
const towerZs = []
const changeZs = []
for (const layer of rTower.layers) {
  let tower = false
  const tools = new Set()
  for (let i = 0; i < layer.paths.length; i += 8) {
    const role = ROLE_OF(layer.paths[i+3])
    if (role === 11) tower = true
    else if (role !== 0) tools.add(TOOL_OF(layer.paths[i+3]))
  }
  if (tower) towerZs.push(+layer.z.toFixed(2))
  if (tools.size > 1) changeZs.push(+layer.z.toFixed(2))
}
ok(changeZs.length > 0 && changeZs[0] > 20, `the tool changes really are high up (first at z=${changeZs[0]})`)
ok(towerZs[0] === rTower.layers[0].z, `the tower starts on the FIRST layer (z=${towerZs[0]}), not in mid-air`)
// Continuous: every layer from the bed to the last change carries tower material — a gap is a floating slab.
const lastChange = changeZs[changeZs.length - 1]
const towerSet = new Set(towerZs)
const gaps = rTower.layers.filter(layer => layer.z <= lastChange + 1e-6 && !towerSet.has(+layer.z.toFixed(2))).length
ok(gaps === 0, `no gaps: every layer up to the last change (z=${lastChange}) carries tower material (${towerZs.length} layers)`)
ok(towerZs[towerZs.length - 1] <= lastChange + 1e-6,
   `and none above it (top tower z=${towerZs[towerZs.length - 1]} <= ${lastChange})`)
// The sustain rings are purge-account material: the per-tool purge still sums to the total, and the split the
//  stats card shows (model = by_tool - purge_by_tool) stays a real figure.
const towerPurge = rTower.stats.filament_mm_purge_by_tool
ok(Math.abs(towerPurge.reduce((sum, value) => sum + value, 0) - rTower.stats.filament_mm_purge) < 1e-6,
   `sustain rings are charged to the purge account (${rTower.stats.filament_mm_purge.toFixed(1)} mm total)`)
Module.selector_clear()

// ===== Painting tools other than the radius brush: smart fill, bucket fill, single triangle, circle cursor ======
//  All four reach the SAME selector the brush writes, so what these check is that each tool selects a different and
//  sensible set of facets — not that the resulting G-code differs, which the section above already covers.
console.log('\n[paint tools]')
const toolBox = makeBoxSTL(20, 20, 20)              // kernel coords: x,y in [0,20] (XY as-is), z in [0,20]
const TOP_FACET = 2                                 // outwardBoxTriangles order: 2,3 = top (z=20); 6,7 = the x=20 wall
const WALL_FACET = 6
const paintedTotal = () => {
  let total = 0
  for (let state = 1; state <= 16; state++) total += Module.selector_painted_count_state(state)
  return total
}
const freshSelector = () => Module.selector_prepare(new Uint8Array(toolBox))

// (1) Smart fill on a cube's top face floods the whole flat face and stops at the 90° edges: with an angle limit
//     well under 90 it can never cross onto a wall, so the result is the two top triangles and nothing else.
freshSelector()
Module.selector_seed_fill(TOP_FACET, 10, 10, 20, 30, 2)
const smartFilled = Module.selector_painted_count_state(2)
ok(smartFilled > 0, `smart fill marks the clicked face (${smartFilled} facets)`)
ok(smartFilled === paintedTotal(), `smart fill writes exactly one state (no spill into the others)`)

// (2) The same click with the angle raised past 90° crosses the cube's edges and takes the whole closed mesh —
//     the property that makes the angle a real limit rather than a decoration.
freshSelector()
Module.selector_seed_fill(TOP_FACET, 10, 10, 20, 95, 2)
ok(Module.selector_painted_count_state(2) > smartFilled,
   `raising the fill angle past the edge angle spreads further (${smartFilled} -> ${Module.selector_painted_count_state(2)})`)

// (3) Single triangle == bucket fill with the propagation off (upstream's POINTER cursor is literally that call).
//     One click marks strictly less than the smart fill that flooded the whole face.
freshSelector()
Module.selector_bucket_fill(TOP_FACET, 10, 10, 20, -1, false, 3)
const oneFacet = Module.selector_painted_count_state(3)
ok(oneFacet > 0 && oneFacet < smartFilled, `triangle tool marks a single facet, less than a fill (${oneFacet} < ${smartFilled})`)

// (4) Bucket fill spreads across facets sharing the clicked spot's current state — on a fresh (all NONE) mesh with
//     the propagation on that is more than the one facet above.
freshSelector()
Module.selector_bucket_fill(TOP_FACET, 10, 10, 20, 30, true, 3)
ok(Module.selector_painted_count_state(3) > oneFacet,
   `bucket fill propagates further than the single triangle (${oneFacet} -> ${Module.selector_painted_count_state(3)})`)

// (5) Every tool has an eraser, and it clears what the tool itself painted — a fill the eraser cannot undo is the
//     failure this pair exists to rule out (the brush's eraser has its own check in the section above).
freshSelector()
Module.selector_seed_fill(TOP_FACET, 10, 10, 20, 30, 2)
Module.selector_seed_fill_erase(TOP_FACET, 10, 10, 20, 30)
ok(paintedTotal() === 0, `the smart fill eraser clears what the smart fill painted (${paintedTotal()} left)`)
freshSelector()
Module.selector_bucket_fill(TOP_FACET, 10, 10, 20, 30, true, 3)
Module.selector_bucket_fill_erase(TOP_FACET, 10, 10, 20, 30, true)
ok(paintedTotal() === 0, `the bucket fill eraser clears what the bucket fill painted (${paintedTotal()} left)`)

// (6) The brush's cursor shape reaches the kernel: a SPHERE around a point on the wall also catches the far wall
//     within its radius, a CIRCLE facing the camera does not. Same click, same radius, different facet count.
freshSelector()
Module.selector_paint_shape(WALL_FACET, 20, 10, 10, 60, 10, 10, 14, 2, 0)   // 0 = sphere
const spherePainted = Module.selector_painted_count_state(2)
freshSelector()
Module.selector_paint_shape(WALL_FACET, 20, 10, 10, 60, 10, 10, 14, 2, 1)   // 1 = circle
const circlePainted = Module.selector_painted_count_state(2)
ok(spherePainted > 0 && circlePainted > 0 && spherePainted !== circlePainted,
   `the cursor shape argument changes what the brush selects (sphere ${spherePainted} vs circle ${circlePainted})`)

// (7) The state guard the brush has applies to the fills too: an out-of-range state paints nothing rather than
//     silently landing on some other extruder.
freshSelector()
Module.selector_seed_fill(TOP_FACET, 10, 10, 20, 30, 99)
Module.selector_bucket_fill(TOP_FACET, 10, 10, 20, 30, true, 99)
ok(paintedTotal() === 0, `a fill with an out-of-range state marks nothing (${paintedTotal()} facets)`)
Module.selector_clear()

// ===== New in stage 7 (the real OrcaSlicer Arachne port — variable-width walls) =====
console.log('\n[stage7]')
// Per-segment widths (the parallel widths array) — collecting wall (type1) segments only
const wallWidths = (result) => {
  const out = []
  for (let layerIndex = 3; layerIndex < result.layers.length - 3; layerIndex++) {
    const paths = result.layers[layerIndex].paths
    const widths = result.layers[layerIndex].widths
    if (!widths) continue
    let k = 0
    for (let i = 0; i < paths.length; i += 8) {
      if (paths[i + 3] === 1 && widths[k] > 0) out.push(widths[k])
      k++
    }
  }
  return out
}
const valueSpan = (values) => {
  if (!values.length) return { min: 0, max: 0, n: 0 }
  return { min: Math.min(...values), max: Math.max(...values), n: values.length }
}

// (1) arachne cube: slices fine and the wall width is uniform ≈ w (thick shape)
const rArachneCube = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, wall_generator: 'arachne' }), () => {})
const arachneCubeWidths = valueSpan(wallWidths(rArachneCube))
let arachneCubeText = 'ERR'
if (!rArachneCube.error) arachneCubeText = 'wall segs ' + arachneCubeWidths.n
ok(!rArachneCube.error && arachneCubeWidths.n > 0, `arachne cube slices ok (${arachneCubeText})`)
ok(Math.abs(arachneCubeWidths.min - 0.42) < 0.03 && Math.abs(arachneCubeWidths.max - 0.42) < 0.03, `arachne cube walls ~uniform w (min=${arachneCubeWidths.min.toFixed(3)} max=${arachneCubeWidths.max.toFixed(3)})`)

// (2) arachne thin cross: wall width varies (min<max) and the thin arms exceed w (within the 50~150% range)
const rArachneCross = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify({ ...params, wall_generator: 'arachne' }), () => {})
const arachneCrossWidths = valueSpan(wallWidths(rArachneCross))
console.log(`  arachne cross wall width mm: min=${arachneCrossWidths.min.toFixed(3)} max=${arachneCrossWidths.max.toFixed(3)} n=${arachneCrossWidths.n}`)
ok(!rArachneCross.error && arachneCrossWidths.max - arachneCrossWidths.min > 0.05, `arachne thin cross → VARIABLE bead width (min=${arachneCrossWidths.min.toFixed(3)} < max=${arachneCrossWidths.max.toFixed(3)})`)
ok(arachneCrossWidths.min >= 0.42 * 0.5 - 1e-3 && arachneCrossWidths.max <= 0.42 * 1.5 + 1e-3, `arachne widths within 50–150% of w (${arachneCrossWidths.min.toFixed(3)}..${arachneCrossWidths.max.toFixed(3)})`)

// (3) E is width-based — E/mm in the arachne wall G-code varies with width (wider segments raise E per unit length)
const wallEperMM = (gcode) => {
  const lines = gcode.split('\n')
  const out = []
  let previousX = null
  let previousY = null
  let inWall = false
  for (const line of lines) {
    if (line.includes('; walls (Arachne')) {
      inWall = true
      previousX = null
      continue
    }
    if (line.startsWith(';')) { inWall = false }   // ends at the next feature comment (z-hop G1 Z is a travel, so it is kept)
    const travel = line.match(/^G0 X([\d.-]+) Y([\d.-]+)/)
    if (travel) {
      previousX = +travel[1]
      previousY = +travel[2]
      continue
    }
    const match = line.match(/^G1 X([\d.-]+) Y([\d.-]+) E([\d.]+)/)
    if (match) {
      const x = +match[1]
      const y = +match[2]
      const extrusion = +match[3]
      if (inWall && previousX !== null) {
        const distance = Math.hypot(x - previousX, y - previousY)
        if (distance > 0.3) out.push(extrusion / distance)
      }
      previousX = x
      previousY = y
    }
  }
  return out
}
const wallExtrusionPerMM = wallEperMM(rArachneCross.gcode)
const extrusionSpan = valueSpan(wallExtrusionPerMM.filter(value => value > 0))
console.log(`  arachne cross wall E/mm: min=${extrusionSpan.min.toFixed(5)} max=${extrusionSpan.max.toFixed(5)} n=${extrusionSpan.n}`)
ok(extrusionSpan.n > 0 && extrusionSpan.max > extrusionSpan.min * 1.15, `wall E/mm scales with bead width (spread ${extrusionSpan.min.toFixed(4)}→${extrusionSpan.max.toFixed(4)})`)

// (4) Backwards compatible: the default (classic) matches the stage-6 result and widths are uniformly w
ok(typeTotal(rArachneCube, 1) > 0 && typeTotal(rCube, 1) > 0, `both classic & arachne emit walls (type1)`)
const rClassicCube = Module.slice(new Uint8Array(cubeBinarySTL), JSON.stringify({ ...params, wall_generator: 'classic' }), () => {})
ok(rClassicCube.stats.layers === rCube.stats.layers && Math.abs(rClassicCube.stats.filament_mm - rCube.stats.filament_mm) < 1e-6,
   'stage-7 default (classic) keeps cube result unchanged (backward compatible)')
const classicCubeWidths = valueSpan(wallWidths(rClassicCube))
ok(Math.abs(classicCubeWidths.min - 0.42) < 1e-2 && Math.abs(classicCubeWidths.max - 0.42) < 1e-2, `classic widths array = uniform line_width (${classicCubeWidths.min.toFixed(3)})`)

// ===== New in stage 8 (the real OrcaSlicer Fill pattern port — gyroid TPMS and friends) =====
console.log('\n[stage8]')
const fillCube = makeBoxSTL(30, 30, 20)
const fillParams = { ...params, infill_density: 0.20 }
const sparseSegments = (result) => result.layers.reduce((sum, layer) => {
  const paths = layer.paths
  let count = 0
  for (let i = 0; i < paths.length; i += 8) if (paths[i + 3] === 2) count++
  return sum + count
}, 0)
// (1) The ported patterns slice successfully with segments > 0 (gyroid/honeycomb/3dhoneycomb/crosshatch/concentric)
for (const pattern of ['gyroid', 'honeycomb', '3dhoneycomb', 'crosshatch', 'concentric']) {
  const rPattern = Module.slice(new Uint8Array(fillCube), JSON.stringify({ ...fillParams, sparse_infill_pattern: pattern }), () => {})
  let sparseText = 'ERR'
  if (!rPattern.error) sparseText = sparseSegments(rPattern)
  ok(!rPattern.error && sparseSegments(rPattern) > 0, `ported Fill '${pattern}': slices ok, sparse segs=${sparseText}`)
}
// (2) Upstream gyroid (TPMS) vs the approximated gyroid: different segment structure
const rGyroidReal = Module.slice(new Uint8Array(fillCube), JSON.stringify({ ...fillParams, sparse_infill_pattern: 'gyroid' }), () => {})
const rGyroidApproximated = Module.slice(new Uint8Array(fillCube), JSON.stringify({ ...fillParams, sparse_infill_pattern: 'gyroid_approx' }), () => {})
console.log(`  gyroid real segs=${sparseSegments(rGyroidReal)} vs approx segs=${sparseSegments(rGyroidApproximated)}`)
ok(sparseSegments(rGyroidReal) > 0 && sparseSegments(rGyroidApproximated) > 0 && sparseSegments(rGyroidReal) !== sparseSegments(rGyroidApproximated),
   `real gyroid (TPMS) differs from sine-approx (real=${sparseSegments(rGyroidReal)} != approx=${sparseSegments(rGyroidApproximated)})`)
// (3) gyroid TPMS z phase: the sparse geometry differs between two z levels (the surface phase changes with z)
const gyroidLayers = rGyroidReal.layers.filter(layer => {
  const paths = layer.paths
  for (let i = 0; i < paths.length; i += 8) if (paths[i + 3] === 2) return true
  return false
})
const signatureOf = (layer) => {
  const paths = layer.paths
  let sum = 0
  let count = 0
  for (let i = 0; i < paths.length; i += 8) {
    if (paths[i + 3] === 2) {
      sum += paths[i] * 7.3 + paths[i + 1] * 3.1
      count++
    }
  }
  if (!count) return 0
  return sum / count
}
const lowSignature = signatureOf(gyroidLayers[Math.floor(gyroidLayers.length * 0.3)]).toFixed(3)
const highSignature = signatureOf(gyroidLayers[Math.floor(gyroidLayers.length * 0.7)]).toFixed(3)
console.log(`  gyroid TPMS z-phase: loLayer sig=${lowSignature} hiLayer sig=${highSignature}`)
ok(lowSignature !== highSignature, `real gyroid has TPMS z-phase (geometry varies with z: ${lowSignature} != ${highSignature})`)
// (4) Backwards compatible: gyroid_approx still uses the old sine approximation (present) and rectilinear's default is unchanged
ok(sparseSegments(rGyroidApproximated) > 0, `gyroid_approx (legacy sine) still available (segs=${sparseSegments(rGyroidApproximated)})`)

// (5) The real PressureEqualizer port (pe_lite:false): runs without crashing or mangling, preserves total E and keeps the structure.
//  ⚠ The real PE only adjusts flow in g-code tagged with OrcaSlicer's ;_EXTRUDE_SET_SPEED -> it passes straight through our plain mini-kernel g-code.
//  Here we verify that "the port links, runs and does not corrupt the resulting g-code" (the need for tags is recorded as a limitation in the README).
const extrusionSumOf = (gcode) => {
  let sum = 0
  for (const match of gcode.matchAll(/ E(-?[\d.]+)/g)) sum += parseFloat(match[1])
  return sum
}
const rRealPEoff = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(params), () => {})
const rRealPE = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...params, max_volumetric_extrusion_rate_slope: 2.0, pe_lite: false }), () => {})
ok(!rRealPE.error && /^; LAYER/m.test(rRealPE.gcode) && /^M104/m.test(rRealPE.gcode), `real PE port runs + preserves g-code structure (; LAYER, M104)`)
ok(Math.abs(extrusionSumOf(rRealPE.gcode) - extrusionSumOf(rRealPEoff.gcode)) < 0.01, `real PE conserves total E (${extrusionSumOf(rRealPE.gcode).toFixed(2)} ≈ ${extrusionSumOf(rRealPEoff.gcode).toFixed(2)})`)
ok(Math.abs(rRealPE.stats.filament_mm - rRealPEoff.stats.filament_mm) < 1e-6, `real PE: filament stat unchanged (speed-only)`)

// ===== New in stage 9 (full real PE integration — OrcaSlicer tag emission + segment splitting) =====
console.log('\n[stage9]')
const stage9Cube = makeBoxSTL(20, 20, 10)
const extrusionMoveCount = (gcode) => (gcode.match(/^G1 /gm) || []).length
const hasTag = (gcode) => /;_EXTRUDE_SET_SPEED/.test(gcode) || /;_EXTRUSION_ROLE:/.test(gcode) || /;_EXTRUDE_END/.test(gcode)
// (1) emit_pe_tags=true with strip off -> all 3 tag kinds present (OrcaSlicer format)
const rStage9Tags = Module.slice(new Uint8Array(stage9Cube), JSON.stringify({ ...params, emit_pe_tags: true, pe_strip_tags: false }), () => {})
ok(/;_EXTRUDE_SET_SPEED/.test(rStage9Tags.gcode) && /;_EXTRUSION_ROLE:/.test(rStage9Tags.gcode) && /;_EXTRUDE_END/.test(rStage9Tags.gcode),
   `emit_pe_tags → ;_EXTRUDE_SET_SPEED/;_EXTRUSION_ROLE/;_EXTRUDE_END all present`)
// (2) Defaults -> no tags (backwards compatible)
const rStage9Default = Module.slice(new Uint8Array(stage9Cube), JSON.stringify(params), () => {})
ok(!hasTag(rStage9Default.gcode), `default: no PE tags emitted (backward compatible)`)
// (3) Real PE (arachne walls = variable flow -> splitting): more G1 lines + total E preserved + tags stripped at the end (strip by default)
const rStage9Off = Module.slice(new Uint8Array(stage9Cube), JSON.stringify({ ...params, wall_generator: 'arachne' }), () => {})
const rStage9PE = Module.slice(new Uint8Array(stage9Cube), JSON.stringify({ ...params, wall_generator: 'arachne', max_volumetric_extrusion_rate_slope: 1.0, pe_lite: false }), () => {})
console.log(`  real PE: G1 off=${extrusionMoveCount(rStage9Off.gcode)} on=${extrusionMoveCount(rStage9PE.gcode)}, E off=${extrusionSumOf(rStage9Off.gcode).toFixed(2)} on=${extrusionSumOf(rStage9PE.gcode).toFixed(2)}`)
ok(extrusionMoveCount(rStage9PE.gcode) > extrusionMoveCount(rStage9Off.gcode), `real PE splits/ramps → G1 line count increases (${extrusionMoveCount(rStage9Off.gcode)}→${extrusionMoveCount(rStage9PE.gcode)})`)
ok(Math.abs(extrusionSumOf(rStage9PE.gcode) - extrusionSumOf(rStage9Off.gcode)) < 0.05, `real PE conserves total E (${extrusionSumOf(rStage9PE.gcode).toFixed(2)} ≈ ${extrusionSumOf(rStage9Off.gcode).toFixed(2)})`)
ok(!hasTag(rStage9PE.gcode), `real PE output: tags stripped by default (clean g-code)`)
// (4) F ramp steps: the split G1 F markers really are inserted
const feedRampCount = (gcode) => (gcode.match(/^G1 F\d+\s*$/gm) || []).length
ok(feedRampCount(rStage9PE.gcode) > 0, `real PE inserts feedrate ramp steps (G1 F markers: ${feedRampCount(rStage9PE.gcode)})`)

// ===== New in stage 10 (the ported GCodeProcessor time estimate — the upstream trapezoidal planner) =====
console.log('\n[stage10]')
const stage10Cube = makeBoxSTL(20, 20, 10)
// (1) The cube G-code parses successfully with a total time > 0
const rTime = Module.slice(new Uint8Array(stage10Cube), JSON.stringify(params), () => {})
ok(!rTime.error && typeof rTime.stats.time_estimate === 'number' && rTime.stats.time_estimate > 0,
   `GCodeProcessor time estimate: total=${rTime.stats.time_estimate.toFixed(1)}s (>0)`)
ok(rTime.stats.time_moves > 0 && rTime.stats.layer_times.length > 0,
   `parsed ${rTime.stats.time_moves} moves, ${rTime.stats.layer_times.length} layer times`)
// per-layer times sum to total (single write site)
const layerTimeSum = rTime.stats.layer_times.reduce((sum, value) => sum + value, 0)
ok(Math.abs(layerTimeSum - rTime.stats.time_estimate) / rTime.stats.time_estimate < 0.001,
   `layer_times sum ${layerTimeSum.toFixed(1)} == total ${rTime.stats.time_estimate.toFixed(1)}`)
// (2) Faster speed parameters shorten the time (physically consistent direction)
const rTimeSlow = Module.slice(new Uint8Array(stage10Cube), JSON.stringify({ ...params, print_speed: 30 }), () => {})
const rTimeFast = Module.slice(new Uint8Array(stage10Cube), JSON.stringify({ ...params, print_speed: 120 }), () => {})
ok(rTimeFast.stats.time_estimate < rTimeSlow.stats.time_estimate,
   `faster print_speed -> less time (30mm/s=${rTimeSlow.stats.time_estimate.toFixed(0)}s > 120mm/s=${rTimeFast.stats.time_estimate.toFixed(0)}s)`)
// (3) Parsed filament == the kernel's own calculation (±2%)
const filamentDelta = Math.abs(rTime.stats.filament_mm - rTime.stats.time_filament_mm) / rTime.stats.filament_mm
ok(filamentDelta <= 0.02, `parsed filament == kernel stat within 2% (${rTime.stats.time_filament_mm.toFixed(1)} vs ${rTime.stats.filament_mm.toFixed(1)}, ${(filamentDelta * 100).toFixed(2)}%)`)
// Time breakdown per role (PE tag mode)
const rTimeTagged = Module.slice(new Uint8Array(stage10Cube), JSON.stringify({ ...params, emit_pe_tags: true, pe_strip_tags: false }), () => {})
ok(Object.keys(rTimeTagged.stats.role_times).length > 0,
   `role time breakdown present in tag mode (roles: ${Object.keys(rTimeTagged.stats.role_times).join(',')})`)
// determinism: identical params -> identical estimate
const rTimeAgain = Module.slice(new Uint8Array(stage10Cube), JSON.stringify(params), () => {})
ok(rTime.stats.time_estimate === rTimeAgain.stats.time_estimate, `time estimate is deterministic`)

// ===== Where the model sits must not change what it slices to =====================================================
//  The viewer used to re-centre its slice input on the XY origin, because a model placed away from it lost infill —
//  measured on this very box: sparse 828 -> 414, solid 427 -> 183, with no error and no warning. The cause was in
//  infill_lines (clip_util.h): each pattern line was drawn through the origin-projected foot and extended by the
//  region's own SIZE, so a region further from the origin than that was simply never reached. That centring is what
//  made the slice frame follow the model, which in turn is what made the prime tower and the paint drift.
console.log('\n[layer count] a layer exists while its middle is below the object top (upstream generate_object_layers)')
// The kernel cut each layer at its top and kept only tops below the object height, so a 20 mm cube lost its last layer
//  and printed 19.8 mm (OrcaSlicer 2.4.2 on the same cube: 100 layers, max_z_height 20.00).
for (const [height, layers] of [[20, 100], [20.05, 100], [20.09, 100], [20.11, 101], [0.15, 1]]) {
  const box = trianglesToSTL(outwardBoxTriangles(-5, -5, 0, 10, 10, height))
  const result = Module.slice(new Uint8Array(box), JSON.stringify(params), () => {})
  const tops = result.layers.map(layer => layer.z)
  ok(!result.error && tops.length === layers && Math.abs(tops.at(-1) - 0.2 * layers) < 1e-6,
     `a ${height} mm box prints ${layers} layers, the last at ${(0.2 * layers).toFixed(1)} (${tops.length}, ${tops.at(-1)?.toFixed(3)})`)
}

console.log('\n[bed origin]')
//  The G-code is in PRINTER coordinates, which start wherever printable_area does: a delta bed is centred on (0,0)
//  and some cartesian beds are offset. The kernel adds the bed centre (bed_origin + bed/2) to every plate-local
//  coordinate; it used to add bed/2 alone, which put a centred model on a delta bed's edge (Anycubic Predator,
//  bed -185..185: model at 185,186).
{
  const originBox = makeBoxSTL(20, 20, 2)
  const centredBox = moveSTL(originBox, -10, -10, 0)   // makeBoxSTL builds x,y in [0,20]; the viewer hands the kernel plate-centred coordinates
  const extrusionCentre = (extra) => {
    const result = Module.slice(new Uint8Array(centredBox), JSON.stringify({ ...params, bed_width: 200, bed_depth: 200, skirt_loops: 0, ...extra }), () => {})
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const match of result.gcode.matchAll(/^G1 X([-\d.]+) Y([-\d.]+) E/gm)) {
      minX = Math.min(minX, +match[1])
      maxX = Math.max(maxX, +match[1])
      minY = Math.min(minY, +match[2])
      maxY = Math.max(maxY, +match[2])
    }
    return [(minX + maxX) / 2, (minY + maxY) / 2]
  }
  const near = ([x, y], [expectedX, expectedY]) => Math.abs(x - expectedX) < 0.01 && Math.abs(y - expectedY) < 0.01
  const corner = extrusionCentre({})
  ok(near(corner, [100, 100]), `bed from (0,0): the model prints at the bed centre (${corner})`)
  const delta = extrusionCentre({ bed_origin_x: -100, bed_origin_y: -100 })
  ok(near(delta, [0, 0]), `bed centred on (0,0): the model prints at (0,0) (${delta})`)
  const offset = extrusionCentre({ bed_origin_x: 5, bed_origin_y: -10 })
  ok(near(offset, [105, 90]), `bed from (5,-10): the model prints at (105,90) (${offset})`)
}

console.log('\n[position invariance]')
const positionBox = makeBoxSTL(20, 20, 20)   // tall enough that most layers are sparse, which is what went missing
const positionParams = { ...params, layer_height: 0.2, infill_density: 0.15, bed_width: 400, bed_depth: 400 }
const rolesAt = (dx, dy) => {
  const result = Module.slice(new Uint8Array(moveSTL(positionBox, dx, dy, 0)), JSON.stringify(positionParams), () => {})
  const counts = { 0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0,10:0,11:0 }
  for (const layer of result.layers) for (let i = 0; i < layer.paths.length; i += 8) counts[ROLE_OF(layer.paths[i+3])]++
  return { counts, filament: result.stats.filament_mm }
}
//  The box is at x,y in [0,20] as makeBoxSTL builds it, so dx=-10 is the centred case the workaround produced and
//  everything else is a placement that used to come out short.
const positionBase = rolesAt(-10, -10)
for (const [name, dx, dy] of [['as built (x,y in [0,20])', 0, 0], ['off +x', 30, 0], ['off +x +y', 30, 30],
                              ['negative both', -60, -60], ['far corner', 60, 60]]) {
  const placed = rolesAt(dx, dy)
  const same = Object.keys(positionBase.counts).every(role => positionBase.counts[role] === placed.counts[role])
  const segments = Object.values(placed.counts).reduce((sum, value) => sum + value, 0)
  ok(same && Math.abs(positionBase.filament - placed.filament) < 1e-3,
     `${name}: same slice as centred (${placed.filament.toFixed(1)}mm, ${segments} segments, same in every role)`)
}

// ===== Overlapping shells union, as upstream's Regular slicing mode does ==========================================
//  The kernel slices the merge of every object as ONE mesh, and used to fill the layer loops even-odd — so two
//  objects on the same spot counted as "inside twice" and sliced to nothing (measured in the viewer: a project
//  imported twice printed 1210mm of a 42984mm model). Segments are now oriented by the facet normal and filled
//  NonZero. What must not change with it: a hole is still a hole, and a shell with every facet flipped still prints.
console.log('\n[overlapping shells]')
const SHELL_BOX_MM = 20                    // the test box: [0, 20]^3
const SHELL_BED_MM = 400                   // room for the offset copies below
const HALF_OVERLAP_OFFSET_MM = SHELL_BOX_MM / 2
const SEPARATE_OFFSET_MM = 2 * SHELL_BOX_MM   // far enough that the two boxes do not touch
const VOID_BOX_MM = SHELL_BOX_MM / 2
const VOID_INSET_MM = (SHELL_BOX_MM - VOID_BOX_MM) / 2   // centred inside the box
const MID_HEIGHT_MM = SHELL_BOX_MM / 2     // inside the void
const FILAMENT_TOLERANCE_MM = 1e-3
// Union bounds for two boxes overlapping by half: more than one box, less than two apart.
const UNION_MORE_THAN_ONE = 1.2
const UNION_LESS_THAN_TWO = 2
const BOX_FACETS = 12                      // makeBoxSTL: two triangles per face
const WALL_ROLE = 1                        // toolpath roles (viewer-package/src/core/toolpath_encoding.js ROLE)
const SPARSE_ROLE = 2
const shellBox = makeBoxSTL(SHELL_BOX_MM, SHELL_BOX_MM, SHELL_BOX_MM)
const shellParams = { ...params, bed_width: SHELL_BED_MM, bed_depth: SHELL_BED_MM }
const filamentOf = (stl, sliceParams = shellParams) => {
  const result = Module.slice(new Uint8Array(stl), JSON.stringify(sliceParams), () => {})
  if (result.error) return NaN
  return result.stats.filament_mm
}
const oneBox = filamentOf(shellBox)
ok(Math.abs(filamentOf(concatSTL(shellBox, shellBox)) - oneBox) < FILAMENT_TOLERANCE_MM, `two coincident boxes print as one (${oneBox.toFixed(1)}mm)`)
const overlapped = filamentOf(concatSTL(shellBox, moveSTL(shellBox, HALF_OVERLAP_OFFSET_MM, 0, 0)))
ok(overlapped > oneBox * UNION_MORE_THAN_ONE && overlapped < oneBox * UNION_LESS_THAN_TWO,
   `two boxes overlapping by half print their union (${overlapped.toFixed(1)}mm, one box ${oneBox.toFixed(1)}mm)`)
ok(Math.abs(filamentOf(flipSTL(shellBox)) - oneBox) < FILAMENT_TOLERANCE_MM, 'a box with every facet flipped still prints the same')
//  A hollow part is an outer shell plus an inner one facing inward — the inner loops wind against the outer.
//  Judged on the middle layer (inside the void) rather than on filament: a hollow part can use MORE filament than a
//  solid one — the void gets walls, and solid skin above and below it. A filled void would make this layer the solid
//  box's layer exactly; a void adds a ring of walls around it. (Segment COUNTS, not lengths — the sparse infill split
//  around a void comes out as more, shorter lines, so its count is no measure of area.)
const midHeightRoles = (stl) => {
  const result = Module.slice(new Uint8Array(stl), JSON.stringify(shellParams), () => {})
  let closest = result.layers[0]
  for (const layer of result.layers) if (Math.abs(layer.z - MID_HEIGHT_MM) < Math.abs(closest.z - MID_HEIGHT_MM)) closest = layer
  return countByType(closest.paths)
}
const voidBox = flipSTL(moveSTL(makeBoxSTL(VOID_BOX_MM, VOID_BOX_MM, VOID_BOX_MM), VOID_INSET_MM, VOID_INSET_MM, VOID_INSET_MM))
const solidMid = midHeightRoles(shellBox)
const hollowMid = midHeightRoles(concatSTL(shellBox, voidBox))
console.log(`  mid-height walls/sparse segments: solid ${solidMid[WALL_ROLE]}/${solidMid[SPARSE_ROLE]}, hollow ${hollowMid[WALL_ROLE]}/${hollowMid[SPARSE_ROLE]}`)
ok(hollowMid[WALL_ROLE] > solidMid[WALL_ROLE],
   'an inward-facing inner shell is still a void (walls around it at mid height, which a solid layer does not have)')
//  The multi-material path slices each group on its own (slice_mm.cpp) and had the same even-odd fill.
const multiMaterialShells = (secondGroup) => filamentOf(concatSTL(shellBox, secondGroup), { ...shellParams, extruder_count: 2, mm_group_split: BOX_FACETS })
const separateBox = moveSTL(shellBox, SEPARATE_OFFSET_MM, 0, 0)
const multiMaterialOne = multiMaterialShells(separateBox)
const multiMaterialTwo = multiMaterialShells(concatSTL(separateBox, separateBox))
ok(multiMaterialOne > 0 && Math.abs(multiMaterialTwo - multiMaterialOne) < FILAMENT_TOLERANCE_MM, `a group holding two coincident boxes prints one (${multiMaterialTwo.toFixed(1)}mm vs ${multiMaterialOne.toFixed(1)}mm)`)

// ===== A move must not cost the paint ============================================================================
//  The marks are indexed by facet, and moving a model renumbers nothing — so rebuilding the selector on the moved
//  coordinates (which the brush and the layer projection both need) can carry them across. This is upstream's own
//  persistence: TriangleSelector::serialize / deserialize, the same data 3MF stores.
console.log('\n[paint survives a move]')
const moveBox = makeBoxSTL(20, 20, 20)
Module.selector_prepare(new Uint8Array(moveBox))
Module.selector_paint_state(2, 10, 10, 20, 10, 10, 60, 8.0, 2, 0)
const paintedBeforeMove = Module.selector_painted_count_state(2)
ok(paintedBeforeMove > 0, `a stroke marks facets to carry (${paintedBeforeMove})`)
const keptAcrossMove = Module.selector_reprepare(new Uint8Array(moveSTL(moveBox, 40, 25, 0)))
ok(keptAcrossMove === true, `re-registering the moved mesh reports the marks kept`)
ok(Module.selector_painted_count_state(2) === paintedBeforeMove,
   `the same facets are still painted after the move (${Module.selector_painted_count_state(2)})`)
//  And the marks must not follow a mesh they were never on: a different face count is a different model, so the
//  call says so instead of dropping the paint somewhere arbitrary.
const twoTriangles = trianglesToSTL([[[0,0,0],[20,0,0],[0,20,0]], [[0,0,0],[0,20,0],[0,0,20]]])
ok(Module.selector_reprepare(new Uint8Array(twoTriangles)) === false,
   `a mesh with a different face count reports the marks NOT kept`)
ok(Module.selector_painted_count_state(2) === 0,
   `...and starts clean rather than inheriting them (${Module.selector_painted_count_state(2)})`)
Module.selector_clear()

// ===== The bed verdict must see what SLICING adds, not only the model ============================================
//  Support, skirt, brim, raft and the prime tower are produced during slicing, so the model bbox prepare_model()
//  measures cannot predict any of them: a model that fits exactly can still drive the head off the bed. over_bed is
//  therefore widened by the extent of the EMITTED extrusions — the same question upstream asks of the finished
//  G-code (BuildVolume::all_paths_inside). These cases pin the mechanism, not any one feature's clipping policy.
console.log('\n[bed: judged on the emitted toolpaths]')
const bedParams = { ...params, bed_width: 200, bed_depth: 200 }
const sliceOnBed = (stl, extra) => Module.slice(new Uint8Array(stl), JSON.stringify({ ...bedParams, ...extra }), () => {})
//  x 80..100 = flush against the +X bed edge. The model fits exactly; anything added around it does not.
const cubeAtEdge = moveSTL(makeBoxSTL(20, 20, 20), 80, -10, 0)

//  Control first: without a skirt or brim nothing reaches past the model, so the new check must not invent an overflow.
const bedFlush = sliceOnBed(cubeAtEdge, { skirt_loops: 0, brim_width: 0 })
ok(bedFlush.stats.over_bed === false, `a bare model flush against the bed edge is not over the bed`)
ok(bedFlush.stats.over_bed_x === 0 && bedFlush.stats.over_bed_y === 0, `...and reports zero overflow on both axes`)

//  Skirt: offset outward from the contour with no bed clip, so it leaves the bed while the model does not.
const bedSkirt = sliceOnBed(cubeAtEdge, { skirt_loops: 1, skirt_distance: 2, brim_width: 0 })
ok(bedSkirt.stats.over_bed === true, `a skirt leaving the bed is caught (${bedSkirt.stats.over_bed_x.toFixed(2)}mm past)`)
ok(bedSkirt.stats.over_bed_model === false, `...and is attributed to the toolpaths, not to the model`)
ok(bedSkirt.stats.over_bed_x > 1.5, `...with the overflow measured, not just flagged (${bedSkirt.stats.over_bed_x.toFixed(2)}mm)`)

//  Brim: the same hole, further out — so a 5mm brim must report MORE overflow than a 2mm skirt.
const bedBrim = sliceOnBed(cubeAtEdge, { skirt_loops: 0, brim_width: 5 })
ok(bedBrim.stats.over_bed === true, `a brim leaving the bed is caught (${bedBrim.stats.over_bed_x.toFixed(2)}mm past)`)
ok(bedBrim.stats.over_bed_x > bedSkirt.stats.over_bed_x,
   `a 5mm brim reaches further out than a 2mm skirt (${bedBrim.stats.over_bed_x.toFixed(2)} > ${bedSkirt.stats.over_bed_x.toFixed(2)})`)

//  The model check keeps its own job: a model genuinely off the bed is still reported AS the model being off.
const bedModelOff = sliceOnBed(moveSTL(makeBoxSTL(20, 20, 20), 95, -10, 0), { skirt_loops: 0, brim_width: 0 })
ok(bedModelOff.stats.over_bed === true && bedModelOff.stats.over_bed_model === true,
   `a model past the bed edge is still reported by the model check`)
ok(bedModelOff.stats.over_bed_x > 14, `...and now carries how far past it reaches (${bedModelOff.stats.over_bed_x.toFixed(2)}mm)`)

//  Nothing near an edge: skirt and brim both on, and still no overflow claimed.
const bedCentred = sliceOnBed(makeBoxSTL(20, 20, 20), { skirt_loops: 2, skirt_distance: 2, brim_width: 5 })
ok(bedCentred.stats.over_bed === false, `a centred model with skirt+brim stays on the bed`)

//  Height has the same shape of hole: a raft lifts every model layer, so the MODEL's height cannot say whether the
//  print clears the ceiling. Upstream takes this from the same G-code as a second warning (ToolHeightOutside — the
//  top layer's z against max_print_height), so the emitted top z is what gets compared here too.
const bedCeiling = { ...bedParams, skirt_loops: 0, brim_width: 0, bed_height: 20.3 }   // 20mm cube -> 19.8 top, fits
const raftLift = (extra) => Module.slice(new Uint8Array(makeBoxSTL(20, 20, 20)), JSON.stringify({ ...bedCeiling, ...extra }), () => {})
const bedNoRaft = raftLift({ raft_layers: 0 })
ok(bedNoRaft.stats.over_bed === false, `a model that clears the ceiling on its own is not over the bed`)
const bedRaft = raftLift({ raft_layers: 3 })
ok(bedRaft.stats.over_bed === true && bedRaft.stats.over_bed_model === false,
   `a raft lifting the print past printable_height is caught, and blamed on the print not the model`)
ok(bedRaft.stats.over_bed_z > 0.2, `...with the lift measured (${bedRaft.stats.over_bed_z.toFixed(2)}mm over)`)
//  printable_height 0 means the profile states no ceiling — nothing is ever too tall (same rule as prepare_model).
ok(raftLift({ raft_layers: 3, bed_height: 0 }).stats.over_bed === false,
   `with no stated ceiling, height is never reported`)

//  Tree support is the one feature that IS clipped to the bed (upstream m_machine_border), so it must stay on it
//  wherever the model stands. The clip window used to be centred on the model rather than the bed — it travelled
//  with the object, so support beside a model at the edge was clipped against a bed that was not there.
console.log('\n[bed: tree support is clipped to the BED, not to the model]')
const tableAtEdge = moveSTL(makeTableSTL(), 80, -10, 0)     // cap x 80..100 — flush against the +X edge
const treeNoSkirt = { enable_support: true, support_style: 'tree', support_threshold_angle: 30,
                      support_top_z_distance: 0.2, support_xy_distance: 0.35, skirt_loops: 0, brim_width: 0 }
const bedTreeEdge = sliceOnBed(tableAtEdge, treeNoSkirt)
ok(typeTotal(bedTreeEdge, 5) > 0, `the edge model still generates tree support (type5=${typeTotal(bedTreeEdge, 5)})`)
ok(bedTreeEdge.stats.over_bed_x === 0 && bedTreeEdge.stats.over_bed_y === 0,
   `tree support beside a model at the bed edge stays on the bed (x=${bedTreeEdge.stats.over_bed_x.toFixed(2)}, y=${bedTreeEdge.stats.over_bed_y.toFixed(2)})`)
//  ...and clipping to the real bed must not have cost the support everywhere else: centred, it is unchanged.
const bedTreeCentre = sliceOnBed(makeTableSTL(), treeNoSkirt)
ok(typeTotal(bedTreeCentre, 5) > 0, `a centred model's tree support is unaffected (type5=${typeTotal(bedTreeCentre, 5)})`)
ok(bedTreeCentre.stats.over_bed === false, `...and is not over the bed either`)

//  The non-organic tree styles (upstream smsTreeSlim / Strong / Hybrid) run TreeSupport, not TreeSupport3D, and that
//  path keeps its layer outlines in PrintObject's tree-support cache. The adapter returned an empty pointer for it, so
//  every one of these styles dereferenced null on any model: std::length_error on st, "memory access out of bounds" on mt.
console.log('\n[tree support: every style slices]')
for (const tree_style of ['organic', 'slim', 'strong', 'hybrid']) {
  let styled = null
  try { styled = sliceOnBed(makeTableSTL(), { ...treeNoSkirt, tree_style }) } catch (error) { styled = { error: String(error) } }
  ok(!styled.error && typeTotal(styled, 5) > 0, `tree_style ${tree_style} slices and emits support (type5=${styled.error ?? typeTotal(styled, 5)})`)
}

// ===== ;TYPE: role tags: the G-code TEXT names the roles the stream records =======================================
//  The viewer draws a slice from the toolpath stream, but an exported .gcode / .gcode.3mf comes back as text, and
//  the multi-material path wrote no role marks at all: an opened painted model drew its object as prime tower (every
//  extrusion after the tower's "; prime tower" comment inherited it until the next layer). With gcode_role_tags the
//  writer tags each run from the same type push_toolpath_segment records, so reading the text back must give the stream's
//  per-role extrusion length. Without the flag no tag is written — the default G-code is pinned by golden.mjs.
console.log('\n[role tags]')
const { parseGcode } = await import('../../../viewer-package/src/core/gcode_parse.js')
const lengthByRole = (layers) => {
  const byRole = {}
  for (const layer of layers) for (let i = 0; i < layer.paths.length; i += 8) {
    const role = ROLE_OF(layer.paths[i + 3])
    if (role === 0) continue
    byRole[role] = (byRole[role] ?? 0) + Math.hypot(layer.paths[i + 4] - layer.paths[i], layer.paths[i + 5] - layer.paths[i + 1])
  }
  return byRole
}
const tagCases = [
  ['single material, tree support, skirt', makeTableSTL(), { ...params, enable_support: true, support_style: 'tree', support_threshold_angle: 30 }],
  ['raft', cubeBinarySTL, { ...params, raft_layers: 2 }],
  ['multi-material, ring tower', multiMaterialSTL, { ...params, extruder_count: 2, mm_group_split: multiMaterialSplit, wipe_tower_real: false }],
  ['multi-material, real WipeTower', multiMaterialSTL, { ...params, extruder_count: 2, mm_group_split: multiMaterialSplit, wipe_tower_real: true }],
  ['thin wall + gap fill', makeCrossSTL(), params],
  ['gap fill ring', makeRingSTL(), params],
  ['arachne walls + ironing', cubeBinarySTL, { ...params, wall_generator: 'arachne', ironing_type: 'top' }],
  ['scarf seam', cubeBinarySTL, { ...params, seam_slope_type: 'external' }],
  ['spiral', cubeBinarySTL, { ...params, spiral_mode: true }],
]
for (const [name, stl, caseParams] of tagCases) {
  const untagged = Module.slice(new Uint8Array(stl), JSON.stringify(caseParams), () => {})
  const tagged = Module.slice(new Uint8Array(stl), JSON.stringify({ ...caseParams, gcode_role_tags: true }), () => {})
  ok(!untagged.gcode.includes(';TYPE:'), `${name}: no ;TYPE: without the flag`)
  //  The time estimate reads the same G-code through the ported GCodeProcessor, which acts on ;TYPE: — a tag must
  //  change what a move is called, never how long it takes.
  //  (The multi-material path reports no estimate; there both sides are absent and only the filament is compared.)
  ok(untagged.stats.time_estimate === tagged.stats.time_estimate && untagged.stats.filament_mm === tagged.stats.filament_mm,
     `${name}: same time estimate and filament with tags (${tagged.stats.time_estimate?.toFixed(1) ?? 'no estimate'}s, ${tagged.stats.filament_mm.toFixed(1)}mm)`)
  const stream = lengthByRole(tagged.layers)
  const text = lengthByRole(parseGcode(tagged.gcode).layers)
  const roles = [...new Set([...Object.keys(stream), ...Object.keys(text)])].sort((first, second) => first - second)
  const mismatchedRoles = roles.filter(role => Math.abs((stream[role] ?? 0) - (text[role] ?? 0)) > 0.01 * Math.max(stream[role] ?? 0, text[role] ?? 0, 1))
  ok(mismatchedRoles.length === 0, `${name}: text read back gives the stream's length in every role (${roles.map(role => `${role}:${(stream[role] ?? 0).toFixed(0)}/${(text[role] ?? 0).toFixed(0)}`).join(' ')})`)
}

// Reordering a layer's paths must not drop paths. Upstream's check removed a whole collection whenever its first or last
//  child had no endpoints, so every path in it was lost: on a 3M-facet tree-slim model 64.6 mm of support toolpaths over
//  three layers, one of them a 37 mm outline of a whole support island (ShortestPath.cpp remove_entities_without_endpoints).
console.log('\n[path reordering]')
{
  const kept = Module.chain_reorder_kept_length()
  ok(Math.abs(kept - 15) < 1e-6, `reordering keeps the paths of collections with an empty first or last child (${kept.toFixed(3)} of 15 mm)`)
}

if (failed === 0) console.log('\nALL NODE TESTS PASSED')
else console.log(`\n${failed} TEST(S) FAILED`)
let exitCode = 1
if (failed === 0) exitCode = 0
process.exit(exitCode)
