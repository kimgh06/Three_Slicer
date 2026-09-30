// PASS1's per-layer union on the GPU: every layer's raw loops in, the union's boundary pieces out, all layers in one
//  submit. The kernel side is wasm-core/contour_phase.h (capture the loops, build this module's input, walk the pieces
//  into contours, and fall back to its own union for any layer whose loops do not close); the worker drives both.
//
// What runs here, per layer independently (WGSL: contour_gpu_shaders.js):
//   expand     the uploaded start points into segments, links and polygon-of-segment
//   bin        segments into a 2 mm grid per layer
//   intersect  pairs of segments sharing a cell; a crossing is decided as if every vertex were moved by an
//              infinitesimal amount (higher vertex id first, x before y), and its place along each segment is an exact
//              fraction of 64-bit integers
//   sort       each segment's crossings by that fraction; equal fractions by the same perturbation (256-bit compare)
//   winding    a ray per polygon for its first segment, then the crossings' deltas along the polygon
//   pieces     the stretches between crossings whose two sides differ in NonZero insideness
//   link       at every vertex, each piece's successor by direction
//   compact    (start x, start y, successor, layer) per piece — what the kernel reads
//
// Measured (design appendix F15): 2.3M segments over 849 layers in 50 to 70 ms including the kernel's side, against
//  2.6 s for the same union on one CPU thread and about 0.3 s on 14. The contours have the CPU union's area (within
//  2e-10 relative) and other vertices, so a GPU slice's G-code is not the CPU slice's byte for byte.
//
// The module takes its GPUDevice from the caller and never decides whether the GPU should be used.
import {
  BIN_SHADER, INTERSECT_SHADER, SORT_SHADER, LINK_SHADER, SCAN_SHADER, CHECK_SHADER, GLUE_SHADER, PIECES_SHADER,
  TIES_SHADER, ZIP_SHADER, DIRECTIONS_SHADER, EXPAND_SHADER, COMPACT_SHADER, GATE_SHADER, ARGS_SHADER,
  POLYGON_WINDING_SHADER,
} from './contour_gpu_shaders.js'

// Numeric WebGPU constants: the named globals exist in a browser worker but not on a bare node globalThis.
const BUFFER = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 }
const SHADER_STAGE_COMPUTE = 0x4
const MAP_MODE_READ = 0x1

const CELL_SIZE = 2_000_000          // the grid cell in kernel units (2 mm); contour_phase.cpp counts cell entries with the same value
const FILL_NONZERO = 0               // PASS1's fill rule (the shaders also know positive, negative and even-odd)
const WORKGROUP_SIZE = 256
const MAX_WORKGROUPS_PER_DIMENSION = 65535
const RANGE_LIMIT = 4096             // a scanned range longer than this is a corrupt scan, and no kernel loops over it
const VERTEX_DEGREE_LIMIT = 1024     // pieces meeting at one vertex
const SMALLEST_POOLED_BUFFER = 65536
const SMALLEST_EVENT_CAPACITY = 65536
// Crossings per segment the buffers are sized for, tried in order. A slice's contours rarely cross (measured: 80
//  crossings in 2.3M segments on a clean mesh, 64,000 in 1.6M on a scan), so the first fits; a run that overflows its
//  bound reports it and the next factor is tried.
const EVENTS_PER_SEGMENT = [1, 3]
// The limits the device is asked for. The defaults (128 MB per storage binding, 8 storage buffers per stage) are below
//  what a large model needs: pieces take 64 bytes per segment at the first event factor.
const WANTED_BINDING_BYTES = 1 << 30
const WANTED_STORAGE_BUFFERS = 10

/** A device for makeContourGpu from a GPU entry point (navigator.gpu in a worker), or null when there is none. */
export async function acquireContourDevice(gpu) {
  if (!gpu) return null
  const adapter = await gpu.requestAdapter()
  if (!adapter) return null
  if (adapter.limits.maxStorageBuffersPerShaderStage < WANTED_STORAGE_BUFFERS) return null
  return adapter.requestDevice({ requiredLimits: {
    maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, WANTED_BINDING_BYTES),
    maxBufferSize: Math.min(adapter.limits.maxBufferSize, WANTED_BINDING_BYTES),
    maxStorageBuffersPerShaderStage: WANTED_STORAGE_BUFFERS,
  } })
}

