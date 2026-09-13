// node self-test (track C stage 3): cube (binary + ASCII) + table (overhang) -> slice() -> invariant checks.
//   Run: node reverse_engineering/wasm-core/test.mjs   (final judgement still comes from the browser / vite preview)
import createSlicer from '../engine/src/slicer_core.js'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// --- Box geometry ---
function boxFaces(sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]]
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  return { v, f }
}
export function makeBoxSTL(sx, sy, sz) {              // binary cube
  const { v, f } = boxFaces(sx, sy, sz)
  const buf = Buffer.alloc(84 + f.length * 50)
  buf.writeUInt32LE(f.length, 80)
  let off = 84
  for (const face of f) {
    off += 12
    for (const idx of face) { buf.writeFloatLE(v[idx][0], off); buf.writeFloatLE(v[idx][1], off + 4); buf.writeFloatLE(v[idx][2], off + 8); off += 12 }
    buf.writeUInt16LE(0, off); off += 2
  }
  return buf
}
export function makeAsciiBoxSTL(sx, sy, sz) {         // ASCII cube
  const { v, f } = boxFaces(sx, sy, sz)
  let s = 'solid cube\n'
  for (const face of f) {
    s += ' facet normal 0 0 0\n  outer loop\n'
    for (const idx of face) s += `   vertex ${v[idx][0]} ${v[idx][1]} ${v[idx][2]}\n`
    s += '  endloop\n endfacet\n'
  }
  s += 'endsolid cube\n'
  return Buffer.from(s, 'utf8')
}
// Box triangles in absolute coordinates (for assembling the overhang table)
function boxTris(ox, oy, oz, sx, sy, sz) {
  const { v, f } = boxFaces(sx, sy, sz)
  return f.map(fc => fc.map(i => [v[i][0] + ox, v[i][1] + oy, v[i][2] + oz]))
}
// Table / T shape (overhang): a wide 20x20x4 cap on a narrow 6x6x10 column -> the cap's underside overhangs into thin air
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80)
  let off = 84
  for (const t of tris) { off += 12; for (const p of t) { buf.writeFloatLE(p[0], off); buf.writeFloatLE(p[1], off + 4); buf.writeFloatLE(p[2], off + 8); off += 12 } buf.writeUInt16LE(0, off); off += 2 }
  return buf
}
export function makeTableSTL() {
  return trisToSTL([...boxTris(7, 7, 0, 6, 6, 10), ...boxTris(0, 0, 10, 20, 20, 4)])
}
// Cylinder (for arc fitting checks) — with the side split into segments the wall becomes an arc
export function makeCylinderSTL(r, h, seg) {
  const tris = [], top = h, bot = 0
  for (let i = 0; i < seg; i++) {
    const a0 = 2 * Math.PI * i / seg, a1 = 2 * Math.PI * (i + 1) / seg
    const x0 = r * Math.cos(a0), y0 = r * Math.sin(a0), x1 = r * Math.cos(a1), y1 = r * Math.sin(a1)
    tris.push([[x0, y0, bot], [x1, y1, bot], [x1, y1, top]])
    tris.push([[x0, y0, bot], [x1, y1, top], [x0, y0, top]])
    tris.push([[0, 0, bot], [x1, y1, bot], [x0, y0, bot]])
    tris.push([[0, 0, top], [x0, y0, top], [x1, y1, top]])
  }
  return trisToSTL(tris)
}
// Models for stage 5 -------------------------------------------------------------
// Thin cross (thin wall): a thick hub (3x3, >=2w) with 4 thin arms (0.6mm ≈ 1.5w). Hub = 2 wall loops, arms = a single center line.
export function makeCrossSTL() {
  const hub = 3, arm = 0.6, len = 5, h = 3
  return trisToSTL([
    ...boxTris(-hub / 2, -hub / 2, 0, hub, hub, h),
    ...boxTris(hub / 2, -arm / 2, 0, len, arm, h),
    ...boxTris(-hub / 2 - len, -arm / 2, 0, len, arm, h),
    ...boxTris(-arm / 2, hub / 2, 0, arm, len, h),
    ...boxTris(-arm / 2, -hub / 2 - len, 0, arm, len, h),
  ])
}
// Thin ring/tube (gap fill): a square frame with 2.5w (≈1.05mm) walls -> 1 wall loop + a 0.5w leftover gap.
export function makeRingSTL() {
  const w = 0.42, th = 2.5 * w, outer = 10, h = 3
  return trisToSTL([
    ...boxTris(-outer / 2, -outer / 2, 0, outer, th, h),
    ...boxTris(-outer / 2, outer / 2 - th, 0, outer, th, h),
    ...boxTris(-outer / 2, -outer / 2 + th, 0, th, outer - 2 * th, h),
    ...boxTris(outer / 2 - th, -outer / 2 + th, 0, th, outer - 2 * th, h),
  ])
}
// L shape (wall-avoiding travel): a concave notch -> a straight travel between the arms crosses the outer wall.
export function makeLShapeSTL() {
  return trisToSTL([...boxTris(0, 0, 0, 24, 8, 4), ...boxTris(0, 0, 0, 8, 24, 4)])
}
// Two boxes side by side (multi-material): the first 12 triangles = group 0, the next 12 = group 1 (split=12).
export function makeTwoBoxSTL() {
  const A = boxTris(0, 0, 0, 10, 10, 6), B = boxTris(16, 0, 0, 10, 10, 6)
  return { stl: trisToSTL([...A, ...B]), split: A.length }
}

// Three boxes in triangle order, one per extruder — the N-way grouping fixture.
export function makeThreeBoxSTL() {
  const A = boxTris(0, 0, 0, 10, 10, 6), B = boxTris(16, 0, 0, 10, 10, 6), C = boxTris(32, 0, 0, 10, 10, 6)
  return { stl: trisToSTL([...A, ...B, ...C]), splits: [A.length, A.length + B.length] }
}
// --- Painted multi-material fixtures ---------------------------------------------------------------------------
// The facet projection behind painting (project_custom_facets_footprint) drops vertical faces — they project to a
//  zero-area sliver — and a horizontal face only reaches the one slicing plane it sits on. A painted region that is
//  fat on many layers therefore needs a big SLANTED face. The wedge is a 20x20x10 base carrying one slanted face
//  rising from z=10 (at y=0) to z=20 (at y=20): painting that single face marks the whole 20x20 footprint on every
//  layer above z=10, so the painted region is the full cross-section there and none of it below.
export const WEDGE_FACETS = 18, WEDGE_SLOPE_FACET = 12, WEDGE_PITCH = 25
function wedgeTris(ox) {
  const P = (x, y, z) => [x + ox, y, z]
  return [
    ...boxTris(ox, 0, 0, 20, 20, 10),                                                // 0..11 base (top face = 2,3)
    [P(0,0,10), P(20,0,10), P(20,20,20)], [P(0,0,10), P(20,20,20), P(0,20,20)],      // 12,13 slanted face
    [P(0,20,10), P(20,20,10), P(20,20,20)], [P(0,20,10), P(20,20,20), P(0,20,20)],   // 14,15 back wall
    [P(0,0,10), P(0,20,20), P(0,20,10)], [P(20,0,10), P(20,20,10), P(20,20,20)],     // 16,17 ends
  ]
}
export function makeWedgeSTL(count) {
  return trisToSTL(Array.from({ length: count }, (_, k) => wedgeTris(k * WEDGE_PITCH)).flat())
}
// Overlap fixture: a 6x6 leg and a 20x20 cap meeting at z=10.15. Both faces on that plane project onto the z=10.2
//  slicing plane (0.05 away — inside the projector's half-layer tolerance) and the contour there is the whole cap,
//  so the leg's square sits strictly inside the cap's square: two painted extruders claiming the same area.
//  The plane is 10.15 and not 10.0 because a plane where the geometry changes solids slices to nothing at all.
export const OVERLAP_LEG_FACET = 2, OVERLAP_CAP_FACET = 12, OVERLAP_Z = 10.2
export function makeOverlapSTL() {
  return trisToSTL([...boxTris(7, 7, 0, 6, 6, 10.15), ...boxTris(0, 0, 10.15, 20, 20, 3.85)])
}

const params = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2,
  infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0,
  print_speed: 60, first_layer_speed: 20, travel_speed: 150, nozzle_temp: 210, bed_temp: 60,
  top_shell_layers: 4, bottom_shell_layers: 3, skirt_loops: 1, skirt_distance: 2, brim_width: 0,
  retract_length: 0.8, retract_speed: 30, z_hop: 0.4, infill_angle: 45,
}

let failed = 0
function ok(cond, msg) { if (!cond) { console.error('  FAIL:', msg); failed++ } else console.log('  ok:', msg) }
// The stride-8 role field carries the printing extruder in its high bits (value = role + tool*16, decoded by the
//  viewer's toolpath_segments.js). Untooled output is entirely below 16 so the mask is a no-op there, but a slice
//  that switches tools would otherwise drop every tooled segment out of the role histogram.
const ROLE_OF = (v) => v & 15, TOOL_OF = (v) => v >>> 4
function countByType(paths) { const c = {0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0,10:0,11:0}; for (let i = 0; i < paths.length; i += 8) c[ROLE_OF(paths[i+3])]++; return c }
const typeTotal = (r, t) => r.layers.reduce((a, Ly) => a + countByType(Ly.paths)[t], 0)
const topLayerWithType = (r, t) => { let top = -1; r.layers.forEach((Ly, i) => { if (countByType(Ly.paths)[t] > 0) top = i }); return top }

const Module = await createSlicer()
const here = dirname(fileURLToPath(import.meta.url))
const stlBin = makeBoxSTL(20, 20, 20)
writeFileSync(join(here, 'cube20.stl'), stlBin)
writeFileSync(join(here, 'cube20_ascii.stl'), makeAsciiBoxSTL(20, 20, 20))
writeFileSync(join(here, 'table.stl'), makeTableSTL())

let progressCalls = 0, lastDone = 0, lastTotal = 0
const onProgress = (done, total) => { progressCalls++; lastDone = done; lastTotal = total }

const r = Module.slice(new Uint8Array(stlBin), JSON.stringify(params), onProgress)
if (r.error) { console.error('FAIL: slice error:', r.error); process.exit(1) }
const expected = Math.round(20 / params.layer_height)
console.log(`[cube] layers=${r.stats.layers}, segments=${r.stats.path_segments}, filament=${r.stats.filament_mm.toFixed(2)}mm, progress=${progressCalls}`)

// ===== The original 22 (stage 2) — kept =====
ok(Math.abs(r.stats.layers - expected) <= 1, `layer count ${r.stats.layers} within ±1 of ${expected}`)
ok(r.stats.path_segments > 0, `path_segments > 0 (${r.stats.path_segments})`)
ok(r.stats.filament_mm > 0, `total filament > 0 (${r.stats.filament_mm.toFixed(2)}mm)`)
ok(/G1 [^\n]*E[0-9]/.test(r.gcode), 'G-code contains G1 ... E<num> extrusion lines')
ok(r.gcode.includes('M83'), 'G-code has relative-E (M83)')
ok(r.layers.length === r.stats.layers, 'layers array length == stats.layers')
let wallFound = false, infillFound = false
for (const Ly of r.layers) { const c = countByType(Ly.paths); if (c[1]) wallFound = true; if (c[2] || c[3]) infillFound = true }
ok(wallFound, 'toolpaths contain wall segments (type=1)')
ok(infillFound, 'toolpaths contain infill segments (type=2/3)')
const nL = r.layers.length
const infillCount = (Ly) => { const c = countByType(Ly.paths); return c[2] + c[3] }
const solidCount = (Ly) => countByType(Ly.paths)[3]
const midMid = Math.floor(nL / 2)
const midInfill = infillCount(r.layers[midMid])
for (const li of [0, 1, 2]) ok(solidCount(r.layers[li]) > 0, `bottom shell layer ${li} solid (type=3): ${solidCount(r.layers[li])}`)
for (const li of [nL-1, nL-2, nL-3]) ok(solidCount(r.layers[li]) > 0, `top shell layer ${li} solid (type=3): ${solidCount(r.layers[li])}`)
ok(infillCount(r.layers[0]) > midInfill * 2, `layer0 infill density (${infillCount(r.layers[0])}) >> mid (${midInfill})`)
ok(solidCount(r.layers[midMid]) === 0, `mid layer ${midMid} sparse only`)
ok(countByType(r.layers[0].paths)[4] > 0, `layer 0 skirt (type=4): ${countByType(r.layers[0].paths)[4]}`)
ok(/^; skirt/m.test(r.gcode), 'G-code has "; skirt" marker')
const glines = r.gcode.split('\n')
ok(glines.some((l, i) => /^G1 Z[\d.]+ F\d+$/.test(l) && /^G0 /.test(glines[i + 1] || '')), 'z_hop: G1 Z lift precedes G0 travel')
ok(progressCalls > 0 && lastDone === lastTotal, `progress 100% (${lastDone}/${lastTotal})`)
const rA = Module.slice(new Uint8Array(makeAsciiBoxSTL(20, 20, 20)), JSON.stringify(params), onProgress)
ok(rA.stats.layers === r.stats.layers, `ASCII same layer count (${rA.stats.layers})`)
ok(Math.abs(rA.stats.filament_mm - r.stats.filament_mm) < 0.5, `ASCII same filament`)

