// The front of PASS1 on the GPU: the seated triangles and the layer planes in (the kernel's MESH phase,
//  wasm-core/contour_phase.h), contour_gpu.js's union input out, in GPU buffers, so the contours never leave the GPU
//  between the cut and the union.
//
// What runs here (WGSL: contour_front_shaders.js), every layer at once:
//   cut      per triangle, the layers it spans (exact z compares), each crossing in double-float, oriented as tri_plane
//   cancel   segments coinciding exactly in opposite directions removed in pairs (cancel_coincident), by a hash on place
//   chain    each end continues into the smallest unused segment starting at its 1e-3 mm key (chain_polys' greedy rule)
//   loops    pointer jumping for each loop's head and each segment's rank; tails that lead into a cycle stay out
//   layout   loops sorted by (layer, head), laid out as chain_polys' n + 1 points, write_polygon's duplicates dropped
//   tables   layer origins and grids, polygon ranges, the cell-list size
//
// Measured (design report gpu-full-port-trial-2026-10-01.md section 3): 3.0M triangles, 420 layers in 30 ms (the kernel's
//  own capture: 410 ms st, 71 ms mt); 0.24 % of the edges differ from the kernel's by its double rounding a shared
//  mesh-edge crossing to 1e-6 mm two ways, which the 48-bit double-float does not reproduce.
//
// A layer with a chain that does not close is marked (openLayers): the kernel cuts, chains and unions that layer itself
//  from the mesh it handed over (contour_phase::assemble), so the slice never depends on the GPU closing every loop.
import {
  CUT_SHADER, CANCEL_SHADER, CHAIN_SHADER, JUMP_SHADER, CYCLES_SHADER, LOOPS_SHADER, OUTPUT_SHADER, WRITE_SHADER,
  TABLES_SHADER, ENTRIES_SHADER, OPEN_LAYERS_SHADER,
} from './contour_front_shaders.js'
import { SCAN_SHADER } from './contour_gpu_shaders.js'

// Numeric WebGPU constants: the named globals exist in a browser worker but not on a bare node globalThis.
const BUFFER = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 }
const SHADER_STAGE_COMPUTE = 0x4
const MAP_MODE_READ = 0x1
const WORKGROUP_SIZE = 256
const MAX_WORKGROUPS_PER_DIMENSION = 65535
const CELL_SIZE = 2_000_000   // the union's grid cell in kernel units; contour_gpu.js and contour_phase.cpp use the same
const INT32_MAX = 0x7fffffff
const INT32_MIN = -0x80000000

const smallestPowerOfTwo = (count) => 2 ** Math.ceil(Math.log2(Math.max(2, count)))

/**
 * @param {GPUDevice} device the device contour_gpu.js runs on (its buffers feed the union directly)
 * @returns {Promise<{ cut(triangles: Float32Array, planes: Float64Array): Promise<object>, dispose(): void }>}
 */
