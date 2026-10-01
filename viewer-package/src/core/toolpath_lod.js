// Level of detail for the toolpath: far away, draw every k-th layer k layers thick.
//
// A frame's GPU time follows the number of bead triangles, and from a distance one layer is far less than a pixel
//  tall, so most of those triangles land inside pixels a neighbour already covers. Measured on haaland.3mf (6 plates,
//  14.6M segments, M5 Pro, DPR 2, headless): the overview has 0.19 px per layer and drew in 27.8 ms; k=2 14.3 ms,
//  k=4 9.5 ms, with 0.1-0.4% of pixels visibly different. A coarse level is used only while k layers still fit in
//  LOD_MAX_LAYER_PX: groups 1.3 px tall (k=2 at 0.65 px/layer) changed 0.12% of pixels, groups 2.6 px tall (k=4)
//  showed the infill through the gaps between the kept layers' walls on curved surfaces.
//
// Two things are never thinned. The base layers (raft, skirt/brim, the first layer) are one or two layers of
//  something that exists nowhere else, so dropping them erased the brim ring and the raft under supports in the
//  measurement; they stay at full detail. And a cut layer range, which the caller handles by asking for level 1:
//  the top of a group is the layer that is kept, so a cut inside a group would show the cut k-1 layers low.
import { ROLE } from './toolpath_encoding.js'

export const LOD_LEVELS = [2, 4]
export const LOD_MAX_LAYER_PX = 1.5

/** The highest layer that holds raft or skirt/brim, and at least the first layer. `vType` and `vLayer` are
 *  per-vertex (two per segment), as buildSegmentData lays them out. */
export function baseLayerTop(vType, vLayer) {
  let top = 0
  for (let i = 0; i < vType.length; i += 2)
    if ((vType[i] === ROLE.RAFT || vType[i] === ROLE.SKIRT) && vLayer[i] > top) top = vLayer[i]
  return top
}

/**
 * Which segments a level keeps, and how many layers each one stands for.
 *
 * Above the base, layers are grouped k at a time counting DOWN from the top layer, so the topmost layer is always
 *  kept and the print keeps its height; each group is drawn by its top layer. The lowest group stops at the base
 *  rather than reaching into it. Base layers are kept as they are (one layer each).
 *
 * -> { source: Uint32Array (segment indices, in order), layers: Uint8Array }
 */
export function decimateLayers(layerOf, segmentCount, k, baseTop) {
  let top = 0
  for (let s = 0; s < segmentCount; s++) if (layerOf(s) > top) top = layerOf(s)
  const keeps = (layer) => layer <= baseTop || (top - layer) % k === 0
  let kept = 0
  for (let s = 0; s < segmentCount; s++) if (keeps(layerOf(s))) kept++
  const source = new Uint32Array(kept), layers = new Uint8Array(kept)
  let j = 0
  for (let s = 0; s < segmentCount; s++) {
    const layer = layerOf(s)
    if (!keeps(layer)) continue
    source[j] = s
    layers[j] = 1
    if (layer > baseTop) layers[j] = Math.min(k, layer - baseTop)
    j++
  }
  return { source, layers }
}

/** The median bead height, sampled — the layer height the projection is judged by. */
export function typicalLayerHeight(heightOf, segmentCount) {
  const step = Math.max(1, Math.floor(segmentCount / 4096))
  const samples = []
  for (let s = 0; s < segmentCount; s += step) samples.push(heightOf(s))
  if (!samples.length) return 0
  samples.sort((a, b) => a - b)
  return samples[samples.length >> 1]
}

/** On-screen height in pixels of `size` (mm) at `distance` (mm), for a perspective camera. */
export function projectedPixels(size, distance, fovDegrees, viewportPixels) {
  if (!(distance > 0)) return Infinity
  return size * (viewportPixels / 2) / (distance * Math.tan(fovDegrees * Math.PI / 360))
}

/** The coarsest level whose k layers still fit in LOD_MAX_LAYER_PX; 1 when none does. */
export function chooseLevel(layerPixels, levels = LOD_LEVELS) {
  let chosen = 1
  for (const k of levels) if (k * layerPixels <= LOD_MAX_LAYER_PX && k > chosen) chosen = k
  return chosen
}