/**
 * @param {GPUDevice} device from acquireContourDevice (browser) or Dawn's create() (node tests)
 * @returns {Promise<{ union(input, piecesTarget): Promise<object>, dispose(): void }>}
 */
export async function makeContourGpu(device) {
  const compile = async (code, name) => {
    const module = device.createShaderModule({ code })
    const info = await module.getCompilationInfo()
    const failure = info.messages.find(message => message.type === 'error')
    if (failure) throw new Error(`contour GPU shader ${name}: line ${failure.lineNum}: ${failure.message}`)
    return module
  }
  // a layout from one letter per binding: u uniform, r read-only storage, w storage
  const BINDING_TYPE = { u: 'uniform', r: 'read-only-storage', w: 'storage' }
  const layoutOf = (kinds) => device.createBindGroupLayout({ entries: [...kinds].map((kind, binding) => (
    { binding, visibility: SHADER_STAGE_COMPUTE, buffer: { type: BINDING_TYPE[kind] } })) })
  const pipelineOf = (module, layout, entryPoint) => device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint } })

  const layouts = {
    expand: layoutOf('urrrwww'), bin: layoutOf('urrrwrw'), intersect: layoutOf('urrrrrwwrww'), sort: layoutOf('urrrrwr'),
    link: layoutOf('urrwrwwww'), scan: layoutOf('uww'), check: layoutOf('urw'), glue: layoutOf('urrrurrrww'),
    pieces: layoutOf('urrrurrrrwww'), ties: layoutOf('urrw'), zip: layoutOf('urrw'), directions: layoutOf('urw'),
    compact: layoutOf('urrrw'), gate: layoutOf('urrw'), args: layoutOf('urw'), polygonWinding: layoutOf('urrw'),
  }
  const modules = {
    expand: await compile(EXPAND_SHADER, 'expand'), bin: await compile(BIN_SHADER, 'bin'),
    intersect: await compile(INTERSECT_SHADER, 'intersect'), sort: await compile(SORT_SHADER, 'sort'),
    link: await compile(LINK_SHADER, 'link'), scan: await compile(SCAN_SHADER, 'scan'),
    check: await compile(CHECK_SHADER, 'check'), glue: await compile(GLUE_SHADER, 'glue'),
    pieces: await compile(PIECES_SHADER, 'pieces'), ties: await compile(TIES_SHADER, 'ties'),
    zip: await compile(ZIP_SHADER, 'zip'), directions: await compile(DIRECTIONS_SHADER, 'directions'),
    compact: await compile(COMPACT_SHADER, 'compact'), gate: await compile(GATE_SHADER, 'gate'),
    args: await compile(ARGS_SHADER, 'args'), polygonWinding: await compile(POLYGON_WINDING_SHADER, 'polygon winding'),
  }
  const pipelines = {
    expand: pipelineOf(modules.expand, layouts.expand, 'expand'),
    cellCount: pipelineOf(modules.bin, layouts.bin, 'count'), cellScatter: pipelineOf(modules.bin, layouts.bin, 'scatter'),
    intersect: pipelineOf(modules.intersect, layouts.intersect, 'intersect'),
    sortEvents: pipelineOf(modules.sort, layouts.sort, 'sortEvents'),
    vertexCount: pipelineOf(modules.link, layouts.link, 'vcountK'), vertexScatter: pipelineOf(modules.link, layouts.link, 'vscatter'),
    successor: pipelineOf(modules.link, layouts.link, 'successor'),
    scanBlock: pipelineOf(modules.scan, layouts.scan, 'scanBlock'), scanAddOffsets: pipelineOf(modules.scan, layouts.scan, 'addOff'),
    checkRanges: pipelineOf(modules.check, layouts.check, 'check'),
    rays: pipelineOf(modules.glue, layouts.glue, 'rays'), deltaSums: pipelineOf(modules.glue, layouts.glue, 'deltaSums'),
    pieces: pipelineOf(modules.pieces, layouts.pieces, 'pieces'), ties: pipelineOf(modules.ties, layouts.ties, 'ties'),
    zip: pipelineOf(modules.zip, layouts.zip, 'zip'), directions: pipelineOf(modules.directions, layouts.directions, 'dirs'),
    compact: pipelineOf(modules.compact, layouts.compact, 'compact'),
    gate: pipelineOf(modules.gate, layouts.gate, 'gate'), dispatchArguments: pipelineOf(modules.args, layouts.args, 'argsK'),
    polygonWinding: pipelineOf(modules.polygonWinding, layouts.polygonWinding, 'polyWK'),
  }

  // Buffers are pooled across runs, by size rounded up to a power of two: creating the upper-bound buffers anew each
  //  run cost more than the rest of the pipeline (measured). A pooled buffer is not zeroed, so every counter is cleared
  //  on the GPU before it is used.
  const pool = new Map()
  let lent = []
  let held = []      // bind groups and small buffers of the run in flight
  let encoder = null
  const smallBuffer = (usage) => { const buffer = device.createBuffer({ size: 16, usage }); held.push(buffer); return buffer }
  const pooled = (bytes, usage) => {
    const size = Math.max(SMALLEST_POOLED_BUFFER, 2 ** Math.ceil(Math.log2(Math.max(16, bytes))))
    const key = `${size}:${usage}`
    let buffer = pool.get(key)?.pop()
    if (!buffer) buffer = device.createBuffer({ size, usage: usage | BUFFER.COPY_DST })
    lent.push([key, buffer])
    return buffer
  }
  const release = () => {
    for (const [key, buffer] of lent) {
      if (!pool.has(key)) pool.set(key, [])
      pool.get(key).push(buffer)
    }
    for (const item of held) item.destroy?.()
    lent = []
    held = []
  }
  const ensureEncoder = () => { if (!encoder) encoder = device.createCommandEncoder(); return encoder }
  const bindGroupOf = (layout, buffers) => {
    const group = device.createBindGroup({ layout, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) })
    held.push(group)
    return group
  }
  // one compute pass over `invocations` items
  const dispatch = (pipeline, layout, buffers, invocations) => {
    let groupsX = Math.ceil(invocations / WORKGROUP_SIZE), groupsY = 1
    if (groupsX > MAX_WORKGROUPS_PER_DIMENSION) { groupsY = Math.ceil(groupsX / MAX_WORKGROUPS_PER_DIMENSION); groupsX = MAX_WORKGROUPS_PER_DIMENSION }
    const pass = ensureEncoder().beginComputePass()
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroupOf(layout, buffers)); pass.dispatchWorkgroups(groupsX, groupsY); pass.end()
  }
  // one compute pass whose size a GPU buffer holds (a count that exists only on the GPU)
  const dispatchIndirect = (pipeline, layout, buffers, argumentsBuffer) => {
    const pass = ensureEncoder().beginComputePass()
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroupOf(layout, buffers)); pass.dispatchWorkgroupsIndirect(argumentsBuffer, 0); pass.end()
  }
  const clear = (buffer) => ensureEncoder().clearBuffer(buffer)
  const copy = (source, sourceOffset, target, targetOffset, bytes) => ensureEncoder().copyBufferToBuffer(source, sourceOffset, target, targetOffset, bytes)
  const uniform = (values) => {
    const buffer = smallBuffer(BUFFER.UNIFORM | BUFFER.COPY_DST)
    device.queue.writeBuffer(buffer, 0, new Uint32Array(values))
    return buffer
  }
  // in-place exclusive scan of `count` u32
  const scan = (buffer, count) => {
    const blocks = Math.ceil(count / WORKGROUP_SIZE)
    const parameters = uniform([count, 0, 0, 0])
    const blockSums = pooled(blocks * 4 + 4, BUFFER.STORAGE)
    dispatch(pipelines.scanBlock, layouts.scan, [parameters, buffer, blockSums], count)
    if (blocks === 1) return   // one block: scanBlock already wrote the exclusive scan
    scan(blockSums, blocks)
    dispatch(pipelines.scanAddOffsets, layouts.scan, [parameters, buffer, blockSums], count)
  }
  // Every kernel that loops over a scanned range runs only behind this: a dispatch keeps the GPU after its page is gone,
  //  and one looping over a corrupt range froze the display until a reboot (2026-09-26). The check records into `bad`;
  //  the gates below then zero the item counts of the kernels that would loop.
  const checkRanges = (starts, count, limit, bad) =>
    dispatch(pipelines.checkRanges, layouts.check, [uniform([count, limit, 0, 0]), starts, bad], count)
  // `target[targetWord]` = a count taken from a GPU buffer (or `constant` when there is none), or 0 once `bad` is set
  const gate = (bad, source, sourceIndex, target, targetWord, constant = 0) => {
    const out = pooled(16, BUFFER.STORAGE | BUFFER.COPY_SRC)
    let useSource = 1, from = source
    if (!source) { useSource = 0; from = pooled(16, BUFFER.STORAGE) }
    dispatch(pipelines.gate, layouts.gate, [uniform([sourceIndex, useSource, constant, 0]), bad, from, out], 1)
    copy(out, 0, target, targetWord * 4, 4)
    return out
  }
  const dispatchArgumentsFrom = (count) => {
    const argumentsBuffer = pooled(16, BUFFER.STORAGE | BUFFER.INDIRECT)
    dispatch(pipelines.dispatchArguments, layouts.args, [uniform([WORKGROUP_SIZE, 0, 0, 0]), count, argumentsBuffer], 1)
    return argumentsBuffer
  }
  const submit = async () => {
    if (encoder) { device.queue.submit([encoder.finish()]); encoder = null }
    await device.queue.onSubmittedWorkDone()
  }
  // `wordCount` u32 of a buffer, handed to `consume` while the staging buffer is mapped (no second copy)
  const readWords = async (source, wordCount, consume) => {
    const bytes = Math.max(4, wordCount * 4)
    const staging = device.createBuffer({ size: Math.ceil(bytes / 16) * 16, usage: BUFFER.MAP_READ | BUFFER.COPY_DST })
    const readEncoder = device.createCommandEncoder()
    readEncoder.copyBufferToBuffer(source, 0, staging, 0, Math.ceil(bytes / 4) * 4)
    device.queue.submit([readEncoder.finish()])
    await staging.mapAsync(MAP_MODE_READ)
    const result = consume(new Uint32Array(staging.getMappedRange(), 0, wordCount))
    staging.unmap(); staging.destroy()
    return result
  }

  // One run at one event capacity. Resolves to the summary; the pieces are copied into piecesTarget(pieceCount).
  const run = async (input, eventsPerSegment, piecesTarget) => {
    const segmentCount = input.segmentCount, cellCount = input.cellCount, polygonCount = input.polygonCount, layerCount = input.layerCount
    const cellEntryCount = Math.max(1, input.cellEntryCount)
    const eventCapacity = Math.max(SMALLEST_EVENT_CAPACITY, segmentCount * eventsPerSegment), pairCapacity = Math.ceil(eventCapacity / 2)
    const pieceCapacity = segmentCount + eventCapacity, vertexCapacity = segmentCount + pairCapacity
    const largestBuffer = 2 ** Math.ceil(Math.log2(Math.max(pieceCapacity * 32, eventCapacity * 32)))
    if (largestBuffer > device.limits.maxStorageBufferBindingSize || largestBuffer > device.limits.maxBufferSize)
      return { ok: false, reason: `a ${largestBuffer} byte buffer is over this device's limit`, overflow: false }
    const started = performance.now()

    // ---- upload: one start point per segment and the per-layer and per-polygon tables
    const segmentParameters = uniform([segmentCount, cellCount, CELL_SIZE, 0]), eventParameters = uniform([segmentCount, cellCount, CELL_SIZE, 1])
    const points = pooled(segmentCount * 8, BUFFER.STORAGE), polygonLayers = pooled(polygonCount * 4, BUFFER.STORAGE)
    const layers = pooled(layerCount * 16, BUFFER.STORAGE), polygons = pooled(polygonCount * 16, BUFFER.STORAGE)
    device.queue.writeBuffer(points, 0, input.points, 0, segmentCount * 2)
    device.queue.writeBuffer(polygonLayers, 0, input.polyLayer, 0, polygonCount)
    device.queue.writeBuffer(layers, 0, input.layerInfo, 0, layerCount * 4)
    device.queue.writeBuffer(polygons, 0, input.polyInfo, 0, polygonCount * 4)
    const segments = pooled(segmentCount * 16, BUFFER.STORAGE), segmentInfo = pooled(segmentCount * 16, BUFFER.STORAGE)
    const segmentPolygon = pooled(segmentCount * 4, BUFFER.STORAGE)
    const unused = [0, 1, 2, 3, 4].map(() => pooled(16, BUFFER.STORAGE))   // bindings a pass does not write in its counting mode
    const bad = pooled(16, BUFFER.STORAGE | BUFFER.COPY_SRC)               // [0]: a range check failed
    clear(bad)
    dispatch(pipelines.expand, layouts.expand, [uniform([segmentCount, polygonCount, 0, 0]), points, polygons, polygonLayers, segments, segmentInfo, segmentPolygon], segmentCount)

    // ---- bin: every segment into the grid cells its box covers
    const cellStarts = pooled((cellCount + 1) * 4, BUFFER.STORAGE | BUFFER.COPY_SRC)
    clear(cellStarts)
    dispatch(pipelines.cellCount, layouts.bin, [segmentParameters, segments, segmentInfo, layers, cellStarts, unused[0], unused[1]], segmentCount)
    scan(cellStarts, cellCount + 1)
    checkRanges(cellStarts, cellCount, RANGE_LIMIT, bad)
    gate(bad, null, 0, eventParameters, 1, cellCount)
    gate(bad, null, 0, segmentParameters, 1, cellCount)   // the intersect passes loop over cells: 0 cells once a cell range is bad
    const cellCursor = pooled((cellCount + 1) * 4, BUFFER.STORAGE), cellList = pooled(cellEntryCount * 8, BUFFER.STORAGE)
    clear(cellCursor)
    dispatch(pipelines.cellScatter, layouts.bin, [segmentParameters, segments, segmentInfo, layers, cellCursor, cellStarts, cellList], segmentCount)

    // ---- crossings: count per segment, scan, then write
    const eventStarts = pooled((segmentCount + 1) * 4, BUFFER.STORAGE | BUFFER.COPY_SRC)
    const countingFlags = pooled(16, BUFFER.STORAGE), flags = pooled(16, BUFFER.STORAGE | BUFFER.COPY_SRC)   // flags[0]: crossing pairs
    clear(flags); clear(countingFlags); clear(eventStarts)
    dispatch(pipelines.intersect, layouts.intersect, [segmentParameters, segments, segmentInfo, layers, cellStarts, cellList, eventStarts, unused[0], unused[2], countingFlags, unused[1]], cellEntryCount)
    scan(eventStarts, segmentCount + 1)
    checkRanges(eventStarts, segmentCount, RANGE_LIMIT, bad)
    const countingWinding = uniform([segmentCount, polygonCount, FILL_NONZERO, 0]), writingWinding = uniform([segmentCount, polygonCount, FILL_NONZERO, 1])
    const tieParameters = uniform([segmentCount, 0, 0, 0])
    // every kernel that loops over event ranges: 0 segments once one is bad
    for (const target of [eventParameters, countingWinding, writingWinding, tieParameters]) gate(bad, null, 0, target, 0, segmentCount)
    const eventCursor = pooled((segmentCount + 1) * 4, BUFFER.STORAGE)
    clear(eventCursor)
    const events = pooled(eventCapacity * 32, BUFFER.STORAGE), pairs = pooled(pairCapacity * 8, BUFFER.STORAGE)
    dispatch(pipelines.intersect, layouts.intersect, [eventParameters, segments, segmentInfo, layers, cellStarts, cellList, eventCursor, events, eventStarts, flags, pairs], cellEntryCount)
    dispatch(pipelines.sortEvents, layouts.sort, [eventParameters, segments, segmentInfo, layers, eventStarts, events, pairs], segmentCount)
    const ties = pooled((SMALLEST_EVENT_CAPACITY + 1) * 4, BUFFER.STORAGE | BUFFER.COPY_SRC)   // [0]: segments holding two events at one place
    clear(ties)
    dispatch(pipelines.ties, layouts.ties, [tieParameters, eventStarts, events, ties], segmentCount)

    // ---- winding: a ray per polygon, the deltas along it, then the pieces
    const work = pooled((segmentCount + 1) * 4, BUFFER.STORAGE), polygonWinding = pooled(polygonCount * 4, BUFFER.STORAGE)
    const glue = [eventParameters, segments, segmentInfo, layers, countingWinding, eventStarts, events, polygons, work, polygonWinding]
    dispatch(pipelines.rays, layouts.glue, glue, polygonCount)
    dispatch(pipelines.deltaSums, layouts.glue, glue, segmentCount + 1)
    scan(work, segmentCount + 1)
    const polygonsWithWinding = pooled(polygonCount * 16, BUFFER.STORAGE)
    dispatch(pipelines.polygonWinding, layouts.polygonWinding, [uniform([polygonCount, 0, 0, 0]), polygons, polygonWinding, polygonsWithWinding], polygonCount)
    const leftWinding = pooled(segmentCount * 8, BUFFER.STORAGE)
    dispatch(pipelines.zip, layouts.zip, [uniform([segmentCount, 0, 0, 0]), work, segmentPolygon, leftWinding], segmentCount)
    const pieceStarts = pooled((segmentCount + 1) * 4, BUFFER.STORAGE | BUFFER.COPY_SRC)
    clear(pieceStarts)
    const pieceInputs = [eventParameters, segments, segmentInfo, layers]
    dispatch(pipelines.pieces, layouts.pieces, [...pieceInputs, countingWinding, eventStarts, events, leftWinding, polygonsWithWinding, pieceStarts, unused[3], unused[4]], segmentCount)
    scan(pieceStarts, segmentCount + 1)
    const pieceVertices = pooled(pieceCapacity * 16, BUFFER.STORAGE), pieceCoordinates = pooled(pieceCapacity * 32, BUFFER.STORAGE)
    dispatch(pipelines.pieces, layouts.pieces, [...pieceInputs, writingWinding, eventStarts, events, leftWinding, polygonsWithWinding, pieceStarts, pieceVertices, pieceCoordinates], segmentCount)

    // ---- link: each piece's successor at the vertex it ends in (the piece count lives on the GPU from here on)
    const pieceCount = pooled(16, BUFFER.STORAGE | BUFFER.COPY_SRC)
    copy(pieceStarts, segmentCount * 4, pieceCount, 0, 4)
    const pieceCountUniform = uniform([0, 0, 0, 0])
    copy(pieceCount, 0, pieceCountUniform, 0, 4)
    const perPiece = dispatchArgumentsFrom(pieceCount)
    const directions = pooled(pieceCapacity * 16, BUFFER.STORAGE)
    dispatchIndirect(pipelines.directions, layouts.directions, [pieceCountUniform, pieceCoordinates, directions], perPiece)
    const linkParameters = uniform([0, vertexCapacity, 0, 0])
    copy(pieceCount, 0, linkParameters, 0, 4)
    const vertexStarts = pooled((vertexCapacity + 1) * 4, BUFFER.STORAGE), vertexCursor = pooled((vertexCapacity + 1) * 4, BUFFER.STORAGE | BUFFER.COPY_SRC)
    const vertexList = pooled(pieceCapacity * 4, BUFFER.STORAGE), successors = pooled(pieceCapacity * 4, BUFFER.STORAGE)
    const labels = pooled(pieceCapacity * 8, BUFFER.STORAGE), labelsSpare = pooled(pieceCapacity * 8, BUFFER.STORAGE)   // bound by the link kernels, not read here
    clear(vertexCursor); clear(vertexStarts)
    dispatchIndirect(pipelines.vertexCount, layouts.link, [linkParameters, pieceVertices, directions, vertexStarts, unused[2], vertexList, successors, labels, labelsSpare], perPiece)
    scan(vertexStarts, vertexCapacity + 1)
    checkRanges(vertexStarts, vertexCapacity, VERTEX_DEGREE_LIMIT, bad)
    const gatedPieceCount = gate(bad, pieceCount, 0, linkParameters, 0)   // 0 once any range was bad: the link kernels then do nothing
    const perGatedPiece = dispatchArgumentsFrom(gatedPieceCount)
    const link = [linkParameters, pieceVertices, directions, vertexCursor, vertexStarts, vertexList, successors, labels, labelsSpare]
    dispatchIndirect(pipelines.vertexScatter, layouts.link, link, perGatedPiece)
    dispatchIndirect(pipelines.successor, layouts.link, link, perGatedPiece)

    // ---- what the kernel reads: 16 bytes a piece
    const compact = pooled(pieceCapacity * 16, BUFFER.STORAGE | BUFFER.COPY_SRC)
    dispatchIndirect(pipelines.compact, layouts.compact, [pieceCountUniform, pieceCoordinates, successors, pieceVertices, compact], perPiece)

    // ---- one readback of every count the host needs
    const summaryBuffer = pooled(32, BUFFER.STORAGE | BUFFER.COPY_SRC)
    copy(pieceCount, 0, summaryBuffer, 0, 4); copy(eventStarts, segmentCount * 4, summaryBuffer, 4, 4); copy(flags, 0, summaryBuffer, 8, 4)
    copy(ties, 0, summaryBuffer, 12, 4); copy(bad, 0, summaryBuffer, 16, 4); copy(vertexCursor, vertexCapacity * 4, summaryBuffer, 20, 4)
    await submit()
    const [pieces, eventCount, pairCount, tiedSegments, badRanges, overDegree] = await readWords(summaryBuffer, 6, words => Array.from(words))
    const summary = { pieceCount: pieces, eventCount, pairCount, tiedSegments, eventsPerSegment }
    if (eventCount > eventCapacity || pairCount > pairCapacity) {
      release()
      return { ok: false, overflow: true, reason: `${eventCount} crossings over the ${eventCapacity} the buffers held`, ...summary }
    }
    if (badRanges > 0 || overDegree > 0 || pieces > pieceCapacity) {
      release()
      return { ok: false, overflow: false, reason: `the pipeline stopped itself: ${badRanges} ranges out of bounds, ${overDegree} vertices over the degree limit`, ...summary }
    }
    const target = piecesTarget(pieces)
    await readWords(compact, pieces * 4, words => target.set(new Int32Array(words.buffer, words.byteOffset, words.length)))
    release()
    return { ok: true, ms: performance.now() - started, ...summary }
  }

  /**
   * The union of every layer of `input` (the kernel's contour_gpu_input(): counts plus views into its heap).
   * @param {(pieceCount: number) => Int32Array} piecesTarget where the pieces go, 4 x i32 each (the kernel's
   *   contour_result_buffer)
   * @returns {Promise<{ok: boolean, reason?: string, ms?: number, pieceCount?: number, eventCount?: number}>}
   */
  const union = async (input, piecesTarget) => {
    if (input.segmentCount === 0 || input.polygonCount === 0) { piecesTarget(0); return { ok: true, ms: 0, pieceCount: 0, eventCount: 0, pairCount: 0, tiedSegments: 0 } }
    let outcome = null
    for (const eventsPerSegment of EVENTS_PER_SEGMENT) {
      outcome = await run(input, eventsPerSegment, piecesTarget)
      if (outcome.ok || !outcome.overflow) return outcome
    }
    return outcome
  }

  const dispose = () => {
    release()
    for (const buffers of pool.values()) for (const buffer of buffers) buffer.destroy()
    pool.clear()
  }
  return { union, dispose }
}
