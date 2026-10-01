// PASS1's union on the GPU (src/contour_gpu.js + src/contour_slice.js + wasm-core/contour_phase.h), end to end:
//  the kernel captures its loops, the GPU unions them, the kernel slices on the GPU's contours.
//   [off]        with the contour phase never entered, the kernel's slice is what it was (the golden check covers the
//                bytes; here only that a captured slice leaves no state behind)
//   [gpu]        a GPU slice has the CPU slice's layers and, within a tolerance, its filament; no layer falls back
//   [coincident] two boxes sharing a wall — segments coinciding in opposite directions, which the pipeline cannot
//                order by itself — still slice with no layer on the CPU
//   [repeat]     the same input gives the same G-code twice
//   [mesh]       with the GPU's cut and chain (contour_front_gpu.js) the kernel hands over its mesh, and the slice is the
//                capture route's
//   [capture]    a GPU module without the cut and chain takes the capture route
//   [open layer] a layer whose chain does not close (a box with a missing facet) is cut, chained and unioned by the
//                kernel from the mesh it kept, and counted
//   [refusal]    a device that fails leaves the kernel's own slice
// The GPU checks run only with a device (Dawn under node: CONTOUR_GPU_WEBGPU_PATH=<webgpu index.js>, or the `webgpu`
//  package when installed); without one they SKIP — the CPU slice is the contract, the GPU the bonus.
import { strict as assert } from 'node:assert'
import createSlicer from '../src/slicer_core.js'
import { makeContourGpu } from '../src/contour_gpu.js'
import { kernelHasContourPhase, sliceWithContourGpu } from '../src/contour_slice.js'

let passed = 0, skipped = 0
const ok = (name) => { passed++; console.log('  ok', name) }
const skip = (name) => { skipped++; console.log('  skip', name) }

function boxTriangles(originX, originY, originZ, sizeX, sizeY, sizeZ) {
  const corners = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]]
    .map(([x, y, z]) => [originX + x * sizeX, originY + y * sizeY, originZ + z * sizeZ])
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  return faces.map(face => face.map(index => corners[index]))
}
function toSTL(triangles) {
  const buffer = Buffer.alloc(84 + triangles.length * 50)
  buffer.writeUInt32LE(triangles.length, 80)
  triangles.forEach((triangle, index) => {
    let offset = 84 + index * 50 + 12
    for (const vertex of triangle) for (const value of vertex) { buffer.writeFloatLE(value, offset); offset += 4 }
  })
  return new Uint8Array(buffer)
}
// two boxes that overlap (their outlines cross) and a third that shares a whole wall with the first
const overlapping = toSTL([...boxTriangles(-10, -10, 0, 20, 20, 6), ...boxTriangles(0, 0, 0, 20, 20, 6)])
const sharedWall = toSTL([...boxTriangles(-10, -10, 0, 10, 20, 6), ...boxTriangles(0, -10, 0, 10, 20, 6)])
// a box with one side facet missing: every layer's chain stops at the gap
const holed = toSTL(boxTriangles(-10, -10, 0, 20, 20, 6).filter((_, index) => index !== 4 + 2))
const paramsText = JSON.stringify({ layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15,
  bed_width: 180, bed_depth: 180, printable_height: 180, skirt_loops: 0 })
const FILAMENT_TOLERANCE = 0.01   // the GPU's contours have the CPU union's area and other vertices (measured: within 0.3 %)

const kernel = await createSlicer()
assert.ok(kernelHasContourPhase(kernel), 'the kernel exports the contour phase')
const cpu = kernel.slice(overlapping, paramsText, () => {})
assert.ok(!cpu.error && cpu.layers.length > 0)

let device = null
try {
  const module = await import(process.env.CONTOUR_GPU_WEBGPU_PATH || 'webgpu')
  Object.assign(globalThis, module.globals ?? {})
  const gpu = module.create([])
  globalThis.__contourGpuInstance = gpu   // Dawn's instance must outlive the run (a collected one crashes the process)
  const adapter = await gpu.requestAdapter()
  if (adapter) device = await adapter.requestDevice({ requiredLimits: {
    maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30),
    maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30), maxStorageBuffersPerShaderStage: 10 } })
} catch { device = null }

