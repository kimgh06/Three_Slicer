// The Arachne Voronoi diagram is built with FastInt as the big integer of boost's exact predicates
// (voronoi_fast_int.h). The diagram has to be the one boost's own integer gives, bit for bit. The kernel hashes
// the diagrams of twelve outlines where almost every circle event is recomputed exactly; REFERENCE_HASH is what
// boost's default builder gives for the same outlines (voronoi_fast_int_hash.cpp compiled natively with
// -DVORONOI_REFERENCE_BUILDER, boost 1.89).
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REFERENCE_VERTICES = 71723
const REFERENCE_HASH = '1dc738f55377cada'
const OUTLINES = 12

const here = dirname(fileURLToPath(import.meta.url))
const KERNELS = ['slicer_core.js', 'slicer_core.mt.js']
for (const name of KERNELS) {
  const kernel = await (await import(join(here, '../../engine/src', name))).default()
  const result = kernel.voronoi_fast_int_hash(OUTLINES)
  assert.equal(result.vertices, REFERENCE_VERTICES, `${name}: Voronoi vertex count`)
  assert.equal(result.hash, REFERENCE_HASH, `${name}: the diagrams differ from boost's own builder's`)
  console.log(`ok ${name}: ${result.vertices} Voronoi vertices, hash ${result.hash}`)
}

// Both port copies route every segment diagram through the FastInt builder.
for (const port of ['arachne_port', 'treesupport_port']) {
  const source = readFileSync(join(here, '..', port, 'libslic3r/Geometry/Voronoi.cpp'), 'utf8')
  assert.equal(source.match(/boost::polygon::construct_voronoi\(/g), null, `${port}: a diagram is built with boost's default builder`)
  assert.equal(source.match(/ construct_segment_voronoi\(seg/g).length, 2, `${port}: the two calls`)
}
console.log('ok both Voronoi.cpp copies use construct_segment_voronoi')
process.exit(0)
