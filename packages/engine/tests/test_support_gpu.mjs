// The organic tree support's branches made outside the kernel (src/support_route.js, support_trace.js, support_gpu.js,
//  support_slice.js + wasm-core/support_phase.h).
//   [radius]    branchRadius is upstream's TreeSupportSettings::getRadius
//   [route]     tips walk down a field to the bed and merge; a wall in the field is walked around, never entered; a
//               branch with no room at all ends on the model; with several object layers per field layer a branch
//               changes pixel only between field layers
//   [trace]     a mask's rings enclose exactly its solid pixels, a hole and a corner contact included; simplifying a
//               ring keeps it within the tolerance
//   [organic]   which kernel params stop a slice at its support tips
//   [fallback]  a support pipeline that fails leaves the kernel's own slice, byte for byte (RESUME)
//   [inject]    a support pipeline's rings are what the kernel prints
//   [gpu]       the real pipeline on a device: every tip is routed, the support stands on the bed, and the same input
//               gives the same G-code twice
//   [field]     the field's block codec on a device: every pixel of a code texture reads back as written, uniform
//               blocks, mixed blocks, a texture edge that cuts a block and rows past the ones packed included
// [gpu] runs only with a device (Dawn under node: SUPPORT_GPU_WEBGPU_PATH=<webgpu index.js>, or the `webgpu` package
//  when installed); without one it SKIPS. The CPU slice is the contract.
//   Run: node packages/engine/tests/test_support_gpu.mjs
import { strict as assert } from 'node:assert'
import createSlicer from '../src/slicer_core.js'
import { SECTION_FLOATS, branchRadius, routeBranches } from '../src/support_route.js'
import { PACKED_PIXELS, simplifyRing, tracePackedRings, traceRings } from '../src/support_trace.js'
import { fieldBlockCode, makeFieldBlocks, makeSupportGpu } from '../src/support_gpu.js'
import { readFileSync } from 'node:fs'
import { kernelHasSupportPhase, sliceWithSupportGpu, slicesOrganicSupport } from '../src/support_slice.js'
import { outwardBoxTriangles, trianglesToSTLBytes } from '../../wasm-core/tests/stl_fixtures.mjs'

let passed = 0, skipped = 0
const ok = (name) => { passed++; console.log('  ok', name) }
const skip = (name) => { skipped++; console.log('  skip', name) }

// ---- [radius]
const settings = { layerHeight: 0.2, maxMove: 0.2, minRadius: 0.4, branchRadius: 1, radiusIncreasePerLayer: 0.0175, tipLayers: 5 }
assert.equal(branchRadius(settings, 0), 0.4)
assert.ok(Math.abs(branchRadius(settings, 5) - 1) < 1e-12, 'the tip reaches the branch radius after tipLayers')
assert.ok(Math.abs(branchRadius(settings, 105) - (1 + 100 * 0.0175)) < 1e-12, 'below the tip the radius grows per layer')
ok('[radius] branchRadius follows upstream')

