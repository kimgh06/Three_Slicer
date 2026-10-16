// selector_import_paint: loading a 3mf's painted facets into the kernel's TriangleSelector.
// The encoding under test is upstream's, not ours — a facet's paint is its split tree written as a bitstream and
// rendered as hex (FacetsAnnotation::get_triangle_as_string, slicer/src/libslic3r/Model.cpp:3542). An unsplit
// painted facet is one nibble `state << 2`, except states 3..16 which use the 0b1100 prefix plus a second nibble
// holding state-3 — written most-significant nibble first, so Extruder3 reads "0C".
import createSlicer from '../../engine/src/slicer_core.js'
import { boxTrianglesWithInwardBottom, trianglesToSTL } from './stl_fixtures.mjs'

const cubeSTL = trianglesToSTL(boxTrianglesWithInwardBottom(0, 0, 0, 20, 20, 20))   // 12 facets

const HEX = { 1: '4', 2: '8', 3: '0C', 4: '1C', 5: '2C' }   // state -> unsplit-facet hex

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
const prepare = () => slicer.selector_prepare(new Uint8Array(cubeSTL))
const importPaint = (facets, hexes) => slicer.selector_import_paint(Int32Array.from(facets), hexes.join('\n'))
const counts = (...states) => states.map(state => slicer.selector_painted_count_state(state))

console.log('[decode]')
prepare()
ok(slicer.selector_facet_count() === 12, `the fixture has 12 facets (got ${slicer.selector_facet_count()})`)
let applied = importPaint([1, 3, 5], [HEX[1], HEX[3], HEX[5]])
ok(applied === 3, `all three facets were applied (got ${applied})`)
ok(counts(1, 3, 5).join() === '1,1,1', `each state got exactly its one facet (got ${counts(1,3,5)})`)
ok(counts(2, 4).join() === '0,0', `states nobody painted stay empty (got ${counts(2,4)})`)

console.log('\n[the two support states]')
// ENFORCER/BLOCKER are states 1 and 2 of the same enum, so paint_supports decodes through the same path — which
// is exactly why a support BLOCKER and an Extruder2 material paint are indistinguishable once imported.
prepare()
importPaint([0, 2], [HEX[1], HEX[2]])
ok(slicer.selector_painted_count(true) === 1, 'enforcer (state 1) is readable through the boolean API')
ok(slicer.selector_painted_count(false) === 1, 'blocker (state 2) is readable through the boolean API')

console.log('\n[import replaces, never merges]')
// Upstream's deserialize resets first. The viewer relies on this being a replace: it is why the import may only
// run on a freshly prepared selector, and the test states it so a future "merge" change cannot pass silently.
prepare()
importPaint([1], [HEX[3]])
importPaint([2], [HEX[4]])
ok(counts(3)[0] === 0, 'the first import is gone after the second')
ok(counts(4)[0] === 1, 'the second import is the one in effect')

console.log('\n[ordering]')
// triangles_to_split must be strictly ascending (upstream asserts it and binary-searches it), but a 3mf lists
// facets in its own order and the viewer rebases several objects into one array — so the kernel sorts.
prepare()
applied = importPaint([9, 1, 5], [HEX[3], HEX[4], HEX[5]])
ok(applied === 3, `an out-of-order batch is fully applied (got ${applied})`)
ok(counts(4, 5, 3).join() === '1,1,1', `each facet kept its own state through the sort (got ${counts(4,5,3)})`)

console.log('\n[bad input is dropped, not crashed on]')
prepare()
applied = importPaint([1, 99, -1, 4], [HEX[3], HEX[3], HEX[3], HEX[4]])
ok(applied === 2, `out-of-range facet indices are skipped (applied ${applied}, want 2)`)
ok(counts(3, 4).join() === '1,1', `the in-range facets still landed (got ${counts(3,4)})`)

prepare()
applied = importPaint([1, 4], ['ZZ', HEX[4]])
ok(applied === 1, `a malformed hex string is dropped (applied ${applied}, want 1)`)
ok(counts(4)[0] === 1, 'the valid facet beside it is unaffected')

