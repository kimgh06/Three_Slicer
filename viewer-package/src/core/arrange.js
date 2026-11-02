// Auto arrange: places object footprints on a rectangular bed, each as close to the centre as it fits, largest first.
// Independently authored (packages/PROVENANCE.md). Each footprint is rasterised, over-covering, onto a grid
//  with the spacing added, so a placement the grid accepts cannot overlap.
// ponytail: no rotation and a 2 mm grid, so a tight nest wastes up to a cell per side. A no-fit-polygon nester is the
//  upgrade if a full plate of small parts needs it.
const CELL_MM = 2

function polygonArea(points) {
  let doubled = 0
  points.forEach(([x, y], index) => {
    const [nextX, nextY] = points[(index + 1) % points.length]
    doubled += x * nextY - nextX * y
  })
  return Math.abs(doubled) / 2
}

// The polygon's x range inside a horizontal band. Convex input, so one range per band.
function bandRange(points, low, high) {
  let min = Infinity, max = -Infinity
  const take = (x) => { min = Math.min(min, x); max = Math.max(max, x) }
  points.forEach(([x0, y0], index) => {
    const [x1, y1] = points[(index + 1) % points.length]
    if (y0 >= low && y0 <= high) take(x0)
    for (const edge of [low, high]) {
      if ((y0 - edge) * (y1 - edge) < 0) take(x0 + (x1 - x0) * (edge - y0) / (y1 - y0))
    }
  })
  return [min, max]
}

// The cells a footprint covers, relative to its own lower left corner, grown by `spacing` on every side.
function rasterise(hull, spacing) {
  const minX = Math.min(...hull.map(point => point[0])), minY = Math.min(...hull.map(point => point[1]))
  const maxX = Math.max(...hull.map(point => point[0])), maxY = Math.max(...hull.map(point => point[1]))
  const rows = Math.max(1, Math.ceil((maxY - minY) / CELL_MM))
  const grow = Math.ceil(spacing / CELL_MM)
  const spans = new Map()
  for (let row = 0; row < rows; row++) {
    const [low, high] = bandRange(hull, minY + row * CELL_MM, minY + (row + 1) * CELL_MM)
    if (low > high) continue
    const first = Math.floor((low - minX) / CELL_MM) - grow, last = Math.ceil((high - minX) / CELL_MM) + grow
    for (let reach = row - grow; reach <= row + grow; reach++) {
      const held = spans.get(reach)
      spans.set(reach, [Math.min(first, held?.[0] ?? first), Math.max(last, held?.[1] ?? last)])
    }
  }
  return { spans: [...spans], minX, minY, sizeX: maxX - minX, sizeY: maxY - minY }
}

/**
 * @param items [{ id, hull: [[x, y], ...] }], convex footprints relative to each object's own reference point
 * @returns {{ placed: [{ id, x, y }], unplaced: [id] }} x, y: where the reference point goes, from the bed centre
 */
export function arrangeOnBed(items, { width, depth, spacing = 3 }) {
  const cols = Math.floor(width / CELL_MM), rows = Math.floor(depth / CELL_MM)
  const filled = Array.from({ length: rows }, () => new Int32Array(cols + 1))   // per row, cells filled before each column
  const isFree = (spans, column, row) => spans.every(([rowOffset, [first, last]]) => {
    const at = row + rowOffset
    if (at < 0 || at >= rows) return true
    const from = Math.max(0, column + first), to = Math.min(cols, column + last)
    return to <= from || filled[at][to] === filled[at][from]
  })
  const mark = (spans, column, row) => {
    for (const [rowOffset, [first, last]] of spans) {
      const at = row + rowOffset
      if (at < 0 || at >= rows) continue
      const line = filled[at], cells = new Uint8Array(cols)
      for (let col = 0; col < cols; col++) cells[col] = line[col + 1] - line[col]
      cells.fill(1, Math.max(0, column + first), Math.max(0, Math.min(cols, column + last)))
      for (let col = 0; col < cols; col++) line[col + 1] = line[col] + cells[col]
    }
  }
  const placed = [], unplaced = []
  const largestFirst = [...items].sort((a, b) => polygonArea(b.hull) - polygonArea(a.hull))
  for (const item of largestFirst) {
    const shape = rasterise(item.hull, spacing)
    let best = null
    for (let row = 0; row * CELL_MM + shape.sizeY <= depth; row++) {
      for (let column = 0; column * CELL_MM + shape.sizeX <= width; column++) {
        const offX = column * CELL_MM + shape.sizeX / 2 - width / 2, offY = row * CELL_MM + shape.sizeY / 2 - depth / 2
        const cost = offX * offX + offY * offY
        if ((best === null || cost < best.cost) && isFree(shape.spans, column, row)) best = { cost, column, row }
      }
    }
    if (best === null) { unplaced.push(item.id); continue }
    mark(shape.spans, best.column, best.row)
    placed.push({
      id: item.id,
      x: best.column * CELL_MM - width / 2 - shape.minX,
      y: best.row * CELL_MM - depth / 2 - shape.minY,
    })
  }
  return { placed, unplaced }
}
