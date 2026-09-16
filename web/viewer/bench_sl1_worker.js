// Bench worker: rasterize+encode a strided subset of layers. Same three calls makeSL1 makes per layer,
//  just off the main thread, to find out whether convertToBlob is actually N-way parallel.
import { slaRasterTransform, drawLayer } from '../../viewer-package/src/core/sl1_write.js'

self.onmessage = async ({ data: { indices, paths, params } }) => {
  const transform = slaRasterTransform(params)
  const canvas = new OffscreenCanvas(transform.px, transform.py)
  const ctx = canvas.getContext('2d')
  const out = []
  const t = { clear: 0, draw: 0, encode: 0, read: 0 }
  let mark = performance.now()
  const tick = (key) => { const n = performance.now(); t[key] += n - mark; mark = n }
  for (let k = 0; k < indices.length; k++) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, transform.px, transform.py); tick('clear')
    ctx.fillStyle = '#fff'; drawLayer(ctx, paths[k], transform); tick('draw')
    const blob = await canvas.convertToBlob({ type: 'image/png' }); tick('encode')
    out.push(new Uint8Array(await blob.arrayBuffer())); tick('read')
  }
  self.postMessage({ indices, pngs: out, t }, out.map(u => u.buffer))
}
