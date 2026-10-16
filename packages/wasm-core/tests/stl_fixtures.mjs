// The meshes the kernel tests and tools slice, and the binary STL they are sent as. 32 files under tests/ and tools/
//  each carried a private copy of these builders before; they are imported from here now. Importing this module runs
//  nothing (test.mjs, which also exports fixtures, runs its whole suite on import).
//
// A triangle list ("triangles" in the names below) is an array of [[x, y, z], [x, y, z], [x, y, z]], in millimetres, z up.

// Binary STL layout: an 80-byte header (left zero), the facet count as uint32, then 50 bytes per facet — a 12-byte
//  normal (left zero; the kernel recomputes it), three 12-byte vertices of float32 x/y/z, and a 2-byte attribute (zero).
const STL_COUNT_OFFSET = 80
const STL_FACETS_OFFSET = 84
const STL_FACET_BYTES = 50
const STL_NORMAL_BYTES = 12
const STL_VERTEX_BYTES = 12
const STL_FLOAT_BYTES = 4
const STL_ATTRIBUTE_BYTES = 2
const STL_SECOND_VERTEX_OFFSET = STL_NORMAL_BYTES + STL_VERTEX_BYTES
const STL_THIRD_VERTEX_OFFSET = STL_NORMAL_BYTES + 2 * STL_VERTEX_BYTES
const COORDINATES_PER_TRIANGLE = 9

// Binary STL of a triangle list, as a node Buffer.
export function trianglesToSTL(triangles) {
  const buffer = Buffer.alloc(STL_FACETS_OFFSET + triangles.length * STL_FACET_BYTES)
  buffer.writeUInt32LE(triangles.length, STL_COUNT_OFFSET)
  let offset = STL_FACETS_OFFSET
  for (const triangle of triangles) {
    offset += STL_NORMAL_BYTES
    for (const point of triangle) {
      buffer.writeFloatLE(point[0], offset)
      buffer.writeFloatLE(point[1], offset + STL_FLOAT_BYTES)
      buffer.writeFloatLE(point[2], offset + 2 * STL_FLOAT_BYTES)
      offset += STL_VERTEX_BYTES
    }
    offset += STL_ATTRIBUTE_BYTES
  }
  return buffer
}

// The same bytes as a plain Uint8Array (a copy, not a Buffer view), the type the kernel bindings take.
export function trianglesToSTLBytes(triangles) {
  return new Uint8Array(trianglesToSTL(triangles))
}

// Binary STL of a flat position array (x, y, z of every corner, nine numbers per triangle), as a node Buffer.
export function positionsToSTL(positions) {
  const triangles = []
  for (let start = 0; start < positions.length; start += COORDINATES_PER_TRIANGLE) {
    triangles.push([
      [positions[start], positions[start + 1], positions[start + 2]],
      [positions[start + 3], positions[start + 4], positions[start + 5]],
      [positions[start + 6], positions[start + 7], positions[start + 8]],
    ])
  }
  return trianglesToSTL(triangles)
}

const facetCountOf = (stl) => stl.readUInt32LE(STL_COUNT_OFFSET)

// The facets of several binary STL Buffers in one Buffer, in argument order.
export function concatSTL(...buffers) {
  const total = buffers.reduce((sum, buffer) => sum + facetCountOf(buffer), 0)
  const out = Buffer.alloc(STL_FACETS_OFFSET + total * STL_FACET_BYTES)
  out.writeUInt32LE(total, STL_COUNT_OFFSET)
  let writeAt = STL_FACETS_OFFSET
  for (const buffer of buffers) {
    buffer.copy(out, writeAt, STL_FACETS_OFFSET)
    writeAt += facetCountOf(buffer) * STL_FACET_BYTES
  }
  return out
}

// A copy of a binary STL Buffer with every vertex moved by (offsetX, offsetY, offsetZ).
export function moveSTL(stl, offsetX, offsetY, offsetZ) {
  const out = Buffer.from(stl)
  const offsets = [offsetX, offsetY, offsetZ]
  for (let facet = 0; facet < facetCountOf(out); facet++) {
    const facetStart = STL_FACETS_OFFSET + facet * STL_FACET_BYTES
    for (let vertex = 0; vertex < 3; vertex++) {
      const vertexStart = facetStart + STL_NORMAL_BYTES + vertex * STL_VERTEX_BYTES
      for (let axis = 0; axis < 3; axis++) {
        const at = vertexStart + axis * STL_FLOAT_BYTES
        out.writeFloatLE(out.readFloatLE(at) + offsets[axis], at)
      }
    }
  }
  return out
}