// ---- [route]
const bed = { minX: -50, minY: -50, maxX: 50, maxY: 50 }
const grid = { originX: -50, originY: -50, pixel: 0.2, movePixels: 1 }
const sectionsOf = (routed, layer) => {
  const list = []
  for (let section = routed.layerStart[layer]; section < routed.layerStart[layer + 1]; section++) list.push(Array.from(routed.sections.subarray(section * SECTION_FLOATS, (section + 1) * SECTION_FLOATS)))
  return list
}
{
  // open space: two tips 3 mm apart, 40 layers up, meet and reach the bed as one branch
  const tips = Float32Array.from([-1.5, 0, 40, 0.4, 1.5, 0, 40, 0.4])
  const routed = routeBranches({ tips, layerCount: 41, settings, bed, grid, reachAt: () => 30 })
  assert.equal(routed.stats.tips, 2)
  assert.equal(routed.stats.merges, 1, 'the two branches merge')
  assert.equal(routed.stats.roots, 1, 'one branch reaches the bed')
  assert.equal(routed.stats.onModel, 0)
  for (let layer = 0; layer <= 40; layer++) assert.ok(sectionsOf(routed, layer).length >= 1, `layer ${layer} holds a cross-section`)
  assert.equal(sectionsOf(routed, 0).length, 1, 'one cross-section stands on the bed')
  assert.equal(sectionsOf(routed, 40).length, 2, 'both tips are drawn on their own layer')
  // a step never exceeds the field's move
  for (let layer = 1; layer <= 40; layer++) for (const section of sectionsOf(routed, layer)) assert.ok(section[6] * 2 <= grid.pixel * Math.SQRT2 + 1e-6, 'a step is at most one field pixel')
  ok('[route] two tips merge and stand on the bed')
}
{
  // a wall at x in [2, 3] below layer 30: a tip above it has to step off before it gets there
  const reachAt = (fieldLayer, x) => {
    if (fieldLayer < 30 && x >= 2 && x <= 3) return 0
    // room grows with the distance from the wall, and is carried down from the layers above it
    if (fieldLayer < 30) return Math.max(0.001, Math.min(30, Math.abs(x - 2.5) - 0.5))
    return Math.max(0.001, Math.min(30, Math.abs(x - 2.5) - 0.5 + (fieldLayer - 30) * 0.2))
  }
  const routed = routeBranches({ tips: Float32Array.from([2.5, 0, 60, 0.4]), layerCount: 61, settings, bed, grid, reachAt })
  assert.equal(routed.stats.roots, 1, 'the branch reaches the bed')
  for (let layer = 0; layer < 30; layer++) for (const section of sectionsOf(routed, layer)) {
    assert.ok(section[0] < 2 - section[4] + grid.pixel || section[0] > 3 + section[4] - grid.pixel, `layer ${layer}: the branch is beside the wall (x ${section[0].toFixed(2)}, radius ${section[4].toFixed(2)})`)
  }
  ok('[route] a wall is walked around')
}
{
  // solid everywhere below layer 10: the branch ends there
  const routed = routeBranches({ tips: Float32Array.from([0, 0, 20, 0.4]), layerCount: 21, settings, bed, grid, reachAt: (fieldLayer) => { if (fieldLayer < 10) return 0; return 30 } })
  assert.equal(routed.stats.onModel, 1, 'the branch ends on the model')
  assert.equal(routed.stats.roots, 0)
  for (let layer = 0; layer < 10; layer++) assert.equal(sectionsOf(routed, layer).length, 0, `layer ${layer} below the model's top holds nothing`)
  ok('[route] a branch with the model under it ends on it')
}
{
  // two object layers per field layer: a branch changes pixel only between field layers
  const pairGrid = { ...grid, movePixels: 2, layersPerStep: 2 }
  const routed = routeBranches({ tips: Float32Array.from([-4, 0, 40, 0.4, 4, 0, 40, 0.4]), layerCount: 41, settings, bed, grid: pairGrid, reachAt: () => 30 })
  assert.equal(routed.stats.roots, 1)
  // going from an odd layer to the even one below stays inside one field layer
  for (let layer = 1; layer <= 40; layer += 2) for (const section of sectionsOf(routed, layer)) assert.ok(section[6] < 1e-9, `layer ${layer}: no sideways step inside a field layer`)
  ok('[route] with two layers per field layer a branch moves between field layers only')
}

