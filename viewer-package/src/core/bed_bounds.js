// Does what stands on the plate fit inside the printable volume?
// The kernel asks the same question in pass1.cpp (prepare_model) and reports it as stats.over_bed — but only once a
// slice has finished. This answers it while the model is still being dragged, which is when it can still be acted on.
// Coordinates follow the kernel's: bed-local and centred on the origin, so the bed spans [-w/2,w/2] x [-d/2,d/2].
// ponytail: the bed is treated as its bounding rectangle, exactly as the kernel does — a circular or custom
//  printable_area is not reduced to a polygon here, because the polygon never reaches the kernel either
//  (deriveKernelParams collapses it to bed_width/bed_depth). Revisit both together, not this one alone.

const past = (low, high, half) => Math.max(0, -half - low, high - half)

/**
 * @param box    modelBounds() output — world coordinates, or null when the plate is empty.
 * @param origin platePos() of the plate the box sits on ({x, z} in world coordinates).
 * @param bedHeight printable_height in mm; 0 means the profile states no ceiling (the kernel skips it too).
 * @returns null when everything fits, else how far past the printable volume it reaches, in mm per axis.
 */
export function bedOverflow(box, origin, bedWidth, bedDepth, bedHeight) {
  if (!box) return null
  // Bed-local x is world x minus the plate origin; bed-local y is world y PLUS origin.z, because modelBounds
  //  already negated three's z on the way out (the same conversion the prime-tower placement makes).
  const x = past(box.minX - origin.x, box.maxX - origin.x, bedWidth / 2)
  const y = past(box.minY + origin.z, box.maxY + origin.z, bedDepth / 2)
  const z = bedHeight > 0 ? Math.max(0, box.height - bedHeight) : 0
  return (x || y || z) ? { x, y, z } : null
}

/** A w x d printable_area rectangle keeping the existing area's origin corner (the printer-card bed inputs). */
export function bedRectangle(area, w, d) {
  const ok = Array.isArray(area) && area.length >= 3
  const x0 = ok ? Math.min(...area.map(p => p[0])) : 0, y0 = ok ? Math.min(...area.map(p => p[1])) : 0
  return [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d], [x0, y0 + d]]
}

/** The overflow as one line, naming only the axes that actually overflow. */
export function overflowText(overflow) {
  if (!overflow) return ''
  const parts = []
  if (overflow.x) parts.push(`X ${overflow.x.toFixed(1)}mm`)
  if (overflow.y) parts.push(`Y ${overflow.y.toFixed(1)}mm`)
  if (overflow.z) parts.push(`height ${overflow.z.toFixed(1)}mm`)
  return parts.join(' · ')
}