// ===== New in stage 3 =====
console.log('\n[stage3]')
// A cube has vertical walls -> no support (defaults: enable_support=false, raft=0, bed=256)
ok(typeTotal(r, 5) === 0, `cube (default) has no support (type5=0)`)

// --- Support: the overhang table ---
const supP = { ...params, enable_support: true, support_threshold_angle: 30, support_density: 0.15, support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2 }
const rSup = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(supP), () => {})
const rNo  = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, enable_support: false }), () => {})
if (rSup.error) { console.error('FAIL: table slice error', rSup.error); process.exit(1) }
console.log(`  table layers=${rSup.stats.layers}, support(type5) total=${typeTotal(rSup, 5)}, topSupLayer=${topLayerWithType(rSup, 5)}`)
// (1) Support exists in the z band under the overhang (cap = z10, ~layer 49), and never inside or above the cap
ok(typeTotal(rSup, 5) > 0, `overhang model generates support (type5=${typeTotal(rSup, 5)})`)
const belowCap = rSup.layers.filter(L => L.z > 2 && L.z < 9.5).some(L => countByType(L.paths)[5] > 0)
ok(belowCap, 'support present in layers below the overhang (2<z<9.5)')
const topCapNoSup = [rSup.layers.length-1, rSup.layers.length-2].every(i => countByType(rSup.layers[i].paths)[5] === 0)
ok(topCapNoSup, 'no support inside the solid cap (top layers type5=0)')
ok(/^; support/m.test(rSup.gcode), 'G-code has "; support" marker')
// (2) Higher support_top_z_distance -> larger contact z gap -> the support top sits lower
const rGap = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, support_top_z_distance: 0.6 }), () => {})
ok(topLayerWithType(rGap, 5) < topLayerWithType(rSup, 5),
   `larger top_z_distance lowers support top (gap0.6 top=${topLayerWithType(rGap, 5)} < gap0.2 top=${topLayerWithType(rSup, 5)})`)
// ③ enable_support=false → type5 == 0
ok(typeTotal(rNo, 5) === 0, `enable_support=false → no support (type5=${typeTotal(rNo, 5)})`)

// --- Raft ---
const rRaft = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, raft_layers: 2 }), () => {})
ok(rRaft.stats.raft_layers === 2 && rRaft.stats.model_layers === r.stats.model_layers,
   `raft_layers=2, model_layers=${rRaft.stats.model_layers} (== no-raft ${r.stats.model_layers})`)
ok(countByType(rRaft.layers[0].paths)[6] > 0 && countByType(rRaft.layers[1].paths)[6] > 0,
   `first 2 layers are raft (type6): ${countByType(rRaft.layers[0].paths)[6]}, ${countByType(rRaft.layers[1].paths)[6]}`)
ok(/^; raft/m.test(rRaft.gcode), 'G-code has "; raft" marker')
ok(rRaft.layers[2].z > 0.5 && r.layers[0].z < 0.5,
   `model z shifted up by raft (raft model layer0 z=${rRaft.layers[2].z.toFixed(2)} vs no-raft ${r.layers[0].z.toFixed(2)})`)
ok(rRaft.layers.length === rRaft.stats.layers, `raft: layers array (${rRaft.layers.length}) == stats.layers (${rRaft.stats.layers})`)

// --- Bed parameterization ---
const rBed = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, bed_width: 200, bed_depth: 200 }), () => {})
ok(/off=100\.0,100\.0/.test(rBed.gcode), 'bed 200 → offset 100 (header off=100.0,100.0)')
ok(/off=128\.0,128\.0/.test(r.gcode), 'default bed 256 → offset 128')
// bed200 coordinates sit around 100, bed256 around 128
const firstX = (g) => { const m = g.match(/^G1 X([\d.]+)/m); return m ? parseFloat(m[1]) : NaN }
ok(firstX(rBed.gcode) < 115 && firstX(r.gcode) > 115, `X offset applied (bed200 X=${firstX(rBed.gcode).toFixed(1)} < bed256 X=${firstX(r.gcode).toFixed(1)})`)

// ===== New in stage 4 (path and G-code level) =====
console.log('\n[stage4]')
const g0count = (g) => (g.match(/^G0 /gm) || []).length
// (1) Every infill pattern slices successfully with segments > 0
for (const pat of ['rectilinear', 'grid', 'triangles', 'zigzag', 'gyroid']) {
  const rp = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, sparse_infill_pattern: pat }), () => {})
  ok(!rp.error && rp.stats.path_segments > 0, `pattern ${pat}: slices ok, segments=${rp.error ? 'ERR' : rp.stats.path_segments}`)
}
// (2) zigzag travel < rectilinear
const rRect = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, sparse_infill_pattern: 'rectilinear' }), () => {})
const rZig  = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, sparse_infill_pattern: 'zigzag' }), () => {})
ok(g0count(rZig.gcode) < g0count(rRect.gcode), `zigzag travels (${g0count(rZig.gcode)}) < rectilinear (${g0count(rRect.gcode)})`)

// (3) Cooling fan: 0 on the first layer, then a ramp, then M107
const fanS = [...r.gcode.matchAll(/^M106 S(\d+)$/gm)].map(m => +m[1])
ok(fanS.length > 0 && fanS[0] === 0, `first layer fan = 0 (first M106 S${fanS[0]})`)
ok(fanS.includes(255), `fan ramps to full 255 (distinct: ${[...new Set(fanS)].join(',')})`)
ok(fanS[0] < fanS[fanS.length - 1], `fan monotonic ramp ${fanS[0]}→${fanS[fanS.length - 1]}`)
ok(/^M107$/m.test(r.gcode), 'M107 present (fan off at end)')

// (4) Slowdown: small layers are slowed (default 8s) vs disabled (0)
const layerFeed = (g, li) => {   // F of the layer's first XY extrusion move (skipping retract/unretract E-only lines)
  const lines = g.split('\n'); const k = lines.findIndex(l => l.startsWith(`; LAYER ${li} `)); if (k < 0) return NaN
  for (let j = k + 1; j < lines.length && !lines[j].startsWith('; LAYER'); j++) { const m = lines[j].match(/^G1 X[\d.-]+ Y[\d.-]+ E[\d.]+ F(\d+)$/); if (m) return +m[1] }
  return NaN
}
const rFast = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, slow_down_layer_time: 0 }), () => {})
ok(layerFeed(rFast.gcode, 10) === 3600, `no-slowdown layer10 feed=${layerFeed(rFast.gcode, 10)} (=print 3600)`)
ok(layerFeed(r.gcode, 10) < 3600 && layerFeed(r.gcode, 10) >= 1200, `slowdown layer10 feed=${layerFeed(r.gcode, 10)} (<3600, >=1200 floor)`)

// (5) Arc fitting: cylinder -> G2/G3 present + extrusion volume preserved within ±1%
const cyl = makeCylinderSTL(10, 6, 64)
writeFileSync(join(here, 'cylinder.stl'), cyl)
const rArcOff = Module.slice(new Uint8Array(cyl), JSON.stringify({ ...params, enable_arc_fitting: false }), () => {})
const rArcOn  = Module.slice(new Uint8Array(cyl), JSON.stringify({ ...params, enable_arc_fitting: true }), () => {})
ok(/^G[23] /m.test(rArcOn.gcode), `arc fitting on → G2/G3 present (${(rArcOn.gcode.match(/^G[23] /gm) || []).length} arcs)`)
ok(!/^G[23] /m.test(rArcOff.gcode), 'arc fitting off → no G2/G3')
const arcDev = Math.abs(rArcOn.stats.filament_mm - rArcOff.stats.filament_mm) / rArcOff.stats.filament_mm
ok(arcDev < 0.01, `arc extrusion within ±1% (Δ=${(arcDev * 100).toFixed(3)}%)`)

// (6) Seam position: back = fixed, random = scattered (and deterministic)
const firstWallStart = (layer) => { const p = layer.paths; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 1) return [p[i], p[i + 1]]; return null }
const seamSpread = (res) => {
  const xs = [], ys = []
  for (let li = 5; li < res.layers.length - 5; li++) { const s = firstWallStart(res.layers[li]); if (s) { xs.push(s[0]); ys.push(s[1]) } }
  const sp = a => a.length ? Math.max(...a) - Math.min(...a) : 0
  return sp(xs) + sp(ys)
}
const rBack = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, seam_position: 'back' }), () => {})
const rRand = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, seam_position: 'random' }), () => {})
const rRand2 = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, seam_position: 'random' }), () => {})
ok(seamSpread(rBack) < 1.0, `seam back fixed (spread ${seamSpread(rBack).toFixed(2)}mm)`)
ok(seamSpread(rRand) > 5.0, `seam random dispersed (spread ${seamSpread(rRand).toFixed(2)}mm)`)
ok(rRand.gcode === rRand2.gcode, 'seam random deterministic (identical gcode on rerun)')
ok(/seam=back/.test(r.gcode) && /pattern=rectilinear/.test(r.gcode), 'G-code header carries pattern/seam')

// (7) Spiral (vase): slices successfully and Z rises within a layer
const rSpiral = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, spiral_mode: true }), () => {})
ok(!rSpiral.error && /^G1 X[\d.]+ Y[\d.]+ Z[\d.]+ E/m.test(rSpiral.gcode), 'spiral: extrude moves carry rising Z')

// ===== New in stage 5 (gap fill · thin wall · scarf · pressure advance · tree-lite · bridge) =====
console.log('\n[stage5]')

// (1) Gap fill: a 2.5w ring (0.5w leftover gap) -> type7 present. Absent on a solid cube (backwards compatible).
const rRing = Module.slice(new Uint8Array(makeRingSTL()), JSON.stringify(params), () => {})
ok(!rRing.error && typeTotal(rRing, 7) > 0, `gap-fill on 2.5w ring (type7=${rRing.error ? 'ERR' : typeTotal(rRing, 7)})`)
ok(typeTotal(r, 7) === 0, `solid cube has no gap-fill (type7=${typeTotal(r, 7)})`)

// (2) Thin wall (Arachne-lite): a thin cross -> the arms carry a center line (type8), and the thick hub keeps 2 wall loops.
const rCross = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify(params), () => {})
ok(!rCross.error && typeTotal(rCross, 8) > 0, `thin cross → thin-wall centerline (type8=${rCross.error ? 'ERR' : typeTotal(rCross, 8)})`)
ok(typeTotal(r, 8) === 0, `solid cube has no thin-wall (type8=${typeTotal(r, 8)})`)
// Does the thick hub get a second wall: wall_loops 2 yields more wall segments than 1 (added only on the hub)
const rCross1 = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify({ ...params, wall_loops: 1 }), () => {})
ok(typeTotal(rCross, 1) > typeTotal(rCross1, 1),
   `thick hub takes 2nd wall (wall2 type1=${typeTotal(rCross, 1)} > wall1 type1=${typeTotal(rCross1, 1)})`)

