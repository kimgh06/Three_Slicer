// The brush's kernel side, beyond "a facet got marked": the swept stroke, the section plane, the overhang limit
// and the fill preview. All four are upstream behaviour the bridge previously did not expose.
//   Run: node packages/wasm-core/test_paint_brush.mjs
import createSlicer from '../engine/src/slicer_core.js'

// A tall thin plate, finely triangulated along x so a stroke has facets to land on between two samples. 1x1mm
// quads across a 40mm span: coarse enough to stay fast, fine enough that a 3mm brush covers several of them.
function plateTris(width, height, cols, rows) {
  const tris = []
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const x0 = (i / cols) * width, x1 = ((i + 1) / cols) * width
    const z0 = (j / rows) * height, z1 = ((j + 1) / rows) * height
    tris.push([[x0, 0, z0], [x1, 0, z0], [x1, 0, z1]], [[x0, 0, z0], [x1, 0, z1], [x0, 0, z1]])
  }
  return tris
}
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80)
  let off = 84
  for (const t of tris) { off += 12; for (const p of t) { buf.writeFloatLE(p[0], off); buf.writeFloatLE(p[1], off + 4); buf.writeFloatLE(p[2], off + 8); off += 12 } buf.writeUInt16LE(0, off); off += 2 }
  return buf
}
const WIDTH = 40, HEIGHT = 10
const plateSTL = trisToSTL(plateTris(WIDTH, HEIGHT, 40, 10))

const M = await createSlicer()
let fail = 0
const ok = (cond, msg) => { console.log((cond ? '  ok: ' : '  FAIL: ') + msg); if (!cond) fail++ }
const T2 = 2
// The camera sits on -y looking at the plate, which is the frame every cursor is built in.
const CAM = [WIDTH / 2, -100, HEIGHT / 2]
// Which facet a point on the plate belongs to. The plate is two triangles per 1x1 cell, laid out column-major.
const facetAt = (x, z) => {
  const i = Math.min(39, Math.max(0, Math.floor(x / (WIDTH / 40))))
  const j = Math.min(9, Math.max(0, Math.floor(z / (HEIGHT / 10))))
  return (i * 10 + j) * 2
}
const fresh = () => { M.selector_prepare(new Uint8Array(plateSTL)); M.selector_set_clip_plane(0, 0, 1, 0, false); M.selector_set_overhang_limit(0) }
const painted = (state = T2) => M.selector_painted_count_state(state)

// WHERE the paint landed, not how much of it there is: select_patch SPLITS triangles, so a facet count is a count
// of sub-triangles and says more about how the cursor cut them than about the area it covered.
const paintedXRange = (state = T2) => {
  const tris = M.selector_overlay_state(state)
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < tris.length; i += 3) { if (tris[i] < lo) lo = tris[i]; if (tris[i] > hi) hi = tris[i] }
  return tris.length ? [lo, hi] : null
}
const paintedNear = (x, state = T2) => {
  const tris = M.selector_overlay_state(state)
  for (let i = 0; i < tris.length; i += 3) if (Math.abs(tris[i] - x) < 0.6) return true
  return false
}

console.log('[the swept stroke]')
fresh()
ok(M.selector_facet_count() === 800, `the fixture has 800 facets (got ${M.selector_facet_count()})`)
// Two samples 20mm apart with a 3mm brush: the balls at each end cannot reach each other, so the middle of the
// path is exactly the gap a fast drag leaves when every sample is painted as its own ball.
const A = [5, 0, HEIGHT / 2], B = [25, 0, HEIGHT / 2], MID = 15
M.selector_paint_shape(facetAt(A[0], A[2]), A[0], A[1], A[2], ...CAM, 3, T2, 1)
M.selector_paint_shape(facetAt(B[0], B[2]), B[0], B[1], B[2], ...CAM, 3, T2, 1)
ok(painted() > 0, `two separate samples paint their own ends (${painted()} sub-facets)`)
ok(!paintedNear(MID), 'and leave the middle of the path bare')
fresh()
M.selector_paint_stroke(facetAt(B[0], B[2]), A[0], A[1], A[2], B[0], B[1], B[2], ...CAM, 3, T2, 1)
ok(paintedNear(MID), 'the capsule between the same two samples fills that gap')
// And it is a swept brush, not a flood: it must not reach past its own endpoints by more than the radius.
const span = paintedXRange()
ok(span && span[0] > A[0] - 3.5 && span[1] < B[0] + 3.5,
   `the stroke stays inside its own path (x ${span?.map(v => v.toFixed(1))} for a 5..25 stroke, radius 3)`)

