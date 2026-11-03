// Auto orient: picks which way a mesh should face the bed. Independently authored (packages/PROVENANCE.md).
// The candidates are the directions holding the most surface area plus the six axes; each is costed by the downward
//  surface that would need support, offset by the flat area that would sit on the bed, with height as a tie-break.
const MAX_SAMPLED_FACES = 200000
const CANDIDATES = 24
const BED_ROUNDING = 1e-3     // normals this close count as one direction
const ON_BED_MM = 0.2         // a downward face this far above the lowest point rests on the bed
const FACES_BED = 0.995       // a face this aligned with the direction lies flat on the bed
const CONTACT_WEIGHT = 0.5    // measured on the fixtures: flat contact matters, but less than avoiding support
const HEIGHT_WEIGHT = 0.02    // a tie-break between orientations that need the same support
const KEEP_MARGIN = 0.01      // a gain under 1% of the surface is not worth moving the object for

function facesOf(positions) {
  const count = positions.length / 9
  const stride = Math.max(1, Math.ceil(count / MAX_SAMPLED_FACES))
  const faces = []
  for (let face = 0; face < count; face += stride) {
    const at = face * 9
    const a = [positions[at], positions[at + 1], positions[at + 2]]
    const u = [positions[at + 3] - a[0], positions[at + 4] - a[1], positions[at + 5] - a[2]]
    const v = [positions[at + 6] - a[0], positions[at + 7] - a[1], positions[at + 8] - a[2]]
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const length = Math.hypot(...cross)
    if (length === 0) continue
    faces.push({
      normal: cross.map(value => value / length), area: length / 2 * stride,
      corners: [a, [positions[at + 3], positions[at + 4], positions[at + 5]], [positions[at + 6], positions[at + 7], positions[at + 8]]],
    })
  }
  return faces
}

function candidateDirections(faces) {
  const byDirection = new Map()
  for (const face of faces) {
    const key = face.normal.map(value => Math.round(value / BED_ROUNDING)).join()
    const held = byDirection.get(key)
    if (held) held.area += face.area
    else byDirection.set(key, { direction: face.normal, area: face.area })
  }
  const largest = [...byDirection.values()].sort((a, b) => b.area - a.area).slice(0, CANDIDATES).map(entry => entry.direction)
  return [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], ...largest]
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function costOf(faces, direction, overhangCos, totalArea) {
  let lowest = Infinity, highest = -Infinity
  for (const face of faces) {
    for (const corner of face.corners) {
      const depth = dot(corner, direction)     // larger means nearer the bed
      if (-depth < lowest) lowest = -depth
      if (-depth > highest) highest = -depth
    }
  }
  let overhang = 0, contact = 0
  for (const face of faces) {
    const facing = dot(face.normal, direction)
    if (facing <= overhangCos) continue
    const height = Math.min(...face.corners.map(corner => -dot(corner, direction))) - lowest
    if (height < ON_BED_MM) { if (facing > FACES_BED) contact += face.area }
    else overhang += face.area * facing
  }
  return overhang - CONTACT_WEIGHT * contact + HEIGHT_WEIGHT * (highest - lowest) * Math.sqrt(totalArea)
}

/**
 * @param positions model-frame triangle soup, nine floats per face
 * @param overhangAngle degrees from vertical past which a surface needs support
 * @returns the unit direction, in the model frame, to turn towards the bed, or null when the current pose is as good
 */
export function bestOrientation(positions, overhangAngle = 45) {
  const faces = facesOf(positions)
  if (!faces.length) return null
  const totalArea = faces.reduce((sum, face) => sum + face.area, 0)
  const overhangCos = Math.cos((90 - overhangAngle) * Math.PI / 180)
  const current = costOf(faces, [0, 0, -1], overhangCos, totalArea)
  let best = null, bestCost = current
  for (const direction of candidateDirections(faces)) {
    const cost = costOf(faces, direction, overhangCos, totalArea)
    if (cost < bestCost) { best = direction; bestCost = cost }
  }
  if (current - bestCost < KEEP_MARGIN * totalArea) return null
  return best
}