// (3) Scarf seam: seam_slope_type=external -> a ; scarf marker + the seam's z is midway (zE-h < z < zE).
const rScarf = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, seam_slope_type: 'external' }), () => {})
ok(/^; scarf$/m.test(rScarf.gcode), 'scarf: "; scarf" marker present')
ok(!/^; scarf$/m.test(r.gcode), 'no scarf marker when seam_slope_type=none (default)')
const scarfLayerZ = (g, li) => {   // extrusion Z values of layer li
  const lines = g.split('\n'); const k = lines.findIndex(l => l.startsWith(`; LAYER ${li} `)); if (k < 0) return []
  const out = []; for (let j = k + 1; j < lines.length && !lines[j].startsWith('; LAYER'); j++) { const m = lines[j].match(/Z([\d.]+) E/); if (m) out.push(+m[1]) }
  return out
}
const z5 = scarfLayerZ(rScarf.gcode, 5)   // layer5 zE=1.2, h=0.2 -> midway between (1.0, 1.2)
ok(z5.some(z => z > 1.0 + 1e-6 && z < 1.2 - 1e-6), `scarf ramp has intermediate z in (1.0,1.2): ${[...new Set(z5)].filter(z => z > 1.0 && z < 1.2).map(z => z.toFixed(3)).slice(0, 3).join(',')}`)

// (4) Pressure advance: enabled -> M900 K<v> in the preamble; disabled -> absent.
const rPA = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, enable_pressure_advance: true, pressure_advance: 0.045 }), () => {})
ok(/^M900 K0\.045/m.test(rPA.gcode), 'pressure advance: M900 K0.045 present when enabled')
ok(!/^M900/m.test(r.gcode), 'no M900 when pressure advance disabled (default)')

// (5) Tree-lite: tapers downward -> the lower support span < the upper one, narrower at the bottom than grid, and touches down. (overhang table)
const supSpan = (Ly) => { let a = 1e9, b = -1e9, c = 1e9, d = -1e9, n = 0; const p = Ly.paths; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 5) { a = Math.min(a, p[i]); b = Math.max(b, p[i]); c = Math.min(c, p[i + 1]); d = Math.max(d, p[i + 1]); n++ } return n ? Math.max(b - a, d - c) : 0 }
const supLayers = (res) => res.layers.map(Ly => ({ z: Ly.z, span: supSpan(Ly) })).filter(x => x.span > 0)
const rTree = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, support_style: 'tree_lite' }), () => {})
const rGridS = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, support_style: 'grid' }), () => {})
const tL = supLayers(rTree), gL = supLayers(rGridS)
const treeTop = tL[tL.length - 1].span, treeBot = tL[0].span, gridBot = gL[0].span
console.log(`  tree spans: top=${treeTop.toFixed(1)} bot=${treeBot.toFixed(1)}  grid bot=${gridBot.toFixed(1)}  tree grounds z=${tL[0].z.toFixed(2)}`)
ok(treeTop > treeBot + 1.0, `tree_lite tapers: top span ${treeTop.toFixed(1)} > bottom span ${treeBot.toFixed(1)} (top > bottom)`)
ok(treeBot < gridBot - 0.5, `tree_lite narrower than grid at bottom (${treeBot.toFixed(1)} < ${gridBot.toFixed(1)})`)
ok(tL[0].z < 1.0, `tree_lite grounds near bed (lowest support z=${tL[0].z.toFixed(2)})`)
// Stage 33: the material comparison was corrected from "segment count" to "real path length".
//  The count is an inaccurate proxy — the narrower the region, the more direction changes and short segments,
//  so the count can rise even when tapering uses less material (measured: 705 vs 704, an inversion). Length is the real material usage.
const supPathLen = (r) => (r.layers || []).reduce((a, Ly) => {
  const p = Ly.paths; if (!p) return a
  let s = 0
  for (let i = 0; i < p.length; i += 8) if (p[i+3] === 5 || p[i+3] === 6) s += Math.hypot(p[i+4]-p[i], p[i+5]-p[i+1])
  return a + s
}, 0)
const tLen = supPathLen(rTree), gLen = supPathLen(rGridS)
ok(tLen <= gLen, `tree_lite uses <= grid support material (path length ${tLen.toFixed(0)}mm <= ${gLen.toFixed(0)}mm)`)

// (6) Bridge: an unsupported bottom (the overhang cap's underside) -> type9 + ; bridge. Table without support. Absent on a solid cube.
const rBridge = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(params), () => {})
ok(typeTotal(rBridge, 9) > 0 && /^; bridge/m.test(rBridge.gcode), `unsupported overhang bottom → bridge (type9=${typeTotal(rBridge, 9)})`)
ok(typeTotal(r, 9) === 0, `solid cube has no bridge (type9=${typeTotal(r, 9)})`)

// Backwards compatible: with every stage-5 parameter at its default, the cube result is unchanged (layer count, filament)
const rCompat = Module.slice(new Uint8Array(stlBin), JSON.stringify({
  ...params, seam_slope_type: 'none', enable_pressure_advance: false, support_style: 'grid',
}), () => {})
ok(rCompat.stats.layers === r.stats.layers && Math.abs(rCompat.stats.filament_mm - r.stats.filament_mm) < 1e-6,
   'stage-5 defaults keep cube result unchanged (backward compatible)')

// ===== New in stage 6 (ironing · wall avoidance · PE-lite · multi-material) =====
console.log('\n[stage6]')

// (1) Ironing: type10 exists on the cube's top layer with flow ~10% (comparing E/mm), and is absent when off.
const rIron = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, ironing_type: 'top' }), () => {})
ok(typeTotal(rIron, 10) > 0, `ironing on → top-surface re-pass (type10=${typeTotal(rIron, 10)})`)
ok(typeTotal(r, 10) === 0, `ironing off (default) → no type10 (${typeTotal(r, 10)})`)
const blockEperMM = (g, marker) => {   // E/mm of the first long extrusion in the marker block (position tracked via G0)
  const lines = g.split('\n'); const k = lines.findIndex(l => l.trim() === marker); if (k < 0) return null
  let px = null, py = null
  for (let j = k + 1; j < lines.length && !lines[j].startsWith('; LAYER') && lines[j].trim() !== '; end'; j++) {
    const g0 = lines[j].match(/^G0 X([\d.-]+) Y([\d.-]+)/); if (g0) { px = +g0[1]; py = +g0[2]; continue }
    const m = lines[j].match(/^G1 X([\d.-]+) Y([\d.-]+) E([\d.]+)/)
    if (m) { const x = +m[1], y = +m[2], e = +m[3]; if (px !== null) { const d = Math.hypot(x - px, y - py); if (d > 1) return e / d } px = x; py = y }
  }
  return null
}
const firstBigE = (g) => { const lines = g.split('\n'); let px = null, py = null; for (const l of lines) { const g0 = l.match(/^G0 X([\d.-]+) Y([\d.-]+)/); if (g0) { px = +g0[1]; py = +g0[2]; continue } const m = l.match(/^G1 X([\d.-]+) Y([\d.-]+) E([\d.]+)/); if (m) { const x = +m[1], y = +m[2], e = +m[3]; if (px !== null) { const d = Math.hypot(x - px, y - py); if (d > 1) return e / d } px = x; py = y } } return null }
const ironE = blockEperMM(rIron.gcode, '; ironing'), normalE = firstBigE(r.gcode)
ok(ironE && normalE && Math.abs(ironE / normalE - 0.1) < 0.02, `ironing flow ~10% of normal (ratio=${(ironE / normalE).toFixed(3)})`)

// (2) Wall-avoiding travel: on the L shape, reduce_crossing_wall=true lowers the number of travels crossing the outer wall.
const rWoff = Module.slice(new Uint8Array(makeLShapeSTL()), JSON.stringify({ ...params, reduce_crossing_wall: false }), () => {})
const rWon = Module.slice(new Uint8Array(makeLShapeSTL()), JSON.stringify({ ...params, reduce_crossing_wall: true }), () => {})
console.log(`  L-shape wall crossings: off=${rWoff.stats.wall_crossings} on=${rWon.stats.wall_crossings}`)
ok(rWoff.stats.wall_crossings > 0, `L-shape has wall-crossing travels without avoidance (${rWoff.stats.wall_crossings})`)
ok(rWon.stats.wall_crossings < rWoff.stats.wall_crossings, `reduce_crossing_wall lowers crossings (${rWon.stats.wall_crossings} < ${rWoff.stats.wall_crossings})`)

// (3) PE-lite: with slope set, the rate of change in volumetric flow between adjacent extrusions stays within the limit. (overhang table: bridge speed difference)
const maxPEslope = (g) => {   // maximum per-layer rate of change in volumetric flow (mm³/s²) between adjacent extrusions. Tracked across travels, reset at ; LAYER.
  const lines = g.split('\n'); let maxS = 0, curF = null, px = null, py = null, lastFlow = null
  const Adep = 0.2 * (0.42 - 0.2 * (1 - Math.PI / 4))   // deposited cross-section at h0.2 (mm²)
  for (const l of lines) {
    if (l.startsWith('; LAYER')) { lastFlow = null; px = null; py = null; curF = null; continue }
    const g0 = l.match(/^G0 X([\d.-]+) Y([\d.-]+)/); if (g0) { px = +g0[1]; py = +g0[2]; continue }
    const m = l.match(/^G1 X([\d.-]+) Y([\d.-]+) E[\d.]+/); if (!m) continue
    const fm = l.match(/F(\d+)/); if (fm) curF = +fm[1]
    const x = +m[1], y = +m[2]
    if (px !== null && curF) { const d = Math.hypot(x - px, y - py); if (d > 0.05) { const v = curF / 60, flow = Adep * v, t = d / v; if (lastFlow !== null && t > 0) { const s = Math.abs(flow - lastFlow) / t; if (s > maxS) maxS = s } lastFlow = flow } }
    px = x; py = y
  }
  return maxS
}
const rPEoff = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(params), () => {})
const rPEon = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...params, max_volumetric_extrusion_rate_slope: 40 }), () => {})
const peOff = maxPEslope(rPEoff.gcode), peOn = maxPEslope(rPEon.gcode)
console.log(`  PE flow-slope (mm³/s²): off=${peOff.toFixed(1)} on(limit40)=${peOn.toFixed(1)}`)
ok(peOff > 40, `without PE the flow-slope exceeds limit (${peOff.toFixed(1)} > 40)`)
ok(peOn <= 40 + 1.0, `PE-lite caps flow-slope to limit (${peOn.toFixed(1)} ≤ 40)`)
ok(Math.abs(rPEon.stats.filament_mm - rPEoff.stats.filament_mm) < 1e-6, `PE changes speed not E (filament identical)`)

