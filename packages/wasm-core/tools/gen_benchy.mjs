// Stage 28 fixture: a programmatically generated "pseudo benchy" (3DBenchy is CC-BY-ND and the repo only ships a .drc -> avoid redistributing it).
//  Properties: (1) off-center origin (2) minz≠0 (bed seating test) (3) asymmetric tall shape (orientation test)
//        (4) an external overhanging arm (needs support) (5) a sealed internal cavity (reversed box -> support must not intrude).
import { writeFileSync } from 'node:fs'
import { boxTrianglesWithInwardBottom, trianglesToSTL } from '../tests/stl_fixtures.mjs'

// The reversed boxes are the sealed cavity: every facet wound the other way.
const reversed = (boxTriangles) => boxTriangles.map(([first, second, third]) => [first, third, second])
const triangles = [
  // Hull
  ...boxTrianglesWithInwardBottom(0, 0, 0, 40, 24, 8),
  // Sealed internal cavity (inside the hull, reversed -> a sealed void). Ceiling z=6 (2mm of solid above) = a closed overhang.
  ...reversed(boxTrianglesWithInwardBottom(10, 6, 2, 14, 12, 4)),
  // Cabin (on top)
  ...boxTrianglesWithInwardBottom(6, 4, 8, 22, 16, 14),
  // Chimney (tall and narrow)
  ...boxTrianglesWithInwardBottom(28, 9, 22, 5, 5, 12),
  // External overhanging arm (out past x=40, air underneath -> needs support)
  ...boxTrianglesWithInwardBottom(40, 7, 15, 12, 10, 4),
]

// Offset (applied only when writing — box vertices are shared between triangles, so mutating the array would add it twice): minz=+5 (floating) + off-center XY.
const OFFSET = [62, 46, 5]

// Binary STL
const placed = triangles.map(triangle => triangle.map(point => [point[0] + OFFSET[0], point[1] + OFFSET[1], point[2] + OFFSET[2]]))
writeFileSync('testing_files/pseudo_benchy.stl', trianglesToSTL(placed))

// bbox summary
let boundsMin = [1e9,1e9,1e9], boundsMax = [-1e9,-1e9,-1e9]
for (const triangle of triangles) for (const vertex of triangle) for (let k=0;k<3;k++){
  boundsMin[k]=Math.min(boundsMin[k],vertex[k]+OFFSET[k])
  boundsMax[k]=Math.max(boundsMax[k],vertex[k]+OFFSET[k])
}
console.log(`pseudo_benchy.stl: ${triangles.length} tris  bbox min=[${boundsMin.map(x=>x.toFixed(0))}] max=[${boundsMax.map(x=>x.toFixed(0))}]  (minz=${boundsMin[2]}, off-center)`)
