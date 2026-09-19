// Slice-by-rendering for SLA masks: the raw MESH is drawn once per layer, and the fragments above the slicing
//  plane count into the stencil signed by facing (front +1, back -1, wrapping) — a non-zero count IS the layer
//  mask, the NonZero rule the kernel's contours use (slice_planes.h). It was an INVERT parity (even-odd), which
//  left two coincident objects EMPTY in the mask while the slice and its supports treated them as solid. A
//  mirrored transform flips every facing at once, so it changes the sign of the count and never its zero. No plane
//  sweep, no chaining, no contours: the mask comes straight from the triangles, so it cannot lose
//  what contour stitching drops (measured on a 775k-facet scan model: 0.007% avg / 0.047% worst
//  pixel diff against the kernel-contour reference, 0.7 ms/layer for all 658 layers).
// FRAME: the kernel (slice_sla) keeps the mesh's own XY and SEATS z (minZ -> 0, measured on a cube:
//  contours at [0,0]..[20,30], layer zs from lh). prepare() reproduces exactly that — XY untouched,
//  z seated — so a layerZ from the kernel's own layer list lands on the same plane.
// DEVICE INJECTED, like sl1_raster_gpu.js: core/ never touches navigator (layer guard); the browser
//  acquires via scene/gpu_device.js, node via Dawn. AA: aa>1 renders 4x MSAA (WebGPU's guaranteed
//  set is {1,4}) — per-sample stencil coverage resolves to the gray level.

import { STL_HEADER_BYTES, STL_DATA_OFFSET, STL_TRIANGLE_BYTES, stlByteLength } from './stl_format.js'

const BUF_VERTEX = 0x20, BUF_COPY_DST = 0x8, BUF_COPY_SRC = 0x4, BUF_MAP_READ = 0x1, BUF_UNIFORM = 0x40
const TEX_RENDER = 0x10, TEX_COPY_SRC = 0x1

const SHADER = /* wgsl */ `
struct U { ax: vec3<f32>, pad1: f32, ay: vec3<f32>, layerZ: f32, dims: vec2<f32>, pad2: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) wz: f32 };
@vertex fn vs(@location(0) p: vec3<f32>) -> VOut {
  let canv = vec2<f32>(u.ax.x*p.x + u.ax.y*p.y + u.ax.z, u.ay.x*p.x + u.ay.y*p.y + u.ay.z);
  var o: VOut;
  o.pos = vec4<f32>(canv.x/u.dims.x*2.0 - 1.0, 1.0 - canv.y/u.dims.y*2.0, 0.0, 1.0);
  o.wz = p.z;
  return o;
}
// only surfaces ABOVE the plane count: their signed per-pixel count says inside/outside at (x,y,z)
@fragment fn fsParity(v: VOut) -> @location(0) vec4<f32> {
  if (v.wz < u.layerZ) { discard; }
  return vec4<f32>(0.0);
}
@vertex fn vsCover(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment fn fsWhite() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }
`

/** Binary STL bytes -> Float32Array of xyz triples (normals skipped). null when not binary STL. */
const stlVerts = (bytes) => {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes)
  if (bytes.byteLength < STL_DATA_OFFSET) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = dv.getUint32(STL_HEADER_BYTES, true)
  if (stlByteLength(n) !== bytes.byteLength) return null
  const out = new Float32Array(n * 9)
  for (let i = 0; i < n; i++) {
    const base = STL_DATA_OFFSET + STL_TRIANGLE_BYTES * i + 12   // past the stored normal
    for (let f = 0; f < 9; f++) out[i * 9 + f] = dv.getFloat32(base + 4 * f, true)
  }
  return out
}

/**
 * @param {GPUDevice} device injected
 * @returns {{ prepare(stlBytes: Uint8Array): boolean,
 *             rasterize(layerZ: number, transform, aa?: number): Promise<Uint8Array>,
 *             dispose(): void }}
 */