const filamentOf = (result) => Number(result.stats.filament_mm ?? result.stats.filament)
if (!device) {
  for (const name of ['[gpu]', '[coincident]', '[capture]', '[mesh]', '[open layer]', '[repeat]']) skip(`${name} no WebGPU device`)
} else {
  const contourGpu = await makeContourGpu(device)
  const job = (stl) => sliceWithContourGpu({ kernel, contourGpu, stl, paramsText, onProgress: () => {} })

  const gpuSlice = await job(overlapping)
  assert.equal(gpuSlice.stats.contour_engine, 'gpu', `engine: ${gpuSlice.stats.contour_engine_reason}`)
  assert.equal(gpuSlice.stats.contour_front, 'gpu', 'the mesh route cut and chained the layers')
  assert.equal(gpuSlice.layers.length, cpu.layers.length)
  assert.equal(gpuSlice.stats.contour_fallback_layers, 0)
  assert.ok(gpuSlice.stats.contour_crossings > 0, 'the two outlines cross')
  const drift = Math.abs(filamentOf(gpuSlice) - filamentOf(cpu)) / filamentOf(cpu)
  assert.ok(drift < FILAMENT_TOLERANCE, `filament ${filamentOf(gpuSlice)} vs ${filamentOf(cpu)}`)
  ok(`[gpu] ${gpuSlice.layers.length} layers, ${gpuSlice.stats.contour_crossings} crossings, filament within ${(drift * 100).toFixed(3)} % of the CPU slice`)

  const wallCpu = kernel.slice(sharedWall, paramsText, () => {})
  const wallGpu = await job(sharedWall)
  assert.equal(wallGpu.stats.contour_engine, 'gpu')
  assert.equal(wallGpu.stats.contour_fallback_layers, 0, 'the shared wall is cancelled before the GPU sees it')
  const wallDrift = Math.abs(filamentOf(wallGpu) - filamentOf(wallCpu)) / filamentOf(wallCpu)
  assert.ok(wallDrift < FILAMENT_TOLERANCE, `filament ${filamentOf(wallGpu)} vs ${filamentOf(wallCpu)}`)
  ok(`[coincident] a shared wall: no layer on the CPU, filament within ${(wallDrift * 100).toFixed(3)} %`)

  const captureRoute = await sliceWithContourGpu({ kernel, contourGpu: { union: contourGpu.union }, stl: overlapping, paramsText, onProgress: () => {} })
  assert.equal(captureRoute.stats.contour_front, 'cpu')
  assert.equal(captureRoute.stats.contour_engine, 'gpu')
  const declined = await sliceWithContourGpu({ kernel, contourGpu, stl: overlapping, paramsText, onProgress: () => {}, meshRoute: false })
  assert.equal(declined.stats.contour_front, 'cpu')
  assert.equal(declined.gcode, captureRoute.gcode)
  ok('[capture] a GPU module without the cut and chain, or meshRoute false, takes the capture route')
  assert.equal(gpuSlice.gcode, captureRoute.gcode, 'the GPU cut and chain gave the kernel\'s loops on a clean mesh')
  ok('[mesh] the mesh route gives the capture route\'s G-code on a clean mesh')

  const holedCpu = kernel.slice(holed, paramsText, () => {})
  const holedGpu = await job(holed)
  assert.equal(holedGpu.stats.contour_engine, 'gpu', `engine: ${holedGpu.stats.contour_engine_reason}`)
  assert.ok(holedGpu.stats.contour_open_layers > 0, 'the gap leaves chains open')
  assert.ok(holedGpu.stats.contour_fallback_layers >= holedGpu.stats.contour_open_layers)
  assert.equal(holedGpu.gcode, holedCpu.gcode, 'every layer of the holed box came from the kernel\'s own cut, chain and union')
  ok(`[open layer] ${holedGpu.stats.contour_open_layers} open layers rebuilt by the kernel from the mesh; the CPU slice's G-code`)

  const again = await job(overlapping)
  assert.equal(again.gcode, gpuSlice.gcode)
  ok('[repeat] the same input gives the same G-code')

  const afterGpu = kernel.slice(overlapping, paramsText, () => {})
  assert.equal(afterGpu.gcode, cpu.gcode)
  ok('[off] a plain slice after GPU slices is the plain slice')
  contourGpu.dispose()
}

const failing = { union: async () => ({ ok: false, reason: 'refused for the test' }) }
const refused = await sliceWithContourGpu({ kernel, contourGpu: failing, stl: overlapping, paramsText, onProgress: () => {} })
assert.equal(refused.stats.contour_engine, 'cpu')
assert.equal(refused.stats.contour_engine_reason, 'refused for the test')
assert.equal(refused.gcode, cpu.gcode)
ok('[refusal] a GPU that refuses leaves the kernel\'s own slice, with the reason')

console.log(`test_contour_gpu: ${passed} checks passed, ${skipped} skipped`)
process.exit(0)
