// The organic tree support's branches on the GPU, from what the kernel hands out when it stops at its support tips
//  (wasm-core/support_phase.h): every layer's outline, the tips, upstream's branch settings. Three steps:
//   field   bottom-up, per layer at FIELD_PIXEL_MM: the layer's outline is filled (stencil), jump flooding
//           gives each pixel its nearest solid pixel, and reach[l](p) = min(clearance[l](p) - xy distance, the largest
//           reach[l-1] within one layer's move of p): the largest radius that may stand at p and still get down to the
//           bed. One scalar per pixel stands for the collision and avoidance areas of EVERY radius, which upstream
//           computes as polygons per radius (TreeModelVolumes::precalculate).
//   route   support_route.js walks the tips down through that field (CPU, lookups only).
//   draw    per layer at DRAW_PIXEL_MM: the branches' cross-sections are drawn over the layer's clearance, so the union
//           of the branches and the difference with the model are the rasterization; the support's rectangle is read
//           back and traced into rings (support_trace.js).
// Layers are worked on a batch at a time, as tiles of one atlas texture: a render pass costs far more than its pixels
//  here (one pass per layer and step was 25,000 passes for a 1173-layer plate, and eight workers' passes queue in the
//  browser's one GPU process), so a batch's outlines are filled in one pass, flooded together in one pass per jump
//  step, and only the reach recurrence, which reads the layer below, still takes a pass per layer.
// The device is injected; this module never touches `navigator`. The result is a support with upstream's tips and
//  other branches (measured on one 1173-layer plate against the kernel: see AGENTS.md).
import { SECTION_FLOATS, branchRadius, routeBranches } from './support_route.js'
import { PACKED_PIXELS, simplifyRing, tracePackedRings } from './support_trace.js'

// The field's pixel. A branch may lean by `maxMove` a layer and moves by whole field pixels, so when a pixel is wider
//  than that one field layer stands for several object layers (a branch then moves a pixel every so many layers, the
//  same lean). At 0.2 mm and one field layer per layer the flood of one 1173-layer plate was 0.5 s of GPU time and its
//  field 663 MB; at 0.4 mm and every other layer both are an eighth, but a tip (0.4 mm radius, placed by the kernel at
//  the xy distance from a wall) is then narrower than the field can tell from the wall: 1574 of that plate's 3542
//  branches were routed as standing on the model. So the pixel stays at the move of one layer where that is 0.2 mm.
const FIELD_PIXEL_MM = 0.2
// Object layers one field layer stands for, at least. A branch then changes pixel every second layer, by twice as many
//  pixels, and the field joins the collision of both layers. Half the flood and half the bytes read back, which is what
//  eight workers of a slice-all run queue for (measured in Chrome: the field of one plate 0.23 s alone, 1.1-1.4 s beside
//  seven others; slice-all of a 28-plate project 17.7 -> 16.7 s). At three, 27 branches of that plate ended on the model.
const FIELD_LAYERS_PER_STEP = 2
const DRAW_PIXEL_MM = 0.1
// the field of every layer is held on the CPU while the branches are routed, at most one byte per pixel (FIELD_BYTE_BUDGET is set against that bound)
//  (every worker of a slice-all run holds one, so this is per plate being sliced)
const FIELD_BYTE_BUDGET = 1280 << 20
// reach is stored as a byte on a logarithmic scale between these, rounded down (a step is 2.4 % of the radius)
const REACH_MIN_MM = 0.05
const REACH_CODES = 253
// what the route reads for a free pixel with room for no branch: more than a solid pixel's 0, less than any radius
const REACH_FREE_MM = 1e-3
// corners a traced outline may lose: one drawn pixel, which is what a pixel staircase strays from the true edge
const SIMPLIFY_PIXELS = 1
const NO_SEED = 65535
const SLOT_BYTES = 256, ROW_ALIGN = 256
// WebGPU's flag values (the spec's), so the module needs no global: node's Dawn binding installs none
const STAGE_VERTEX = 0x1, STAGE_FRAGMENT = 0x2
const STAGE_COMPUTE = 0x4
const TEXTURE_COPY_SRC = 0x1, TEXTURE_BINDING = 0x4, TEXTURE_RENDER_ATTACHMENT = 0x10
const BUFFER_MAP_READ = 0x1, BUFFER_COPY_SRC = 0x4, BUFFER_COPY_DST = 0x8, BUFFER_VERTEX = 0x20, BUFFER_UNIFORM = 0x40, BUFFER_STORAGE = 0x80
const MAP_MODE_READ = 0x1
// an atlas is at most this many pixels on a side, and holds at most this many layers
//  (at 6144 a worker's atlases were ~1.1 GB of GPU memory, 8.6 GB for the eight workers of a slice-all run)
const ATLAS_SIDE = 4096
// Batches submitted before the oldest one's readback is awaited. A readback is a round trip to the GPU process, and
//  awaiting each batch alone left the worker idle for it: 130 round trips for one 1173-layer plate.
const BATCHES_IN_FLIGHT = 4
const ATLAS_TILES = 32
// the draw packs each layer's own rectangle into its atlas, so a batch holds more layers than the atlas has grid tiles
const DRAW_TILES = 64
// upstream's collision at a layer joins the layers within the z distances; each is filled in its own stencil bit
const STENCIL_BITS = 8
const SLOT_BINDING_BYTES = 72
const STEP_TOLERANCE = 1e-3

const UNIFORMS = `struct Slot { origin: vec2f, extent: vec2f, pixelMm: f32, xyDistance: f32, maxRadius: f32, logSpan: f32, step: i32, first: i32, movePixels: i32,
  tileSize: vec2i, tileOrigin: vec2i, sourceOrigin: vec2i }
@group(0) @binding(0) var<uniform> slot: Slot;
fn toClip(point: vec2f) -> vec2f { let unit = (point - slot.origin) / slot.extent; return vec2f(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0); }`
const FULLSCREEN = `@vertex fn full(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i32(index & 1u) * 4 - 1), f32(i32(index >> 1u) * 4 - 1), 0.5, 1.0); }`
// a tile's viewport places the outline; a seed is its own pixel in atlas coordinates
const OUTLINE_SHADER = `${UNIFORMS}
@vertex fn fan(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(toClip(position), 0.5, 1.0); }
@fragment fn none() {}
${FULLSCREEN}
@fragment fn seed(@builtin(position) at: vec4f) -> @location(0) vec2u { return vec2u(at.xy); }
@fragment fn unseed() -> @location(0) vec2u { return vec2u(${NO_SEED}u); }`
// one jump step of one tile's rectangle (tileOrigin, tileSize in atlas pixels); a sample outside it belongs to another
//  layer, or was left by an earlier batch
const JUMP_SHADER = `${UNIFORMS}
@group(0) @binding(1) var source: texture_2d<u32>;
${FULLSCREEN}
@fragment fn jump(@builtin(position) at: vec4f) -> @location(0) vec2u {
  let here = vec2i(at.xy); let low = slot.tileOrigin; let high = low + slot.tileSize;
  var best = vec2u(${NO_SEED}u); var bestDistance = 3.0e38;
  for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
    let sampleAt = here + vec2i(dx, dy) * slot.step;
    if (sampleAt.x < low.x || sampleAt.y < low.y || sampleAt.x >= high.x || sampleAt.y >= high.y) { continue; }
    let candidate = textureLoad(source, sampleAt, 0).xy;
    if (candidate.x == ${NO_SEED}u) { continue; }
    let delta = vec2f(vec2i(candidate) - here); let distance = dot(delta, delta);
    if (distance < bestDistance) { bestDistance = distance; best = candidate; }
  } }
  return best; }`
