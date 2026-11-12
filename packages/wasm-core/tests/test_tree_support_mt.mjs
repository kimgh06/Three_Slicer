// Organic tree support runs its tbb loops threaded on mt (TreeSupport3D.cpp generate_tree_support_3D), with the
//  branch loop of organic_draw_branches split into a threaded compute and a commit in the serial order. Its G-code has
//  to be the st G-code too; organic is the style a tree(auto) type left on 'default' resolves to.
// Tree support (slim / strong / hybrid) runs its loops threaded on mt: detect_overhangs' layer passes, draw_circles,
//  generate_toolpaths, the avoidance precompute, and drop_nodes' spanning trees and move pass. Each has to give the
//  serial loop's result, so the mt G-code must equal the st G-code, run after run. The move pass is where this broke first: the SupportNode constructor also points
//  the nodes merged into its parent at the new node, one node can be merged into several parents, and the last of those
//  writes followed the thread order (measured on a 1.13M-facet hybrid plate: a different G-code on every mt run).
//  The model is built to reach that code: stacked slabs whose branches merge on the way down, and build-plate-only
//  support, so branches that land on a lower slab are pruned through those links.
import assert from 'node:assert/strict'
import createSlicer from '../../engine/src/slicer_core.js'
import createSlicerMt from '../../engine/src/slicer_core.mt.js'
import { outwardBoxTriangles, trianglesToSTLBytes } from './stl_fixtures.mjs'

// A tower with three slabs sticking out at different heights and directions, and a wide roof over all of them.
const model = trianglesToSTLBytes([
  ...outwardBoxTriangles(-4, -4, 0, 8, 8, 24),
  ...outwardBoxTriangles(-20, -4, 6, 16, 12, 1.2),
  ...outwardBoxTriangles(4, -18, 10, 12, 22, 1.2),
  ...outwardBoxTriangles(-16, 2, 15, 20, 16, 1.2),
  ...outwardBoxTriangles(-24, -22, 24, 44, 44, 1.2),
])

const params = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15,
  bed_width: 180, bed_depth: 180, printable_height: 180, skirt_loops: 0,
  enable_support: true, support_style: 'tree', support_on_build_plate_only: true,
}

