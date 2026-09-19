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

// A cube at [-4,4]^2 x [0,8], `copies` times; `inner` adds a half-size cube at z 2..6 with every facet flipped.
const cubeFacets = (scale, z0) => {
  const v = [[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(([x, y, z]) => [x * scale, y * scale, z0 + z * scale * 2])
  return [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]].map(f => f.map(i => v[i]))
}
const stl = (facets) => {
  const b = new Uint8Array(84 + facets.length * 50), dv = new DataView(b.buffer); dv.setUint32(80, facets.length, true)
  facets.forEach((face, i) => { let o = 84 + 50 * i + 12; for (const p of face) for (const c of p) { dv.setFloat32(o, c, true); o += 4 } })
  return b
}
const flip = (facets) => facets.map(([a, b, c]) => [a, c, b])
const T = { px: 64, py: 64, map: (x, y) => [32 + x * 4, 32 - y * 4] }
const lit = (mask) => mask.reduce((n, v) => n + (v > 127 ? 1 : 0), 0)
const maskOf = async (facets) => {
  const parity = makeSl1ParityGpu(device)
  assert.ok(parity.prepare(stl(facets)))
  const mask = await parity.rasterize(4, T, 1)
  parity.dispose()
  return mask
}

const one = await maskOf(cubeFacets(4, 0))
assert.ok(lit(one) > 0, 'one cube lights its square')
assert.deepEqual(await maskOf([...cubeFacets(4, 0), ...cubeFacets(4, 0)]), one, 'two coincident cubes mask as one')
console.log(`  ok coincident: two cubes on one spot light the same ${lit(one)} px as one`)
assert.deepEqual(await maskOf(flip(cubeFacets(4, 0))), one, 'a cube with every facet flipped masks the same')
console.log('  ok flipped: a fully inverted cube masks the same')
const hollow = await maskOf([...cubeFacets(4, 0), ...flip(cubeFacets(2, 2))])
assert.ok(Math.abs(lit(hollow) / lit(one) - 0.75) < 0.05, `hollow keeps its void (${lit(hollow)} of ${lit(one)} px)`)
console.log(`  ok void: an inward-facing inner cube stays empty (${lit(hollow)} of ${lit(one)} px lit)`)
device.destroy?.()
console.log('\ntest_sl1_gpu_overlap: 3 checks passed')
process.exit(0)
