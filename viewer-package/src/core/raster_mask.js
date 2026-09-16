// CPU rasterizer for SLA masks: the REFERENCE implementation the GPU path is validated against, and
//  the fallback every environment without WebGPU gets — which is also what finally lets an SL1 export
//  run under plain node (the canvas path needed an OffscreenCanvas the caller had to inject).
// Active-edge-table scanline fill, even-odd — the same fill rule the canvas path used, so hole
//  orientation cannot matter. Measured 1.0 ms/layer on a 2.01M-segment model's 1440x2560 mask
//  (the naive per-row edge scan this replaces was 10ms).
// AA is upstream's model: supersample the fill at NxN subsamples per pixel and average — a boundary
//  pixel's gray level IS its coverage. N=1 collapses to the plain binary mask.

import { STRIDE } from './toolpath_encoding.js'

/** Segment-continuity loop rebuild — the same rule drawLayer (sl1_write.js) applies to the stride-8
 *  stream: a loop is a run of segments whose start is the previous segment's end. */
export function loopsOfPaths(paths) {
  const loops = []
  let cur = null
  for (let k = 0; k < paths.length; k += STRIDE) {
    const ax = paths[k], ay = paths[k + 1], bx = paths[k + 4], by = paths[k + 5]
    if (cur && Math.abs(cur.lx - ax) < 1e-6 && Math.abs(cur.ly - ay) < 1e-6) {
      cur.pts.push(bx, by); cur.lx = bx; cur.ly = by
    } else {
      cur = { pts: [ax, ay, bx, by], lx: bx, ly: by }
      loops.push(cur)
    }
  }
  return loops.map(l => l.pts)
}

/** Even-odd AET fill of one row set. `emit(y, x0, x1)` receives inclusive pixel spans. */
function scanFill(loops, W, H, toX, toY, emit) {
  const buckets = new Array(H).fill(null)
  for (const pts of loops) {
    const n = pts.length / 2
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      let x0 = toX(pts[i * 2], pts[i * 2 + 1]), y0 = toY(pts[i * 2], pts[i * 2 + 1])
      let x1 = toX(pts[j * 2], pts[j * 2 + 1]), y1 = toY(pts[j * 2], pts[j * 2 + 1])
      if (y0 === y1) continue
      if (y0 > y1) { const tx = x0; x0 = x1; x1 = tx; const ty = y0; y0 = y1; y1 = ty }
      const yStart = Math.max(0, Math.ceil(y0 - 0.5))
      if (yStart >= H || y1 < 0.5) continue
      const e = { x: x0 + (yStart + 0.5 - y0) / (y1 - y0) * (x1 - x0), dx: (x1 - x0) / (y1 - y0), yEnd: y1 }
      ;(buckets[yStart] ??= []).push(e)
    }
  }
  const active = []
  for (let y = 0; y < H; y++) {
    const yc = y + 0.5
    if (buckets[y]) active.push(...buckets[y])
    for (let i = active.length - 1; i >= 0; i--) if (active[i].yEnd <= yc) active.splice(i, 1)
    active.sort((a, b) => a.x - b.x)
    for (let i = 0; i + 1 < active.length; i += 2) {
      const s = Math.max(0, Math.ceil(active[i].x - 0.5))
      const e = Math.min(W - 1, Math.floor(active[i + 1].x - 0.5))
      if (e >= s) emit(y, s, e)
    }
    for (const a of active) a.x += a.dx
  }
}

/**
 * One layer's stride-8 segment stream -> a gray8 mask under the SL1 raster transform.
 * @param {Float32Array} paths  stride-8 layer stream ([x0,y0,z,enc, x1,y1,z,enc] per segment)
 * @param {{px:number, py:number, map:(x:number,y:number)=>[number,number]}} transform  slaRasterTransform result
 * @param {number} [aa]  supersample factor per axis (1 = binary mask, 4 = 16 subsamples/pixel)
 * @returns {Uint8Array} px*py luminance bytes
 */
export function rasterizeMask(paths, transform, aa = 1) {
  const { px: W, py: H } = transform
  const loops = loopsOfPaths(paths)
  const mask = new Uint8Array(W * H)
  if (aa <= 1) {
    scanFill(loops, W, H,
      (x, y) => transform.map(x, y)[0], (x, y) => transform.map(x, y)[1],
      (y, s, e) => { mask.fill(255, y * W + s, y * W + e + 1) })
    return mask
  }
  // supersampled: fill at aa*W x aa*H into per-pixel coverage counts, then average.
  const cover = new Uint16Array(W * H)
  scanFill(loops, W * aa, H * aa,
    (x, y) => transform.map(x, y)[0] * aa, (x, y) => transform.map(x, y)[1] * aa,
    (sy, s, e) => {
      const y = (sy / aa) | 0
      for (let sx = s; sx <= e; sx++) cover[y * W + ((sx / aa) | 0)]++
    })
  const full = aa * aa
  for (let i = 0; i < cover.length; i++) mask[i] = Math.round(cover[i] * 255 / full)
  return mask
}
