// SL1 slice worker: mask PNGs -> occupancy slices (+ role grids), one STRIDED subset per worker.
// The front half of the reconstruction pipeline, split out so it can run N-wide. Measured on a Benchy
// (1095 layers) this half is decode 853ms + drawImage 896ms + getImageData 1170ms + roles 359ms = ~3.3s of
// the 5.5s total, and all of it is per-layer independent — unlike the surface-nets sweep behind it, which is
// inherently sequential (its vertex ring spans consecutive layers). So this is where parallelism belongs.
//
// Each worker takes every Nth layer, not a contiguous block: the consumer needs slices IN ORDER, and striding
// keeps every worker roughly at the same layer, so the reorder buffer on the far side stays a handful of
// slices instead of a third of the archive (~50MB).
import { fillSliceFromRGBA } from './core/sla_reconstruct.js'
import { drawLayer } from './core/sl1_write.js'
import { STRIDE, ROLE, roleOf } from './core/toolpath_encoding.js'

let BATCH = 6   // slices per canvas/readback — amortizes the getImageData call, bounds bitmaps in flight

const filterByRole = (paths, role) => {
  const out = []
  for (let k = 0; k + STRIDE - 1 < paths.length; k += STRIDE) if (roleOf(paths[k + 3]) === role) for (let f = 0; f < STRIDE; f++) out.push(paths[k + f])
  return out
}

// In: { indices: Int32Array (absolute layer numbers this worker owns), pngs: ArrayBuffer[] (same order),
//       rolePaths: Float32Array[]|null, nx, ny, matrix, scale, width, height }
// Out: one { index, slice, ranges, roles } per layer (transferred), then { done, timings }
self.onmessage = async (event) => {
  const { indices, pngs, rolePaths, nx, ny, matrix, scale, width, height, batch } = event.data
  if (batch > 0) BATCH = batch
  try {
    const t = { decode: 0, draw: 0, read: 0, roles: 0, fill: 0 }
    let mark = 0
    const canvas = new OffscreenCanvas(nx, ny * BATCH)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    // The role canvas turns the sidecar's mm segments into a role grid: pad filled blue, support red on top
    //  (a support foot standing ON the pad reads as support, matching the sliced preview's priorities).
    const roleCanvas = rolePaths ? new OffscreenCanvas(nx, ny * BATCH) : null
    const roleCtx = roleCanvas?.getContext('2d', { willReadFrequently: true })
    const decodeBatch = (start) => {
      const jobs = []
      for (let k = 0; k < BATCH && start + k < pngs.length; k++) {
        const j = start + k
        jobs.push(createImageBitmap(new Blob([pngs[j]], { type: 'image/png' })).then(bmp => { pngs[j] = null; return bmp }))
      }
      return jobs
    }
    let inFlight = decodeBatch(0)
    for (let base = 0; base < pngs.length; base += BATCH) {
      mark = performance.now()
      const bitmaps = await Promise.all(inFlight)
      t.decode += performance.now() - mark
      inFlight = decodeBatch(base + BATCH)              // next batch decodes while this one is read out
      mark = performance.now()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, nx, ny * BATCH)
      for (let k = 0; k < bitmaps.length; k++) {
        ctx.setTransform(matrix[0] * scale, matrix[1] * scale, matrix[2] * scale, matrix[3] * scale,
          matrix[4] * scale, matrix[5] * scale + k * ny)
        ctx.drawImage(bitmaps[k], 0, 0)
        bitmaps[k].close?.()
      }
      t.draw += performance.now() - mark; mark = performance.now()
      const rgba = ctx.getImageData(0, 0, nx, ny * bitmaps.length).data
      t.read += performance.now() - mark; mark = performance.now()
      let roleGrid = null
      // Skip the whole role pass for a batch whose layers carry no support/pad segments — above the supports
      //  that is most of an archive, and the pass costs a full-canvas fill plus a second readback.
      const batchHasRoles = roleCtx && rolePaths.slice(base, base + bitmaps.length).some(a => a && a.length)
      if (batchHasRoles) {
        roleCtx.setTransform(1, 0, 0, 1, 0, 0)
        roleCtx.clearRect(0, 0, nx, ny * BATCH)
        for (let k = 0; k < bitmaps.length; k++) {
          const paths = rolePaths[base + k] ?? new Float32Array(0)
          const rowOff = k * ny
          const map = { map: (x, y) => [(x + width / 2) / width * nx, (height / 2 - y) / height * ny + rowOff] }
          roleCtx.fillStyle = '#00f'
          drawLayer(roleCtx, filterByRole(paths, ROLE.RAFT), map)
          roleCtx.fillStyle = '#f00'
          drawLayer(roleCtx, filterByRole(paths, ROLE.SUPPORT), map)
        }
        roleGrid = roleCtx.getImageData(0, 0, nx, ny * bitmaps.length).data
        t.roles += performance.now() - mark; mark = performance.now()
      }
      mark = performance.now()
      for (let k = 0; k < bitmaps.length; k++) {
        const slice = new Uint8Array(nx * ny)
        const ranges = fillSliceFromRGBA(slice, rgba.subarray(k * nx * ny * 4, (k + 1) * nx * ny * 4), nx, ny, 0)
        let roles = null
        if (roleGrid) {
          roles = new Uint8Array(nx * ny)
          const gridOff = k * nx * ny * 4
          for (let r = 0; r < ny; r++) {                 // same row flip as fillSliceFromRGBA
            const rowOff = gridOff + r * nx * 4, outOff = nx * (ny - 1 - r)
            for (let c = 0; c < nx; c++) {
              const at = rowOff + c * 4
              roles[outOff + c] = roleGrid[at] > 127 ? 5 : roleGrid[at + 2] > 127 ? 6 : 0
            }
          }
        }
        const transfer = [slice.buffer, ranges.buffer]
        if (roles) transfer.push(roles.buffer)
        self.postMessage({ index: indices[base + k], slice, ranges, roles }, transfer)
      }
      t.fill += performance.now() - mark
    }
    self.postMessage({ done: true, timings: t })
  } catch (e) {
    self.postMessage({ error: String(e?.message || e) })
  }
}
