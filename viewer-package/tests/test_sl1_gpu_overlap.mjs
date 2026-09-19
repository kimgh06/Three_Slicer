// SLA mask fill rule on the GPU path: overlapping objects are ONE solid, as the kernel's contours say.
//   Run: node viewer-package/tests/test_sl1_gpu_overlap.mjs   (SL1_GPU_WEBGPU_PATH=<dawn index.js> for a device)
//
// The kernel fills layer loops NonZero (packages/wasm-core/slice_planes.h), so two objects on the same spot print as
//  one. sl1_parity_gpu.js renders the MESH instead of those contours, and counted the surfaces above the plane as a
//  parity (stencil INVERT = even-odd): the doubled cube came out EMPTY — a resin print missing the part its slice and
//  supports stood on. It now counts them signed by facing. Measured before the fix: 1024 px lit for one cube, 0 for two.
// Its own file and its own device rather than a section of test_sl1_gpu.mjs: added there, the extra rasterize runs
//  reproducibly killed Dawn under node (SIGSEGV, no output) after that file's earlier passes — the long-process
//  pattern the binding is known for, not a renderer fault (the same calls pass in a fresh process). Without a
//  device it SKIPS, like test_sl1_gpu.mjs: the CPU path is the contract.
import { strict as assert } from 'node:assert'
import { makeSl1ParityGpu } from '../src/core/sl1_parity_gpu.js'

let device = null
try {
  const mod = await import(process.env.SL1_GPU_WEBGPU_PATH || 'webgpu')
  const gpu = mod.create ? mod.create([]) : mod.gpu
  device = await (await gpu?.requestAdapter())?.requestDevice()
} catch { device = null }
if (!device) { console.log('test_sl1_gpu_overlap: skipped (no WebGPU device — CPU path is the contract)'); process.exit(0) }

// A cube of CUBE_HALF_MM around the origin, CUBE_HALF_MM * 2 tall; `flip` inverts every facet (inward-facing).
const CUBE_HALF_MM = 4
const INNER_HALF_MM = CUBE_HALF_MM / 2, INNER_BOTTOM_MM = CUBE_HALF_MM / 2     // half size, centred in height
const SLICE_HEIGHT_MM = CUBE_HALF_MM                                            // mid-height of the outer cube
// Raster: RASTER_PX square, RASTER_SCALE px per mm, model origin at the centre.
const RASTER_PX = 64, RASTER_SCALE = 4
const LIT_THRESHOLD = 127                          // a binary (aa=1) mask pixel is lit above half of 255
// The hollow's lit share: the outer square minus the inner one, whose side is half as long -> 1 - (1/2)^2.
const HOLLOW_LIT_SHARE = 1 - (INNER_HALF_MM / CUBE_HALF_MM) ** 2
const HOLLOW_SHARE_TOLERANCE = 0.05                // boundary pixels of two squares
const cubeFacets = (half, bottom) => {
  const corners = [[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(([x, y, z]) => [x * half, y * half, bottom + z * half * 2])
  return [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]].map(face => face.map(corner => corners[corner]))
}
const STL_FACETS_OFFSET = 84, STL_COUNT_OFFSET = 80, STL_FACET_BYTES = 50, STL_NORMAL_BYTES = 12, STL_FLOAT_BYTES = 4
const stl = (facets) => {
  const bytes = new Uint8Array(STL_FACETS_OFFSET + facets.length * STL_FACET_BYTES), view = new DataView(bytes.buffer)
  view.setUint32(STL_COUNT_OFFSET, facets.length, true)
  facets.forEach((face, index) => {
    let writeAt = STL_FACETS_OFFSET + STL_FACET_BYTES * index + STL_NORMAL_BYTES
    for (const vertex of face) for (const coordinate of vertex) { view.setFloat32(writeAt, coordinate, true); writeAt += STL_FLOAT_BYTES }
  })
  return bytes
}
const flip = (facets) => facets.map(([first, second, third]) => [first, third, second])
const RASTER_CENTRE = RASTER_PX / 2
const transform = { px: RASTER_PX, py: RASTER_PX, map: (x, y) => [RASTER_CENTRE + x * RASTER_SCALE, RASTER_CENTRE - y * RASTER_SCALE] }
const litPixels = (mask) => mask.reduce((count, value) => count + (value > LIT_THRESHOLD ? 1 : 0), 0)
const maskOf = async (facets) => {
  const parity = makeSl1ParityGpu(device)
  assert.ok(parity.prepare(stl(facets)))
  const mask = await parity.rasterize(SLICE_HEIGHT_MM, transform, 1)
  parity.dispose()
  return mask
}

const outerCube = cubeFacets(CUBE_HALF_MM, 0)
const one = await maskOf(outerCube)
assert.ok(litPixels(one) > 0, 'one cube lights its square')
assert.deepEqual(await maskOf([...outerCube, ...outerCube]), one, 'two coincident cubes mask as one')
console.log(`  ok coincident: two cubes on one spot light the same ${litPixels(one)} px as one`)
assert.deepEqual(await maskOf(flip(outerCube)), one, 'a cube with every facet flipped masks the same')
console.log('  ok flipped: a fully inverted cube masks the same')
const hollow = await maskOf([...outerCube, ...flip(cubeFacets(INNER_HALF_MM, INNER_BOTTOM_MM))])
assert.ok(Math.abs(litPixels(hollow) / litPixels(one) - HOLLOW_LIT_SHARE) < HOLLOW_SHARE_TOLERANCE,
  `hollow keeps its void (${litPixels(hollow)} of ${litPixels(one)} px)`)
console.log(`  ok void: an inward-facing inner cube stays empty (${litPixels(hollow)} of ${litPixels(one)} px lit)`)
device.destroy?.()
console.log('\ntest_sl1_gpu_overlap: 3 checks passed')
process.exit(0)