// one layer's tile, from its flood and the tile of the layer below (in the other reach atlas, at sourceOrigin)
const REACH_SHADER = `${UNIFORMS}
@group(0) @binding(1) var nearest: texture_2d<u32>;
@group(0) @binding(2) var below: texture_2d<f32>;
${FULLSCREEN}
struct Out { @location(0) reach: f32, @location(1) coded: f32 }
@fragment fn reachable(@builtin(position) at: vec4f) -> Out {
  let here = vec2i(at.xy); let local = here - slot.tileOrigin;
  let seed = textureLoad(nearest, here, 0).xy;
  var value = slot.maxRadius;
  if (seed.x != ${NO_SEED}u) { value = min(slot.maxRadius, length(vec2f(vec2i(seed) - here)) * slot.pixelMm - slot.xyDistance); }
  if (slot.first == 0) {
    var carried = -1.0e30; let reachSquared = slot.movePixels * slot.movePixels;
    for (var dy = -slot.movePixels; dy <= slot.movePixels; dy++) { for (var dx = -slot.movePixels; dx <= slot.movePixels; dx++) {
      if (dx * dx + dy * dy > reachSquared) { continue; }
      let sampleAt = slot.sourceOrigin + clamp(local + vec2i(dx, dy), vec2i(0), slot.tileSize - vec2i(1));
      carried = max(carried, textureLoad(below, sampleAt, 0).x);
    } }
    value = min(value, carried);
  }
  // 0: the pixel itself is solid (the model, or a layer within the z distances of it); 1: free, with room for no branch
  var code = 1.0;
  if (seed.x == u32(here.x) && seed.y == u32(here.y)) { code = 0.0; }
  else if (value >= ${REACH_MIN_MM}) { code = clamp(floor(2.0 + ${REACH_CODES}.0 * log(value / ${REACH_MIN_MM}) / slot.logSpan), 2.0, 255.0); }
  return Out(value, code / 255.0); }`
const SECTION_SHADER = `${UNIFORMS}
@group(0) @binding(1) var nearest: texture_2d<u32>;
struct Corner { @builtin(position) position: vec4f, @location(0) local: vec2f, @location(1) @interpolate(flat) shape: vec2f, @location(2) @interpolate(flat) halfRun: f32 }
@vertex fn section(@builtin(vertex_index) index: u32, @location(0) centre: vec2f, @location(1) along: vec2f, @location(2) shape: vec2f, @location(3) run: vec2f) -> Corner {
  let corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let local = corners[index] * vec2f(max(shape.x * shape.y, run.x + shape.x), shape.x);
  let point = centre + along * local.x + vec2f(-along.y, along.x) * local.y;
  return Corner(vec4f(toClip(point), 0.5, 1.0), local, shape, run.x); }
@fragment fn inside(corner: Corner) -> @location(0) f32 {
  let radius = corner.shape.x;
  let scaled = corner.local / vec2f(radius * corner.shape.y, radius);
  let beside = vec2f(max(abs(corner.local.x) - corner.halfRun, 0.0), corner.local.y);
  if (dot(scaled, scaled) > 1.0 && dot(beside, beside) > radius * radius) { discard; }
  let here = vec2i(corner.position.xy); let seed = textureLoad(nearest, here, 0).xy;
  if (seed.x != ${NO_SEED}u && length(vec2f(vec2i(seed) - here)) * slot.pixelMm < slot.xyDistance) { discard; }
  return 1.0; }`

// The drawn masks leave the GPU as one bit per pixel: a word of the packed texture is PACKED_PIXELS mask pixels in a
//  row. Read back as a byte per pixel they were 2.45 GB over a 28-plate project, through the one GPU process the eight
//  workers of a slice-all run share.
const PACK_SHADER = `@group(0) @binding(0) var mask: texture_2d<f32>;
${FULLSCREEN}
@fragment fn pack(@builtin(position) position: vec4f) -> @location(0) u32 {
  let first = vec2i(i32(position.x) * ${PACKED_PIXELS}, i32(position.y));
  let width = i32(textureDimensions(mask).x);
  var bits = 0u;
  for (var bit = 0; bit < ${PACKED_PIXELS}; bit++) {
    if (first.x + bit < width && textureLoad(mask, first + vec2i(bit, 0), 0).r > 0.5) { bits |= 1u << u32(bit); }
  }
  return bits; }`