// A copy of a binary STL Buffer with each facet's second and third vertex swapped: every facet faces the other way.
export function flipSTL(stl) {
  const out = Buffer.from(stl)
  for (let facet = 0; facet < facetCountOf(out); facet++) {
    const facetStart = STL_FACETS_OFFSET + facet * STL_FACET_BYTES
    const secondVertex = Buffer.from(out.subarray(facetStart + STL_SECOND_VERTEX_OFFSET, facetStart + STL_THIRD_VERTEX_OFFSET))
    out.copy(out, facetStart + STL_SECOND_VERTEX_OFFSET, facetStart + STL_THIRD_VERTEX_OFFSET, facetStart + STL_THIRD_VERTEX_OFFSET + STL_VERTEX_BYTES)
    secondVertex.copy(out, facetStart + STL_THIRD_VERTEX_OFFSET)
  }
  return out
}

// Box corners: the bottom face 0..3 counter-clockwise seen from above, the top face 4..7 above them.
function boxCorners(originX, originY, originZ, sizeX, sizeY, sizeZ) {
  const unplaced = [[0,0,0],[sizeX,0,0],[sizeX,sizeY,0],[0,sizeY,0],[0,0,sizeZ],[sizeX,0,sizeZ],[sizeX,sizeY,sizeZ],[0,sizeY,sizeZ]]
  return unplaced.map(corner => [corner[0] + originX, corner[1] + originY, corner[2] + originZ])
}
// Two triangles per face, in the order bottom, top, y = min, x = max, y = max, x = min.
const OUTWARD_BOX_FACES = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
const INWARD_BOTTOM_BOX_FACES = [[0,1,2],[0,2,3],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]

// An axis-aligned box with every facet wound outward (counter-clockwise seen from outside).
export function outwardBoxTriangles(originX, originY, originZ, sizeX, sizeY, sizeZ) {
  const corners = boxCorners(originX, originY, originZ, sizeX, sizeY, sizeZ)
  return OUTWARD_BOX_FACES.map(face => face.map(cornerIndex => corners[cornerIndex]))
}

// The same box and facet order, but with the two bottom facets wound the other way (their normal points up, into the
//  box). Most of the kernel tests were written against this mesh and their golden output was recorded with it, so it
//  stays a mesh of its own rather than being corrected to outwardBoxTriangles.
export function boxTrianglesWithInwardBottom(originX, originY, originZ, sizeX, sizeY, sizeZ) {
  const corners = boxCorners(originX, originY, originZ, sizeX, sizeY, sizeZ)
  return INWARD_BOTTOM_BOX_FACES.map(face => face.map(cornerIndex => corners[cornerIndex]))
}

// The overhang table: a 6x6x10 leg at (7,7) under a 20x20x4 cap at z=10, whose underside overhangs. Its two boxes
//  come from buildBox (one of the two box builders above), the leg's 12 facets first.
export function tableTriangles(buildBox) {
  return [...buildBox(7, 7, 0, 6, 6, 10), ...buildBox(0, 0, 10, 20, 20, 4)]
}

// A closed cylinder standing on z=0: facetCount side quads, a fan on the top and one on the bottom.
export function closedCylinderTriangles(centerX, centerY, radius, height, facetCount) {
  const triangles = []
  const top = []
  const bottom = []
  for (let i = 0; i < facetCount; i++) {
    const angle = 2 * Math.PI * i / facetCount
    top.push([centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle), height])
    bottom.push([centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle), 0])
  }
  for (let i = 0; i < facetCount; i++) {
    const next = (i + 1) % facetCount
    triangles.push([bottom[i], bottom[next], top[next]], [bottom[i], top[next], top[i]])
    triangles.push([[centerX, centerY, height], top[i], top[next]])
    triangles.push([[centerX, centerY, 0], bottom[next], bottom[i]])
  }
  return triangles
}

// The viewer's placement frame (bakeLocal): the XY bounding-box centre moved to the origin, the lowest point to z=0.
export function centreXYSeatZ(triangles) {
  let minX = 1e9
  let minY = 1e9
  let minZ = 1e9
  let maxX = -1e9
  let maxY = -1e9
  for (const triangle of triangles) {
    for (const vertex of triangle) {
      minX = Math.min(minX, vertex[0])
      maxX = Math.max(maxX, vertex[0])
      minY = Math.min(minY, vertex[1])
      maxY = Math.max(maxY, vertex[1])
      minZ = Math.min(minZ, vertex[2])
    }
  }
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  return triangles.map(triangle => triangle.map(vertex => [vertex[0] - centerX, vertex[1] - centerY, vertex[2] - minZ]))
}