// ---- [trace]
const signedArea = (ring) => { let area = 0; for (let at = 0; at < ring.length; at += 2) { const next = (at + 2) % ring.length; area += ring[at] * ring[next + 1] - ring[next] * ring[at + 1] } return area / 2 }
{
  const width = 10, rows = 8, image = new Uint8Array(width * rows)
  for (let y = 1; y < 6; y++) for (let x = 1; x < 7; x++) image[y * width + x] = 255
  image[3 * width + 3] = 0; image[3 * width + 4] = 0   // a hole
  image[6 * width + 7] = 255                              // a pixel touching the block at a corner
  const { rings, solidPixels } = traceRings(image, width, width, rows)
  assert.equal(solidPixels, 29)
  assert.equal(rings.length, 3, 'the block, its hole, and the corner pixel are three rings')
  const areas = rings.map(signedArea).sort((a, b) => a - b)
  assert.deepEqual(areas, [-2, 1, 30], 'the hole runs the other way round')
  // random masks, with a solid block so that whole words of solid pixels are skipped
  let seed = 7
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let trial = 0; trial < 200; trial++) {
    const maskWidth = 3 + Math.floor(random() * 40), maskRows = 3 + Math.floor(random() * 30), rowBytes = Math.ceil(maskWidth / 256) * 256
    const mask = new Uint8Array(rowBytes * maskRows), fill = random()
    for (let y = 0; y < maskRows; y++) for (let x = 0; x < maskWidth; x++) if (random() < fill) mask[y * rowBytes + x] = 255
    if (trial % 3 === 0) for (let y = 2; y < Math.min(maskRows, 14); y++) for (let x = 1; x < Math.min(maskWidth, 22); x++) mask[y * rowBytes + x] = 255
    let expected = 0
    for (let y = 0; y < maskRows; y++) for (let x = 0; x < maskWidth; x++) if (mask[y * rowBytes + x]) expected++
    const traced = traceRings(mask, rowBytes, maskWidth, maskRows)
    assert.equal(traced.solidPixels, expected, `trial ${trial}: the solid pixels are counted`)
    assert.ok(Math.abs(Math.abs(traced.rings.reduce((sum, ring) => sum + signedArea(ring), 0)) - expected) < 1e-9, `trial ${trial}: the rings enclose the solid pixels`)
    // the same mask as one bit per pixel, at an offset inside a larger packed image with other bits around it: the
    //  pipeline reads a batch of masks back that way, and the rings have to be the byte tracer's
    const left = Math.floor(random() * 70), top = Math.floor(random() * 5), wordsPerRow = 4
    const packed = new Uint32Array(wordsPerRow * (maskRows + top + 2))
    for (let index = 0; index < packed.length; index++) packed[index] = Math.floor(random() * 0x100000000) >>> 0
    for (let y = 0; y < maskRows; y++) for (let x = 0; x < maskWidth; x++) {
      const wordIndex = (top + y) * wordsPerRow + Math.floor((left + x) / PACKED_PIXELS), bit = 1 << ((left + x) % PACKED_PIXELS)
      if (mask[y * rowBytes + x]) packed[wordIndex] |= bit
      else packed[wordIndex] &= ~bit
    }
    assert.deepEqual(tracePackedRings(packed, wordsPerRow, left, top, maskWidth, maskRows), traced, `trial ${trial}: the packed mask traces to the same rings`)
  }
  const circle = []
  for (let index = 0; index < 400; index++) circle.push(Math.round(50 + 40 * Math.cos(index / 400 * 2 * Math.PI)), Math.round(50 + 40 * Math.sin(index / 400 * 2 * Math.PI)))
  const simplified = simplifyRing(circle, 1)
  assert.ok(simplified.length / 2 < 60 && simplified.length / 2 >= 8, `a circle keeps a few corners (${simplified.length / 2})`)
  assert.ok(Math.abs(Math.abs(signedArea(simplified)) - Math.PI * 1600) / (Math.PI * 1600) < 0.03, 'and its area within 3 %')
  ok('[trace] rings enclose the solid pixels; simplifying keeps the shape')
}

// ---- [organic]
assert.equal(slicesOrganicSupport(JSON.stringify({ enable_support: true, support_style: 'tree' })), true, 'tree with no tree_style is organic')
assert.equal(slicesOrganicSupport(JSON.stringify({ enable_support: true, support_style: 'tree', tree_style: 'slim' })), false)
assert.equal(slicesOrganicSupport(JSON.stringify({ enable_support: true, support_style: 'grid' })), false)
assert.equal(slicesOrganicSupport(JSON.stringify({ enable_support: false, support_style: 'tree' })), false)
assert.equal(slicesOrganicSupport(JSON.stringify({ enable_support: true, support_style: 'tree', raft_layers: 2 })), false, 'a raft keeps upstream\'s path')
ok('[organic] the params that stop a slice at its support tips')