// The field leaves the GPU as blocks of FIELD_BLOCK x FIELD_BLOCK pixels: a block of one value is that value in the
//  block table, any other block is a slot of FIELD_BLOCK_BYTES in a compacted list, which the table entry names with
//  MIXED_BLOCK set. Most of a layer is one value per block (inside the model, or far from it: 73-80 % of the 8x8 blocks
//  of the three largest plates of a 28-plate project), and the field was the largest readback of a slice-all run
//  (3.3 GB, read back twice it made the field of a large plate 0.7 s slower beside seven other workers in Chrome).
//  The slot order follows the GPU's atomics, the values do not, so the route reads the same field.
const FIELD_BLOCK = 8, FIELD_BLOCK_BYTES = FIELD_BLOCK * FIELD_BLOCK
const MIXED_BLOCK = 0x80000000
const BLOCK_WORKGROUP = 64
const BLOCK_SHADER = `struct Table { mixed: atomic<u32>, entries: array<u32> }
struct Batch { rows: u32, blocksPerRow: u32, blockCount: u32, unused: u32 }
@group(0) @binding(0) var coded: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> table: Table;
@group(0) @binding(2) var<storage, read_write> blocks: array<u32>;
@group(0) @binding(3) var<uniform> batch: Batch;
fn codeAt(x: u32, y: u32, width: u32) -> u32 {
  if (x >= width || y >= batch.rows) { return 0u; }
  return u32(round(textureLoad(coded, vec2u(x, y), 0).r * 255.0)); }
@compute @workgroup_size(${BLOCK_WORKGROUP}) fn pack(@builtin(global_invocation_id) id: vec3u) {
  let block = id.x;
  if (block >= batch.blockCount) { return; }
  let width = textureDimensions(coded).x;
  let left = (block % batch.blocksPerRow) * ${FIELD_BLOCK}u; let top = (block / batch.blocksPerRow) * ${FIELD_BLOCK}u;
  var words: array<u32, ${FIELD_BLOCK_BYTES / 4}>;
  let first = codeAt(left, top, width);
  var uniform = true;
  for (var row = 0u; row < ${FIELD_BLOCK}u; row++) { for (var column = 0u; column < ${FIELD_BLOCK}u; column++) {
    let code = codeAt(left + column, top + row, width);
    if (code != first) { uniform = false; }
    let at = row * ${FIELD_BLOCK}u + column;
    words[at / 4u] |= code << ((at % 4u) * 8u);
  } }
  if (uniform) { table.entries[block] = first; return; }
  let slot = atomicAdd(&table.mixed, 1u);
  table.entries[block] = ${MIXED_BLOCK}u | slot;
  for (var word = 0u; word < ${FIELD_BLOCK_BYTES / 4}u; word++) { blocks[slot * ${FIELD_BLOCK_BYTES / 4}u + word] = words[word]; }
}`

/**
 * The field's block codec (FIELD_BLOCK above), shared by the pipeline and its test.
 * @param {GPUDevice} device
 * @returns {{ encode: (encoder: GPUCommandEncoder, codedView: GPUTextureView, width: number, rows: number) => { submitted: () => Promise<object> } }}
 *   encode() appends the packing of the first `rows` rows of an r8unorm texture `width` pixels wide; submitted(),
 *   called once the encoder is, answers the page fieldBlockCode reads ({ table, blocks, blocksPerRow, bytes, release }).
 */
export function makeFieldBlocks(device) {
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: STAGE_COMPUTE, texture: { sampleType: 'unfilterable-float' } },
    { binding: 1, visibility: STAGE_COMPUTE, buffer: { type: 'storage' } },
    { binding: 2, visibility: STAGE_COMPUTE, buffer: { type: 'storage' } },
    { binding: 3, visibility: STAGE_COMPUTE, buffer: { type: 'uniform' } }] })
  const pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: device.createShaderModule({ code: BLOCK_SHADER }), entryPoint: 'pack' } })
  const encode = (encoder, codedView, width, rows) => {
    const blocksPerRow = Math.ceil(width / FIELD_BLOCK), blockCount = blocksPerRow * Math.ceil(rows / FIELD_BLOCK)
    const tableBytes = (blockCount + 1) * 4
    const table = device.createBuffer({ size: tableBytes, usage: BUFFER_STORAGE | BUFFER_COPY_SRC })
    const blocks = device.createBuffer({ size: blockCount * FIELD_BLOCK_BYTES, usage: BUFFER_STORAGE | BUFFER_COPY_SRC })
    const batch = device.createBuffer({ size: 16, usage: BUFFER_UNIFORM | BUFFER_COPY_DST })
    device.queue.writeBuffer(batch, 0, new Uint32Array([rows, blocksPerRow, blockCount, 0]))
    const tableRead = device.createBuffer({ size: tableBytes, usage: BUFFER_COPY_DST | BUFFER_MAP_READ })
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, device.createBindGroup({ layout, entries: [{ binding: 0, resource: codedView },
      { binding: 1, resource: { buffer: table } }, { binding: 2, resource: { buffer: blocks } }, { binding: 3, resource: { buffer: batch } }] }))
    pass.dispatchWorkgroups(Math.ceil(blockCount / BLOCK_WORKGROUP))
    pass.end()
    encoder.copyBufferToBuffer(table, 0, tableRead, 0, tableBytes)
    const submitted = async () => {
      await tableRead.mapAsync(MAP_MODE_READ)
      const entries = new Uint32Array(tableRead.getMappedRange())
      const mixed = entries[0]
      let blockBytes = new Uint8Array(0), blockRead = null
      // the mixed blocks are copied once their count is known
      if (mixed > 0) {
        blockRead = device.createBuffer({ size: mixed * FIELD_BLOCK_BYTES, usage: BUFFER_COPY_DST | BUFFER_MAP_READ })
        const copy = device.createCommandEncoder()
        copy.copyBufferToBuffer(blocks, 0, blockRead, 0, mixed * FIELD_BLOCK_BYTES)
        device.queue.submit([copy.finish()])
        await blockRead.mapAsync(MAP_MODE_READ)
        blockBytes = new Uint8Array(blockRead.getMappedRange())
      }
      table.destroy(); blocks.destroy(); batch.destroy()
      const release = () => {
        tableRead.unmap(); tableRead.destroy()
        if (blockRead) { blockRead.unmap(); blockRead.destroy() }
      }
      return { table: entries.subarray(1), blocks: blockBytes, blocksPerRow, bytes: entries.byteLength + blockBytes.byteLength, release }
    }
    return { submitted }
  }
  return { encode }
}

/** The code at pixel (x, y) of a page makeFieldBlocks read back. */
export function fieldBlockCode(page, x, y) {
  const entry = page.table[Math.floor(y / FIELD_BLOCK) * page.blocksPerRow + Math.floor(x / FIELD_BLOCK)]
  if (entry < MIXED_BLOCK) return entry
  return page.blocks[(entry - MIXED_BLOCK) * FIELD_BLOCK_BYTES + (y % FIELD_BLOCK) * FIELD_BLOCK + x % FIELD_BLOCK]
}

const jumpStepsFor = (boundPixels) => {
  const steps = []
  for (let step = 2 ** Math.ceil(Math.log2(Math.max(2, boundPixels))); step >= 1; step /= 2) steps.push(step)
  steps.push(1)
  return steps
}

/**
 * @param {GPUDevice} device
 * @returns {{ run: (request: object, options?: { canceled?: () => boolean }) => Promise<object> }}
 *   run() answers { ok: true, layerRingStart, ringStart, points, stats } (the support body per layer in the request's
 *   frame, the layout support_phase_inject takes) or { ok: false, reason }.
 */
