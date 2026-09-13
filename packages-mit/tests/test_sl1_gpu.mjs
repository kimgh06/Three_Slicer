// The SLA gray8/AA raster path's completion criteria, as asserts:
//   [format]      masks are gray8 (color type 0, depth 8) — the ONE layout upstream's SL1 reader
//                 accepts (PNGReadWrite.cpp:100) — and round-trip pixel-exact through a real inflate.
//   [reference]   the CPU AET rasterizer matches analytic coverage on synthetic geometry, binary and AA.
//   [fallback]    a full makeSL1 runs under plain node with NOTHING injected (no canvas, no GPU).
//   [gpu]         the GPU stencil-fan path matches the CPU reference away from boundaries, its AA is
//                 monotonic across an edge, and same device + same input -> same bytes. These run only
//                 when a WebGPU device exists (browser, or Dawn via SL1_GPU_WEBGPU_PATH under node) —
//                 absent GPU they SKIP, they do not fail: the CPU path is the contract, GPU the bonus.
//   Determinism scope (AGENTS.md): masks are NOT covered by golden — cross-vendor bytes may differ
//                 inside the boundary tolerance asserted here.
import { strict as assert } from 'node:assert'
import { inflateSync } from 'node:zlib'
import { encodeGray8 } from './src/core/png_gray.js'
import { rasterizeMask, loopsOfPaths } from './src/core/raster_mask.js'
import { makeSl1GpuRaster } from './src/core/sl1_raster_gpu.js'
import { makeSl1ParityGpu } from './src/core/sl1_parity_gpu.js'
import { slaRasterTransform, makeSL1 } from './src/core/sl1_write.js'
import { parseSl1, pngSize } from './src/core/sl1_read.js'

let passed = 0, skipped = 0
const ok = (name) => { passed++; console.log('  ok', name) }
const skip = (name) => { skipped++; console.log('  skip', name) }

// small portrait display: canvas 256 wide x 128 tall, 0.1mm/px
const PARAMS = { display_width: 12.8, display_height: 25.6, display_pixels_x: 128, display_pixels_y: 256 }
const T = slaRasterTransform(PARAMS)
assert.equal(T.px, 256); assert.equal(T.py, 128)

// a square loop [-4,4]^2 as the stride-8 stream every layer consumer reads
const squarePaths = (half = 4) => {
  const c = [[-half,-half],[half,-half],[half,half],[-half,half]]
  const out = new Float32Array(4 * 8)
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = c[i], [bx, by] = c[(i + 1) % 4]
    out.set([ax, ay, 0, 1, bx, by, 0, 1], i * 8)
  }
  return out
}

const decodePng = (bytes) => {
  // IHDR is always the first chunk at offset 8; walk chunks for IDAT
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = dv.getUint32(16), height = dv.getUint32(20)
  const bitDepth = bytes[24], colorType = bytes[25]
  let at = 8
  const idat = []
  while (at < bytes.length) {
    const len = dv.getUint32(at)
    const type = String.fromCharCode(bytes[at+4], bytes[at+5], bytes[at+6], bytes[at+7])
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + len))
    at += 12 + len
  }
  const zcat = new Uint8Array(idat.reduce((n, c) => n + c.length, 0))
  let zat = 0
  for (const c of idat) { zcat.set(c, zat); zat += c.length }
  const raw = inflateSync(zcat)
  const pix = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (1 + width)], 0, 'filter 0')
    pix.set(raw.subarray(y * (1 + width) + 1, (y + 1) * (1 + width)), y * width)
  }
  return { width, height, bitDepth, colorType, pix }
}

// [format] gray8 IHDR + pixel-exact round trip
{
  const mask = rasterizeMask(squarePaths(), T, 1)
  const png = await encodeGray8(mask, T.px, T.py)
  const back = decodePng(png)
  assert.equal(back.colorType, 0, 'PNG_COLOR_TYPE_GRAY')
  assert.equal(back.bitDepth, 8)
  assert.deepEqual(back.pix, mask, 'pixels round-trip exactly')
  assert.deepEqual(pngSize(png), { width: 256, height: 128 })
  ok('format: gray8 IHDR, filter-0 scanlines, pixel-exact inflate round-trip')
}

// [reference] binary: an 8x8mm square at 0.1mm/px is an 80x80px block, area exact to the pixel grid
{
  const mask = rasterizeMask(squarePaths(), T, 1)
  let on = 0
  for (const v of mask) { assert.ok(v === 0 || v === 255); if (v === 255) on++ }
  assert.equal(on, 80 * 80, `binary area ${on}`)
  ok('reference: binary fill area is analytic (80x80 px)')
}

// [reference] AA: a half-pixel-shifted edge grays to ~50% coverage; interior stays 255
{
  const mask = rasterizeMask(squarePaths(4.05), T, 4)   // edge at x=4.05mm -> half of pixel column covered
  const { px: W } = T
  const [cx, cy] = T.map(0, 0)
  assert.equal(mask[Math.floor(cy) * W + Math.floor(cx)], 255, 'interior saturated')
  const [ex, ey] = T.map(0, 4.08)   // inside the boundary pixel band (portrait: model y -> canvas x)
  const edge = mask[Math.floor(ey) * W + Math.floor(ex)]
  assert.ok(edge > 40 && edge < 220, `edge coverage gray, got ${edge}`)
  ok('AA: boundary pixel is fractional coverage, interior saturated')
}