// ---- the kernel side, with a pipeline standing in for the GPU
const kernel = await createSlicer()
assert.ok(kernelHasSupportPhase(kernel), 'the kernel has the support phase')
const model = trianglesToSTLBytes([...outwardBoxTriangles(-4, -4, 0, 8, 8, 20), ...outwardBoxTriangles(-20, -20, 20, 40, 40, 1.2)])
const paramsText = JSON.stringify({
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15,
  bed_width: 180, bed_depth: 180, printable_height: 180, skirt_loops: 0, enable_support: true, support_style: 'tree', gcode_role_tags: true,
})
const supportMm = (gcode) => {
  let inSupport = false, x = 0, y = 0, total = 0
  for (const line of gcode.split('\n')) {
    if (line.startsWith(';TYPE:')) { inSupport = /support/i.test(line); continue }
    if (!line.startsWith('G1 ')) continue
    const nextX = Number(/X(-?[\d.]+)/.exec(line)?.[1] ?? x), nextY = Number(/Y(-?[\d.]+)/.exec(line)?.[1] ?? y)
    if (inSupport && / E[\d.]/.test(line)) total += Math.hypot(nextX - x, nextY - y)
    x = nextX; y = nextY
  }
  return total
}
const plain = kernel.slice(model, paramsText, () => {})
const job = (supportGpu) => sliceWithSupportGpu({ kernel, supportGpu, stl: model, paramsText, onProgress: () => {} })
{
  const failed = await job({ run: async () => ({ ok: false, reason: 'no device today' }) })
  assert.equal(failed.stats.support_engine, 'cpu')
  assert.equal(failed.stats.support_engine_reason, 'no device today')
  assert.equal(failed.gcode, plain.gcode, 'the slice is the kernel\'s own, byte for byte')
  const thrown = await job({ run: async () => { throw new Error('device lost') } })
  assert.equal(thrown.stats.support_engine_reason, 'device lost')
  assert.equal(thrown.gcode, plain.gcode)
  assert.equal(kernel.slice(model, paramsText, () => {}).gcode, plain.gcode, 'and nothing is left behind for the next slice')
  ok('[fallback] a failing pipeline leaves the kernel\'s own slice')
}
{
  // The worker hands the pipeline over as a promise it started before the capture, so the device is made while the
  //  kernel runs (awaited first, eight workers each waited ~1.2 s before their kernel started). The promise is not
  //  read before the capture is over, and one that gives nothing leaves the kernel's own slice with the worker's reason.
  let captureDone = false, awaitedAfterCapture = null
  const progressed = () => { captureDone = true }
  const late = { then: (resolve) => { awaitedAfterCapture = captureDone; resolve(null) } }
  const none = await sliceWithSupportGpu({ kernel, supportGpu: late, unavailableReason: () => 'no adapter here', stl: model, paramsText, onProgress: progressed })
  assert.equal(awaitedAfterCapture, true, 'the pipeline promise is awaited after the capture')
  assert.equal(none.stats.support_engine, 'cpu')
  assert.equal(none.stats.support_engine_reason, 'no adapter here')
  assert.equal(none.gcode, plain.gcode)
  const resolved = await sliceWithSupportGpu({ kernel, supportGpu: Promise.resolve({ run: async () => ({ ok: false, reason: 'asked' }) }), stl: model, paramsText, onProgress: () => {} })
  assert.equal(resolved.stats.support_engine_reason, 'asked', 'a promised pipeline is run')
  const workerSource = readFileSync(new URL('../src/slicer.worker.js', import.meta.url), 'utf8')
  assert.ok(/supportGpu: supportGpuOf\(\)/.test(workerSource), 'the worker passes the pipeline as a promise, not awaited')
  ok('[fallback] a pipeline handed over as a promise is awaited after the capture; none leaves the kernel\'s own slice')
}
{
  let seen = null
  const column = { run: async (request) => {
    seen = request
    const layers = request.outlines.layerRingStart.length - 1
    const layerRingStart = new Uint32Array(layers + 1), ringStart = [0], points = []
    for (let layer = 0; layer < layers; layer++) {
      if (layer < request.supportLayers - 2) { points.push(10, 10, 16, 10, 16, 16, 10, 16); ringStart.push(points.length / 2) }
      layerRingStart[layer + 1] = ringStart.length - 1
    }
    return { ok: true, layerRingStart, ringStart: Uint32Array.from(ringStart), points: Float32Array.from(points), stats: { totalMs: 1 } }
  } }
  const injected = await job(column)
  assert.equal(injected.stats.support_engine, 'gpu')
  assert.ok(seen.tips.length >= 4 && seen.tips.buffer !== kernel.HEAPF32?.buffer, 'the request is a copy, not a view of the kernel heap')
  assert.ok(supportMm(injected.gcode) > 100, 'the pipeline\'s rings are printed')
  assert.notEqual(injected.gcode, plain.gcode)
  ok('[inject] the pipeline\'s support body is what the kernel prints')
}

