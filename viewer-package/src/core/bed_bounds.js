// Does what stands on the plate fit inside the printable volume?
// The kernel asks the same question in pass1.cpp (prepare_model) and reports it as stats.over_bed — but only once a
// slice has finished. This answers it while the model is still being dragged, which is when it can still be acted on.
// Coordinates follow the kernel's: bed-local and centred on the origin, so the bed spans [-w/2,w/2] x [-d/2,d/2].
// A bed that is not a rectangle (a delta's circle, plate frame `shape`) is checked against its outline with the
//  footprint's convex hull, as upstream's BuildVolume does. ponytail: the kernel's own over-bed report
//  (pass1.cpp, gcode_writer.h extrusion_bed_overflow) still uses the bounding rectangle — it sees the box, so a
//  corner of a delta bed's box passes there; this check is the one that catches it, before the slice.

const past = (low, high, half) => Math.max(0, -half - low, high - half)

/**
 * @param box    modelBounds() output — world coordinates, or null when the plate is empty.
 * @param origin platePos() of the plate the box sits on ({x, z} in world coordinates).
 * @param bedHeight printable_height in mm; 0 means the profile states no ceiling (the kernel skips it too).
 * @returns null when everything fits, else how far past the printable volume it reaches, in mm per axis.
 */
//  `shape` (plate frame) and `footprint` (the convex hull of what stands on the plate, world [x, y] points as
//  modelBounds reports them) switch the X/Y test to the outline; the result then names the distance past the edge.
export function bedOverflow(box, origin, bedWidth, bedDepth, bedHeight, { shape = null, footprint = null } = {}) {
  if (!box) return null
  let z = 0
  if (bedHeight > 0) z = Math.max(0, box.height - bedHeight)
  if (shape && footprint) {
    // Bed-local is world minus the plate origin in x and world PLUS origin.z in y (see below).
    const edge = footprintOverflow(footprint.map(([x, y]) => [x - origin.x, y + origin.z]), shape)
    if (edge || z) return { x: 0, y: 0, z, edge }
    return null
  }
  // Bed-local x is world x minus the plate origin; bed-local y is world y PLUS origin.z, because modelBounds
  //  already negated three's z on the way out (the same conversion the prime-tower placement makes).
  const x = past(box.minX - origin.x, box.maxX - origin.x, bedWidth / 2)
  const y = past(box.minY + origin.z, box.maxY + origin.z, bedDepth / 2)
  if (x || y || z) return { x, y, z }
  return null
}

// How far the furthest footprint point lies outside the bed outline, in mm (0 when every point is inside).
//  Both in bed-local coordinates. Point-in-polygon by crossings, distance to the nearest edge for a point outside.
export function footprintOverflow(points, shape) {
  let worst = 0
  for (const point of points) {
    if (insidePolygon(point, shape)) continue
    worst = Math.max(worst, distanceToOutline(point, shape))
  }
  return worst
}

function insidePolygon([x, y], shape) {
  let inside = false
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const [xi, yi] = shape[i], [xj, yj] = shape[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function distanceToOutline([x, y], shape) {
  let best = Infinity
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const [ax, ay] = shape[j], [bx, by] = shape[i]
    const dx = bx - ax, dy = by - ay
    const along = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(x - (ax + along * dx), y - (ay + along * dy)))
  }
  return best
}

/** A w x d printable_area rectangle keeping the existing area's origin corner (the printer-card bed inputs). */
export function bedRectangle(area, w, d) {
  let x0 = 0, y0 = 0
  if (Array.isArray(area) && area.length >= 3) { x0 = Math.min(...area.map(p => p[0])); y0 = Math.min(...area.map(p => p[1])) }
  return [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d], [x0, y0 + d]]
}

/** The overflow as one line, naming only the axes that actually overflow. */
export function overflowText(overflow) {
  if (!overflow) return ''
  const parts = []
  if (overflow.x) parts.push(`X ${overflow.x.toFixed(1)}mm`)
  if (overflow.y) parts.push(`Y ${overflow.y.toFixed(1)}mm`)
  if (overflow.edge) parts.push(`bed edge ${overflow.edge.toFixed(1)}mm`)
  if (overflow.z) parts.push(`height ${overflow.z.toFixed(1)}mm`)
  return parts.join(' · ')
}
