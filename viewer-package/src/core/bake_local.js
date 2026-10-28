// Model -> three-local geometry: the axis swap and seating every loaded mesh goes through, plus the bounding box and
//  sphere the scene mesh needs. Pure, so the 3mf parse worker can run it before the result reaches the main thread:
//  on haaland.3mf (17 objects, 3.79M facets) the main thread spent 46 ms in this transform and 37 ms in
//  computeBoundingBox, in one long task right after the parse. The mesh carries no normal attribute: its material is
//  flat shaded, and three.js then takes the face normal from screen-space derivatives in the fragment shader, which
//  for a triangle soup is the per-face normal an attribute would hold. The attribute was 136MB of GPU upload on that
//  model (one float3 per vertex, three times per face) and 157 ms of computeVertexNormals before it moved here.

/** model (z up) -> three-local (R = RotX(-90deg)), centred in XZ, minY = 0. */
export function bakeLocal(modelPos) {
  const n = modelPos.length, p = new Float32Array(n)
  for (let i = 0; i < n; i += 3) { p[i] = modelPos[i]; p[i + 1] = modelPos[i + 2]; p[i + 2] = -modelPos[i + 1] }
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (let i = 0; i < n; i += 3) { minx = Math.min(minx, p[i]); maxx = Math.max(maxx, p[i]); miny = Math.min(miny, p[i + 1]); maxy = Math.max(maxy, p[i + 1]); minz = Math.min(minz, p[i + 2]); maxz = Math.max(maxz, p[i + 2]) }
  const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2
  for (let i = 0; i < n; i += 3) { p[i] -= cx; p[i + 1] -= miny; p[i + 2] -= cz }
  return { localPos: p, size: { w: maxx - minx, d: maxz - minz, h: maxy - miny } }
}

/** Min/max of a position stream, as three.js computeBoundingBox reads it. -> { min: [x,y,z], max: [x,y,z] } */
export function positionBounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const v = positions[i + axis]
      if (v < min[axis]) min[axis] = v
      if (v > max[axis]) max[axis] = v
    }
  }
  return { min, max }
}

/**
 * The bounding sphere three.js computeBoundingSphere makes on the first render (it culls with it): the box centre,
 *  then the largest squared distance to it, in that order. 60ms of the first frame after a haaland.3mf load.
 *  -> { center: [x,y,z], radius }
 */
export function positionSphere(positions, bounds) {
  const center = [0, 0, 0]
  const empty = bounds.max[0] < bounds.min[0] || bounds.max[1] < bounds.min[1] || bounds.max[2] < bounds.min[2]
  if (!empty) for (let axis = 0; axis < 3; axis++) center[axis] = (bounds.min[axis] + bounds.max[axis]) * 0.5
  let maxRadiusSq = 0
  for (let i = 0; i < positions.length; i += 3) {
    const dx = center[0] - positions[i], dy = center[1] - positions[i + 1], dz = center[2] - positions[i + 2]
    maxRadiusSq = Math.max(maxRadiusSq, dx * dx + dy * dy + dz * dz)
  }
  return { center, radius: Math.sqrt(maxRadiusSq) }
}

/** Everything the scene builds a loaded mesh from, in one pass a worker can make. */
export function bakeModel(modelPos) {
  const { localPos, size } = bakeLocal(modelPos)
  const bounds = positionBounds(localPos)
  return { localPos, size, bounds, sphere: positionSphere(localPos, bounds) }
}
