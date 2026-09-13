// S1 verification: does support_threshold_angle point in the same direction as upstream.
//  Upstream detect_overhangs (SupportMaterial.cpp:1439): lower_layer_offset = layer_height / tan(threshold)
//  Tooltip: "the lower the value, the steeper an overhang can be while still printing without support" = higher threshold -> more support
//  Note: the buggy version before stage 33 had tan in the numerator, so the direction was inverted and only matched by coincidence at 45° (tan=1).
//
// Why these fixtures (measured):
//  - table.stl's overhang is perfectly horizontal (0°), so it triggers at any threshold and discriminates nothing.
//  - If the per-layer overhang band is thinner than the sliver-removal opening (openR=line_width*0.6) it gets erased ->
//    slopes of 25° or more produce no support even at a threshold of 80° (a property of the current kernel).
//  - Hence three gentle slopes (8°/16°/20°).
//  Stage 33: after replacing the morphological opening with an area filter, the triggering threshold now **matches the real slope angle**
//    (previously the opening erased thin bands, so a 16° cone only triggered at θ=60° and a 20° cone at θ=80° — a distorted threshold).
//    Now the overhang condition θ > slope angle holds directly, so we sample on both sides of each slope angle.
import createSlicer from '../engine/src/slicer_core.js'

// Inverted cone: apex (z=0) -> a base of radius R (z=H). Side slope angle = atan(H/R) (90° = vertical).
function coneTris(cx, cy, R, slopeDeg, seg = 64) {
  const H = R * Math.tan(slopeDeg * Math.PI / 180)
  const apex = [cx, cy, 0], topC = [cx, cy, H]
  const p = i => { const a = 2 * Math.PI * i / seg; return [cx + R * Math.cos(a), cy + R * Math.sin(a), H] }
  const t = []
  for (let i = 0; i < seg; i++) { const a = p(i), b = p((i + 1) % seg); t.push([apex, b, a]); t.push([topC, a, b]) }
  return t
}
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80)
  let off = 84
  for (const tr of tris) { off += 12; for (const v of tr) { buf.writeFloatLE(v[0], off); buf.writeFloatLE(v[1], off + 4); buf.writeFloatLE(v[2], off + 8); off += 12 } buf.writeUInt16LE(0, off); off += 2 }
  return buf
}
const stl = new Uint8Array(trisToSTL([
  ...coneTris(-40, 0, 14, 8), ...coneTris(0, 0, 14, 16), ...coneTris(40, 0, 14, 20),
]))

const base = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2,
  infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75,
  enable_support: true, support_style: 'grid', support_density: 0.15,
  support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2,
  bed_width: 220, bed_depth: 220,
  // This test only looks at the "threshold -> overhang detection" semantics. Small-overhang removal (default true upstream)
  //  filters out the thin per-layer bands of a smooth cone and hides the angle behavior, so it is turned off (the removal logic itself is checked separately).
  support_remove_small_overhang: false,
}
const M = await createSlicer()

// Toolpath stride 8, type offset +3 (the buildSegmentData contract in toolpath_gpu.js). type 5 = support base, 6 = interface.
const supportSegments = (angle) => {
  const r = M.slice(stl, JSON.stringify({ ...base, support_threshold_angle: angle }), () => {})
  if (r.error) throw new Error(String(r.error))
  let seg = 0
  for (const L of r.layers || []) {
    const p = L.paths; if (!p) continue
    for (let i = 0; i < p.length; i += 8) { const t = p[i + 3]; if (t === 5 || t === 6) seg++ }
  }
  return seg
}

// Points chosen between the triggering thresholds of each cone (8°/16°/20°) — one more target should qualify at each step.
const ANGLES = [5, 12, 18, 25]
const rows = ANGLES.map(a => ({ a, seg: supportSegments(a) }))
for (const r of rows) console.log(`  θ=${String(r.a).padStart(2)}°  support segments ${String(r.seg).padStart(6)}`)

let fail = 0
for (let i = 1; i < rows.length; i++) {
  if (rows[i].seg <= rows[i - 1].seg) {
    console.log(`FAIL monotonic increase violated: θ=${rows[i - 1].a}°(${rows[i - 1].seg}) -> θ=${rows[i].a}°(${rows[i].seg})`)
    fail++
  }
}
if (rows[0].seg !== 0) { console.log(`FAIL support generated at the lowest threshold (10°) (${rows[0].seg}) — over-detection`); fail++ }

console.log(fail ? `\nSUPPORT ANGLE TEST FAILED (${fail})` : '\nSUPPORT ANGLE TEST PASSED — higher threshold = more support (matches upstream direction)')
process.exit(fail ? 1 : 0)