export async function makeContourFront(device) {
  const BINDING_TYPE = { u: 'uniform', r: 'read-only-storage', w: 'storage' }
  const layouts = new Map(), modules = new Map(), pipelines = new Map(), buffers = new Map()
  let encoder = null, transient = []

  const layoutOf = (kinds) => {
    if (!layouts.has(kinds)) layouts.set(kinds, device.createBindGroupLayout({ entries: [...kinds].map((kind, binding) => (
      { binding, visibility: SHADER_STAGE_COMPUTE, buffer: { type: BINDING_TYPE[kind] } })) }))
    return layouts.get(kinds)
  }
  const pipelineOf = (code, entryPoint, kinds) => {
    const key = `${entryPoint}\u0000${kinds}\u0000${code}`
    if (!pipelines.has(key)) {
      if (!modules.has(code)) modules.set(code, device.createShaderModule({ code }))
      pipelines.set(key, device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layoutOf(kinds)] }),
        compute: { module: modules.get(code), entryPoint } }))
    }
    return pipelines.get(key)
  }
  // compile every shader up front, so a WGSL error surfaces as a refusal instead of an empty result
  for (const code of [CUT_SHADER, CANCEL_SHADER, CHAIN_SHADER, JUMP_SHADER, CYCLES_SHADER, LOOPS_SHADER, OUTPUT_SHADER, WRITE_SHADER, TABLES_SHADER, ENTRIES_SHADER, OPEN_LAYERS_SHADER, SCAN_SHADER]) {
    const module = device.createShaderModule({ code })
    modules.set(code, module)
    const failure = (await module.getCompilationInfo()).messages.find(message => message.type === 'error')
    if (failure) throw new Error(`contour front shader: line ${failure.lineNum}: ${failure.message}`)
  }

  // a storage buffer kept across slices by name; a regrown one is destroyed after the submit that last used it
  const buffer = (name, bytes) => {
    const size = Math.max(16, Math.ceil(bytes / 16) * 16)
    const kept = buffers.get(name)
    if (kept && kept.size >= size) return kept
    if (kept) transient.push(kept)
    const made = device.createBuffer({ size, usage: BUFFER.STORAGE | BUFFER.COPY_SRC | BUFFER.COPY_DST })
    buffers.set(name, made)
    return made
  }
  const encoderOf = () => { if (!encoder) encoder = device.createCommandEncoder(); return encoder }
  const uniform = (values) => {
    const made = device.createBuffer({ size: Math.max(16, values.length * 4), usage: BUFFER.UNIFORM | BUFFER.COPY_DST })
    device.queue.writeBuffer(made, 0, new Uint32Array(values))
    transient.push(made)
    return made
  }
  const zero = device.createBuffer({ size: 16, usage: BUFFER.UNIFORM | BUFFER.COPY_DST })   // the double-float's `dfZero`
  device.queue.writeBuffer(zero, 0, new Uint32Array(4))
  const run = (code, entryPoint, kinds, bound, invocations) => {
    if (invocations <= 0) return
    let groupsX = Math.ceil(invocations / WORKGROUP_SIZE), groupsY = 1
    if (groupsX > MAX_WORKGROUPS_PER_DIMENSION) { groupsY = Math.ceil(groupsX / MAX_WORKGROUPS_PER_DIMENSION); groupsX = MAX_WORKGROUPS_PER_DIMENSION }
    const group = device.createBindGroup({ layout: layoutOf(kinds), entries: bound.map((target, binding) => ({ binding, resource: { buffer: target } })) })
    const pass = encoderOf().beginComputePass()
    pass.setPipeline(pipelineOf(code, entryPoint, kinds)); pass.setBindGroup(0, group); pass.dispatchWorkgroups(groupsX, groupsY); pass.end()
  }
  const clear = (target, bytes) => encoderOf().clearBuffer(target, 0, Math.ceil(bytes / 4) * 4)
  const copy = (source, sourceOffset, target, targetOffset, bytes) => encoderOf().copyBufferToBuffer(source, sourceOffset, target, targetOffset, bytes)
  const submit = async () => {
    if (encoder) { device.queue.submit([encoder.finish()]); encoder = null }
    await device.queue.onSubmittedWorkDone()
    for (const item of transient) item.destroy()
    transient = []
  }
  // `wordCount` 32-bit words from `offsetWords` on, copied out of the staging buffer
  const readWords = async (source, wordCount, offsetWords = 0, Type = Uint32Array) => {
    const bytes = Math.max(4, wordCount * 4)
    const staging = device.createBuffer({ size: Math.ceil(bytes / 16) * 16, usage: BUFFER.MAP_READ | BUFFER.COPY_DST })
    encoderOf().copyBufferToBuffer(source, offsetWords * 4, staging, 0, Math.ceil(bytes / 4) * 4)
    await submit()
    await staging.mapAsync(MAP_MODE_READ)
    const words = new Type(staging.getMappedRange(0, wordCount * 4).slice(0))
    staging.unmap(); staging.destroy()
    return words
  }
  // in-place exclusive scan of `count` u32 (contour_gpu_shaders.js' scan)
  const scan = (data, count, depth = 0) => {
    const blocks = Math.ceil(count / WORKGROUP_SIZE)
    const sums = buffer(`scan.${depth}`, (blocks + 1) * 4)
    const parameters = uniform([count, 0, 0, 0])
    run(SCAN_SHADER, 'scanBlock', 'uww', [parameters, data, sums], count)
    if (blocks === 1) return
    scan(sums, blocks, depth + 1)
    run(SCAN_SHADER, 'addOff', 'uww', [parameters, data, sums], count)
  }

  // layers, triangles -> segments (with their chain keys), cancelled pairs, successors
  async function segmentsOf(triangles, planes) {
    const triangleCount = triangles.length / 9, layerCount = planes.length
    const planePairs = new Float32Array(layerCount * 2)   // each plane's z as hi + lo, for exact compares with f32 vertices
    for (let layer = 0; layer < layerCount; layer++) {
      const high = Math.fround(planes[layer])
      planePairs[layer * 2] = high; planePairs[layer * 2 + 1] = Math.fround(planes[layer] - high)
    }
    const triangleBuffer = buffer('triangles', triangles.byteLength), planeBuffer = buffer('planes', planePairs.byteLength)
    device.queue.writeBuffer(triangleBuffer, 0, triangles); device.queue.writeBuffer(planeBuffer, 0, planePairs)
    const counts = buffer('counts', (triangleCount + 1) * 4)
    clear(counts, (triangleCount + 1) * 4)
    const unused = [1, 2, 3].map(index => buffer(`unused${index}`, 16))
    run(CUT_SHADER, 'main', 'urrwwwwu', [uniform([triangleCount, layerCount, 0, 0]), triangleBuffer, planeBuffer, counts, ...unused, zero], triangleCount)
    scan(counts, triangleCount + 1)
    const [segmentCount] = await readWords(counts, 1, triangleCount)   // the segment count sizes everything after
    const segmentPoints = buffer('segmentPoints', segmentCount * 16), segmentKeys = buffer('segmentKeys', segmentCount * 16)
    const segmentLayer = buffer('segmentLayer', segmentCount * 4)
    run(CUT_SHADER, 'main', 'urrwwwwu', [uniform([triangleCount, layerCount, 1, 0]), triangleBuffer, planeBuffer, counts, segmentPoints, segmentKeys, segmentLayer, zero], triangleCount)

    const tableSize = smallestPowerOfTwo(segmentCount * 2), mask = tableSize - 1
    const dead = buffer('dead', segmentCount * 4)
    const owner = buffer('owner', tableSize * 4), headA = buffer('headA', tableSize * 4), headB = buffer('headB', tableSize * 4)
    const nextA = buffer('nextA', segmentCount * 4), nextB = buffer('nextB', segmentCount * 4)
    clear(dead, segmentCount * 4); clear(owner, tableSize * 4); clear(headA, tableSize * 4); clear(headB, tableSize * 4)
    const cancelBound = [uniform([segmentCount, mask, 0, 0]), segmentPoints, segmentLayer, owner, headA, headB, nextA, dead]
    run(CANCEL_SHADER, 'insert', 'urrwwwww', cancelBound, segmentCount)
    run(CANCEL_SHADER, 'pair', 'urrwwwww', cancelBound, tableSize)
    clear(owner, tableSize * 4); clear(headA, tableSize * 4); clear(headB, tableSize * 4)
    const successor = buffer('successor', (segmentCount + 2) * 4)
    clear(successor, (segmentCount + 2) * 4)
    const chainBound = [uniform([segmentCount, mask, 0, 0]), segmentKeys, segmentLayer, dead, owner, headA, headB, nextA, nextB, successor]
    run(CHAIN_SHADER, 'insertStarts', 'urrrwwwwww', chainBound, segmentCount)
    run(CHAIN_SHADER, 'insertEnds', 'urrrwwwwww', chainBound, segmentCount)
    run(CHAIN_SHADER, 'pairEnds', 'urrrwwwwww', chainBound, tableSize)
    return { layerCount, segmentCount, segmentPoints, segmentLayer, successor, dead }
  }

  // segments with successors -> the union's input (contour_gpu.js' layout), still on the GPU
  async function loopsOf(segments) {
    const { layerCount, segmentCount, segmentPoints, segmentLayer, successor, dead } = segments
    // labels (each segment's loop head), then ranks (its distance to the loop's last segment); ping-pong buffers
    const rounds = Math.ceil(Math.log2(Math.max(2, segmentCount))) + 1
    const valueA = buffer('valueA', segmentCount * 4), nextOfA = buffer('nextOfA', segmentCount * 4)
    const valueB = buffer('valueB', segmentCount * 4), nextOfB = buffer('nextOfB', segmentCount * 4)
    const label = buffer('label', segmentCount * 4), rank = buffer('rank', segmentCount * 4), reach = buffer('reach', segmentCount * 4)
    const jump = (mode, input, output) => run(JUMP_SHADER, 'main', 'urrwwwwrr',
      [uniform([segmentCount, mode, 0, 0]), successor, dead, input[0], input[1], output[0], output[1], label, reach], segmentCount)
    const jumpRounds = (mode, finalValue, finalNext) => {
      let from = [valueA, nextOfA], to = [valueB, nextOfB]
      for (let round = 0; round < rounds; round++) { jump(mode, from, to); [from, to] = [to, from] }
      copy(from[0], 0, finalValue, 0, segmentCount * 4)
      if (finalNext) copy(from[1], 0, finalNext, 0, segmentCount * 4)
    }
    jump(0, [valueB, nextOfB], [valueA, nextOfA]); jumpRounds(1, label, reach)
    const hit = buffer('hit', segmentCount * 4)
    clear(hit, segmentCount * 4)
    run(CYCLES_SHADER, 'main', 'uww', [uniform([segmentCount, 0, 0, 0]), reach, hit], segmentCount)
    run(CYCLES_SHADER, 'main', 'uww', [uniform([segmentCount, 1, 0, 0]), reach, hit], segmentCount)
    const openLayer = buffer('openLayer', layerCount * 4)
    clear(openLayer, layerCount * 4)
    run(OPEN_LAYERS_SHADER, 'main', 'urrrw', [uniform([segmentCount, 0, 0, 0]), dead, reach, segmentLayer, openLayer], segmentCount)
    jump(2, [valueB, nextOfB], [valueA, nextOfA]); jumpRounds(3, rank)

    // heads, sorted by (layer, head) with a bitonic sort
    const headFlag = buffer('headFlag', (segmentCount + 1) * 4)
    clear(headFlag, (segmentCount + 1) * 4)
    const loopBound = (parameters, heads, polygonOf, loopStart, order) => [parameters, successor, label, rank, segmentLayer, headFlag, heads, polygonOf, loopStart, order, reach]
    const unused = [4, 5, 6, 7].map(index => buffer(`unused${index}`, 16))
    run(LOOPS_SHADER, 'flagHeads', 'urrrrwwwwwr', loopBound(uniform([segmentCount, 0, layerCount, 0]), ...unused), segmentCount)
    scan(headFlag, segmentCount + 1)
    const [headCount] = await readWords(headFlag, 1, segmentCount)    // the loop count sizes the sort
    const padded = smallestPowerOfTwo(headCount)
    const heads = buffer('heads', padded * 8), polygonOf = buffer('polygonOf', segmentCount * 4)
    const loopStart = buffer('loopStart', (headCount + 1) * 4), order = buffer('order', (segmentCount + headCount) * 4)
    const bound = (parameters) => loopBound(parameters, heads, polygonOf, loopStart, order)
    run(LOOPS_SHADER, 'gatherHeads', 'urrrrwwwwwr', bound(uniform([segmentCount, padded, layerCount, 0])), segmentCount)
    run(LOOPS_SHADER, 'padHeads', 'urrrrwwwwwr', bound(uniform([segmentCount, padded, layerCount, headCount])), padded - headCount)
    for (let block = 2; block <= padded; block *= 2) for (let distance = block / 2; distance >= 1; distance /= 2)
      run(LOOPS_SHADER, 'bitonic', 'urrrrwwwwwr', bound(uniform([segmentCount, padded, distance, block])), padded)
    clear(loopStart, (headCount + 1) * 4)
    run(LOOPS_SHADER, 'lengths', 'urrrrwwwwwr', bound(uniform([segmentCount, padded, layerCount, headCount])), headCount)
    scan(loopStart, headCount + 1)
    const [slotCount] = await readWords(loopStart, 1, headCount)      // points of the closed loops, chain_polys' n + 1 each
    run(LOOPS_SHADER, 'place', 'urrrrwwwwwr', bound(uniform([segmentCount, padded, layerCount, headCount])), segmentCount)

    // the points write_polygon keeps, the polygons chain_polys keeps, the layer boxes
    const kept = buffer('kept', (slotCount + 1) * 4), polygonKept = buffer('polygonKept', (headCount + 1) * 4)
    const layerBox = buffer('layerBox', layerCount * 32), slotPolygon = buffer('slotPolygon', slotCount * 4)
    const boxStart = new Int32Array(layerCount * 8)
    for (let layer = 0; layer < layerCount; layer++) boxStart.set([INT32_MAX, INT32_MAX, INT32_MIN, INT32_MIN], layer * 8)
    device.queue.writeBuffer(layerBox, 0, boxStart)
    clear(kept, (slotCount + 1) * 4)
    const outputBound = [uniform([slotCount, headCount, layerCount, 0]), order, segmentPoints, segmentLayer, successor, loopStart, kept, polygonKept, layerBox, slotPolygon]
    run(OUTPUT_SHADER, 'slotPolygons', 'urrrrrwwww', outputBound, headCount)
    run(OUTPUT_SHADER, 'keep', 'urrrrrwwww', outputBound, slotCount)
    run(OUTPUT_SHADER, 'polygonCounts', 'urrrrrwwww', outputBound, headCount)
    run(OUTPUT_SHADER, 'keepValid', 'urrrrrwwww', outputBound, slotCount)
    const polygonValidAt = buffer('polygonValidAt', (headCount + 1) * 4)
    clear(polygonValidAt, (headCount + 1) * 4)
    copy(polygonKept, 0, polygonValidAt, 0, headCount * 4)
    scan(polygonValidAt, headCount + 1)
    const keptAt = buffer('keptAt', (slotCount + 1) * 4)
    clear(keptAt, (slotCount + 1) * 4)
    copy(kept, 0, keptAt, 0, slotCount * 4)
    scan(keptAt, slotCount + 1)
    const [pointCount] = await readWords(keptAt, 1, slotCount)
    const [polygonCount] = await readWords(polygonValidAt, 1, headCount)
    const points = buffer('points', pointCount * 8), layerStart = buffer('layerStart', (layerCount + 1) * 4)
    clear(layerStart, (layerCount + 1) * 4)
    run(WRITE_SHADER, 'main', 'urrrrrrww', [uniform([slotCount, headCount, layerCount, 0]), order, segmentPoints, segmentLayer, kept, keptAt, layerBox, points, layerStart], slotCount)
    scan(layerStart, layerCount + 1)
    const layerInfo = buffer('layerInfo', (layerCount + 1) * 16), polygonInfo = buffer('polygonInfo', polygonCount * 20 + 16)
    const tableBound = [uniform([slotCount, headCount, layerCount, CELL_SIZE]), layerBox, layerStart, layerInfo, polygonValidAt, loopStart, keptAt, order, segmentLayer, polygonInfo]
    run(TABLES_SHADER, 'cells', 'urwwrrrrrw', tableBound, 1)
    run(TABLES_SHADER, 'polygons', 'urwwrrrrrw', tableBound, headCount)
    const entries = buffer('entries', 16)
    clear(entries, 16)
    run(ENTRIES_SHADER, 'main', 'urrw', [uniform([polygonCount, CELL_SIZE, 0, 0]), polygonInfo, points, entries], polygonCount)
    const [cellCount] = await readWords(layerInfo, 1, layerCount * 4)
    const [cellEntryCount] = await readWords(entries, 1)
    const boxes = await readWords(layerBox, layerCount * 8, 0, Int32Array)
    const openLayers = await readWords(openLayer, layerCount)
    // the origin the kernel adds back to every piece; a layer with no loop has none, and the kernel's own is 0 there
    const origins = new Int32Array(layerCount * 2)
    for (let layer = 0; layer < layerCount; layer++) {
      if (boxes[layer * 8 + 2] < boxes[layer * 8]) continue
      origins[layer * 2] = boxes[layer * 8]; origins[layer * 2 + 1] = boxes[layer * 8 + 1]
    }
    return { layerCount, segmentCount: pointCount, polygonCount, cellCount, cellEntryCount, headCount, slotCount, origins, openLayers,
      points, layerInfo, polygonInfo }
  }

  /**
   * The union input of every layer of a mesh.
   * @param {Float32Array} triangles 9 floats per triangle, seated (the kernel's contour_mesh().tris)
   * @param {Float64Array} planes the z of every layer plane (contour_mesh().planes)
   * @returns {Promise<object>} counts, `origins` (min x, min y per layer, kernel units), `openLayers` (1 per layer with a
   *   segment left out of every closed loop: that layer's input is incomplete and the kernel rebuilds it), `openSegments`
   *   and `input`, contour_gpu.js' union input with its arrays as GPU buffers
   */
  const cut = async (triangles, planes) => {
    const started = performance.now()
    const segments = await segmentsOf(triangles, planes)
    const [matcherOverflow] = await readWords(segments.successor, 1, segments.segmentCount)
    const deadFlags = await readWords(segments.dead, segments.segmentCount)
    let cancelled = 0
    for (const flag of deadFlags) cancelled += flag
    const laid = await loopsOf(segments)
    const loopSegments = laid.slotCount - laid.headCount
    return {
      ms: performance.now() - started, triangleCount: triangles.length / 9, rawSegments: segments.segmentCount, cancelled,
      openSegments: segments.segmentCount - cancelled - loopSegments, matcherOverflow, origins: laid.origins, openLayers: laid.openLayers,
      input: { layerCount: laid.layerCount, segmentCount: laid.segmentCount, polygonCount: laid.polygonCount, cellCount: laid.cellCount,
        cellEntryCount: laid.cellEntryCount, points: { gpuBuffer: laid.points }, layerInfo: { gpuBuffer: laid.layerInfo },
        polyInfo: { gpuBuffer: laid.polygonInfo }, polyLayer: { gpuBuffer: laid.polygonInfo, offset: laid.polygonCount * 16 } },
    }
  }
  const dispose = () => {
    for (const kept of buffers.values()) kept.destroy()
    buffers.clear()
    for (const item of transient) item.destroy()
    transient = []
    zero.destroy()
  }
  return { cut, dispose }
}
