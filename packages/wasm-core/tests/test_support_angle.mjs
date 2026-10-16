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
import createSlicer from '../../engine/src/slicer_core.js'
import { trianglesToSTL } from './stl_fixtures.mjs'

// Inverted cone: apex (z=0) -> a base of radius R (z=H). Side slope angle = atan(H/R) (90° = vertical).
function coneTriangles(centerX, centerY, radius, slopeDeg, segmentCount = 64) {
  const height = radius * Math.tan(slopeDeg * Math.PI / 180)
  const apex = [centerX, centerY, 0], topCenter = [centerX, centerY, height]
  const rimPoint = i => {
    const angle = 2 * Math.PI * i / segmentCount
    return [centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle), height]
  }
  const triangles = []
  for (let i = 0; i < segmentCount; i++) {
    const current = rimPoint(i), next = rimPoint((i + 1) % segmentCount)
    triangles.push([apex, next, current])
    triangles.push([topCenter, current, next])
  }
  return triangles
}
const stl = new Uint8Array(trianglesToSTL([
  ...coneTriangles(-40, 0, 14, 8), ...coneTriangles(0, 0, 14, 16), ...coneTriangles(40, 0, 14, 20),
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
const slicer = await createSlicer()

// Toolpath stride 8, type offset +3 (the buildSegmentData contract in toolpath_gpu.js). type 5 = support base, 6 = interface.
const supportSegments = (angle) => {
  const result = slicer.slice(stl, JSON.stringify({ ...base, support_threshold_angle: angle }), () => {})
  if (result.error) throw new Error(String(result.error))
  let segments = 0
  for (const layer of result.layers || []) {
    const paths = layer.paths
    if (!paths) continue
    for (let i = 0; i < paths.length; i += 8) {
      const type = paths[i + 3]
      if (type === 5 || type === 6) segments++
    }
  }
  return segments
}

// Points chosen between the triggering thresholds of each cone (8°/16°/20°) — one more target should qualify at each step.
const ANGLES = [5, 12, 18, 25]
const rows = ANGLES.map(angle => ({ angle, segments: supportSegments(angle) }))
for (const row of rows) console.log(`  θ=${String(row.angle).padStart(2)}°  support segments ${String(row.segments).padStart(6)}`)

let fail = 0
for (let i = 1; i < rows.length; i++) {
  if (rows[i].segments <= rows[i - 1].segments) {
    console.log(`FAIL monotonic increase violated: θ=${rows[i - 1].angle}°(${rows[i - 1].segments}) -> θ=${rows[i].angle}°(${rows[i].segments})`)
    fail++
  }
}
if (rows[0].segments !== 0) {
  console.log(`FAIL support generated at the lowest threshold (10°) (${rows[0].segments}) — over-detection`)
  fail++
}

if (fail) {
  console.log(`\nSUPPORT ANGLE TEST FAILED (${fail})`)
  process.exit(1)
}
console.log('\nSUPPORT ANGLE TEST PASSED — higher threshold = more support (matches upstream direction)')
process.exit(0)
