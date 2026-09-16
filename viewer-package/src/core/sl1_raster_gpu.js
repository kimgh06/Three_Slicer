// GPU rasterizer for SLA masks: stencil-fan even-odd fill with hardware MSAA — the AA path for
//  high-resolution displays, where CPU supersampling stops being free (measured: 1ms/layer at
//  1440x2560 binary, but a 12K display at 4x supersample is ~256ms/layer on the CPU).
// The DEVICE IS INJECTED. This module never touches navigator (the layer guard forbids it in core/,
//  and rightly: under node the device comes from Dawn's `webgpu` package instead) — acquisition
//  lives in scene/gpu_device.js for the browser and in the test for node.
// Fill rule: triangle-fan stencil INVERT = even-odd, the same rule the CPU reference (raster_mask.js)
//  and the old canvas path fill with, so hole orientation cannot matter on any path.
// AA semantics: aa <= 1 renders single-sample (binary mask, comparable to the CPU reference pixel
//  for pixel at centers); aa > 1 renders 4x MSAA — WebGPU guarantees exactly {1, 4} — and the
//  resolve averages per-sample stencil coverage into the gray level.
import { loopsOfPaths } from './raster_mask.js'

// Numeric WebGPU usage flags: the named globals (GPUBufferUsage/GPUTextureUsage) exist in browsers
//  but are NOT guaranteed on a bare node globalThis — the injected device is, so only the device is used.
const BUF_VERTEX = 0x20, BUF_COPY_DST = 0x8, BUF_COPY_SRC = 0x4, BUF_MAP_READ = 0x1
const TEX_RENDER = 0x10, TEX_COPY_SRC = 0x1

const SHADER = /* wgsl */ `
@vertex fn vs(@location(0) pos: vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(pos, 0.0, 1.0);
}
@fragment fn fsMask() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn fsCover() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }
`

/**
 * @param {GPUDevice} device injected — browser: scene/gpu_device.js, node: dawn's create()
 * @returns {{ rasterize(paths: Float32Array, transform, aa?: number): Promise<Uint8Array>, dispose(): void }}
 */
export function makeSl1GpuRaster(device) {
  const module = device.createShaderModule({ code: SHADER })
  const vertexLayout = [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }]
  const pipelines = new Map()   // sampleCount -> {fill, cover}
  const pipelinesFor = (samples) => {
    let p = pipelines.get(samples)
    if (p) return p
    const stencilInvert = { compare: 'always', passOp: 'invert', failOp: 'invert', depthFailOp: 'invert' }
    const fill = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs', buffers: vertexLayout },
      fragment: { module, entryPoint: 'fsMask', targets: [{ format: 'r8unorm', writeMask: 0 }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always',
        stencilFront: stencilInvert, stencilBack: stencilInvert },
      multisample: { count: samples },
    })
    const stencilKeep = { compare: 'not-equal', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' }
    const cover = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs', buffers: vertexLayout },
      fragment: { module, entryPoint: 'fsCover', targets: [{ format: 'r8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always',
        stencilFront: stencilKeep, stencilBack: stencilKeep },
      multisample: { count: samples },
    })
    p = { fill, cover }
    pipelines.set(samples, p)
    return p
  }

  // Fan triangles in CLIP space from the layer's loops: (v0, vi, vi+1) per loop — with stencil invert
  //  the fan's winding and self-overlap do not matter, parity is all that survives.
  const fanVertices = (paths, transform) => {
    const { px: W, py: H } = transform
    const loops = loopsOfPaths(paths)
    let count = 0
    for (const pts of loops) { const n = pts.length / 2; if (n >= 3) count += (n - 2) * 3 }
    const out = new Float32Array(count * 2)
    let at = 0
    const clipX = (x, y) => (transform.map(x, y)[0] / W) * 2 - 1
    const clipY = (x, y) => 1 - (transform.map(x, y)[1] / H) * 2
    for (const pts of loops) {
      const n = pts.length / 2
      if (n < 3) continue
      const x0 = clipX(pts[0], pts[1]), y0 = clipY(pts[0], pts[1])
      for (let i = 1; i + 1 < n; i++) {
        out[at++] = x0; out[at++] = y0
        out[at++] = clipX(pts[i * 2], pts[i * 2 + 1]); out[at++] = clipY(pts[i * 2], pts[i * 2 + 1])
        out[at++] = clipX(pts[(i + 1) * 2], pts[(i + 1) * 2 + 1]); out[at++] = clipY(pts[(i + 1) * 2], pts[(i + 1) * 2 + 1])
      }
    }
    return out
  }

  const COVER_TRI = new Float32Array([-1, -1, 3, -1, -1, 3])   // one clip-space triangle over the viewport

  const rasterize = async (paths, transform, aa = 1) => {
    const { px: W, py: H } = transform
    const samples = aa > 1 ? 4 : 1
    const { fill, cover } = pipelinesFor(samples)
    const verts = fanVertices(paths, transform)
    const vbuf = device.createBuffer({ size: Math.max(8, verts.byteLength), usage: BUF_VERTEX | BUF_COPY_DST })
    if (verts.length) device.queue.writeBuffer(vbuf, 0, verts)
    const cbuf = device.createBuffer({ size: COVER_TRI.byteLength, usage: BUF_VERTEX | BUF_COPY_DST })
    device.queue.writeBuffer(cbuf, 0, COVER_TRI)

    const color = device.createTexture({ size: [W, H], format: 'r8unorm', sampleCount: samples,
      usage: TEX_RENDER | (samples === 1 ? TEX_COPY_SRC : 0) })
    const resolve = samples > 1
      ? device.createTexture({ size: [W, H], format: 'r8unorm', usage: TEX_RENDER | TEX_COPY_SRC })
      : null
    const ds = device.createTexture({ size: [W, H], format: 'depth24plus-stencil8', sampleCount: samples, usage: TEX_RENDER })

    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: samples > 1 ? 'discard' : 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 }, ...(resolve ? { resolveTarget: resolve.createView() } : {}) }],
      depthStencilAttachment: { view: ds.createView(),
        depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1,
        stencilLoadOp: 'clear', stencilStoreOp: 'discard', stencilClearValue: 0 },
    })
    if (verts.length) {
      pass.setPipeline(fill)
      pass.setVertexBuffer(0, vbuf)
      pass.draw(verts.length / 2)
    }
    pass.setPipeline(cover)
    pass.setStencilReference(0)
    pass.setVertexBuffer(0, cbuf)
    pass.draw(3)
    pass.end()

    // r8unorm readback: bytesPerRow must be 256-aligned; strip the padding on the way out.
    const rowBytes = Math.ceil(W / 256) * 256
    const rb = device.createBuffer({ size: rowBytes * H, usage: BUF_COPY_DST | BUF_MAP_READ })
    enc.copyTextureToBuffer({ texture: resolve ?? color }, { buffer: rb, bytesPerRow: rowBytes }, [W, H])
    device.queue.submit([enc.finish()])
    await rb.mapAsync(1 /* GPUMapMode.READ */)
    const padded = new Uint8Array(rb.getMappedRange())
    const mask = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) mask.set(padded.subarray(y * rowBytes, y * rowBytes + W), y * W)
    rb.unmap()
    for (const r of [vbuf, cbuf, color, resolve, ds, rb]) r?.destroy()
    return mask
  }

  return { rasterize, dispose: () => { pipelines.clear() } }
}
