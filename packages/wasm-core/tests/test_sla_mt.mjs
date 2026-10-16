// The mt (pthread) kernel variant carries the whole SLA group too (build.sh links sla_group_mt.o), but until
//  this test nothing ever loaded it — a link error or a thread-order divergence would have shipped silently.
//  The SLA chain runs on ExecutionSeq, so the two variants must agree BYTE for byte, not just statistically:
//  stats, every layer's path stream, and both meshes.
import assert from 'node:assert/strict'
import createSlicer from '../../engine/src/slicer_core.js'
import createSlicerMt from '../../engine/src/slicer_core.mt.js'
import { outwardBoxTriangles, trianglesToSTLBytes } from './stl_fixtures.mjs'

// A 10x10x5 box centred on the origin.
function boxSTL() {
  return trianglesToSTLBytes(outwardBoxTriangles(-5, -5, 0, 10, 10, 5))
}

const params = JSON.stringify({
  layer_height: 0.05,
  initial_layer_height: 0.05,
  bed_width: 120.96,
  bed_depth: 68.04,
  supports_enable: true,
  support_object_elevation: 5,
  pad_enable: true,
})

const [singleThreadSlicer, threadedSlicer] = [await createSlicer(), await createSlicerMt()]
const expected = singleThreadSlicer.slice_sla(boxSTL(), params, undefined)
const actual = threadedSlicer.slice_sla(boxSTL(), params, undefined)

assert.equal(actual.error, undefined, `mt slice_sla errored: ${actual.error}`)
for (const key of ['layers', 'support_points', 'pad_layers', 'lift_layers', 'path_segments'])
  assert.equal(actual.stats[key], expected.stats[key], `stats.${key} diverged between variants`)
assert.ok(expected.stats.support_points > 0 && expected.stats.pad_layers > 0, 'the case must exercise supports AND pad')

assert.equal(actual.layers.length, expected.layers.length)
for (let index = 0; index < expected.layers.length; index++)
  assert.deepEqual(actual.layers[index].paths, expected.layers[index].paths, `layer ${index} paths diverged`)
assert.deepEqual(actual.support_mesh, expected.support_mesh)
assert.deepEqual(actual.pad_mesh, expected.pad_mesh)

console.log(`test_sla_mt: mt/st byte-identical over ${expected.layers.length} layers, `
  + `${expected.stats.support_points} points, pad ${expected.stats.pad_layers} layers`)
process.exit(0)