export function makeSupportGpu(device) {
  const outlineModule = device.createShaderModule({ code: OUTLINE_SHADER }), jumpModule = device.createShaderModule({ code: JUMP_SHADER })
  const reachModule = device.createShaderModule({ code: REACH_SHADER }), sectionModule = device.createShaderModule({ code: SECTION_SHADER })
  const slotEntry = { binding: 0, visibility: STAGE_VERTEX | STAGE_FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SLOT_BINDING_BYTES } }
  const uintEntry = { binding: 1, visibility: STAGE_FRAGMENT, texture: { sampleType: 'uint' } }
  const floatEntry = { binding: 2, visibility: STAGE_FRAGMENT, texture: { sampleType: 'unfilterable-float' } }
  const slotLayout = device.createBindGroupLayout({ entries: [slotEntry] })
  const sampledLayout = device.createBindGroupLayout({ entries: [slotEntry, uintEntry] })
  const reachLayout = device.createBindGroupLayout({ entries: [slotEntry, uintEntry, floatEntry] })
  const layoutOf = (group) => device.createPipelineLayout({ bindGroupLayouts: [group] })
  const keep = { compare: 'always', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' }
  // even-odd: the kernel's outline is a union already, a hole is a ring inside its outer ring. One pipeline per stencil
  //  bit, so the layers a collision joins are filled side by side in one pass and any set bit is solid.
  const fillPipelines = Array.from({ length: STENCIL_BITS }, (unused, bit) => device.createRenderPipeline({ layout: layoutOf(slotLayout),
    vertex: { module: outlineModule, entryPoint: 'fan', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] },
    fragment: { module: outlineModule, entryPoint: 'none', targets: [{ format: 'rg16uint', writeMask: 0 }] }, primitive: { cullMode: 'none' },
    depthStencil: { format: 'depth24plus-stencil8', depthCompare: 'always', depthWriteEnabled: false, stencilWriteMask: 1 << bit,
      stencilFront: { ...keep, passOp: 'invert' }, stencilBack: { ...keep, passOp: 'invert' } } }))
  const seedPipeline = device.createRenderPipeline({ layout: layoutOf(slotLayout),
    vertex: { module: outlineModule, entryPoint: 'full' }, fragment: { module: outlineModule, entryPoint: 'seed', targets: [{ format: 'rg16uint' }] },
    depthStencil: { format: 'depth24plus-stencil8', depthCompare: 'always', depthWriteEnabled: false, stencilWriteMask: 0,
      stencilFront: { ...keep, compare: 'not-equal' }, stencilBack: { ...keep, compare: 'not-equal' } } })
  // the pixels the fill left empty are written "no seed" by a draw, so the seed texture is never cleared as a whole
  //  (clearing each pass's whole target was most of the pipeline's time: 60 GB of clears for one 1173-layer plate)
  const unseedPipeline = device.createRenderPipeline({ layout: layoutOf(slotLayout),
    vertex: { module: outlineModule, entryPoint: 'full' }, fragment: { module: outlineModule, entryPoint: 'unseed', targets: [{ format: 'rg16uint' }] },
    depthStencil: { format: 'depth24plus-stencil8', depthCompare: 'always', depthWriteEnabled: false, stencilWriteMask: 0,
      stencilFront: { ...keep, compare: 'equal' }, stencilBack: { ...keep, compare: 'equal' } } })
  const jumpPipeline = device.createRenderPipeline({ layout: layoutOf(sampledLayout), vertex: { module: jumpModule, entryPoint: 'full' }, fragment: { module: jumpModule, entryPoint: 'jump', targets: [{ format: 'rg16uint' }] } })
  const reachPipeline = device.createRenderPipeline({ layout: layoutOf(reachLayout), vertex: { module: reachModule, entryPoint: 'full' }, fragment: { module: reachModule, entryPoint: 'reachable', targets: [{ format: 'r32float' }, { format: 'r8unorm' }] } })
  const sectionLayout = { arrayStride: SECTION_FLOATS * 4, stepMode: 'instance', attributes: [0, 1, 2, 3].map(index => ({ shaderLocation: index, offset: index * 8, format: 'float32x2' })) }
  const sectionPipeline = device.createRenderPipeline({ layout: layoutOf(sampledLayout), vertex: { module: sectionModule, entryPoint: 'section', buffers: [sectionLayout] }, fragment: { module: sectionModule, entryPoint: 'inside', targets: [{ format: 'r8unorm' }] } })
  const packModule = device.createShaderModule({ code: PACK_SHADER })
  const packLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: STAGE_FRAGMENT, texture: { sampleType: 'float' } }] })
  const packPipeline = device.createRenderPipeline({ layout: layoutOf(packLayout), vertex: { module: packModule, entryPoint: 'full' }, fragment: { module: packModule, entryPoint: 'pack', targets: [{ format: 'r32uint' }] } })
  const fieldBlocks = makeFieldBlocks(device)

  // An atlas of tiles, each one layer's grid: its textures, and the passes that fill a batch's outlines and flood them.
  const makeAtlas = ({ tileWidth, tileRows, uniforms, jumpSteps, jumpSlotOf }) => {
    const side = Math.min(ATLAS_SIDE, device.limits.maxTextureDimension2D)
    const columns = Math.max(1, Math.floor(side / tileWidth)), tileCount = Math.min(ATLAS_TILES, columns * Math.max(1, Math.floor(side / tileRows)))
    const size = [Math.min(columns, tileCount) * tileWidth, Math.ceil(tileCount / columns) * tileRows]
    const TARGET = TEXTURE_RENDER_ATTACHMENT | TEXTURE_BINDING
    const stencil = device.createTexture({ size, format: 'depth24plus-stencil8', usage: TEXTURE_RENDER_ATTACHMENT })
    const seeds = [0, 1].map(() => device.createTexture({ size, format: 'rg16uint', usage: TARGET }))
    const seedViews = seeds.map(texture => texture.createView()), stencilView = stencil.createView()
    const slotBinding = { binding: 0, resource: { buffer: uniforms, size: SLOT_BINDING_BYTES } }
    const slotGroup = device.createBindGroup({ layout: slotLayout, entries: [slotBinding] })
    const sampledGroups = seedViews.map(viewOf => device.createBindGroup({ layout: sampledLayout, entries: [slotBinding, { binding: 1, resource: viewOf }] }))
    const tileOrigin = (tile) => [(tile % columns) * tileWidth, Math.floor(tile / columns) * tileRows]
    /**
     * Fills the outlines of every tile's layers and floods them; returns the index of the seed texture holding the
     *  result. A tile is { layers, rect: [x, y, width, rows] in atlas pixels, fillSlot }: the uniform slot `fillSlot`
     *  maps the tile's part of the plate onto `rect`, and `jumpSlotOf(tile, step)` holds `rect` for a jump step. Only
     *  the rectangles are written and read: nothing is cleared but the stencil.
     */
    const flood = (encoder, outline, tiles) => {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: seedViews[0], loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: stencilView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard', stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard' } })
      pass.setStencilReference(0); pass.setVertexBuffer(0, outline.buffer)
      for (const tile of tiles) {
        pass.setBindGroup(0, slotGroup, [tile.fillSlot * SLOT_BYTES])
        pass.setViewport(...tile.rect, 0, 1); pass.setScissorRect(...tile.rect)
        tile.layers.forEach((layer, bit) => {
          const vertexCount = outline.layerVertexStart[layer + 1] - outline.layerVertexStart[layer]
          if (vertexCount > 0) { pass.setPipeline(fillPipelines[bit]); pass.draw(vertexCount, 1, outline.layerVertexStart[layer]) }
        })
      }
      pass.setViewport(0, 0, size[0], size[1], 0, 1)
      for (const pipeline of [seedPipeline, unseedPipeline]) {
        pass.setPipeline(pipeline)
        for (const tile of tiles) { pass.setScissorRect(...tile.rect); pass.draw(3) }
      }
      pass.end()
      let from = 0
      for (let step = 0; step < jumpSteps; step++) {
        const jump = encoder.beginRenderPass({ colorAttachments: [{ view: seedViews[1 - from], loadOp: 'load', storeOp: 'store' }] })
        jump.setPipeline(jumpPipeline)
        tiles.forEach((tile, index) => {
          jump.setBindGroup(0, sampledGroups[from], [jumpSlotOf(index, step) * SLOT_BYTES]); jump.setScissorRect(...tile.rect); jump.draw(3)
        })
        jump.end()
        from = 1 - from
      }
      return from
    }
    const destroy = () => { stencil.destroy(); seeds.forEach(texture => texture.destroy()) }
    return { size, tileCount, tileOrigin, seedViews, sampledGroups, slotGroup, slotBinding, flood, destroy }
  }

  const run = async (request, { canceled = () => false } = {}) => {
    const started = performance.now()
    const settings = {
      layerHeight: request.layerHeight, xyDistance: request.xyDistance, maxMove: request.maxMove, minRadius: request.minRadius,
      branchRadius: request.branchRadius, radiusIncreasePerLayer: request.radiusIncreasePerLayer, tipLayers: request.tipLayers,
    }
    const tips = request.tips, layerCount = Math.min(request.supportLayers, request.outlines.layerRingStart.length - 1)
    if (!(tips.length >= 4) || layerCount < 1) return { ok: false, reason: 'the slice has no support tips' }
    if (!(settings.maxMove > 0)) return { ok: false, reason: 'the branch angle allows no sideways move' }
    // one field layer per `layersPerStep` object layers, a branch moving `movePixels` field pixels between two of them
    const fieldPixel = FIELD_PIXEL_MM
    //  (the kernel's move is a whole number of its units, 0.199999 mm for 0.2: the tolerance keeps that one layer a step)
    const layersPerStep = Math.max(FIELD_LAYERS_PER_STEP, Math.ceil(fieldPixel / settings.maxMove - STEP_TOLERANCE))
    const movePixels = Math.max(1, Math.floor(settings.maxMove * layersPerStep / fieldPixel + STEP_TOLERANCE))
    if (request.zDistanceBottomLayers + request.zDistanceTopLayers + layersPerStep > STENCIL_BITS) return { ok: false, reason: 'the support z distance spans more layers than the collision fill joins' }
    const { layerRingStart, ringStart, points } = request.outlines
    // the highest tip bounds the layers; the thickest a branch can get from there bounds the field's radius
    let topLayer = 0
    for (let at = 2; at < tips.length; at += 4) topLayer = Math.max(topLayer, Math.round(tips[at]))
    const layers = Math.min(layerCount, topLayer + 1)
    const maxRadius = branchRadius(settings, layers) + settings.maxMove
    // the grid covers the object and the tips, and the room a branch of that radius needs around them, inside the bed
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let at = 0; at < points.length; at += 2) { minX = Math.min(minX, points[at]); maxX = Math.max(maxX, points[at]); minY = Math.min(minY, points[at + 1]); maxY = Math.max(maxY, points[at + 1]) }
    for (let at = 0; at < tips.length; at += 4) { minX = Math.min(minX, tips[at]); maxX = Math.max(maxX, tips[at]); minY = Math.min(minY, tips[at + 1]); maxY = Math.max(maxY, tips[at + 1]) }
    const margin = maxRadius + settings.xyDistance + 1
    const bed = { minX: request.bedMinX, minY: request.bedMinY, maxX: request.bedMaxX, maxY: request.bedMaxY }
    const originX = Math.max(bed.minX, minX - margin), originY = Math.max(bed.minY, minY - margin)
    const extentX = Math.min(bed.maxX, maxX + margin) - originX, extentY = Math.min(bed.maxY, maxY + margin) - originY
    if (!(extentX > 0 && extentY > 0)) return { ok: false, reason: 'the object lies off the bed' }
    // every layer of the field is held while the branches are routed; a plate past the budget keeps upstream's support
    const fieldLayers = Math.ceil(layers / layersPerStep)
    if (extentX * extentY / (fieldPixel * fieldPixel) * fieldLayers > FIELD_BYTE_BUDGET) return { ok: false, reason: 'the plate is too large for the support field' }
    const fieldWidth = Math.ceil(extentX / fieldPixel), fieldRows = Math.ceil(extentY / fieldPixel)
    const drawWidth = Math.ceil(extentX / DRAW_PIXEL_MM), drawRows = Math.ceil(extentY / DRAW_PIXEL_MM)
    const textureLimit = Math.min(ATLAS_SIDE, device.limits.maxTextureDimension2D)
    if (drawWidth > textureLimit || drawRows > textureLimit) return { ok: false, reason: `the support grid (${drawWidth} x ${drawRows}) is past this device's texture size` }

    // ---- outlines as triangle fans, one vertex range per layer
    const layerVertexStart = new Uint32Array(layerCount + 1)
    let vertexCount = 0
    for (let layer = 0; layer < layerCount; layer++) {
      for (let ring = layerRingStart[layer]; ring < layerRingStart[layer + 1]; ring++) vertexCount += Math.max(0, ringStart[ring + 1] - ringStart[ring] - 2) * 3
      layerVertexStart[layer + 1] = vertexCount
    }
    const fans = new Float32Array(Math.max(6, vertexCount * 2))
    let write = 0
    for (let ring = 0; ring + 1 < ringStart.length; ring++) {
      const first = ringStart[ring], last = ringStart[ring + 1]
      for (let point = first + 1; point + 1 < last; point++) {
        fans[write++] = points[first * 2]; fans[write++] = points[first * 2 + 1]
        fans[write++] = points[point * 2]; fans[write++] = points[point * 2 + 1]
        fans[write++] = points[point * 2 + 2]; fans[write++] = points[point * 2 + 3]
      }
    }
    const outline = { layerVertexStart, buffer: device.createBuffer({ size: fans.byteLength, usage: BUFFER_VERTEX | BUFFER_COPY_DST }) }
    device.queue.writeBuffer(outline.buffer, 0, fans)

    // ---- uniform slots: the field's fill, first layer, one per reach tile and its jump steps; the draw's fill and jump steps
    const fieldSteps = jumpStepsFor(Math.ceil((maxRadius + settings.xyDistance) / fieldPixel) + 1)
    const drawSteps = jumpStepsFor(Math.ceil(settings.xyDistance / DRAW_PIXEL_MM) + 1)
    //  (a jump slot holds one tile's rectangle for one step)
    const SLOT_FIELD = 0, SLOT_FIELD_FIRST = 1, REACH_TILE = 2, FIELD_JUMP = REACH_TILE + ATLAS_TILES
    const DRAW_TILE = FIELD_JUMP + ATLAS_TILES * fieldSteps.length, DRAW_JUMP = DRAW_TILE + DRAW_TILES
    const slotCount = DRAW_JUMP + DRAW_TILES * drawSteps.length
    const fieldJumpSlot = (tile, step) => FIELD_JUMP + tile * fieldSteps.length + step
    const drawJumpSlot = (tile, step) => DRAW_JUMP + tile * drawSteps.length + step
    const uniforms = device.createBuffer({ size: slotCount * SLOT_BYTES, usage: BUFFER_UNIFORM | BUFFER_COPY_DST })
    const uniformData = new ArrayBuffer(slotCount * SLOT_BYTES), floats = new Float32Array(uniformData), ints = new Int32Array(uniformData)
    const logSpan = Math.log(maxRadius / REACH_MIN_MM)
    // The field keeps the xy distance as measured between pixel centres, which can be half a field pixel short of the
    //  true distance; the draw clips every cross-section at the xy distance on its own finer grid. (Adding the half
    //  pixel to the field left a 0.4 mm tip no room beside a wall: 2623 steps of one plate found none, against 77.)
    const fieldClearance = settings.xyDistance
    const writeSlot = (slotIndex, { pixelMm, tile, step = 0, first = 0, tileOrigin = [0, 0], sourceOrigin = [0, 0], clearance = settings.xyDistance, plate = [originX, originY, extentX, extentY] }) => {
      const at = slotIndex * SLOT_BYTES / 4
      floats.set([...plate, pixelMm, clearance, maxRadius, logSpan], at)
      ints.set([step, first, movePixels, 0, tile[0], tile[1], tileOrigin[0], tileOrigin[1], sourceOrigin[0], sourceOrigin[1]], at + 8)
    }
    const fieldTile = [fieldWidth, fieldRows]
    writeSlot(SLOT_FIELD, { pixelMm: fieldPixel, tile: fieldTile, clearance: fieldClearance })
    const released = []
    const release = () => { for (const resource of released) resource.destroy() }
    released.push(outline.buffer, uniforms)
    const fieldAtlas = makeAtlas({ tileWidth: fieldWidth, tileRows: fieldRows, uniforms, jumpSteps: fieldSteps.length, jumpSlotOf: fieldJumpSlot })
    released.push(fieldAtlas)
    // layer l sits in tile l % tileCount of reach atlas l & 1, so the layer below is always in the other atlas
    const fieldTiles = fieldAtlas.tileCount
    for (let tile = 0; tile < fieldTiles; tile++) {
      const sourceOrigin = fieldAtlas.tileOrigin((tile + fieldTiles - 1) % fieldTiles)
      writeSlot(REACH_TILE + tile, { pixelMm: fieldPixel, tile: fieldTile, tileOrigin: fieldAtlas.tileOrigin(tile), sourceOrigin, clearance: fieldClearance })
      fieldSteps.forEach((step, index) => writeSlot(fieldJumpSlot(tile, index), { pixelMm: fieldPixel, tile: fieldTile, tileOrigin: fieldAtlas.tileOrigin(tile), step }))
    }
    writeSlot(SLOT_FIELD_FIRST, { pixelMm: fieldPixel, tile: fieldTile, first: 1, clearance: fieldClearance })
    device.queue.writeBuffer(uniforms, 0, uniformData)
    // upstream's collision at a layer covers the layers within the z distances of it
    const collisionLayers = (layer, span = 1) => {
      const list = []
      for (let other = layer - request.zDistanceBottomLayers; other < layer + span + request.zDistanceTopLayers; other++) if (other >= 0 && other < layerCount) list.push(other)
      return list
    }

    // ---- field: bottom-up, a batch of layers per atlas, every layer read back as blocks (makeFieldBlocks)
    const TARGET = TEXTURE_RENDER_ATTACHMENT | TEXTURE_BINDING
    const reach = [0, 1].map(() => device.createTexture({ size: fieldAtlas.size, format: 'r32float', usage: TARGET }))
    const coded = device.createTexture({ size: fieldAtlas.size, format: 'r8unorm', usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_BINDING })
    released.push(...reach, coded)
    const reachViews = reach.map(texture => texture.createView()), codedView = coded.createView()
    const reachGroups = [0, 1].flatMap(seedIndex => [0, 1].map(belowIndex => device.createBindGroup({ layout: reachLayout,
      entries: [fieldAtlas.slotBinding, { binding: 1, resource: fieldAtlas.seedViews[seedIndex] }, { binding: 2, resource: reachViews[belowIndex] }] })))
    // the field as it comes back: per batch, its block table and its mixed blocks (FIELD_BLOCK above). A page is its
    //  buffers' mapped ranges, held until the route has read them.
    const fieldPages = []
    let passes = 0, fieldBytesRead = 0
    const fieldReads = []
    const takeFieldPage = async () => {
      const page = await fieldReads.shift()
      fieldBytesRead += page.bytes
      fieldPages.push(page)
    }
    // `layer` below counts field layers: field layer f stands for object layers f * layersPerStep and up
    const releaseField = () => {
      for (const page of fieldPages) page.release()
      for (const pending of fieldReads) pending.then(page => page.release())
      fieldPages.length = 0
      fieldReads.length = 0
    }
    for (let batchStart = 0, batch = 0; batchStart < fieldLayers; batchStart += fieldTiles, batch++) {
      if (canceled()) { releaseField(); release(); return { ok: false, reason: 'canceled' } }
      if (fieldReads.length === BATCHES_IN_FLIGHT) await takeFieldPage()
      const batchEnd = Math.min(fieldLayers, batchStart + fieldTiles)
      const encoder = device.createCommandEncoder()
      const tiles = []
      for (let layer = batchStart; layer < batchEnd; layer++) tiles.push({ layers: collisionLayers(layer * layersPerStep, layersPerStep), rect: [...fieldAtlas.tileOrigin(layer - batchStart), fieldWidth, fieldRows], fillSlot: SLOT_FIELD })
      const seedIndex = fieldAtlas.flood(encoder, outline, tiles)
      passes += 1 + fieldSteps.length
      for (let layer = batchStart; layer < batchEnd; layer++) {
        const tile = layer - batchStart, target = layer & 1, [x, y] = fieldAtlas.tileOrigin(tile)
        let slotIndex = REACH_TILE + tile
        if (layer === 0) slotIndex = SLOT_FIELD_FIRST
        const pass = encoder.beginRenderPass({ colorAttachments: [reachViews[target], codedView].map(viewOf => ({ view: viewOf, loadOp: 'load', storeOp: 'store' })) })
        pass.setScissorRect(x, y, fieldWidth, fieldRows)
        pass.setPipeline(reachPipeline); pass.setBindGroup(0, reachGroups[seedIndex * 2 + (1 - target)], [slotIndex * SLOT_BYTES]); pass.draw(3); pass.end()
        passes++
      }
      // only the rows this batch's tiles reach
      const batchRows = fieldAtlas.tileOrigin(batchEnd - batchStart - 1)[1] + fieldRows
      const read = fieldBlocks.encode(encoder, codedView, fieldAtlas.size[0], batchRows)
      device.queue.submit([encoder.finish()])
      fieldReads.push(read.submitted())
    }
    while (fieldReads.length) await takeFieldPage()
    const fieldMs = performance.now() - started

    // ---- route
    const routeStarted = performance.now()
    const reachOfCode = new Float32Array(256)
    reachOfCode[1] = REACH_FREE_MM
    for (let code = 2; code < 256; code++) reachOfCode[code] = REACH_MIN_MM * Math.exp((code - 2) / REACH_CODES * logSpan)
    const tileX = new Uint32Array(fieldTiles), tileY = new Uint32Array(fieldTiles)
    for (let tile = 0; tile < fieldTiles; tile++) [tileX[tile], tileY[tile]] = fieldAtlas.tileOrigin(tile)
    const reachAt = (fieldLayer, x, y) => {
      const column = Math.floor((x - originX) / fieldPixel), row = Math.floor((y - originY) / fieldPixel)
      if (column < 0 || row < 0 || column >= fieldWidth || row >= fieldRows) return 0
      const page = Math.floor(fieldLayer / fieldTiles), tile = fieldLayer - page * fieldTiles
      return reachOfCode[fieldBlockCode(fieldPages[page], tileX[tile] + column, tileY[tile] + row)]
    }
    const routed = routeBranches({ tips, layerCount: layers, settings, bed, grid: { originX, originY, pixel: fieldPixel, movePixels, layersPerStep }, reachAt })
    releaseField()   // the field is only read by the route
    const routeMs = performance.now() - routeStarted

    // ---- draw: the layers that hold a cross-section, a batch per atlas, each layer's support rectangle read back and traced
    const drawStarted = performance.now()
    // the atlas is one square of pixels here: each layer's rectangle is packed into it, in rows
    const drawAtlas = makeAtlas({ tileWidth: textureLimit, tileRows: textureLimit, uniforms, jumpSteps: drawSteps.length, jumpSlotOf: drawJumpSlot })
    const mask = device.createTexture({ size: drawAtlas.size, format: 'r8unorm', usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_BINDING })
    const packedWidth = Math.ceil(drawAtlas.size[0] / PACKED_PIXELS), packedRowBytes = Math.ceil(packedWidth * 4 / ROW_ALIGN) * ROW_ALIGN
    const packed = device.createTexture({ size: [packedWidth, drawAtlas.size[1]], format: 'r32uint', usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SRC })
    const sectionBuffer = device.createBuffer({ size: Math.max(SECTION_FLOATS * 4, routed.sections.byteLength), usage: BUFFER_VERTEX | BUFFER_COPY_DST })
    device.queue.writeBuffer(sectionBuffer, 0, routed.sections)
    released.push(drawAtlas, mask, packed, sectionBuffer)
    const maskView = mask.createView(), packedView = packed.createView()
    const packGroup = device.createBindGroup({ layout: packLayout, entries: [{ binding: 0, resource: maskView }] })
    const rectOf = (layer) => {
      let boxMinX = Infinity, boxMinY = Infinity, boxMaxX = -Infinity, boxMaxY = -Infinity
      for (let section = routed.layerStart[layer]; section < routed.layerStart[layer + 1]; section++) {
        const at = section * SECTION_FLOATS, reachOf = routed.sections[at + 4] * routed.sections[at + 5] + routed.sections[at + 6]
        boxMinX = Math.min(boxMinX, routed.sections[at] - reachOf); boxMaxX = Math.max(boxMaxX, routed.sections[at] + reachOf)
        boxMinY = Math.min(boxMinY, routed.sections[at + 1] - reachOf); boxMaxY = Math.max(boxMaxY, routed.sections[at + 1] + reachOf)
      }
      const x = Math.max(0, Math.floor((boxMinX - originX) / DRAW_PIXEL_MM) - 1), y = Math.max(0, Math.floor((boxMinY - originY) / DRAW_PIXEL_MM) - 1)
      const right = Math.min(drawWidth, Math.ceil((boxMaxX - originX) / DRAW_PIXEL_MM) + 1), bottom = Math.min(drawRows, Math.ceil((boxMaxY - originY) / DRAW_PIXEL_MM) + 1)
      return { x, y, width: right - x, rows: bottom - y }
    }
    // the model only matters within the xy distance of the support, so a layer is flooded inside its support's
    //  rectangle widened by that: its window (in the plate's draw pixels)
    const floodMargin = Math.ceil(settings.xyDistance / DRAW_PIXEL_MM) + 2
    const windowOf = (rect) => {
      const x = Math.max(0, rect.x - floodMargin), y = Math.max(0, rect.y - floodMargin)
      return { x, y, width: Math.min(drawWidth, rect.x + rect.width + floodMargin) - x, rows: Math.min(drawRows, rect.y + rect.rows + floodMargin) - y }
    }
    const outLayerRingStart = new Uint32Array(layerCount + 1), outRingStart = [0], outPoints = []
    const ringsOfLayer = new Array(layers).fill(null)
    let solidPixels = 0, readBytes = 0, traceMs = 0
    const drawn = []
    for (let layer = 0; layer < layers; layer++) {
      if (routed.layerStart[layer + 1] === routed.layerStart[layer]) continue
      const rect = rectOf(layer)
      if (rect.width > 0 && rect.rows > 0) drawn.push({ layer, rect, window: windowOf(rect) })
    }
    const drawReads = []
    const traceBatch = async () => {
      const { buffer, pending, mapped } = drawReads.shift()
      await mapped
      const words = new Uint32Array(buffer.getMappedRange())
      for (const read of pending) {
        const traceStarted = performance.now()
        const traced = tracePackedRings(words, packedRowBytes / 4, read.origin[0], read.origin[1], read.rect.width, read.rect.rows)
        solidPixels += traced.solidPixels
        ringsOfLayer[read.layer] = traced.rings.map(ring => {
          const simplified = simplifyRing(ring, SIMPLIFY_PIXELS)
          for (let at = 0; at < simplified.length; at += 2) {
            simplified[at] = originX + (read.rect.x + simplified[at]) * DRAW_PIXEL_MM
            simplified[at + 1] = originY + (read.rect.y + simplified[at + 1]) * DRAW_PIXEL_MM
          }
          return simplified
        })
        traceMs += performance.now() - traceStarted
      }
      buffer.unmap(); buffer.destroy()
    }
    let batches = 0
    for (let next = 0; next < drawn.length;) {
      if (canceled()) { release(); return { ok: false, reason: 'canceled' } }
      if (drawReads.length === BATCHES_IN_FLIGHT) await traceBatch()
      // pack the next layers' windows into the atlas, row after row, until one does not fit
      const batch = []
      let shelfX = 0, shelfY = 0, shelfRows = 0
      while (next < drawn.length && batch.length < DRAW_TILES) {
        const { window } = drawn[next]
        if (shelfX + window.width > drawAtlas.size[0]) { shelfX = 0; shelfY += shelfRows; shelfRows = 0 }
        if (shelfY + window.rows > drawAtlas.size[1]) break
        batch.push({ ...drawn[next], at: [shelfX, shelfY] })
        shelfX += window.width; shelfRows = Math.max(shelfRows, window.rows)
        next++
      }
      batches++
      const encoder = device.createCommandEncoder()
      // this batch's uniform slots: where each window sits in the atlas and which part of the plate it shows. A queue
      //  write lands before the submit below and after the last one.
      const tiles = batch.map(({ layer, window, at }, index) => {
        const rect = [at[0], at[1], window.width, window.rows]
        const plate = [originX + window.x * DRAW_PIXEL_MM, originY + window.y * DRAW_PIXEL_MM, window.width * DRAW_PIXEL_MM, window.rows * DRAW_PIXEL_MM]
        writeSlot(DRAW_TILE + index, { pixelMm: DRAW_PIXEL_MM, tile: [window.width, window.rows], tileOrigin: at, plate })
        drawSteps.forEach((step, stepIndex) => writeSlot(drawJumpSlot(index, stepIndex), { pixelMm: DRAW_PIXEL_MM, tile: [window.width, window.rows], tileOrigin: at, step, plate }))
        return { layers: collisionLayers(layer), rect, fillSlot: DRAW_TILE + index }
      })
      device.queue.writeBuffer(uniforms, DRAW_TILE * SLOT_BYTES, uniformData, DRAW_TILE * SLOT_BYTES, (slotCount - DRAW_TILE) * SLOT_BYTES)
      const seedIndex = drawAtlas.flood(encoder, outline, tiles)
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: maskView, loadOp: 'clear', storeOp: 'store' }] })
      pass.setPipeline(sectionPipeline); pass.setVertexBuffer(0, sectionBuffer)
      // where each layer's support rectangle sits in the atlas
      const pending = []
      batch.forEach(({ layer, rect, window, at }, index) => {
        // the support's rectangle inside its window, in atlas pixels
        const x = at[0] + rect.x - window.x, y = at[1] + rect.y - window.y
        pass.setBindGroup(0, drawAtlas.sampledGroups[seedIndex], [(DRAW_TILE + index) * SLOT_BYTES])
        pass.setViewport(...tiles[index].rect, 0, 1); pass.setScissorRect(x, y, rect.width, rect.rows)
        pass.draw(6, routed.layerStart[layer + 1] - routed.layerStart[layer], 0, routed.layerStart[layer])
        pending.push({ layer, rect, origin: [x, y] })
      })
      pass.end()
      // the rows the batch filled, packed to a bit per pixel and read back in one copy
      const usedRows = shelfY + shelfRows
      const pack = encoder.beginRenderPass({ colorAttachments: [{ view: packedView, loadOp: 'load', storeOp: 'store' }] })
      pack.setPipeline(packPipeline); pack.setBindGroup(0, packGroup); pack.setScissorRect(0, 0, packedWidth, usedRows); pack.draw(3); pack.end()
      passes += 3 + drawSteps.length
      const buffer = device.createBuffer({ size: packedRowBytes * usedRows, usage: BUFFER_COPY_DST | BUFFER_MAP_READ })
      encoder.copyTextureToBuffer({ texture: packed }, { buffer, bytesPerRow: packedRowBytes }, [packedWidth, usedRows])
      readBytes += packedRowBytes * usedRows
      device.queue.submit([encoder.finish()])
      drawReads.push({ buffer, pending, mapped: buffer.mapAsync(MAP_MODE_READ) })
    }
    while (drawReads.length) await traceBatch()
    for (let layer = 0; layer < layerCount; layer++) {
      for (const ring of ringsOfLayer[layer] ?? []) {
        if (ring.length < 6) continue
        for (const value of ring) outPoints.push(value)
        outRingStart.push(outPoints.length / 2)
      }
      outLayerRingStart[layer + 1] = outRingStart.length - 1
    }
    release()
    const drawMs = performance.now() - drawStarted
    return {
      ok: true, layerRingStart: outLayerRingStart, ringStart: Uint32Array.from(outRingStart), points: Float32Array.from(outPoints),
      stats: {
        ...routed.stats, layers, fieldPixelMm: fieldPixel, layersPerStep, fieldGrid: [fieldWidth, fieldRows], drawGrid: [drawWidth, drawRows], passes, drawBatches: batches,
        fieldMs, routeMs, drawMs, traceMs, totalMs: performance.now() - started,
        supportAreaMm2: solidPixels * DRAW_PIXEL_MM * DRAW_PIXEL_MM, readMb: readBytes / 1048576, fieldReadMb: fieldBytesRead / 1048576, rings: outRingStart.length - 1, vertices: outPoints.length / 2,
      },
    }
  }
  return { run }
}
