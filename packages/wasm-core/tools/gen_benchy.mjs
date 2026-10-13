// Stage 28 fixture: a programmatically generated "pseudo benchy" (3DBenchy is CC-BY-ND and the repo only ships a .drc -> avoid redistributing it).
//  Properties: (1) off-center origin (2) minz≠0 (bed seating test) (3) asymmetric tall shape (orientation test)
//        (4) an external overhanging arm (needs support) (5) a sealed internal cavity (reversed box -> support must not intrude).
import { writeFileSync } from 'node:fs'

const tris = []
// outward box
function box(originX, originY, originZ, sizeX, sizeY, sizeZ, rev = false) {
  const corners = [[0,0,0],[sizeX,0,0],[sizeX,sizeY,0],[0,sizeY,0],[0,0,sizeZ],[sizeX,0,sizeZ],[sizeX,sizeY,sizeZ],[0,sizeY,sizeZ]].map(vertex => [vertex[0]+originX, vertex[1]+originY, vertex[2]+originZ])
  const quad = (first,second,third,fourth) => {
    if (rev) return [[corners[first],corners[third],corners[second]],[corners[first],corners[fourth],corners[third]]]
    return [[corners[first],corners[second],corners[third]],[corners[first],corners[third],corners[fourth]]]
  }
  tris.push(...quad(0,1,2,3), ...quad(4,5,6,7), ...quad(0,1,5,4), ...quad(1,2,6,5), ...quad(2,3,7,6), ...quad(3,0,4,7))
}
// Hull
box(0, 0, 0, 40, 24, 8)
// Sealed internal cavity (inside the hull, reversed -> a sealed void). Ceiling z=6 (2mm of solid above) = a closed overhang.
box(10, 6, 2, 14, 12, 4, true)
// Cabin (on top)
box(6, 4, 8, 22, 16, 14)
// Chimney (tall and narrow)
box(28, 9, 22, 5, 5, 12)
// External overhanging arm (out past x=40, air underneath -> needs support)
box(40, 7, 15, 12, 10, 4)

// Offset (applied only when writing — box vertices are shared between triangles, so mutating the array would add it twice): minz=+5 (floating) + off-center XY.
const OFFSET = [62, 46, 5]

// Binary STL
const buffer = Buffer.alloc(84 + tris.length * 50)
buffer.writeUInt32LE(tris.length, 80)
let offset = 84
for (const triangle of tris) {
  offset += 12
  for (const point of triangle) {
    buffer.writeFloatLE(point[0]+OFFSET[0], offset)
    buffer.writeFloatLE(point[1]+OFFSET[1], offset+4)
    buffer.writeFloatLE(point[2]+OFFSET[2], offset+8)
    offset += 12
  }
  buffer.writeUInt16LE(0, offset)
  offset += 2
}
writeFileSync('testing_files/pseudo_benchy.stl', buffer)

// bbox summary
let boundsMin = [1e9,1e9,1e9], boundsMax = [-1e9,-1e9,-1e9]
for (const triangle of tris) for (const vertex of triangle) for (let k=0;k<3;k++){
  boundsMin[k]=Math.min(boundsMin[k],vertex[k]+OFFSET[k])
  boundsMax[k]=Math.max(boundsMax[k],vertex[k]+OFFSET[k])
}
console.log(`pseudo_benchy.stl: ${tris.length} tris  bbox min=[${boundsMin.map(x=>x.toFixed(0))}] max=[${boundsMax.map(x=>x.toFixed(0))}]  (minz=${boundsMin[2]}, off-center)`)
