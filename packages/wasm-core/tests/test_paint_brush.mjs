// The brush's kernel side, beyond "a facet got marked": the swept stroke, the section plane, the overhang limit
// and the fill preview. All four are upstream behaviour the bridge previously did not expose.
//   Run: node packages/wasm-core/tests/test_paint_brush.mjs
import createSlicer from '../../engine/src/slicer_core.js'
import { trianglesToSTL } from './stl_fixtures.mjs'

// A tall thin plate, finely triangulated along x so a stroke has facets to land on between two samples. 1x1mm
// quads across a 40mm span: coarse enough to stay fast, fine enough that a 3mm brush covers several of them.
function plateTriangles(width, height, columns, rows) {
  const triangles = []
  for (let i = 0; i < columns; i++) for (let j = 0; j < rows; j++) {
    const x0 = (i / columns) * width, x1 = ((i + 1) / columns) * width
    const z0 = (j / rows) * height, z1 = ((j + 1) / rows) * height
    triangles.push([[x0, 0, z0], [x1, 0, z0], [x1, 0, z1]], [[x0, 0, z0], [x1, 0, z1], [x0, 0, z1]])
  }
  return triangles
}
const WIDTH = 40, HEIGHT = 10
const plateSTL = trianglesToSTL(plateTriangles(WIDTH, HEIGHT, 40, 10))

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
const T2 = 2
// The camera sits on -y looking at the plate, which is the frame every cursor is built in.
const CAMERA = [WIDTH / 2, -100, HEIGHT / 2]
// Which facet a point on the plate belongs to. The plate is two triangles per 1x1 cell, laid out column-major.
const facetAt = (x, z) => {
  const i = Math.min(39, Math.max(0, Math.floor(x / (WIDTH / 40))))
  const j = Math.min(9, Math.max(0, Math.floor(z / (HEIGHT / 10))))
  return (i * 10 + j) * 2
}
const fresh = () => {
  slicer.selector_prepare(new Uint8Array(plateSTL))
  slicer.selector_set_clip_plane(0, 0, 1, 0, false)
  slicer.selector_set_overhang_limit(0)
}
const painted = (state = T2) => slicer.selector_painted_count_state(state)

// WHERE the paint landed, not how much of it there is: select_patch SPLITS triangles, so a facet count is a count
// of sub-triangles and says more about how the cursor cut them than about the area it covered.
const paintedXRange = (state = T2) => {
  const overlayPositions = slicer.selector_overlay_state(state)
  let low = Infinity, high = -Infinity
  for (let i = 0; i < overlayPositions.length; i += 3) {
    if (overlayPositions[i] < low) low = overlayPositions[i]
    if (overlayPositions[i] > high) high = overlayPositions[i]
  }
  if (!overlayPositions.length) return null
  return [low, high]
}
const paintedNear = (x, state = T2) => {
  const overlayPositions = slicer.selector_overlay_state(state)
  for (let i = 0; i < overlayPositions.length; i += 3) if (Math.abs(overlayPositions[i] - x) < 0.6) return true
  return false
}

console.log('[the swept stroke]')
fresh()
ok(slicer.selector_facet_count() === 800, `the fixture has 800 facets (got ${slicer.selector_facet_count()})`)
// Two samples 20mm apart with a 3mm brush: the balls at each end cannot reach each other, so the middle of the
// path is exactly the gap a fast drag leaves when every sample is painted as its own ball.
const strokeStart = [5, 0, HEIGHT / 2], strokeEnd = [25, 0, HEIGHT / 2], strokeMiddle = 15
slicer.selector_paint_shape(facetAt(strokeStart[0], strokeStart[2]), strokeStart[0], strokeStart[1], strokeStart[2], ...CAMERA, 3, T2, 1)
slicer.selector_paint_shape(facetAt(strokeEnd[0], strokeEnd[2]), strokeEnd[0], strokeEnd[1], strokeEnd[2], ...CAMERA, 3, T2, 1)
ok(painted() > 0, `two separate samples paint their own ends (${painted()} sub-facets)`)
ok(!paintedNear(strokeMiddle), 'and leave the middle of the path bare')
fresh()
slicer.selector_paint_stroke(facetAt(strokeEnd[0], strokeEnd[2]), strokeStart[0], strokeStart[1], strokeStart[2], strokeEnd[0], strokeEnd[1], strokeEnd[2], ...CAMERA, 3, T2, 1)
ok(paintedNear(strokeMiddle), 'the capsule between the same two samples fills that gap')
// And it is a swept brush, not a flood: it must not reach past its own endpoints by more than the radius.
const span = paintedXRange()
ok(span && span[0] > strokeStart[0] - 3.5 && span[1] < strokeEnd[0] + 3.5,
   `the stroke stays inside its own path (x ${span?.map(value => value.toFixed(1))} for a 5..25 stroke, radius 3)`)