// (4) Multi-material: T0/T1 + prime tower (type11). The single-material path is unchanged.
const { stl: mmStl, split: mmSplit } = makeTwoBoxSTL()
const rMM = Module.slice(new Uint8Array(mmStl), JSON.stringify({ ...params, extruder_count: 2, mm_group_split: mmSplit }), () => {})
ok(!rMM.error, `multimaterial slices ok (layers=${rMM.error ? 'ERR' : rMM.stats.layers})`)
ok(/^T0$/m.test(rMM.gcode) && /^T1$/m.test(rMM.gcode), `MM has tool changes T0 and T1`)
ok(typeTotal(rMM, 11) > 0, `MM prime tower emitted (type11=${typeTotal(rMM, 11)})`)
// The default is the fallback ring again: the real WipeTower port is not reproducible (see the [wipe tower]
//  section). Both markers are asserted so a silent flip of the default in either direction fails here.
ok(/^; prime tower \(ring, \d+ loops/m.test(rMM.gcode), `MM uses the deterministic ring by default`)
ok(!/wipe_tower_real: real ported WipeTower/.test(rMM.gcode), `and does not reach for the real tower unasked`)
// With an explicit opt-out (wipe_tower_real=false) the old square ring path is kept
const rMMring = Module.slice(new Uint8Array(mmStl), JSON.stringify({ ...params, extruder_count: 2, mm_group_split: mmSplit, wipe_tower_real: false }), () => {})
ok(/^; prime tower \(ring, \d+ loops/m.test(rMMring.gcode) && typeTotal(rMMring, 11) > 0, `wipe_tower_real=false keeps the ring fallback`)
const rSingle = Module.slice(new Uint8Array(mmStl), JSON.stringify(params), () => {})
ok(!/^T[01]$/m.test(rSingle.gcode) && typeTotal(rSingle, 11) === 0, `single-material path unchanged (no T0/T1, no prime tower)`)

// Per-extruder filament: two materials mean two temperatures and two flow ratios. Without the arrays the MM
//  output must stay exactly what it was, so the same slice is compared both ways.
const mmBase = { ...params, extruder_count: 2, mm_group_split: mmSplit }
const rMMmat = Module.slice(new Uint8Array(mmStl), JSON.stringify({ ...mmBase,
  extruder_nozzle_temp: [270, 220], extruder_flow_ratio: [0.95, 0.98],
  extruder_retract_length: [0.8, 0.4], extruder_z_hop: [0.4, 0.2] }), () => {})
ok(!rMMmat.error, `per-extruder filament slices ok`)
const startTemp = rMMmat.gcode.match(/^M109 S(\d+)/m)?.[1]
const afterT1 = rMMmat.gcode.split(/^T1$/m)[1] ?? ''
ok(startTemp === '270', `preamble heats to T0's material (M109 S${startTemp}, expected 270)`)
ok(/^M109 S220$/m.test(afterT1), `switching to T1 heats to its own material (M109 S220)`)
ok(/^M109 S270$/m.test(afterT1.split(/^T0$/m)[1] ?? ''), `switching back to T0 restores its temperature`)
ok(Math.abs(rMMmat.stats.filament_mm - rMM.stats.filament_mm) > 1e-6,
   `per-extruder flow ratio changes the extruded amount (${rMMmat.stats.filament_mm.toFixed(2)} vs ${rMM.stats.filament_mm.toFixed(2)} mm)`)
const rMMnoArrays = Module.slice(new Uint8Array(mmStl), JSON.stringify(mmBase), () => {})
ok(rMMnoArrays.gcode === rMM.gcode, `MM without per-extruder arrays is byte-identical to before`)

// N-way grouping: three boxes, one per extruder. A single mm_group_split can only express two groups, so the
//  third box used to be folded into the second and printed with its material.
const { stl: mm3Stl, splits: mm3Splits } = makeThreeBoxSTL()
const r3 = Module.slice(new Uint8Array(mm3Stl), JSON.stringify({ ...params,
  extruder_count: 3, mm_group_splits: mm3Splits, mm_group_tools: [0, 1, 2],
  extruder_nozzle_temp: [270, 220, 240], extruder_flow_ratio: [0.95, 0.98, 1.0] }), () => {})
ok(!r3.error, `three-material slice ok (layers=${r3.error ? 'ERR' : r3.stats.layers})`)
ok(/^T2$/m.test(r3.gcode), `third extruder gets its own tool (T2)`)
ok(/^M109 S240$/m.test(r3.gcode), `third extruder heats to its own material (M109 S240)`)
const temps3 = [...r3.gcode.matchAll(/^M109 S(\d+)$/gm)].map(m => m[1])
ok(new Set(temps3).size === 3, `all three materials reach the G-code (temps: ${[...new Set(temps3)].join(', ')})`)
// The old single-boundary form on the same geometry proves what was broken: T2 never appears.
const r3old = Module.slice(new Uint8Array(mm3Stl), JSON.stringify({ ...params,
  extruder_count: 3, mm_group_split: mm3Splits[0],
  extruder_nozzle_temp: [270, 220, 240] }), () => {})
ok(!/^T2$/m.test(r3old.gcode), `a single boundary still yields two groups only (regression guard)`)

// Per-tool filament accounting: a single total cannot say "ABS 1820mm, PLA 980mm", and the filament profiles carry
//  cost/density per material — so the split is what a cost estimate is built from. It must reconcile exactly with
//  the unchanged filament_mm total, or the cost it feeds is wrong.
const byTool = rMM.stats.filament_mm_by_tool
ok(Array.isArray(byTool) && byTool.length >= 2, `MM reports filament_mm_by_tool (${JSON.stringify(byTool)})`)
const byToolSum = byTool.reduce((a, b) => a + b, 0)
ok(Math.abs(byToolSum - rMM.stats.filament_mm) < 1e-6,
   `per-tool filament sums to the total (${byToolSum.toFixed(4)} == ${rMM.stats.filament_mm.toFixed(4)})`)
ok(byTool.every(v => v > 0), `both extruders consume filament (${byTool.map(v => v.toFixed(1)).join(', ')} mm)`)
// The purge is separated because painting multiplies tool changes and the purge total is the only number a user can act on.
ok(rMM.stats.filament_mm_purge > 0 && rMM.stats.filament_mm_purge < rMM.stats.filament_mm,
   `prime tower purge reported on its own (${rMM.stats.filament_mm_purge.toFixed(1)} of ${rMM.stats.filament_mm.toFixed(1)} mm)`)
const byTool3 = r3.stats.filament_mm_by_tool
ok(byTool3.length === 3 && Math.abs(byTool3.reduce((a, b) => a + b, 0) - r3.stats.filament_mm) < 1e-6,
   `three-material: one slot per extruder and the sum still matches (${byTool3.map(v => v.toFixed(1)).join(', ')} mm)`)
// The ring fallback purges too, so the figure is not tied to the real WipeTower path.
ok(rMMring.stats.filament_mm_purge > 0, `ring fallback also reports its purge (${rMMring.stats.filament_mm_purge.toFixed(1)}mm)`)

// ===== Painted multi-material: the paint splits the SLICED POLYGONS, not the triangle list ======================
//  A triangle group is a whole object, so grouping by triangle index can never give one object's layer two
//  materials. These checks are on the region split, the per-layer tool ordering, and the tool channel in the stream.
console.log('\n[paint MM]')
const mmPaint = { ...params, extruder_count: 2 }
const wedge1 = makeWedgeSTL(1)
const paintSlope = (wedgeIndex, state) => Module.selector_paint_state(
  wedgeIndex * WEDGE_FACETS + WEDGE_SLOPE_FACET,
  wedgeIndex * WEDGE_PITCH + 10, 10, 15,        // hit: the middle of the slanted face
  wedgeIndex * WEDGE_PITCH + 10, 10, 60, 16,    // camera above it; radius 16 reaches the whole face
  state)
// Tools actually used by the extrusions of one layer (travels carry the tool too but print nothing; the prime
//  tower is excluded because it belongs to the purge, not to the model's regions).
const modelToolsOf = (L) => {
  const tools = new Set()
  for (let i = 0; i < L.paths.length; i += 8) {
    const role = ROLE_OF(L.paths[i+3]); if (role === 0 || role === 11) continue
    tools.add(TOOL_OF(L.paths[i+3]))
  }
  return [...tools].sort()
}
const toolBoxOf = (L, tool) => {
  const b = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, n: 0 }
  for (let i = 0; i < L.paths.length; i += 8) {
    const role = ROLE_OF(L.paths[i+3]); if (role === 0 || role === 11) continue
    if (TOOL_OF(L.paths[i+3]) !== tool) continue
    for (const [ax, ay] of [[0,1],[4,5]]) {
      b.x0 = Math.min(b.x0, L.paths[i+ax]); b.x1 = Math.max(b.x1, L.paths[i+ax])
      b.y0 = Math.min(b.y0, L.paths[i+ay]); b.y1 = Math.max(b.y1, L.paths[i+ay])
    }
    b.n++
  }
  return b
}

// Reference first: the same model with nothing painted must not touch the painted path at all.
Module.selector_prepare(new Uint8Array(wedge1)); Module.selector_clear()
const rWedgeClean = Module.slice(new Uint8Array(wedge1), JSON.stringify(mmPaint), () => {})
ok(!/^T\d+$/m.test(rWedgeClean.gcode), `unpainted model with 2 extruders declared stays on the single-material path`)

// (1) The painted area prints with the painted extruder, and — this is what the exact segmentation buys — only the
//     part of the layer the paint actually covers. The wedge's slanted face is ONE of the four sides of every
//     cross-section above z=10, so those layers must come out SPLIT: the slope's own edge on T1, the back wall and
//     the two ends still on T0. The volume projector this replaced could not express that; it laid the facet's XY
//     shadow over the whole plane, so the same paint used to turn every layer above z=10 entirely into T1.
Module.selector_prepare(new Uint8Array(wedge1))
paintSlope(0, 2)                                  // state 2 == Extruder2 == T1
ok(Module.selector_painted_count_state(2) > 0, `painting the slanted face marks facets (${Module.selector_painted_count_state(2)})`)
const rWedge = Module.slice(new Uint8Array(wedge1), JSON.stringify(mmPaint), () => {})
ok(!rWedge.error && /^T1$/m.test(rWedge.gcode), `painted single object reaches the multi-tool path (T1 emitted)`)
let belowPaintWrong = 0, splitLayers = 0, plainLayers = 0
for (const L of rWedge.layers) {
  const tools = modelToolsOf(L); if (tools.length === 0) continue          // z=10.00 and the very tip print nothing
  if (L.z < 10.0 - 1e-6) { if (tools.includes(1)) belowPaintWrong++; else plainLayers++; continue }
  if (tools.length > 1) splitLayers++
}
ok(belowPaintWrong === 0 && plainLayers > 20,
   `no layer below the painted face is touched (${plainLayers} plain / ${belowPaintWrong} wrong)`)
ok(splitLayers > 20,
   `a layer whose contour is only partly painted comes out SPLIT between the two tools (${splitLayers} such layers)`)
// The split follows the geometry: the slope rises in +y, so at z the cross-section is y in [2(z-10), 20] and the
//  painted edge is its LOW-y side. T1 therefore has to start at the front edge and T0 has to reach the back wall.
const Lsplit = rWedge.layers.find(L => Math.abs(L.z - 15.0) < 1e-6)
const splitT1 = toolBoxOf(Lsplit, 1), splitT0 = toolBoxOf(Lsplit, 0)
ok(splitT1.n > 0 && splitT0.n > 0 && splitT1.y0 < splitT0.y0 && splitT0.y1 > 19,
   `and on the painted side: T1 starts at the slope edge (y0 ${splitT1.y0.toFixed(1)}) while T0 keeps the back wall (y1 ${splitT0.y1.toFixed(1)})`)
ok(rWedge.stats.filament_mm_by_tool[1] > 0 && rWedge.stats.filament_mm_by_tool[0] > 0,
   `both extruders consume filament (${rWedge.stats.filament_mm_by_tool.map(v => v.toFixed(1)).join(', ')} mm)`)

// (2) No painted facets -> byte-identical to the same slice before anything was painted.
Module.selector_clear()
const rWedgeCleared = Module.slice(new Uint8Array(wedge1), JSON.stringify(mmPaint), () => {})
ok(rWedgeCleared.gcode === rWedgeClean.gcode, `clearing the paint restores the unpainted G-code byte for byte`)
// ... and an untooled stream never sets the tool bits, which is what keeps every older consumer reading it correctly.
const maxRoleField = (res) => res.layers.reduce((m, L) => {
  for (let i = 0; i < L.paths.length; i += 8) m = Math.max(m, L.paths[i+3]); return m }, 0)
ok(maxRoleField(rWedgeCleared) < 16 && maxRoleField(r) < 16,
   `single-material streams stay bare role values (max role field ${maxRoleField(r)} < 16)`)
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
Module.selector_prepare(new Uint8Array(wedge1)); Module.selector_clear()
Module.selector_prepare(new Uint8Array(wedge1))
paintSlope(0, 2)
const facetsBeforeErase = Module.selector_painted_count_state(2)
// How much of the painted face still reaches the layers it covers. Under the exact segmentation a fully painted
//  slope already leaves those layers split (the slope is one side of the cross-section), so "a layer gained a
//  second tool" no longer tells an erase from a paint. What an erase must do is take AREA away from the painted
//  extruder while leaving some of it, so the measure is the painted tool's own share of the layer's extrusions.
const paintedShare = (result) => {
  let painted = 0, total = 0
  for (const L of result.layers) {
    if (L.z < 10.0 - 1e-6) continue
    for (let i = 0; i < L.paths.length; i += 8) {
      const role = ROLE_OF(L.paths[i+3]); if (role === 0 || role === 11) continue
      total++; if (TOOL_OF(L.paths[i+3]) === 1) painted++
    }
  }
  return total ? painted / total : 0
}
const shareBeforeErase = paintedShare(Module.slice(new Uint8Array(wedge1), JSON.stringify(mmPaint), () => {}))
eraseSlope(0, 4)                                  // a cursor smaller than the face -> only its middle is given back
const shareAfterErase = paintedShare(Module.slice(new Uint8Array(wedge1), JSON.stringify(mmPaint), () => {}))
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
const rFullErase = Module.slice(new Uint8Array(wedge1), JSON.stringify(mmPaint), () => {})
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
  Module.selector_prepare(new Uint8Array(overlapSTL)); Module.selector_clear()
  Module.selector_prepare(new Uint8Array(overlapSTL))
  const leg = () => Module.selector_paint_state(OVERLAP_LEG_FACET, 10, 10, 10.15, 10, 10,  50,  5, legState)
  const cap = () => Module.selector_paint_state(OVERLAP_CAP_FACET, 10, 10, 10.15, 10, 10, -40, 20, capState)
  if (legFirst) { leg(); cap() } else { cap(); leg() }
  return Module.slice(new Uint8Array(overlapSTL), JSON.stringify({ ...params, extruder_count: 3 }), () => {})
}
const rOverlapHighLeg = paintOverlap(3, 2, true)      // the leg (the smaller, enclosed area) carries Extruder3
const Lhl = rOverlapHighLeg.layers.find(L => Math.abs(L.z - OVERLAP_Z) < 1e-6)
const boxT2 = toolBoxOf(Lhl, 2), boxT1 = toolBoxOf(Lhl, 1)
// The leg (Extruder3 -> T2) stops at z=10.15, so on the z=10.2 layer — which is pure cap — it owns nothing.
ok(boxT2.n === 0, `the enclosed leg claims nothing on a layer it no longer reaches (T2 segments ${boxT2.n})`)
ok(boxT1.n > 0 && boxT1.x0 < 1 && boxT1.x1 > 19,
   `the surface that IS on that outline owns it: T1 spans the 20x20 cap (x[${boxT1.x0.toFixed(2)},${boxT1.x1.toFixed(2)}])`)