// ---- [gpu]
let device = null
try {
  const module = await import(process.env.SUPPORT_GPU_WEBGPU_PATH || 'webgpu')
  const gpu = module.create([])
  globalThis.__supportGpuInstance = gpu   // Dawn's instance must outlive the run (a collected one crashes the process)
  const adapter = await gpu.requestAdapter()
  if (adapter) device = await adapter.requestDevice()
} catch { device = null }
if (!device) skip('[field] no WebGPU device')
else {
  // a width and a row count that cut the last block, solid runs, and noise; rows past `rows` hold codes never packed
  const width = 203, height = 77, rows = 70, rowBytes = Math.ceil(width / 256) * 256
  const codes = new Uint8Array(rowBytes * height)
  let seed = 11
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let code = Math.floor(random() * 256)
    if (x < 90 && y < 40) code = 0
    else if (x >= 120 && y >= 20 && y < 60) code = 1 + Math.floor(x / 40)
    codes[y * rowBytes + x] = code
  }
  const texture = device.createTexture({ size: [width, height], format: 'r8unorm', usage: 0x4 | 0x2 })   // TEXTURE_BINDING | COPY_DST
  device.queue.writeTexture({ texture }, codes, { bytesPerRow: rowBytes }, [width, height])
  const encoder = device.createCommandEncoder()
  const pending = makeFieldBlocks(device).encode(encoder, texture.createView(), width, rows)
  device.queue.submit([encoder.finish()])
  const page = await pending.submitted()
  let wrong = 0
  for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) if (fieldBlockCode(page, x, y) !== codes[y * rowBytes + x]) wrong++
  assert.equal(wrong, 0, 'every packed pixel reads back as written')
  assert.ok(page.bytes < rows * width, `the page is smaller than the pixels (${page.bytes} of ${rows * width} bytes)`)
  page.release(); texture.destroy()
  ok('[field] the block codec reads every pixel back as written')
}
if (!device) skip('[gpu] no WebGPU device')
else {
  const supportGpu = makeSupportGpu(device)
  const first = await job(supportGpu)
  assert.equal(first.stats.support_engine, 'gpu', `the GPU made the branches (${first.stats.support_engine_reason})`)
  const figures = first.stats.support_gpu
  assert.ok(figures.tips > 100, `the tips are routed (${figures.tips})`)
  assert.ok(figures.roots >= 1, 'a branch stands on the bed')
  assert.equal(figures.onModel, 0, 'nothing ends on the model: the roof has free space under it')
  const ratio = supportMm(first.gcode) / supportMm(plain.gcode)
  assert.ok(ratio > 0.3 && ratio < 3, `the support is of upstream's order (${ratio.toFixed(2)} of its length)`)
  const second = await job(supportGpu)
  assert.equal(second.gcode, first.gcode, 'the same input gives the same G-code')
  ok(`[gpu] ${figures.tips} tips routed to ${figures.roots} roots in ${Math.round(figures.totalMs)} ms; support ${ratio.toFixed(2)} of upstream's length`)
}

console.log(`\nsupport_gpu: ${passed} passed, ${skipped} skipped`)
process.exit(0)