console.log('\n[the eraser sweeps too]')
// Shift+drag is the eraser and is exactly as sampled as a paint drag, so it needs the same capsule or it leaves
// islands of paint behind between its samples.
slicer.selector_erase_stroke(facetAt(strokeEnd[0], strokeEnd[2]), strokeStart[0], strokeStart[1], strokeStart[2], strokeEnd[0], strokeEnd[1], strokeEnd[2], ...CAMERA, 3, 1)
ok(painted() === 0, `an erase stroke over the same path clears it (${painted()} left)`)

console.log('\n[the section plane]')
fresh()
// Clip everything above z=5 (kernel clips where normal.p - offset > 0). A stroke aimed at z=8 must then mark
// nothing, and the same stroke with the plane off must mark something — otherwise the plane is being ignored
// rather than obeyed.
slicer.selector_set_clip_plane(0, 0, 1, 5, true)
slicer.selector_paint_shape(facetAt(20, 8), 20, 0, 8, ...CAMERA, 2, T2, 1)
ok(painted() === 0, `a stroke on the clipped side marks nothing (got ${painted()})`)
slicer.selector_paint_shape(facetAt(20, 2), 20, 0, 2, ...CAMERA, 2, T2, 1)
ok(painted() > 0, `the same brush still paints on the kept side (${painted()})`)
fresh()
slicer.selector_paint_shape(facetAt(20, 8), 20, 0, 8, ...CAMERA, 2, T2, 1)
ok(painted() > 0, `and with the plane off that first stroke does land (${painted()})`)

console.log('\n[the overhang limit]')
fresh()
// The plate faces -y, i.e. it is vertical: nothing on it overhangs. Upstream's highlight_by_angle_deg therefore
// rejects the whole surface, which is what "on overhangs only" has to do on a wall.
slicer.selector_set_overhang_limit(45)
slicer.selector_paint_shape(facetAt(20, 5), 20, 0, 5, ...CAMERA, 3, T2, 1)
ok(painted() === 0, `a vertical wall is not an overhang, so nothing is painted (got ${painted()})`)
slicer.selector_set_overhang_limit(0)
slicer.selector_paint_shape(facetAt(20, 5), 20, 0, 5, ...CAMERA, 3, T2, 1)
ok(painted() > 0, `with the limit off the same stroke lands (${painted()})`)

console.log('\n[the fill preview]')
fresh()
// A preview SELECTS and does not apply — that is the whole point of it. It has to hand back geometry (so the
// viewer can shade it) while leaving every facet count at zero.
const preview = slicer.selector_fill_preview(facetAt(20, 5), 20, 0, 5, 30, 0)
ok(preview.length >= 9, `the preview returns triangles (${preview.length / 9} of them)`)
ok(preview.length % 9 === 0, 'flat x,y,z with 3 vertices per triangle')
ok(painted() === 0 && slicer.selector_painted_count(true) === 0, 'and it marks nothing')
// The whole plate is one smooth feature, so a smart fill over it selects everything — and applying the fill
// afterwards marks what the preview showed.
slicer.selector_seed_fill(facetAt(20, 5), 20, 0, 5, 30, T2)
ok(painted() === preview.length / 9, `the fill marks exactly what the preview drew (${painted()} vs ${preview.length / 9})`)
slicer.selector_fill_preview_clear()
ok(slicer.selector_fill_preview(facetAt(20, 5), 20, 0, 5, -1, 2).length === 9,
   'the single-triangle mode previews exactly one facet')

if (fail === 0) {
  console.log('\nALL PAINT-BRUSH CHECKS PASSED')
  process.exit(0)
}
console.log(`\n${fail} CHECK(S) FAILED`)
process.exit(1)