// Where the leg does exist it keeps its own 6x6 footprint — the paint is confined to the geometry that carries it.
const LlegMid = rOverlapHighLeg.layers.find(L => Math.abs(L.z - 8.0) < 1e-6)
const legT2 = toolBoxOf(LlegMid, 2)
ok(legT2.n > 0 && legT2.x0 > 6.4 && legT2.x1 < 13.6 && legT2.y0 > 6.4 && legT2.y1 < 13.6,
   `and on a layer it does reach, it stays inside the 6x6 leg (x[${legT2.x0.toFixed(2)},${legT2.x1.toFixed(2)}])`)
// Swap which surface carries which extruder: the winner follows the extruder NUMBER, not the surface or the order.
const rOverlapHighCap = paintOverlap(2, 3, true)
const Lhc = rOverlapHighCap.layers.find(L => Math.abs(L.z - OVERLAP_Z) < 1e-6)
ok(modelToolsOf(Lhc).join() === '2' && toolBoxOf(Lhc, 2).x1 > 19,
   `with Extruder3 on the enclosing surface the whole overlap layer is T2 (tools=${modelToolsOf(Lhc)})`)
// What the priority rule promises is that the TOOL ASSIGNMENT is order-independent, not that the G-code is
//  byte-identical. It cannot be: TriangleSelector subdivides a facet as it is painted, so brushing the leg before
//  the cap leaves a different split tree than the reverse, and a slightly different split projects to slightly
//  different region polygons (measured: same facet counts 12/2226 either way, identical per-layer tool sets and
//  identical filament to 3 decimals, but ~650 characters of G-code apart). Assert the promise, not the bytes.
const layerToolsOf = (r) => r.layers.map(modelToolsOf).map(tools => tools.join('/')).join(',')
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
Module.selector_prepare(new Uint8Array(wedge3)); Module.selector_clear()
Module.selector_prepare(new Uint8Array(wedge3))
paintSlope(0, 2); paintSlope(2, 2)
const rWedge3 = Module.slice(new Uint8Array(wedge3), JSON.stringify(mmPaint), () => {})
const layerBlocks = rWedge3.gcode.split(/^; LAYER /m).slice(1)
let repeatedToolLayers = 0, maxToolCmds = 0
for (const block of layerBlocks) {
  const tools = [...block.matchAll(/^T(\d+)$/gm)].map(m => m[1])
  maxToolCmds = Math.max(maxToolCmds, tools.length)
  if (new Set(tools).size !== tools.length) repeatedToolLayers++
}
ok(layerBlocks.length > 50 && repeatedToolLayers === 0 && maxToolCmds <= 1,
   `no layer enters a tool twice (${layerBlocks.length} layers, at most ${maxToolCmds} tool change per layer)`)
const Lmid = rWedge3.layers.find(L => Math.abs(L.z - 15.0) < 1e-6)
const midT1 = toolBoxOf(Lmid, 1), midT0 = toolBoxOf(Lmid, 0)
ok(midT1.x0 < WEDGE_PITCH && midT1.x1 > 2 * WEDGE_PITCH,
   `T1 really does hold two separate regions on that one entry (x[${midT1.x0.toFixed(1)},${midT1.x1.toFixed(1)}] spans wedge 0 and wedge 2)`)
// The middle wedge is untouched, so nothing of it may be printed with the painted tool. T0's own bounding box no
//  longer isolates it — under the exact segmentation T0 also owns the unpainted sides of wedges 0 and 2 — so the
//  claim is made per segment instead: inside the middle wedge's x band there must be T0 extrusions and no T1 ones.
const inMiddleWedge = (L, tool) => {
  let n = 0
  for (let i = 0; i < L.paths.length; i += 8) {
    const role = ROLE_OF(L.paths[i+3]); if (role === 0 || role === 11) continue
    if (TOOL_OF(L.paths[i+3]) !== tool) continue
    const x = L.paths[i]
    if (x > WEDGE_PITCH && x < 2 * WEDGE_PITCH) n++
  }
  return n
}
ok(inMiddleWedge(Lmid, 0) > 0 && inMiddleWedge(Lmid, 1) === 0,
   `the unpainted wedge keeps the group's own tool (T0 ${inMiddleWedge(Lmid, 0)} segments there, T1 ${inMiddleWedge(Lmid, 1)})`)
Module.selector_clear()   // leave the selector clean for whatever runs after this section

// support_filament / support_interface_filament (upstream coInt, 0 = "Default" = keep the loaded tool).
const rSupFilNone = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, support_filament: 0, support_interface_filament: 0 }), () => {})
ok(rSupFilNone.gcode === rSup.gcode, `support_filament=0 leaves the support G-code byte-identical`)
ok(!/^T\d+$/m.test(rSup.gcode), `default support emits no tool change at all`)
// filament index 2 -> tool T1 for both the base and the interface
const rSupFilT1 = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, support_filament: 2, support_interface_filament: 2 }), () => {})
ok(/^T1$/m.test(rSupFilT1.gcode), `support_filament=2 prints support with T1`)
ok(/^T0$/m.test(rSupFilT1.gcode), `and switches back to the object tool afterwards`)
// The default support_style=grid goes through the upstream port, which emits one support body (supTree) — so the
//  interface/base split, and with it a separate interface filament, only exists on the kernel's own grid path.
const supKernel = { ...supP, support_style: 'grid_kernel' }
const rSupFilSplit = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supKernel, support_filament: 3, support_interface_filament: 2 }), () => {})
ok(/^T2$/m.test(rSupFilSplit.gcode) && /^T1$/m.test(rSupFilSplit.gcode),
   `base and interface can use different filaments (T2 base / T1 interface)`)
const supFirstLines = (rSupFilSplit.gcode.split(/^; support$/m)[1] ?? '').split('\n')
ok(/^T[12]$/.test(supFirstLines[1] ?? ''), `the tool change opens the support block (line after "; support" = ${JSON.stringify(supFirstLines[1])})`)
const rSupKernelNone = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(supKernel), () => {})
ok(!/^T\d+$/m.test(rSupKernelNone.gcode), `the same path with the default 0 emits no tool change`)

// Backwards compatible: with every stage-6 parameter at its default, the cube result is unchanged
const rCompat6 = Module.slice(new Uint8Array(stlBin), JSON.stringify({
  ...params, ironing_type: 'no ironing', reduce_crossing_wall: false, max_volumetric_extrusion_rate_slope: 0, extruder_count: 1,
}), () => {})
ok(rCompat6.stats.layers === r.stats.layers && Math.abs(rCompat6.stats.filament_mm - r.stats.filament_mm) < 1e-6,
   'stage-6 defaults keep cube result unchanged (backward compatible)')

// ===== Exact per-layer segmentation (the ported MultiMaterialSegmentation) ==========================================
//  What it replaced laid a painted facet's XY shadow over every slicing plane the facet spanned, so a small patch
//  came out as the whole band of layers it crossed, and a horizontal face came out as a slab. These check the two
//  properties that costs bought: a patch keeps its own OUTLINE, and a flat face lands in its SHELL.
console.log('\n[segmentation]')
const segBox = makeBoxSTL(20, 20, 20)             // kernel coords: x,y in [0,20], z in [0,20]
const segParams = { ...params, extruder_count: 3 }
const segToolLayers = (r, tool) => {
  const zs = []
  for (const L of r.layers) for (let i = 0; i < L.paths.length; i += 8) {
    const role = ROLE_OF(L.paths[i+3]); if (role === 0 || role === 11) continue
    if (TOOL_OF(L.paths[i+3]) === tool) { zs.push(+L.z.toFixed(2)); break }
  }
  return zs
}
// (1) A 5mm brush patch on one wall keeps its own footprint: it may not spread across the layer, and it may not
//     spread onto the other walls. Measured before this: T1 covered the full 0.2..19.8 extent of every layer it
//     touched, because the shadow of a wall facet is the whole wall.
Module.selector_prepare(new Uint8Array(segBox))
Module.selector_paint_state(6, 20, 5, 5, 60, 5, 5, 5, 2)      // facet 6 = the x=20 wall, patch centred at (20,5,5)
const rSegPatch = Module.slice(new Uint8Array(segBox), JSON.stringify(segParams), () => {})
const patchLayers = segToolLayers(rSegPatch, 1)
const patchBox = rSegPatch.layers.filter(L => Math.abs(L.z - 5.0) < 1e-6).map(L => toolBoxOf(L, 1))[0]
ok(patchLayers.length > 0 && patchLayers[patchLayers.length - 1] < 11,
   `a wall patch stays within the layers it spans (T1 on z ${patchLayers[0]}..${patchLayers[patchLayers.length-1]})`)
ok(patchBox.n > 0 && patchBox.x0 > 9 && patchBox.y1 < 11,
   `and within its own corner of those layers (x[${patchBox.x0.toFixed(1)},${patchBox.x1.toFixed(1)}] y[${patchBox.y0.toFixed(1)},${patchBox.y1.toFixed(1)}])`)