console.log('\n[the eraser sweeps too]')
// Shift+drag is the eraser and is exactly as sampled as a paint drag, so it needs the same capsule or it leaves
// islands of paint behind between its samples.
M.selector_erase_stroke(facetAt(B[0], B[2]), A[0], A[1], A[2], B[0], B[1], B[2], ...CAM, 3, 1)
ok(painted() === 0, `an erase stroke over the same path clears it (${painted()} left)`)

console.log('\n[the section plane]')
fresh()
// Clip everything above z=5 (kernel clips where normal.p - offset > 0). A stroke aimed at z=8 must then mark
// nothing, and the same stroke with the plane off must mark something — otherwise the plane is being ignored
// rather than obeyed.
M.selector_set_clip_plane(0, 0, 1, 5, true)
M.selector_paint_shape(facetAt(20, 8), 20, 0, 8, ...CAM, 2, T2, 1)
ok(painted() === 0, `a stroke on the clipped side marks nothing (got ${painted()})`)
M.selector_paint_shape(facetAt(20, 2), 20, 0, 2, ...CAM, 2, T2, 1)
ok(painted() > 0, `the same brush still paints on the kept side (${painted()})`)
fresh()
M.selector_paint_shape(facetAt(20, 8), 20, 0, 8, ...CAM, 2, T2, 1)
ok(painted() > 0, `and with the plane off that first stroke does land (${painted()})`)

console.log('\n[the overhang limit]')
fresh()
// The plate faces -y, i.e. it is vertical: nothing on it overhangs. Upstream's highlight_by_angle_deg therefore
// rejects the whole surface, which is what "on overhangs only" has to do on a wall.
M.selector_set_overhang_limit(45)
M.selector_paint_shape(facetAt(20, 5), 20, 0, 5, ...CAM, 3, T2, 1)
ok(painted() === 0, `a vertical wall is not an overhang, so nothing is painted (got ${painted()})`)
M.selector_set_overhang_limit(0)
M.selector_paint_shape(facetAt(20, 5), 20, 0, 5, ...CAM, 3, T2, 1)
ok(painted() > 0, `with the limit off the same stroke lands (${painted()})`)

console.log('\n[the fill preview]')
fresh()
// A preview SELECTS and does not apply — that is the whole point of it. It has to hand back geometry (so the
// viewer can shade it) while leaving every facet count at zero.
const preview = M.selector_fill_preview(facetAt(20, 5), 20, 0, 5, 30, 0)
ok(preview.length >= 9, `the preview returns triangles (${preview.length / 9} of them)`)
ok(preview.length % 9 === 0, 'flat x,y,z with 3 vertices per triangle')
ok(painted() === 0 && M.selector_painted_count(true) === 0, 'and it marks nothing')
// The whole plate is one smooth feature, so a smart fill over it selects everything — and applying the fill
// afterwards marks what the preview showed.
M.selector_seed_fill(facetAt(20, 5), 20, 0, 5, 30, T2)
ok(painted() === preview.length / 9, `the fill marks exactly what the preview drew (${painted()} vs ${preview.length / 9})`)
M.selector_fill_preview_clear()
ok(M.selector_fill_preview(facetAt(20, 5), 20, 0, 5, -1, 2).length === 9,
   'the single-triangle mode previews exactly one facet')

console.log(fail === 0 ? '\nALL PAINT-BRUSH CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`)
process.exit(fail === 0 ? 0 : 1)
