// Stage 28 fixture: a programmatically generated "pseudo benchy" (3DBenchy is CC-BY-ND and the repo only ships a .drc -> avoid redistributing it).
//  Properties: (1) off-center origin (2) minz≠0 (bed seating test) (3) asymmetric tall shape (orientation test)
//        (4) an external overhanging arm (needs support) (5) a sealed internal cavity (reversed box -> support must not intrude).
import { writeFileSync } from 'node:fs'

const tris = []
// outward box
function box(ox, oy, oz, sx, sy, sz, rev = false) {
  const c = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v => [v[0]+ox, v[1]+oy, v[2]+oz])
  const q = (a,b,cc,d) => rev ? [[c[a],c[cc],c[b]],[c[a],c[d],c[cc]]] : [[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  tris.push(...q(0,1,2,3), ...q(4,5,6,7), ...q(0,1,5,4), ...q(1,2,6,5), ...q(2,3,7,6), ...q(3,0,4,7))
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
const OFF = [62, 46, 5]

// Binary STL
const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80)
let off = 84
for (const t of tris) { off += 12; for (const p of t) { buf.writeFloatLE(p[0]+OFF[0], off); buf.writeFloatLE(p[1]+OFF[1], off+4); buf.writeFloatLE(p[2]+OFF[2], off+8); off += 12 } buf.writeUInt16LE(0, off); off += 2 }
writeFileSync('testing_files/pseudo_benchy.stl', buf)

// bbox summary
let mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9]
for (const t of tris) for (const v of t) for (let k=0;k<3;k++){ mn[k]=Math.min(mn[k],v[k]+OFF[k]); mx[k]=Math.max(mx[k],v[k]+OFF[k]) }
console.log(`pseudo_benchy.stl: ${tris.length} tris  bbox min=[${mn.map(x=>x.toFixed(0))}] max=[${mx.map(x=>x.toFixed(0))}]  (minz=${mn[2]}, off-center)`)