// (2) Two patches on opposite walls stay two separate regions — the segmentation partitions the contour, so the
//     extruders are disjoint without any priority rule deciding between them.
Module.selector_prepare(new Uint8Array(segBox))
Module.selector_paint_state(6, 20, 5, 5, 60, 5, 5, 5, 2)      // x=20 wall, low
Module.selector_paint_state(8, 5, 20, 15, 5, 60, 15, 5, 3)    // y=20 wall, high
const rSegTwo = Module.slice(new Uint8Array(segBox), JSON.stringify(segParams), () => {})
const twoT1 = segToolLayers(rSegTwo, 1), twoT2 = segToolLayers(rSegTwo, 2)
ok(twoT1.length > 0 && twoT2.length > 0 && twoT1[twoT1.length-1] < twoT2[0],
   `two patches at different heights keep their own layers (T1 ..${twoT1[twoT1.length-1]}, T2 ${twoT2[0]}..)`)
const twoLow = rSegTwo.layers.find(L => Math.abs(L.z - 5.0) < 1e-6)
const twoHigh = rSegTwo.layers.find(L => Math.abs(L.z - 15.0) < 1e-6)
ok(toolBoxOf(twoLow, 1).x0 > 9 && toolBoxOf(twoHigh, 2).y0 > 9,
   `and their own corners (low patch x0 ${toolBoxOf(twoLow,1).x0.toFixed(1)}, high patch y0 ${toolBoxOf(twoHigh,2).y0.toFixed(1)})`)

// (3) A flat outer face lands in its SHELL, not in a slab: the number of layers it colours is exactly the shell
//     count. This is the pass upstream calls segmentation_top_and_bottom_layers, and it is what makes painting a
//     top surface mean anything at all — a horizontal facet cuts no slicing plane, so nothing else can carry it.
for (const [label, facet, hitZ, key] of [
  ['top', 2, 20, 'top_shell_layers'], ['bottom', 0, 0, 'bottom_shell_layers'],
]) {
  Module.selector_prepare(new Uint8Array(segBox))
  Module.selector_seed_fill(facet, 10, 10, hitZ, 30, 2)      // smart fill: exactly the two facets of that face
  const rShell = Module.slice(new Uint8Array(segBox), JSON.stringify({ ...segParams, extruder_count: 2 }), () => {})
  const shellLayers = segToolLayers(rShell, 1)
  ok(shellLayers.length === segParams[key],
     `a painted ${label} face colours exactly ${key}=${segParams[key]} layers (got ${shellLayers.length}: ${shellLayers.join(' ')})`)
}

// (4) The shell pass is not only about the model's outermost faces: an overhang's UNDERSIDE is a bottom surface
//     too, and painting it has to reach the bottom shell printed against the air below it. Same fixture as the
//     support tests — a 6x6 leg carrying a 20x20 cap — so the painted face is genuinely interior to the model's
//     bounding box while still being a real bottom surface.
//     (Note for anyone probing this by hand: the face must be wound the way an STL winds it. A bottom face given
//      counter-clockwise reads as an UPWARD facing one, lands in the top projection, and is then occluded away by
//      the layer above — which looks exactly like the paint being ignored.)
const overhang = trisToSTL([...boxTris(7, 7, 0, 6, 6, 10), ...boxTris(0, 0, 10, 20, 20, 4)])
const overhangShell = (facet, hitZ) => {
  Module.selector_prepare(new Uint8Array(overhang))
  Module.selector_seed_fill(facet, 10, 10, hitZ, 30, 2)
  return segToolLayers(Module.slice(new Uint8Array(overhang), JSON.stringify({ ...params, extruder_count: 2 }), () => {}), 1)
}
const capTopLayers = overhangShell(14, 14), capUnderLayers = overhangShell(12, 10)
ok(capTopLayers.length === params.top_shell_layers,
   `the cap's TOP face colours its top shell (${capTopLayers.length} layers: ${capTopLayers.join(' ')})`)
ok(capUnderLayers.length === params.bottom_shell_layers && capUnderLayers[0] > 10,
   `and its UNDERSIDE the bottom shell printed against the air (${capUnderLayers.length} layers: ${capUnderLayers.join(' ')})`)
Module.selector_clear()

// ===== Per-feature filament ids · filament_map · per-tool purge ====================================================
console.log('\n[filament assignment]')
const featBox = makeBoxSTL(20, 20, 20)
const featParams = { ...params, extruder_count: 2 }
const toolsOfRole = (r, role) => {                    // which tools printed a given role, over the whole result
  const tools = new Set()
  for (const L of r.layers) for (let i = 0; i < L.paths.length; i += 8)
    if (ROLE_OF(L.paths[i+3]) === role) tools.add(TOOL_OF(L.paths[i+3]))
  return [...tools].sort()
}
Module.selector_clear()
// (1) An unset id changes nothing: 0 is upstream's "Default", and 1 is the default extruder itself, so neither adds
//     a second tool and neither may reach the multi-tool path.
const rFeatNone = Module.slice(new Uint8Array(featBox), JSON.stringify(featParams), () => {})
const rFeatOne  = Module.slice(new Uint8Array(featBox), JSON.stringify({ ...featParams, outer_wall_filament_id: 1 }), () => {})
ok(rFeatOne.gcode === rFeatNone.gcode, `filament id 1 (the default extruder) leaves the G-code byte-identical`)

// (2) outer_wall_filament_id=2 moves the OUTER WALL to T1 and nothing else. Walls are role 1 and infill role 2, so
//     the claim is checked on the roles rather than on a bounding box.
const rOuter = Module.slice(new Uint8Array(featBox), JSON.stringify({ ...featParams, outer_wall_filament_id: 2 }), () => {})
ok(/^T1$/m.test(rOuter.gcode), `outer_wall_filament_id=2 reaches the multi-tool path (T1 emitted)`)
ok(toolsOfRole(rOuter, 1).join() === '0,1' && toolsOfRole(rOuter, 2).join() === '0',
   `the walls are split over both tools while the infill stays on T0 (walls ${toolsOfRole(rOuter,1)}, infill ${toolsOfRole(rOuter,2)})`)

// (3) sparse_infill_filament_id=2 moves the INFILL instead — the mirror image, which is what says the id is read
//     per feature and not just "something switched tools".
const rInfill = Module.slice(new Uint8Array(featBox), JSON.stringify({ ...featParams, sparse_infill_filament_id: 2 }), () => {})
ok(toolsOfRole(rInfill, 2).join() === '1' && toolsOfRole(rInfill, 1).join() === '0',
   `sparse_infill_filament_id=2 moves only the infill (walls ${toolsOfRole(rInfill,1)}, infill ${toolsOfRole(rInfill,2)})`)

// (4) The surface ids reach the solid infill now that this path detects shells. Solid is role 3, so the claim is
//     checked on the role rather than on the comment that used to say the id was ignored.
const rSurface = Module.slice(new Uint8Array(featBox), JSON.stringify({ ...featParams, top_surface_filament_id: 2 }), () => {})
ok(toolsOfRole(rSurface, 3).join() === '1' && toolsOfRole(rSurface, 1).join() === '0',
   `a surface filament id moves the solid infill and nothing else (solid ${toolsOfRole(rSurface,3)}, walls ${toolsOfRole(rSurface,1)})`)

// (5) filament_map: two filaments in ONE physical extruder still purge; in two extruders they never mix, so the
//     tower is skipped entirely. Without the option nothing changes — that is what keeps every existing slice safe.
const mapped = (map) => Module.slice(new Uint8Array(featBox),
  JSON.stringify({ ...featParams, outer_wall_filament_id: 2, ...(map ? { filament_map: map } : {}) }), () => {})
const rNoMap = mapped(null), rSameNozzle = mapped([1, 1]), rTwoNozzles = mapped([1, 2])
// The map itself is echoed in the header, so the comparison is against everything below it: what must not change
//  is the PRINT — same tool changes, same purges, same extrusions.
const withoutMapHeader = (g) => g.split('\n').filter(line => !line.startsWith('; MM filament_map')).join('\n')
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
ok(Math.abs(purgeByTool.reduce((a, b) => a + b, 0) - rNoMap.stats.filament_mm_purge) < 1e-6,
   `the per-tool purge sums to the purge total (${purgeByTool.reduce((a,b)=>a+b,0).toFixed(3)} vs ${rNoMap.stats.filament_mm_purge.toFixed(3)})`)
ok(rNoMap.stats.filament_mm_by_tool.every((total, t) => total - purgeByTool[t] > -1e-6),
   `and never exceeds that tool's own total, so model = total - tower stays a real figure`)

// ===== Filament identity in the G-code (upstream GCode.cpp footer) ==================================================
//  Upstream always writes the per-filament totals and a config dump; here both are opt-in so the default output the
//  golden guard pins cannot move. These check that the opt-in produces upstream's shape, and that leaving it off
//  produces the byte-identical G-code it always did.
console.log('\n[filament identity]')
const idBox = makeBoxSTL(20, 20, 20)
const idBase = { ...params, extruder_count: 2, outer_wall_filament_id: 2 }
Module.selector_clear()
const rPlain = Module.slice(new Uint8Array(idBox), JSON.stringify(idBase), () => {})
ok(!/CONFIG_BLOCK_START/.test(rPlain.gcode) && !/filament used \[mm\]/.test(rPlain.gcode),
   `the footer blocks are off by default, so existing output is untouched`)

const idFull = { ...idBase, gcode_stats_block: true, gcode_config_block: true,
                 filament_type: ['PLA', 'ABS'], filament_settings_id: ['Generic PLA @X1', 'Generic ABS @X1'],
                 filament_density: [1.24, 1.04], filament_cost: [20, 30] }
