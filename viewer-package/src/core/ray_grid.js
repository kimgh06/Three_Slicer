// A ray against a triangle soup through a uniform grid: only the triangles in the cells the ray crosses are tested.
//  three.js' Mesh.raycast tests every triangle, 17-18 ms per pointer move on a 450k-face model in Firefox, and the hover
//  highlight, the brush and Measure all raycast on every move. Every hit along the ray is returned, nearest first, as
//  three's raycast does: the brush walks past the hits the section plane has cut away.
const TRIANGLES_PER_CELL = 4
const MAX_CELLS_PER_AXIS = 256
const EPSILON = 1e-9

export function buildRayGrid(positions) {
  const count = positions.length / 9
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let at = 0; at < positions.length; at += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[at + axis])
      max[axis] = Math.max(max[axis], positions[at + axis])
    }
  }
  const size = min.map((low, axis) => Math.max(max[axis] - low, 1e-6))
  const volume = size[0] * size[1] * size[2]
  const edge = Math.cbrt(volume * TRIANGLES_PER_CELL / Math.max(count, 1))
  const dims = size.map(length => Math.min(MAX_CELLS_PER_AXIS, Math.max(1, Math.round(length / edge))))
  const cell = size.map((length, axis) => length / dims[axis])
  const cellIndex = (value, axis) => Math.min(dims[axis] - 1, Math.max(0, Math.floor((value - min[axis]) / cell[axis])))
  const spanOf = (triangle) => {
    const low = [0, 0, 0], high = [0, 0, 0]
    for (let axis = 0; axis < 3; axis++) {
      const a = positions[triangle * 9 + axis], b = positions[triangle * 9 + 3 + axis], c = positions[triangle * 9 + 6 + axis]
      low[axis] = cellIndex(Math.min(a, b, c), axis)
      high[axis] = cellIndex(Math.max(a, b, c), axis)
    }
    return { low, high }
  }
  const start = new Uint32Array(dims[0] * dims[1] * dims[2] + 1)
  const visit = (triangle, each) => {
    const { low, high } = spanOf(triangle)
    for (let z = low[2]; z <= high[2]; z++) for (let y = low[1]; y <= high[1]; y++) for (let x = low[0]; x <= high[0]; x++) {
      each((z * dims[1] + y) * dims[0] + x)
    }
  }
  for (let triangle = 0; triangle < count; triangle++) visit(triangle, (index) => { start[index + 1]++ })
  for (let index = 1; index < start.length; index++) start[index] += start[index - 1]
  const items = new Uint32Array(start[start.length - 1])
  const fill = start.slice(0, -1)
  for (let triangle = 0; triangle < count; triangle++) visit(triangle, (index) => { items[fill[index]++] = triangle })
  return { min, max, dims, cell, start, items, seen: new Uint32Array(count), stamp: 0 }
}

// Möller-Trumbore, both faces: the viewer draws its meshes double-sided.
function hitDistance(positions, triangle, origin, direction) {
  const at = triangle * 9
  const e1x = positions[at + 3] - positions[at], e1y = positions[at + 4] - positions[at + 1], e1z = positions[at + 5] - positions[at + 2]
  const e2x = positions[at + 6] - positions[at], e2y = positions[at + 7] - positions[at + 1], e2z = positions[at + 8] - positions[at + 2]
  const px = direction[1] * e2z - direction[2] * e2y, py = direction[2] * e2x - direction[0] * e2z, pz = direction[0] * e2y - direction[1] * e2x
  const determinant = e1x * px + e1y * py + e1z * pz
  if (Math.abs(determinant) < EPSILON) return null
  const inverse = 1 / determinant
  const tx = origin[0] - positions[at], ty = origin[1] - positions[at + 1], tz = origin[2] - positions[at + 2]
  const u = (tx * px + ty * py + tz * pz) * inverse
  if (u < 0 || u > 1) return null
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
  const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inverse
  if (v < 0 || u + v > 1) return null
  const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse
  if (distance < 0) return null
  return distance
}

// Every triangle the ray meets, as { triangle, distance } nearest first. `distance` is in units of `direction`.
export function raycastGrid(grid, positions, origin, direction) {
  const { min, max, dims, cell, start, items, seen } = grid
  let enter = 0, leave = Infinity
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < EPSILON) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return []
      continue
    }
    let near = (min[axis] - origin[axis]) / direction[axis], far = (max[axis] - origin[axis]) / direction[axis]
    if (near > far) [near, far] = [far, near]
    enter = Math.max(enter, near)
    leave = Math.min(leave, far)
  }
  if (enter > leave) return []
  grid.stamp += 1
  if (grid.stamp === 0xFFFFFFFF) { seen.fill(0); grid.stamp = 1 }
  const index = [0, 0, 0], step = [0, 0, 0], next = [0, 0, 0], delta = [0, 0, 0]
  for (let axis = 0; axis < 3; axis++) {
    const entry = origin[axis] + direction[axis] * enter
    index[axis] = Math.min(dims[axis] - 1, Math.max(0, Math.floor((entry - min[axis]) / cell[axis])))
    if (direction[axis] > EPSILON) {
      step[axis] = 1
      next[axis] = (min[axis] + (index[axis] + 1) * cell[axis] - origin[axis]) / direction[axis]
      delta[axis] = cell[axis] / direction[axis]
    } else if (direction[axis] < -EPSILON) {
      step[axis] = -1
      next[axis] = (min[axis] + index[axis] * cell[axis] - origin[axis]) / direction[axis]
      delta[axis] = -cell[axis] / direction[axis]
    } else {
      next[axis] = Infinity
      delta[axis] = Infinity
    }
  }
  const hits = []
  while (index[0] >= 0 && index[0] < dims[0] && index[1] >= 0 && index[1] < dims[1] && index[2] >= 0 && index[2] < dims[2]) {
    const flat = (index[2] * dims[1] + index[1]) * dims[0] + index[0]
    for (let at = start[flat]; at < start[flat + 1]; at++) {
      const triangle = items[at]
      if (seen[triangle] === grid.stamp) continue
      seen[triangle] = grid.stamp
      const distance = hitDistance(positions, triangle, origin, direction)
      if (distance !== null) hits.push({ triangle, distance })
    }
    let axis = 0
    if (next[1] < next[axis]) axis = 1
    if (next[2] < next[axis]) axis = 2
    if (next[axis] > leave) break
    index[axis] += step[axis]
    next[axis] += delta[axis]
  }
  return hits.sort((first, second) => first.distance - second.distance)
}