export function makeSl1ParityGpu(device) {
  const module = device.createShaderModule({ code: SHADER })
  const vertexLayout = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }]
  const pipelines = new Map()
  const pipelinesFor = (samples) => {
    let p = pipelines.get(samples)
    if (p) return p
    const up = { compare: 'always', passOp: 'increment-wrap', failOp: 'keep', depthFailOp: 'keep' }
    const down = { compare: 'always', passOp: 'decrement-wrap', failOp: 'keep', depthFailOp: 'keep' }
    const keep = { compare: 'not-equal', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' }
    const parity = device.createRenderPipeline({ layout: 'auto',
      vertex: { module, entryPoint: 'vs', buffers: vertexLayout },
      fragment: { module, entryPoint: 'fsParity', targets: [{ format: 'r8unorm', writeMask: 0 }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always',
        stencilFront: up, stencilBack: down },
      multisample: { count: samples } })
    // the cover pipeline reads no uniform, so its 'auto' layout is EMPTY — never give it a bind group
    const cover = device.createRenderPipeline({ layout: 'auto',
      vertex: { module, entryPoint: 'vsCover' },
      fragment: { module, entryPoint: 'fsWhite', targets: [{ format: 'r8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always',
        stencilFront: keep, stencilBack: keep },
      multisample: { count: samples } })
    p = { parity, cover }
    pipelines.set(samples, p)
    return p
  }

  let vbuf = null, vertCount = 0
  const prepare = (stlBytes) => {
    const verts = stlVerts(stlBytes)
    if (!verts || !verts.length) return false
    let mnz = Infinity
    for (let i = 2; i < verts.length; i += 3) if (verts[i] < mnz) mnz = verts[i]
    for (let i = 2; i < verts.length; i += 3) verts[i] -= mnz   // the kernel's seat, XY untouched
    vbuf?.destroy()
    vbuf = device.createBuffer({ size: verts.byteLength, usage: BUF_VERTEX | BUF_COPY_DST })
    device.queue.writeBuffer(vbuf, 0, verts)
    vertCount = verts.length / 3
    return true
  }

  const rasterize = async (layerZ, transform, aa = 1) => {
    if (!vbuf) throw new Error('sl1_parity_gpu: prepare() first')
    const { px: W, py: H } = transform
    const samples = aa > 1 ? 4 : 1
    const { parity, cover } = pipelinesFor(samples)
    // model(x,y) -> canvas affine, derived numerically so portrait swap/mirrors cannot drift from slaRasterTransform
    const m00 = transform.map(1, 0), m01 = transform.map(0, 1), m0 = transform.map(0, 0)
    const u = new Float32Array([m00[0]-m0[0], m01[0]-m0[0], m0[0], 0,
                                m00[1]-m0[1], m01[1]-m0[1], m0[1], layerZ, W, H, 0, 0])
    const ubuf = device.createBuffer({ size: 48, usage: BUF_UNIFORM | BUF_COPY_DST })
    device.queue.writeBuffer(ubuf, 0, u)
    const bind = device.createBindGroup({ layout: parity.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] })
    const color = device.createTexture({ size: [W, H], format: 'r8unorm', sampleCount: samples,
      usage: TEX_RENDER | (samples === 1 ? TEX_COPY_SRC : 0) })
    const resolve = samples > 1
      ? device.createTexture({ size: [W, H], format: 'r8unorm', usage: TEX_RENDER | TEX_COPY_SRC }) : null
    const ds = device.createTexture({ size: [W, H], format: 'depth24plus-stencil8', sampleCount: samples, usage: TEX_RENDER })
    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: samples > 1 ? 'discard' : 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 }, ...(resolve ? { resolveTarget: resolve.createView() } : {}) }],
      depthStencilAttachment: { view: ds.createView(),
        depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1,
        stencilLoadOp: 'clear', stencilStoreOp: 'discard', stencilClearValue: 0 } })
    pass.setPipeline(parity)
    pass.setBindGroup(0, bind)
    pass.setVertexBuffer(0, vbuf)
    pass.draw(vertCount)
    pass.setPipeline(cover)
    pass.setStencilReference(0)
    pass.draw(3)
    pass.end()
    const rowBytes = Math.ceil(W / 256) * 256
    const rb = device.createBuffer({ size: rowBytes * H, usage: BUF_COPY_DST | BUF_MAP_READ })
    enc.copyTextureToBuffer({ texture: resolve ?? color }, { buffer: rb, bytesPerRow: rowBytes }, [W, H])
    device.queue.submit([enc.finish()])
    await rb.mapAsync(1 /* READ */)
    const padded = new Uint8Array(rb.getMappedRange())
    const mask = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) mask.set(padded.subarray(y * rowBytes, y * rowBytes + W), y * W)
    rb.unmap()
    for (const res of [ubuf, color, resolve, ds, rb]) res?.destroy()
    return mask
  }

  return { prepare, rasterize, dispose: () => { vbuf?.destroy(); vbuf = null; pipelines.clear() } }
}
