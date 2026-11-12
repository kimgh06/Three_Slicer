// The tree support's branches as centre lines, routed by lookups in a field instead of by propagating polygons.
//  Upstream (TreeSupport3D.cpp create_layer_pathing) carries, for every branch and layer, the AREA the branch may stand
//  in, and pays a polygon offset, difference and union for each. Here a branch is a point with a radius: it steps down
//  one layer at a time to a place where the field says that radius may stand, heading for its nearest neighbour, and two
//  branches that meet become one. The field (support_gpu.js) holds, per layer and pixel, the largest radius that clears
//  the model by the xy distance there and can still get down to the bed, so a branch that follows it never lands on
//  the model.
// The result is not upstream's support: same tips, other branches. No polygon is built here; the branches are drawn by
//  support_gpu.js from the segments this returns.
// A branch moves between the centres of the field's pixels, to the pixels the field itself looked at when it decided
//  that a radius can get down from here (`grid.movePixels`): a step the field promised is then a step the route can
//  take. Sampling a circle of the move distance instead missed the neighbour pixel whenever a pixel was wider than
//  the move, and 25 branches of one plate ended in mid air.
// A branch with nowhere valid to go (a tip the kernel placed closer to the model than its radius, mostly) heads for
//  the most room instead, and ends only where the field is zero all around: on the model, the z distance above it,
//  since the field's collision covers the layers within the z distances.
// Pure: no GPU, no DOM. The field is whatever `reachAt` reads.

/** Floats per drawn cross-section: centre x, y, direction x, y, radius, stretch along the direction, half run, unused. */
export const SECTION_FLOATS = 8
// A cross-section is the tilted branch cut by the layer plane: an ellipse stretched along the tilt by 1 / cos. A step
//  that joins a branch far to the side is a capsule over its run instead, so the stretch is held to this.
const MAX_STRETCH = 2
const NEIGHBOUR_CELL_MM = 30
// two branches whose centres are this fraction of the thicker one's radius apart are one branch already
const MERGE_INSIDE_FRACTION = 0.5

/** Upstream's TreeSupportSettings::getRadius for a branch `height` layers below its tip. */
export function branchRadius(settings, height) {
  if (height <= settings.tipLayers) return settings.minRadius + (settings.branchRadius - settings.minRadius) * height / settings.tipLayers
  return settings.branchRadius + (height - settings.tipLayers) * settings.radiusIncreasePerLayer
}

/**
 * @param {object} job
 * @param {Float32Array} job.tips      x, y, layer, radius per tip (the kernel's, support_phase.h)
 * @param {number} job.layerCount      layers the field covers
 * @param {object} job.settings        layerHeight, maxMove, minRadius, branchRadius, radiusIncreasePerLayer, tipLayers
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} job.bed
 * @param {{originX: number, originY: number, pixel: number, movePixels: number, layersPerStep?: number}} job.grid
 *   the field's pixels; one field layer stands for `layersPerStep` object layers (1 when absent), and a branch
 *   changes pixel only where it passes from one field layer to the next
 * @param {(fieldLayer: number, x: number, y: number) => number} job.reachAt  the largest radius that may stand there
 * @returns {{ sections: Float32Array, layerStart: Uint32Array, stats: object }} the cross-sections grouped by layer
 */
