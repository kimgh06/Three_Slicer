// An object's triangles in the model frame (z up): its local positions through its world matrix, then the axis swap
//  back. buildMergedSTL and the object tools go through this one conversion.
import * as THREE from 'three'

const point = new THREE.Vector3()

export function appendModelPositions(out, localPos, matrixWorld) {
  for (let i = 0; i < localPos.length; i += 3) {
    point.set(localPos[i], localPos[i + 1], localPos[i + 2]).applyMatrix4(matrixWorld)
    out.push(point.x, -point.z, point.y)
  }
}

export function modelSoup(localPos, matrixWorld) {
  const out = []
  appendModelPositions(out, localPos, matrixWorld)
  return new Float32Array(out)
}

/**
 * Turns a flat shape lying on z = 0, facing +z, onto a surface: its z axis along `normal`, sunk `sink` mm in so that the
 *  two solids overlap and slice as one.
 */
export function placeOnSurface(positions, point3, normal, sink) {
  const n = new THREE.Vector3(...normal).normalize()
  const up = new THREE.Vector3(0, 0, 1)
  if (Math.abs(n.z) > 0.999) up.set(0, 1, 0)
  const across = new THREE.Vector3().crossVectors(up, n).normalize()
  const along = new THREE.Vector3().crossVectors(n, across)
  const out = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2] - sink
    out[i] = point3[0] + x * across.x + y * along.x + z * n.x
    out[i + 1] = point3[1] + x * across.y + y * along.y + z * n.y
    out[i + 2] = point3[2] + x * across.z + y * along.z + z * n.z
  }
  return out
}

// How far an object moves down to stand on the bed. Text on a surface keeps its height but never goes under the bed:
//  the kernel seats the whole merge on its lowest point, so 7.69 mm of text below the bed lifted a 20 mm cube by that
//  much (measured: 100 -> 138 layers, with support under everything). A negative part is cut away and may go there.
export function seatShift(lowestHeight, { keepHeight = false, negative = false } = {}) {
  if (negative) return 0
  if (keepHeight) return Math.min(lowestHeight, 0)
  return lowestHeight
}

/** An axis-aligned solid box, wound outward, as a soup. */
export function boxSoup([x0, y0, z0], [x1, y1, z1]) {
  const faces = [
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]],
    [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
  ]
  return new Float32Array(faces.flatMap(([a, b, c, d]) => [...a, ...b, ...c, ...a, ...c, ...d]))
}

/** The half of a box of `bounds` above (`upper`) or below `at` along `axis`, for a plane cut. Margined past the mesh. */
export function halfSpaceBox({ min, max }, axis, at, upper) {
  const margin = 10
  const low = min.map(value => value - margin), high = max.map(value => value + margin)
  if (upper) low[axis] = at
  else high[axis] = at
  return boxSoup(low, high)
}

/** A model-frame soup back into an object's local frame, under the world matrix it keeps. */
export function localFromModel(soup, matrixWorld) {
  const inverse = matrixWorld.clone().invert()
  const out = new Float32Array(soup.length)
  for (let i = 0; i < soup.length; i += 3) {
    point.set(soup[i], soup[i + 2], -soup[i + 1]).applyMatrix4(inverse)
    out[i] = point.x; out[i + 1] = point.y; out[i + 2] = point.z
  }
  return out
}