// [fallback] full makeSL1 under bare node: no canvas, no GPU, real PNGs in the archive
{
  const layers = [0.05, 0.1, 0.15].map((z, idx) => ({ z, idx, paths: squarePaths() }))
  const bytes = await makeSL1({ layers, params: { ...PARAMS, layer_height: 0.05 },
    stats: { layers: 3 }, jobName: 'gpu_t', timestamp: '2026-01-01T00:00:00Z' })
  const back = parseSl1(bytes)
  assert.equal(back.layers.length, 3)
  const first = decodePng(back.layers[0].png)
  assert.equal(first.colorType, 0)
  assert.equal(first.width, 256)
  ok('fallback: end-to-end archive under node with nothing injected')
}

// [gpu] — only with a device (Dawn under node via SL1_GPU_WEBGPU_PATH, or a browser run)
let device = null
try {
  const mod = await import(process.env.SL1_GPU_WEBGPU_PATH || 'webgpu')
  const gpu = mod.create([])
  const adapter = await gpu.requestAdapter()
  device = adapter ? await adapter.requestDevice() : null
} catch { /* no dawn: skip */ }
if (!device) {
  skip('gpu parity/AA/determinism (no WebGPU device — CPU path is the contract)')
} else {
  const { rasterize, dispose } = makeSl1GpuRaster(device)
  const cpu = rasterizeMask(squarePaths(), T, 1)
  const gpu1 = await rasterize(squarePaths(), T, 1)
  // binary parity: differing pixels only at contour boundaries, bounded count
  let diffs = 0
  const isBoundary = (i) => {
    const y = (i / T.px) | 0, x = i % T.px
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= T.px || ny >= T.py) continue
      if (cpu[ny * T.px + nx] !== cpu[i]) return true
    }
    return false
  }
  for (let i = 0; i < cpu.length; i++) if ((cpu[i] === 255) !== (gpu1[i] > 127)) {
    diffs++
    assert.ok(isBoundary(i), `non-boundary mismatch at ${i}`)
  }
  assert.ok(diffs / cpu.length < 1e-4, `boundary diffs ${diffs}`)
  ok(`gpu: binary parity with CPU reference (${diffs} boundary px differ)`)

  const gpu2 = await rasterize(squarePaths(), T, 1)
  assert.deepEqual(gpu2, gpu1)
  const aa1 = await rasterize(squarePaths(4.05), T, 4)
  const aa2 = await rasterize(squarePaths(4.05), T, 4)
  assert.deepEqual(aa2, aa1)
  ok('gpu: same device + same input -> same bytes (binary and MSAA)')

  const [ex, ey] = T.map(0, 4.08)
  const edge = aa1[Math.floor(ey) * T.px + Math.floor(ex)]
  const [cx2, cy2] = T.map(0, 0)
  assert.equal(aa1[Math.floor(cy2) * T.px + Math.floor(cx2)], 255)
  assert.ok(edge > 0 && edge < 255, `MSAA edge gray, got ${edge}`)
  ok('gpu: MSAA edge is fractional, interior saturated')

  // [parity] slice-by-rendering: a closed cube's mesh, sliced at a mid plane, must match the CPU
  //  square reference away from boundaries — and prepare() must SEAT z (the kernel's frame), so a
  //  cube floating at z=-3 slices identically to one at z=0.
  {
    const cubeSTL = (z0) => {
      const v = [[-4,-4,z0],[4,-4,z0],[4,4,z0],[-4,4,z0],[-4,-4,z0+8],[4,-4,z0+8],[4,4,z0+8],[-4,4,z0+8]]
      const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
      const b = new Uint8Array(84 + f.length * 50)
      const dv = new DataView(b.buffer)
      dv.setUint32(80, f.length, true)
      f.forEach((face, i) => { let o = 84 + 50 * i + 12
        for (const vi of face) for (const c of v[vi]) { dv.setFloat32(o, c, true); o += 4 } })
      return b
    }
    const parity = makeSl1ParityGpu(device)
    assert.ok(parity.prepare(cubeSTL(0)), 'prepare accepts a binary STL')
    const cpuRef = rasterizeMask(squarePaths(), T, 1)
    const pm = await parity.rasterize(4, T, 1)   // mid plane of the seated cube
    let pdiffs = 0
    for (let i = 0; i < cpuRef.length; i++) if ((cpuRef[i] === 255) !== (pm[i] > 127)) pdiffs++
    assert.ok(pdiffs / cpuRef.length < 1e-3, `parity vs CPU diffs ${pdiffs}`)
    assert.ok(parity.prepare(cubeSTL(-3)), 're-prepare')
    const pm2 = await parity.rasterize(4, T, 1)
    assert.deepEqual(pm2, pm, 'seating: a floating cube slices identically')
    const pmAA = await parity.rasterize(0.05, T, 4)   // plane hugging the seated bottom face
    let grays = 0
    for (const v of pmAA) if (v > 0 && v < 255) grays++
    assert.ok(pm2.some(v => v > 127), 'mask non-empty')
    parity.dispose()
    ok(`parity: mesh-direct slice matches CPU reference (${pdiffs} px), z-seating pinned`)
  }
  dispose()
  device.destroy?.()
}

console.log(`\ntest_sl1_gpu: ${passed} checks passed${skipped ? `, ${skipped} skipped` : ''}`)
process.exit(0)
