// SL1 surface-reconstruction worker, back half: occupancy slices -> streaming surface nets -> indexed mesh
// with smooth normals and (when the archive carried our role sidecar) per-vertex support/pad colours.
//
// Slices arrive IN ORDER from the coordinator, which fans their production out across N sla_slice workers.
// The sweep here cannot be split the same way — its vertex ring spans consecutive layers, so it stays one
// sequential consumer and instead overlaps with the producers. It is also why this half is off the main
// thread at all: a billion-iteration sweep there is a frozen tab. Working memory is O(nx*ny) regardless of
// layer count (three-slice window, two-layer vertex ring), which is what lets z run at the archive's own
// layer height. Lives at the root of src/ as a vite lib entry, like parse_3mf.worker.js (see make_worker.js
// for why that matters to consumer bundlers).
//
// Measured shape of the work (Benchy, 1095 layers): the slice half is decode 853 / drawImage 896 /
// getImageData 1170 / roles 359 ms, this half is nets 1419 / smooth+normals 589 ms.
import { makeStreamingNets } from './core/sla_reconstruct.js'

let nets = null
let timings = { nets: 0, finish: 0 }

self.onmessage = (event) => {
  const d = event.data
  try {
    if (d.init) {
      nets = makeStreamingNets(d.nx, d.ny, d.sx, d.sy, d.sz, d.ox, d.oy, d.oz)
      timings = { nets: 0, finish: 0 }
      return
    }
    if (d.slice) {
      const mark = performance.now()
      nets.pushSlice(d.slice, d.roles, d.ranges)
      timings.nets += performance.now() - mark
      return
    }
    if (d.finish) {
      const mark = performance.now()
      const { positions, indices, normals, colors } = nets.finish({ smoothRounds: d.smoothRounds ?? 2, normalRounds: d.normalRounds ?? 0 })
      timings.finish = performance.now() - mark
      nets = null
      const transfer = [positions.buffer, indices.buffer, normals.buffer]
      if (colors) transfer.push(colors.buffer)
      self.postMessage({ positions, indices, normals, colors, timings, producerTimings: d.producerTimings, spin: d.spin }, transfer)
    }
  } catch (e) {
    self.postMessage({ error: String(e?.message || e) })
  }
}