const rFull = Module.slice(new Uint8Array(idBox), JSON.stringify(idFull), () => {})
const line = (re) => (rFull.gcode.match(re) ?? [])[0] ?? ''
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
const mms   = (rFull.gcode.match(/^; filament used \[mm\] = ([\d.]+), ([\d.]+)$/m) ?? []).slice(1).map(Number)
const area  = Math.PI * params.filament_diameter * params.filament_diameter / 4
ok(grams.length === 2 && Math.abs(grams[0] - mms[0] * area * 0.001 * 1.24) < 0.02
                      && Math.abs(grams[1] - mms[1] * area * 0.001 * 1.04) < 0.02,
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
const rPetg = Module.slice(new Uint8Array(idBox), JSON.stringify({ ...idBase, filament_type: ['PLA', 'PETG'] }), () => {})
const rNoPetg = Module.slice(new Uint8Array(idBox), JSON.stringify({ ...idBase, filament_type: ['PLA', 'ABS'] }), () => {})
ok(/PETG extra unretract/.test(rPetg.gcode) && !/PETG extra unretract/.test(rNoPetg.gcode),
   `a tool change to PETG unretracts extra, and only for PETG`)
ok(rNoPetg.gcode === rPlain.gcode, `naming a material that needs no special handling changes nothing`)
// TPU on the first layer is a fact the machine's start G-code needs.
const rTpu = Module.slice(new Uint8Array(idBox), JSON.stringify({ ...idBase, filament_type: ['TPU', 'ABS'] }), () => {})
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
const loopsOf = (r) => Number((r.gcode.match(/^; prime tower \(ring, (\d+) loops/m) ?? [])[1] ?? 0)
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
const toolShare = (r, t) => (r.stats.filament_mm_by_tool ?? [])[t] ?? 0
ok(toolShare(rFlush, 1) > toolShare(rTowerOff, 1),
   `the purging tool prints the diverted infill (T2 ${toolShare(rTowerOff,1).toFixed(1)} -> ${toolShare(rFlush,1).toFixed(1)} mm)`)
// Total extrusion is unchanged by WHERE the infill is printed — the lines were going to be laid either way.
ok(Math.abs(rFlush.stats.filament_mm - rTowerOff.stats.filament_mm) < rTowerOff.stats.filament_mm * 0.05,
   `and moving infill between tools does not change how much is extruded (${rTowerOff.stats.filament_mm.toFixed(1)} vs ${rFlush.stats.filament_mm.toFixed(1)} mm)`)

// ===== Wipe tower: the real port is not deterministic ===============================================================
//  Pinned rather than left as folklore. The fallback ring must stay reproducible (it is what ships by default), and
//  the real tower's defect must stay visible until it is fixed — a slicer whose output changes between identical
//  runs cannot be diffed, and its F0 feedrates are not something a printer accepts.
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
ok(realRuns.every(r => Math.abs(r.stats.filament_mm - realRuns[0].stats.filament_mm) < 1e-6),
   `the real tower is stable in WHAT it extrudes (${realRuns[0].stats.filament_mm.toFixed(4)} mm every run)`)
// The defect does not reproduce on every model — on this cube the three runs agree. It reproduces on the overlap
//  fixture with three extruders, which is what makes an uninitialised read the likely cause: the same code, a
//  different heap, a different answer. Pinned on the case that shows it, so a real fix flips this assertion.
const towerRun = () => {
  Module.selector_prepare(new Uint8Array(overlapSTL)); Module.selector_clear()
  Module.selector_prepare(new Uint8Array(overlapSTL))
  Module.selector_paint_state(OVERLAP_LEG_FACET, 10, 10, 10.15, 10, 10, 50, 5, 3)
  Module.selector_paint_state(OVERLAP_CAP_FACET, 10, 10, 10.15, 10, 10, -40, 20, 2)
  return Module.slice(new Uint8Array(overlapSTL), JSON.stringify({ ...params, extruder_count: 3, wipe_tower_real: true }), () => {})
}
const towerRuns = [towerRun(), towerRun(), towerRun()]
const f0Counts = towerRuns.map(r => (r.gcode.match(/ F0$/gm) ?? []).length)
const reproducible = towerRuns[0].gcode === towerRuns[1].gcode && towerRuns[1].gcode === towerRuns[2].gcode
ok(towerRuns.every(r => Math.abs(r.stats.filament_mm - towerRuns[0].stats.filament_mm) < 1e-6),
   `and stable in its totals on the fixture that breaks it too (${towerRuns[0].stats.filament_mm.toFixed(4)} mm)`)
ok(!reproducible || f0Counts.some(n => n > 0),
   `KNOWN DEFECT, pinned: the real tower is not reproducible and emits F0 feedrates (F0 per run: ${f0Counts.join(', ')})`)
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
const towerZs = [], changeZs = []
for (const L of rTower.layers) {
  let tower = false
  const tools = new Set()
  for (let i = 0; i < L.paths.length; i += 8) {
    const role = ROLE_OF(L.paths[i+3])
    if (role === 11) tower = true
    else if (role !== 0) tools.add(TOOL_OF(L.paths[i+3]))
  }
  if (tower) towerZs.push(+L.z.toFixed(2))
  if (tools.size > 1) changeZs.push(+L.z.toFixed(2))
}
ok(changeZs.length > 0 && changeZs[0] > 20, `the tool changes really are high up (first at z=${changeZs[0]})`)
ok(towerZs[0] === rTower.layers[0].z, `the tower starts on the FIRST layer (z=${towerZs[0]}), not in mid-air`)
// Continuous: every layer from the bed to the last change carries tower material — a gap is a floating slab.
const lastChange = changeZs[changeZs.length - 1]
const towerSet = new Set(towerZs)
const gaps = rTower.layers.filter(L => L.z <= lastChange + 1e-6 && !towerSet.has(+L.z.toFixed(2))).length
ok(gaps === 0, `no gaps: every layer up to the last change (z=${lastChange}) carries tower material (${towerZs.length} layers)`)
ok(towerZs[towerZs.length - 1] <= lastChange + 1e-6,
   `and none above it (top tower z=${towerZs[towerZs.length - 1]} <= ${lastChange})`)
// The sustain rings are purge-account material: the per-tool purge still sums to the total, and the split the
//  stats card shows (model = by_tool - purge_by_tool) stays a real figure.
const towerPurge = rTower.stats.filament_mm_purge_by_tool
ok(Math.abs(towerPurge.reduce((a, b) => a + b, 0) - rTower.stats.filament_mm_purge) < 1e-6,
   `sustain rings are charged to the purge account (${rTower.stats.filament_mm_purge.toFixed(1)} mm total)`)
Module.selector_clear()

// ===== Painting tools other than the radius brush: smart fill, bucket fill, single triangle, circle cursor ======
//  All four reach the SAME selector the brush writes, so what these check is that each tool selects a different and
//  sensible set of facets — not that the resulting G-code differs, which the section above already covers.
console.log('\n[paint tools]')
const toolBox = makeBoxSTL(20, 20, 20)              // kernel coords: x,y in [0,20] (XY as-is), z in [0,20]
const TOP_FACET = 2, WALL_FACET = 6                 // boxFaces order: 2,3 = top (z=20); 6,7 = the x=20 wall
const paintedTotal = () => { let n = 0; for (let s = 1; s <= 16; s++) n += Module.selector_painted_count_state(s); return n }
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
const wallWidths = (res) => {
  const out = []
  for (let li = 3; li < res.layers.length - 3; li++) {
    const p = res.layers[li].paths, w = res.layers[li].widths
    if (!w) continue
    let k = 0
    for (let i = 0; i < p.length; i += 8) { if (p[i + 3] === 1 && w[k] > 0) out.push(w[k]); k++ }
  }
  return out
}
const wspan = (a) => a.length ? { min: Math.min(...a), max: Math.max(...a), n: a.length } : { min: 0, max: 0, n: 0 }

// (1) arachne cube: slices fine and the wall width is uniform ≈ w (thick shape)
const rArCube = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, wall_generator: 'arachne' }), () => {})
const acw = wspan(wallWidths(rArCube))
ok(!rArCube.error && acw.n > 0, `arachne cube slices ok (${rArCube.error ? 'ERR' : 'wall segs ' + acw.n})`)
ok(Math.abs(acw.min - 0.42) < 0.03 && Math.abs(acw.max - 0.42) < 0.03, `arachne cube walls ~uniform w (min=${acw.min.toFixed(3)} max=${acw.max.toFixed(3)})`)

// (2) arachne thin cross: wall width varies (min<max) and the thin arms exceed w (within the 50~150% range)
const rArCross = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify({ ...params, wall_generator: 'arachne' }), () => {})
const axw = wspan(wallWidths(rArCross))
console.log(`  arachne cross wall width mm: min=${axw.min.toFixed(3)} max=${axw.max.toFixed(3)} n=${axw.n}`)
ok(!rArCross.error && axw.max - axw.min > 0.05, `arachne thin cross → VARIABLE bead width (min=${axw.min.toFixed(3)} < max=${axw.max.toFixed(3)})`)
ok(axw.min >= 0.42 * 0.5 - 1e-3 && axw.max <= 0.42 * 1.5 + 1e-3, `arachne widths within 50–150% of w (${axw.min.toFixed(3)}..${axw.max.toFixed(3)})`)

// (3) E is width-based — E/mm in the arachne wall G-code varies with width (wider segments raise E per unit length)
const wallEperMM = (g) => {
  const lines = g.split('\n'); const out = []; let px = null, py = null, inWall = false
  for (const l of lines) {
    if (l.includes('; walls (Arachne')) { inWall = true; px = null; continue }
    if (l.startsWith(';')) { inWall = false }   // ends at the next feature comment (z-hop G1 Z is a travel, so it is kept)
    const g0 = l.match(/^G0 X([\d.-]+) Y([\d.-]+)/); if (g0) { px = +g0[1]; py = +g0[2]; continue }
    const m = l.match(/^G1 X([\d.-]+) Y([\d.-]+) E([\d.]+)/)
    if (m) { const x = +m[1], y = +m[2], e = +m[3]; if (inWall && px !== null) { const d = Math.hypot(x - px, y - py); if (d > 0.3) out.push(e / d) } px = x; py = y }
  }
  return out
}
const eArr = wallEperMM(rArCross.gcode)
const eSpan = wspan(eArr.filter(x => x > 0))
console.log(`  arachne cross wall E/mm: min=${eSpan.min.toFixed(5)} max=${eSpan.max.toFixed(5)} n=${eSpan.n}`)
ok(eSpan.n > 0 && eSpan.max > eSpan.min * 1.15, `wall E/mm scales with bead width (spread ${eSpan.min.toFixed(4)}→${eSpan.max.toFixed(4)})`)

// (4) Backwards compatible: the default (classic) matches the stage-6 result and widths are uniformly w
ok(typeTotal(rArCube, 1) > 0 && typeTotal(r, 1) > 0, `both classic & arachne emit walls (type1)`)
const rClassicCube = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, wall_generator: 'classic' }), () => {})
ok(rClassicCube.stats.layers === r.stats.layers && Math.abs(rClassicCube.stats.filament_mm - r.stats.filament_mm) < 1e-6,
   'stage-7 default (classic) keeps cube result unchanged (backward compatible)')
const ccw = wspan(wallWidths(rClassicCube))
ok(Math.abs(ccw.min - 0.42) < 1e-2 && Math.abs(ccw.max - 0.42) < 1e-2, `classic widths array = uniform line_width (${ccw.min.toFixed(3)})`)

// ===== New in stage 8 (the real OrcaSlicer Fill pattern port — gyroid TPMS and friends) =====
console.log('\n[stage8]')
const fillCube = makeBoxSTL(30, 30, 20)
const fparams = { ...params, infill_density: 0.20 }
const sparseSegs = (res) => res.layers.reduce((a, Ly) => { const p = Ly.paths; let c = 0; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 2) c++; return a + c }, 0)
// (1) The ported patterns slice successfully with segments > 0 (gyroid/honeycomb/3dhoneycomb/crosshatch/concentric)
for (const pat of ['gyroid', 'honeycomb', '3dhoneycomb', 'crosshatch', 'concentric']) {
  const rp = Module.slice(new Uint8Array(fillCube), JSON.stringify({ ...fparams, sparse_infill_pattern: pat }), () => {})
  ok(!rp.error && sparseSegs(rp) > 0, `ported Fill '${pat}': slices ok, sparse segs=${rp.error ? 'ERR' : sparseSegs(rp)}`)
}
// (2) Upstream gyroid (TPMS) vs the approximated gyroid: different segment structure
const rGyR = Module.slice(new Uint8Array(fillCube), JSON.stringify({ ...fparams, sparse_infill_pattern: 'gyroid' }), () => {})
const rGyA = Module.slice(new Uint8Array(fillCube), JSON.stringify({ ...fparams, sparse_infill_pattern: 'gyroid_approx' }), () => {})
console.log(`  gyroid real segs=${sparseSegs(rGyR)} vs approx segs=${sparseSegs(rGyA)}`)
ok(sparseSegs(rGyR) > 0 && sparseSegs(rGyA) > 0 && sparseSegs(rGyR) !== sparseSegs(rGyA),
   `real gyroid (TPMS) differs from sine-approx (real=${sparseSegs(rGyR)} != approx=${sparseSegs(rGyA)})`)
// (3) gyroid TPMS z phase: the sparse geometry differs between two z levels (the surface phase changes with z)
const gyLayers = rGyR.layers.filter(L => { const p = L.paths; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 2) return true; return false })
const sigOf = (L) => { const p = L.paths; let s = 0, n = 0; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 2) { s += p[i] * 7.3 + p[i + 1] * 3.1; n++ } return n ? s / n : 0 }
const sLo = sigOf(gyLayers[Math.floor(gyLayers.length * 0.3)]).toFixed(3)
const sHi = sigOf(gyLayers[Math.floor(gyLayers.length * 0.7)]).toFixed(3)
console.log(`  gyroid TPMS z-phase: loLayer sig=${sLo} hiLayer sig=${sHi}`)
ok(sLo !== sHi, `real gyroid has TPMS z-phase (geometry varies with z: ${sLo} != ${sHi})`)
// (4) Backwards compatible: gyroid_approx still uses the old sine approximation (present) and rectilinear's default is unchanged
ok(sparseSegs(rGyA) > 0, `gyroid_approx (legacy sine) still available (segs=${sparseSegs(rGyA)})`)