const singleThreadSlicer = await createSlicer()
const threadedSlicer = await createSlicerMt()
let failures = 0
for (const treeStyle of ['organic', 'slim', 'strong', 'hybrid']) {
  const styled = JSON.stringify({ ...params, tree_style: treeStyle })
  const serial = singleThreadSlicer.slice(model, styled, () => {})
  assert.ok(!serial.error, `${treeStyle}: st slices (${serial.error})`)
  for (let run = 1; run <= 3; run++) {
    const threaded = threadedSlicer.slice(model, styled, () => {})
    const same = threaded.gcode === serial.gcode
    let verdict = 'ok'
    if (!same) {
      verdict = 'FAIL'
      failures++
    }
    console.log(`  ${verdict}: ${treeStyle} mt run ${run} equals st (${serial.gcode.length} bytes)`)
  }
}
// Arachne walls are written by the threaded G-code writers too (slicer_core.cpp parEmit). The toolpath stream and its
//  per-segment widths are what the preview draws, so they are compared as well as the text.
const layerBytes = (result) => result.layers.map((layer) => [layer.z, Array.from(layer.paths), Array.from(layer.widths)])
{
  const arachne = JSON.stringify({ ...params, tree_style: 'hybrid', wall_generator: 'arachne' })
  const serial = singleThreadSlicer.slice(model, arachne, () => {})
  assert.ok(!serial.error, `arachne: st slices (${serial.error})`)
  const threaded = threadedSlicer.slice(model, arachne, () => {})
  const sameText = threaded.gcode === serial.gcode
  let sameLayers = true
  try {
    assert.deepStrictEqual(layerBytes(threaded), layerBytes(serial))
  } catch {
    sameLayers = false
  }
  let verdict = 'ok'
  if (!sameText || !sameLayers) {
    verdict = 'FAIL'
    failures++
  }
  let textWord = 'equals'
  if (!sameText) textWord = 'differs from'
  let layersWord = 'equal'
  if (!sameLayers) layersWord = 'differ'
  console.log(`  ${verdict}: arachne walls, mt G-code ${textWord} st, toolpaths and widths ${layersWord}`)
}
// Only the runtime's main thread starts threads (tbb/stub_parallel.h threaded_here). A loop entered on a pthread that
//  started its own threads hung or aborted one slice in two of three runs with four kernels slicing at once in one
//  browser tab, while node never showed it, so the rule is checked in the source rather than by a slice.
{
  const { readFileSync } = await import('node:fs')
  const stub = readFileSync(new URL('../treesupport_port/tbb/stub_parallel.h', import.meta.url), 'utf8')
  const parallelFor = readFileSync(new URL('../treesupport_port/tbb/parallel_for.h', import.meta.url), 'utf8')
  const threadedHere = stub.slice(stub.indexOf('inline bool threaded_here()'))
  let verdict = 'ok'
  if (!/emscripten_is_main_runtime_thread\(\)/.test(threadedHere.slice(0, 400)) || /tbb_stub::enabled\(\)\.load/.test(parallelFor)) {
    verdict = 'FAIL'
    failures++
  }
  console.log(`  ${verdict}: parallel_for asks threaded_here(), which starts threads from the main runtime thread only`)
}
// The host's thread limit (thread_limit.h, set_thread_limit): a pool run gives each worker a share of the cores. It
//  changes how many threads share the work and nothing else, so the G-code is the st G-code at every limit, and 0
//  takes the limit off again.
{
  const organic = JSON.stringify({ ...params, tree_style: 'organic', wall_generator: 'arachne' })
  const serial = singleThreadSlicer.slice(model, organic, () => {})
  assert.ok(!serial.error, `thread limit: st slices (${serial.error})`)
  for (const limit of [1, 2, 3, 0]) {
    threadedSlicer.set_thread_limit(limit)
    const threaded = threadedSlicer.slice(model, organic, () => {})
    let verdict = 'ok'
    if (threaded.gcode !== serial.gcode) {
      verdict = 'FAIL'
      failures++
    }
    console.log(`  ${verdict}: organic + arachne at thread limit ${limit} equals st`)
  }
  assert.equal(typeof singleThreadSlicer.set_thread_limit, 'function', 'the st kernel takes the call too')
}
// generate_initial_areas' layer loop stays serial: a layer adds tips and roofs to the layers below it under a lock, so
//  threaded, a layer's vector came out in thread order and the tip de-duplication kept whichever of two near-equal tips
//  arrived first (measured on one plate of a 28-plate project: 9 of 54 mt runs gave another support polygon on one
//  layer than st, 0 of 40 with the loop serial). The model above does not reach it, so the source is checked.
{
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../treesupport_port/libslic3r/Support/TreeSupport3D.cpp', import.meta.url), 'utf8')
  const initialAreas = source.slice(source.indexOf('static void generate_initial_areas('))
  const loop = initialAreas.indexOf('tbb::parallel_for(tbb::blocked_range<size_t>(0, raw_overhangs.size())')
  const serialSection = initialAreas.lastIndexOf('tbb_stub::SerialSection', loop)
  const rawOverhangs = initialAreas.indexOf('RichInterfacePlacer rich_interface_placer')
  let verdict = 'ok'
  if (loop < 0 || serialSection < rawOverhangs) {
    verdict = 'FAIL'
    failures++
  }
  console.log(`  ${verdict}: generate_initial_areas opens a SerialSection before its layer loop`)
}
if (failures) {
  console.log(`${failures} TREE SUPPORT MT CHECK(S) FAILED`)
  process.exit(1)
}
console.log('ALL TREE SUPPORT MT CHECKS PASSED')
process.exit(0)
