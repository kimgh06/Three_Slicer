// Model -> three-local geometry: the axis swap and seating every loaded mesh goes through, plus the flat normals and
//  bounding box the scene mesh needs. Pure, so the 3mf parse worker can run it before the result reaches the main
//  thread: on haaland.3mf (17 objects, 3.79M facets) the main thread spent 157 ms in computeVertexNormals, 46 ms in
//  this transform and 37 ms in computeBoundingBox, in one long task right after the parse.

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

/**
 * Per-vertex normals of a non-indexed triangle stream, bit-identical to three.js BufferGeometry.computeVertexNormals
 *  followed by its normalizeNormals: the cross product (C - B) x (A - B) is stored to float32 first, then read back
 *  and multiplied by the reciprocal of its length, with a zero vector left at zero. That order is what keeps the
 *  result identical (test_bake_local.mjs compares the two byte for byte).
 */
export function flatNormals(localPos) {
  const out = new Float32Array(localPos.length)
  const p = localPos
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2], bx = p[i + 3], by = p[i + 4], bz = p[i + 5]
    const cbx = p[i + 6] - bx, cby = p[i + 7] - by, cbz = p[i + 8] - bz
    const abx = ax - bx, aby = ay - by, abz = az - bz
    out[i] = cby * abz - cbz * aby; out[i + 1] = cbz * abx - cbx * abz; out[i + 2] = cbx * aby - cby * abx
    const x = out[i], y = out[i + 1], z = out[i + 2]
    const inverse = 1 / (Math.sqrt(x * x + y * y + z * z) || 1)   // Vector3.normalize multiplies by the reciprocal
    out[i] = x * inverse; out[i + 1] = y * inverse; out[i + 2] = z * inverse
    out[i + 3] = out[i + 6] = out[i]; out[i + 4] = out[i + 7] = out[i + 1]; out[i + 5] = out[i + 8] = out[i + 2]
  }
  return out
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

/** Everything the scene builds a loaded mesh from, in one pass a worker can make. */
export function bakeModel(modelPos) {
  const { localPos, size } = bakeLocal(modelPos)
  return { localPos, size, normals: flatNormals(localPos), bounds: positionBounds(localPos) }
}