// (5) The real PressureEqualizer port (pe_lite:false): runs without crashing or mangling, preserves total E and keeps the structure.
//  ⚠ The real PE only adjusts flow in g-code tagged with OrcaSlicer's ;_EXTRUDE_SET_SPEED -> it passes straight through our plain mini-kernel g-code.
//  Here we verify that "the port links, runs and does not corrupt the resulting g-code" (the need for tags is recorded as a limitation in the README).
const eSumOf = (g) => { let s = 0; for (const m of g.matchAll(/ E(-?[\d.]+)/g)) s += parseFloat(m[1]); return s }
const rRealPEoff = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(params), () => {})
const rRealPE = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...params, max_volumetric_extrusion_rate_slope: 2.0, pe_lite: false }), () => {})
ok(!rRealPE.error && /^; LAYER/m.test(rRealPE.gcode) && /^M104/m.test(rRealPE.gcode), `real PE port runs + preserves g-code structure (; LAYER, M104)`)
ok(Math.abs(eSumOf(rRealPE.gcode) - eSumOf(rRealPEoff.gcode)) < 0.01, `real PE conserves total E (${eSumOf(rRealPE.gcode).toFixed(2)} ≈ ${eSumOf(rRealPEoff.gcode).toFixed(2)})`)
ok(Math.abs(rRealPE.stats.filament_mm - rRealPEoff.stats.filament_mm) < 1e-6, `real PE: filament stat unchanged (speed-only)`)

// ===== New in stage 9 (full real PE integration — OrcaSlicer tag emission + segment splitting) =====
console.log('\n[stage9]')
const g9cube = makeBoxSTL(20, 20, 10)
const g1count = (g) => (g.match(/^G1 /gm) || []).length
const hasTag = (g) => /;_EXTRUDE_SET_SPEED/.test(g) || /;_EXTRUSION_ROLE:/.test(g) || /;_EXTRUDE_END/.test(g)
// (1) emit_pe_tags=true with strip off -> all 3 tag kinds present (OrcaSlicer format)
const r9tags = Module.slice(new Uint8Array(g9cube), JSON.stringify({ ...params, emit_pe_tags: true, pe_strip_tags: false }), () => {})
ok(/;_EXTRUDE_SET_SPEED/.test(r9tags.gcode) && /;_EXTRUSION_ROLE:/.test(r9tags.gcode) && /;_EXTRUDE_END/.test(r9tags.gcode),
   `emit_pe_tags → ;_EXTRUDE_SET_SPEED/;_EXTRUSION_ROLE/;_EXTRUDE_END all present`)
// (2) Defaults -> no tags (backwards compatible)
const r9def = Module.slice(new Uint8Array(g9cube), JSON.stringify(params), () => {})
ok(!hasTag(r9def.gcode), `default: no PE tags emitted (backward compatible)`)
// (3) Real PE (arachne walls = variable flow -> splitting): more G1 lines + total E preserved + tags stripped at the end (strip by default)
const r9off = Module.slice(new Uint8Array(g9cube), JSON.stringify({ ...params, wall_generator: 'arachne' }), () => {})
const r9pe = Module.slice(new Uint8Array(g9cube), JSON.stringify({ ...params, wall_generator: 'arachne', max_volumetric_extrusion_rate_slope: 1.0, pe_lite: false }), () => {})
console.log(`  real PE: G1 off=${g1count(r9off.gcode)} on=${g1count(r9pe.gcode)}, E off=${eSumOf(r9off.gcode).toFixed(2)} on=${eSumOf(r9pe.gcode).toFixed(2)}`)
ok(g1count(r9pe.gcode) > g1count(r9off.gcode), `real PE splits/ramps → G1 line count increases (${g1count(r9off.gcode)}→${g1count(r9pe.gcode)})`)
ok(Math.abs(eSumOf(r9pe.gcode) - eSumOf(r9off.gcode)) < 0.05, `real PE conserves total E (${eSumOf(r9pe.gcode).toFixed(2)} ≈ ${eSumOf(r9off.gcode).toFixed(2)})`)
ok(!hasTag(r9pe.gcode), `real PE output: tags stripped by default (clean g-code)`)
// (4) F ramp steps: the split G1 F markers really are inserted
const fRamp = (g) => (g.match(/^G1 F\d+\s*$/gm) || []).length
ok(fRamp(r9pe.gcode) > 0, `real PE inserts feedrate ramp steps (G1 F markers: ${fRamp(r9pe.gcode)})`)

// ===== New in stage 10 (the ported GCodeProcessor time estimate — the upstream trapezoidal planner) =====
console.log('\n[stage10]')
const g10 = makeBoxSTL(20, 20, 10)
// (1) The cube G-code parses successfully with a total time > 0
const t10 = Module.slice(new Uint8Array(g10), JSON.stringify(params), () => {})
ok(!t10.error && typeof t10.stats.time_estimate === 'number' && t10.stats.time_estimate > 0,
   `GCodeProcessor time estimate: total=${t10.stats.time_estimate.toFixed(1)}s (>0)`)
ok(t10.stats.time_moves > 0 && t10.stats.layer_times.length > 0,
   `parsed ${t10.stats.time_moves} moves, ${t10.stats.layer_times.length} layer times`)
// per-layer times sum to total (single write site)
const ltSum = t10.stats.layer_times.reduce((a, b) => a + b, 0)
ok(Math.abs(ltSum - t10.stats.time_estimate) / t10.stats.time_estimate < 0.001,
   `layer_times sum ${ltSum.toFixed(1)} == total ${t10.stats.time_estimate.toFixed(1)}`)
// (2) Faster speed parameters shorten the time (physically consistent direction)
const t10slow = Module.slice(new Uint8Array(g10), JSON.stringify({ ...params, print_speed: 30 }), () => {})
const t10fast = Module.slice(new Uint8Array(g10), JSON.stringify({ ...params, print_speed: 120 }), () => {})
ok(t10fast.stats.time_estimate < t10slow.stats.time_estimate,
   `faster print_speed -> less time (30mm/s=${t10slow.stats.time_estimate.toFixed(0)}s > 120mm/s=${t10fast.stats.time_estimate.toFixed(0)}s)`)
// (3) Parsed filament == the kernel's own calculation (±2%)
const fdelta = Math.abs(t10.stats.filament_mm - t10.stats.time_filament_mm) / t10.stats.filament_mm
ok(fdelta <= 0.02, `parsed filament == kernel stat within 2% (${t10.stats.time_filament_mm.toFixed(1)} vs ${t10.stats.filament_mm.toFixed(1)}, ${(fdelta * 100).toFixed(2)}%)`)
// Time breakdown per role (PE tag mode)
const t10tag = Module.slice(new Uint8Array(g10), JSON.stringify({ ...params, emit_pe_tags: true, pe_strip_tags: false }), () => {})
ok(Object.keys(t10tag.stats.role_times).length > 0,
   `role time breakdown present in tag mode (roles: ${Object.keys(t10tag.stats.role_times).join(',')})`)
// determinism: identical params -> identical estimate
const t10b = Module.slice(new Uint8Array(g10), JSON.stringify(params), () => {})
ok(t10.stats.time_estimate === t10b.stats.time_estimate, `time estimate is deterministic`)

// ===== Where the model sits must not change what it slices to =====================================================
//  The viewer used to re-centre its slice input on the XY origin, because a model placed away from it lost infill —
//  measured on this very box: sparse 828 -> 414, solid 427 -> 183, with no error and no warning. The cause was in
//  infill_lines (clip_util.h): each pattern line was drawn through the origin-projected foot and extended by the
//  region's own SIZE, so a region further from the origin than that was simply never reached. That centring is what
//  made the slice frame follow the model, which in turn is what made the prime tower and the paint drift.
console.log('\n[position invariance]')
const posBox = makeBoxSTL(20, 20, 20)   // tall enough that most layers are sparse, which is what went missing
const translateSTL = (stl, dx, dy) => {
  const out = Buffer.from(stl)
  const n = out.readUInt32LE(80)
  for (let t = 0, off = 84; t < n; t++, off += 2) {
    off += 12
    for (let k = 0; k < 3; k++, off += 12) {
      out.writeFloatLE(out.readFloatLE(off) + dx, off)
      out.writeFloatLE(out.readFloatLE(off + 4) + dy, off + 4)
    }
  }
  return out
}
const posParams = { ...params, layer_height: 0.2, infill_density: 0.15, bed_width: 400, bed_depth: 400 }
const rolesAt = (dx, dy) => {
  const r = Module.slice(new Uint8Array(translateSTL(posBox, dx, dy)), JSON.stringify(posParams), () => {})
  const c = { 0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0,10:0,11:0 }
  for (const L of r.layers) for (let i = 0; i < L.paths.length; i += 8) c[ROLE_OF(L.paths[i+3])]++
  return { counts: c, filament: r.stats.filament_mm }
}
//  The box is at x,y in [0,20] as makeBoxSTL builds it, so dx=-10 is the centred case the workaround produced and
//  everything else is a placement that used to come out short.
const posBase = rolesAt(-10, -10)
for (const [name, dx, dy] of [['as built (x,y in [0,20])', 0, 0], ['off +x', 30, 0], ['off +x +y', 30, 30],
                              ['negative both', -60, -60], ['far corner', 60, 60]]) {
  const here = rolesAt(dx, dy)
  const same = Object.keys(posBase.counts).every(role => posBase.counts[role] === here.counts[role])
  const segments = Object.values(here.counts).reduce((a, b) => a + b, 0)
  ok(same && Math.abs(posBase.filament - here.filament) < 1e-3,
     `${name}: same slice as centred (${here.filament.toFixed(1)}mm, ${segments} segments, same in every role)`)
}

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
const keptAcrossMove = Module.selector_reprepare(new Uint8Array(translateSTL(moveBox, 40, 25)))
ok(keptAcrossMove === true, `re-registering the moved mesh reports the marks kept`)
ok(Module.selector_painted_count_state(2) === paintedBeforeMove,
   `the same facets are still painted after the move (${Module.selector_painted_count_state(2)})`)
//  And the marks must not follow a mesh they were never on: a different face count is a different model, so the
//  call says so instead of dropping the paint somewhere arbitrary.
const twoTriangles = Buffer.alloc(84 + 2 * 50)
twoTriangles.writeUInt32LE(2, 80)
for (const [t, tri] of [[0, [[0,0,0],[20,0,0],[0,20,0]]], [1, [[0,0,0],[0,20,0],[0,0,20]]]]) {
  let off = 84 + t * 50 + 12
  for (const v of tri) { twoTriangles.writeFloatLE(v[0], off); twoTriangles.writeFloatLE(v[1], off+4); twoTriangles.writeFloatLE(v[2], off+8); off += 12 }
}
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
const cubeAtEdge = translateSTL(makeBoxSTL(20, 20, 20), 80, -10)

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
const bedModelOff = sliceOnBed(translateSTL(makeBoxSTL(20, 20, 20), 95, -10), { skirt_loops: 0, brim_width: 0 })
ok(bedModelOff.stats.over_bed === true && bedModelOff.stats.over_bed_model === true,
   `a model past the bed edge is still reported by the model check`)
ok(bedModelOff.stats.over_bed_x > 14, `...and now carries how far past it reaches (${bedModelOff.stats.over_bed_x.toFixed(2)}mm)`)

//  Nothing near an edge: skirt and brim both on, and still no overflow claimed.
const bedCentred = sliceOnBed(makeBoxSTL(20, 20, 20), { skirt_loops: 2, skirt_distance: 2, brim_width: 5 })
ok(bedCentred.stats.over_bed === false, `a centred model with skirt+brim stays on the bed`)

//  Height has the same shape of hole: a raft lifts every model layer, so the MODEL's height cannot say whether the
//  print clears the ceiling. Upstream takes this from the same G-code as a second warning (ToolHeightOutside — the
//  top layer's z against max_print_height), so the emitted top z is what gets compared here too.
const bedCeil = { ...bedParams, skirt_loops: 0, brim_width: 0, bed_height: 20.3 }   // 20mm cube -> 19.8 top, fits
const raftLift = (extra) => Module.slice(new Uint8Array(makeBoxSTL(20, 20, 20)), JSON.stringify({ ...bedCeil, ...extra }), () => {})
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
const tableAtEdge = translateSTL(makeTableSTL(), 80, -10)     // cap x 80..100 — flush against the +X edge
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

console.log(failed === 0 ? '\nALL NODE TESTS PASSED' : `\n${failed} TEST(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