export function routeBranches({ tips, layerCount, settings, bed, grid, reachAt }) {
  const tipsByLayer = new Map()
  let tipCount = 0
  for (let at = 0; at + 3 < tips.length; at += 4) {
    const layer = Math.round(tips[at + 2])
    if (layer < 0 || layer >= layerCount) continue
    if (!tipsByLayer.has(layer)) tipsByLayer.set(layer, [])
    tipsByLayer.get(layer).push({ x: tips[at], y: tips[at + 1], height: 0, radius: tips[at + 3] })
    tipCount++
  }
  const perLayer = Array.from({ length: layerCount }, () => [])
  const addSection = (layer, fromX, fromY, toX, toY, radius) => {
    const dx = toX - fromX, dy = toY - fromY, run = Math.hypot(dx, dy)
    let directionX = 1, directionY = 0
    if (run > 1e-9) { directionX = dx / run; directionY = dy / run }
    const stretch = Math.min(MAX_STRETCH, Math.hypot(run, settings.layerHeight) / settings.layerHeight)
    perLayer[layer].push((fromX + toX) / 2, (fromY + toY) / 2, directionX, directionY, radius, stretch, run / 2, 0)
  }
  const onBed = (x, y, radius) => x - radius >= bed.minX && x + radius <= bed.maxX && y - radius >= bed.minY && y + radius <= bed.maxY

  const stats = { tips: tipCount, steps: 0, merges: 0, roots: 0, onModel: 0, withoutGrowth: 0, withoutRoom: 0 }
  // the pixels a branch may step to in one layer, as offsets from its own pixel (its own first)
  const offsets = [0, 0]
  for (let dy = -grid.movePixels; dy <= grid.movePixels; dy++) for (let dx = -grid.movePixels; dx <= grid.movePixels; dx++) {
    if ((dx !== 0 || dy !== 0) && dx * dx + dy * dy <= grid.movePixels * grid.movePixels) offsets.push(dx, dy)
  }
  const layersPerStep = grid.layersPerStep ?? 1
  const centreOf = (value, origin) => origin + (Math.floor((value - origin) / grid.pixel) + 0.5) * grid.pixel
  const mergeDistance = Math.max(settings.maxMove, grid.movePixels * grid.pixel)
  let active = []
  for (let layer = layerCount - 1; layer >= 0; layer--) {
    for (const tip of tipsByLayer.get(layer) ?? []) active.push(tip)
    if (layer === 0) break
    const fieldBelow = Math.floor((layer - 1) / layersPerStep)
    const buckets = new Map()
    active.forEach((node, index) => {
      const key = Math.floor(node.x / NEIGHBOUR_CELL_MM) * 65536 + Math.floor(node.y / NEIGHBOUR_CELL_MM)
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(index)
    })
    const moved = []
    for (let index = 0; index < active.length; index++) {
      const node = active[index]
      stats.steps++
      // the nearest other branch is where this one heads
      let targetX = node.x, targetY = node.y, nearest = Infinity
      const cellX = Math.floor(node.x / NEIGHBOUR_CELL_MM), cellY = Math.floor(node.y / NEIGHBOUR_CELL_MM)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const other of buckets.get((cellX + dx) * 65536 + cellY + dy) ?? []) {
        if (other === index) continue
        const distance = Math.hypot(active[other].x - node.x, active[other].y - node.y)
        if (distance < nearest) { nearest = distance; targetX = active[other].x; targetY = active[other].y }
      }
      // the thicker radius the branch would have a layer down, where it fits; its own radius where only that does;
      //  the most room where neither does
      const grown = branchRadius(settings, node.height + 1)
      const centreX = centreOf(node.x, grid.originX), centreY = centreOf(node.y, grid.originY)
      let best = -1, bestScore = Infinity, bestKeeping = -1, bestKeepingScore = Infinity, roomiest = -1, mostRoom = 0
      // within one field layer the branch keeps its pixel
      let candidates = 1
      if (fieldBelow !== Math.floor(layer / layersPerStep)) candidates = offsets.length / 2
      for (let candidate = 0; candidate < candidates; candidate++) {
        const x = centreX + offsets[candidate * 2] * grid.pixel, y = centreY + offsets[candidate * 2 + 1] * grid.pixel
        const reachOf = reachAt(fieldBelow, x, y)
        if (!onBed(x, y, node.radius)) continue
        if (reachOf > mostRoom) { mostRoom = reachOf; roomiest = candidate }
        if (reachOf < node.radius) continue
        const score = Math.hypot(x - targetX, y - targetY)
        if (score < bestKeepingScore) { bestKeepingScore = score; bestKeeping = candidate }
        if (reachOf >= grown && onBed(x, y, grown) && score < bestScore) { bestScore = score; best = candidate }
      }
      let radius = grown, height = node.height + 1
      if (best < 0) {
        radius = node.radius; height = node.height
        best = bestKeeping
        if (best >= 0) stats.withoutGrowth++
        else {
          // the model is under it all around: the branch stands on the model
          if (roomiest < 0) { stats.onModel++; addSection(layer, node.x, node.y, node.x, node.y, node.radius); continue }
          best = roomiest; stats.withoutRoom++
        }
      }
      const x = centreX + offsets[best * 2] * grid.pixel, y = centreY + offsets[best * 2 + 1] * grid.pixel
      addSection(layer, x, y, node.x, node.y, (node.radius + radius) / 2)
      node.x = x; node.y = y; node.radius = radius; node.height = height
      moved.push(node)
    }
    // merge: the thinner branch ends on the thicker one
    moved.sort((a, b) => b.radius - a.radius)
    const kept = [], keptBuckets = new Map()
    let mergeCell = mergeDistance
    if (moved.length) mergeCell = Math.max(mergeDistance, moved[0].radius * MERGE_INSIDE_FRACTION)
    for (const node of moved) {
      const cellX = Math.floor(node.x / mergeCell), cellY = Math.floor(node.y / mergeCell)
      let into = null
      for (let dx = -1; dx <= 1 && !into; dx++) for (let dy = -1; dy <= 1 && !into; dy++) for (const other of keptBuckets.get((cellX + dx) * 65536 + cellY + dy) ?? []) {
        if (Math.hypot(other.x - node.x, other.y - node.y) <= Math.max(mergeDistance, other.radius * MERGE_INSIDE_FRACTION)) { into = other; break }
      }
      if (into) {
        stats.merges++
        into.height = Math.max(into.height, node.height)
        continue
      }
      kept.push(node)
      const key = cellX * 65536 + cellY
      if (!keptBuckets.has(key)) keptBuckets.set(key, [])
      keptBuckets.get(key).push(node)
    }
    active = kept
  }
  // what reaches the first layer stands on the bed
  for (const node of active) { stats.roots++; addSection(0, node.x, node.y, node.x, node.y, node.radius) }

  const layerStart = new Uint32Array(layerCount + 1)
  for (let layer = 0; layer < layerCount; layer++) layerStart[layer + 1] = layerStart[layer] + perLayer[layer].length / SECTION_FLOATS
  const sections = new Float32Array(layerStart[layerCount] * SECTION_FLOATS)
  perLayer.forEach((list, layer) => sections.set(list, layerStart[layer] * SECTION_FLOATS))
  return { sections, layerStart, stats }
}