prepare()
ok(importPaint([1], ['']) === 0, 'an empty hex string applies nothing')
ok(slicer.selector_import_paint(Int32Array.from([]), '') === 0, 'an empty batch applies nothing')
ok(counts(1, 2, 3).join() === '0,0,0', 'a rejected import leaves the selector clean')

console.log('\n[a duplicated facet does not corrupt the stream]')
prepare()
applied = importPaint([3, 3], [HEX[3], HEX[4]])
ok(applied === 1, `the duplicate is collapsed to one entry (applied ${applied}, want 1)`)
ok(counts(3)[0] + counts(4)[0] === 1, 'exactly one of the two states owns the facet')

console.log('\n[facet rebasing across a merge]')
// What the viewer's buildMergedSTL relies on: merging N objects concatenates their triangles IN ORDER, so object
// k's local facet i becomes facet (sum of the earlier objects' face counts) + i. That only holds if the kernel's
// weld preserves triangle order — it does (bindings.cpp prepare_selector), and this pins it, because a weld
// that reordered would silently move every imported 3mf's paint onto the wrong faces.
const twoCubes = boxTrianglesWithInwardBottom(0, 0, 0, 20, 20, 20).concat(boxTrianglesWithInwardBottom(40, 0, 0, 20, 20, 20))
const twoCubeSTL = trianglesToSTL(twoCubes)
slicer.selector_prepare(new Uint8Array(twoCubeSTL))
ok(slicer.selector_facet_count() === 24, `merging two cubes gives 24 facets (got ${slicer.selector_facet_count()})`)
// Second object's local facet 2 == merged facet 12 + 2. Paint it and check the geometry that comes back is the
// FAR cube's (x >= 40), not the near one's.
importPaint([12 + 2], [HEX[3]])
const overlay = slicer.selector_overlay_state(3)
ok(overlay.length === 9, `one facet came back (got ${overlay.length / 9} triangles)`)
let minOverlayX = Infinity
for (let i = 0; i < overlay.length; i += 3) minOverlayX = Math.min(minOverlayX, overlay[i])
ok(minOverlayX >= 40, `the rebased index landed on the second object (min x=${minOverlayX}, want >= 40)`)
// And the same local index WITHOUT the rebase would have landed on the first object — the bug this guards against.
slicer.selector_prepare(new Uint8Array(twoCubeSTL))
importPaint([2], [HEX[3]])
const unrebased = slicer.selector_overlay_state(3)
let maxUnrebasedX = -Infinity
for (let i = 0; i < unrebased.length; i += 3) maxUnrebasedX = Math.max(maxUnrebasedX, unrebased[i])
ok(maxUnrebasedX <= 20, `an un-rebased index lands on the first object (max x=${maxUnrebasedX}) — the two are distinguishable`)

console.log('\n[imported paint reaches a slice]')
// The point of the whole path: a slice run after an import must see the marks. Two extruders with a painted
// facet routes through slice_multimaterial, which emits a tool change; with nothing painted it does not.
const base = { layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15,
  nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0, print_speed: 60, first_layer_speed: 20,
  travel_speed: 150, nozzle_temp: 210, bed_temp: 60, top_shell_layers: 3, bottom_shell_layers: 3,
  skirt_loops: 0, brim_width: 0, extruder_count: 2 }
const toolChanges = (gcode) => (gcode.match(/^T\d+$/gm) ?? []).length
prepare()
const clean = slicer.slice(new Uint8Array(cubeSTL), JSON.stringify(base), () => {})
prepare()
importPaint([4, 5, 6, 7], [HEX[2], HEX[2], HEX[2], HEX[2]])   // a whole side wall onto extruder 2
const painted = slicer.slice(new Uint8Array(cubeSTL), JSON.stringify(base), () => {})
const cleanChanges = toolChanges(clean.gcode ?? ''), paintedChanges = toolChanges(painted.gcode ?? '')
console.log(`  tool changes: unpainted=${cleanChanges} imported=${paintedChanges}`)
ok(cleanChanges === 0, 'an unpainted slice emits no tool change')
ok(paintedChanges > 0, `the imported paint reaches the slice (${paintedChanges} tool changes)`)

if (fail) {
  console.log(`\n${fail} FAILED`)
  process.exit(1)
}
console.log('\npaint import passed')
process.exit(0)
