// SL1 encode worker: one strided subset of layers -> PNG mask bytes. The whole SL1 build is convertToBlob
//  (measured 88% of 7.8s on a 960-layer Benchy), and it refuses to parallelize INSIDE a thread (batching 8
//  on the main thread bought 12%) while parallelizing cleanly ACROSS them: 4 workers 5.6x, 8 workers 9.3x
//  on the same archive. One canvas is created per worker and reused — creating one per layer is what the
//  sequential path's 597ms "clear" stage actually was.
import { zlibSync } from 'three/examples/jsm/libs/fflate.module.js'
import { slaRasterTransform } from './core/sl1_write.js'
import { rasterizeMask } from './core/raster_mask.js'
import { encodeGray8 } from './core/png_gray.js'

// In: { indices: number[] (absolute layer numbers this worker owns), paths: Float32Array[] (same order,
//       structured-clone copies — the main thread keeps its own for the sidecars), params }
// Out: { progress } every 8 layers, then one { indices, pngs: Uint8Array[] } with the buffers transferred.
// Canvas is gone from this worker: the AET rasterizer + gray8 encoder replace convertToBlob, which
//  emitted RGBA masks upstream's SL1 reader rejects. CompressionStream does the IDAT deflate natively
//  (fflate zlibSync is the injected fallback), so per layer this is raster ~1ms + deflate ~5ms.
self.onmessage = async ({ data: { indices, paths, params, aa } }) => {
  const transform = slaRasterTransform(params)
  const pngs = []
  for (let k = 0; k < indices.length; k++) {
    const mask = rasterizeMask(paths[k], transform, aa || 1)
    pngs.push(await encodeGray8(mask, transform.px, transform.py, { deflate: zlibSync }))
    if ((k & 7) === 7) self.postMessage({ progress: k + 1 })
  }
  self.postMessage({ indices, pngs }, pngs.map(png => png.buffer))
}
