// Snapping a measured point to the model's corners and edges. `segments` is a flat [ax, ay, az, bx, by, bz, ...] list of
//  the feature edges, bucketed in a grid so a pointer move looks at the edges near it and not at all of them.
export const SNAP_RADIUS_PX = 10
const CORNER_SHARE = 1.5          // a corner wins over the edge it ends within this much more reach

const cellOf = (value, cell) => Math.floor(value / cell)
const keyOf = (x, y, z) => `${x},${y},${z}`

export function edgeGrid(segments, cell) {
  const cells = new Map()
  for (let at = 0; at < segments.length; at += 6) {
    const low = [0, 1, 2].map(axis => cellOf(Math.min(segments[at + axis], segments[at + 3 + axis]), cell))
    const high = [0, 1, 2].map(axis => cellOf(Math.max(segments[at + axis], segments[at + 3 + axis]), cell))
    for (let x = low[0]; x <= high[0]; x++) for (let y = low[1]; y <= high[1]; y++) for (let z = low[2]; z <= high[2]; z++) {
      const key = keyOf(x, y, z)
      if (!cells.has(key)) cells.set(key, [])
      cells.get(key).push(at)
    }
  }
  return { cells, cell, segments }
}

function nearby({ cells, cell }, point, radius) {
  const found = new Set()
  const low = point.map(value => cellOf(value - radius, cell)), high = point.map(value => cellOf(value + radius, cell))
  for (let x = low[0]; x <= high[0]; x++) for (let y = low[1]; y <= high[1]; y++) for (let z = low[2]; z <= high[2]; z++) {
    for (const at of cells.get(keyOf(x, y, z)) ?? []) found.add(at)
  }
  return found
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// The nearest corner within reach, else the nearest point on an edge within reach, else the point itself.
export function snapPoint(grid, point, radius) {
  const { segments } = grid
  let corner = null, cornerDistance = radius * CORNER_SHARE
  let edge = null, edgeDistance = radius
  for (const at of nearby(grid, point, radius * CORNER_SHARE)) {
    const a = [segments[at], segments[at + 1], segments[at + 2]], b = [segments[at + 3], segments[at + 4], segments[at + 5]]
    for (const end of [a, b]) {
      const away = distance(end, point)
      if (away < cornerDistance) { cornerDistance = away; corner = end }
    }
    const span = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const lengthSquared = span[0] ** 2 + span[1] ** 2 + span[2] ** 2
    if (lengthSquared === 0) continue
    const along = Math.min(1, Math.max(0, ((point[0] - a[0]) * span[0] + (point[1] - a[1]) * span[1] + (point[2] - a[2]) * span[2]) / lengthSquared))
    const onEdge = [a[0] + span[0] * along, a[1] + span[1] * along, a[2] + span[2] * along]
    const away = distance(onEdge, point)
    if (away < edgeDistance) { edgeDistance = away; edge = onEdge }
  }
  if (corner) return { point: corner, kind: 'corner' }
  if (edge) return { point: edge, kind: 'edge' }
  return { point, kind: null }
}
