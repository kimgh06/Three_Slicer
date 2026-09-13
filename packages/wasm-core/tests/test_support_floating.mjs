// Stage 33 regression: detects "support floating in mid-air".
//  The upstream project_support_to_grid diffs the model out of the downward projection before passing it down —
//  so a projection that hits the model dies there (bottom contact) and never comes back below it.
//  The old implementation only accumulated (union) and clipped per layer afterwards, so a region hidden by the model
//  came back on the layers below where the model no longer exists, leaving support hanging in the air.
//
// Criterion: support stacks up from the bed. For a support cell on layer j (j>0), if the layer directly **below** (j-1) has
//  neither support nor model (wall/solid/infill) at that cell, there is nothing holding it up = **floating**.
//  j=0 sits on the bed and is excluded. Judged on a raster grid (0.5mm) — stable without reassembling polygons.
import createSlicer from '../engine/src/slicer_core.js'

// Stepped overhang: a shape whose cross-section jumps between layers, which easily induces floating support.
//  Three tiers: a small lower column -> a large middle plate -> a small offset upper column.
function box(ox,oy,oz,sx,sy,sz){
  const c=[[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v=>[v[0]+ox,v[1]+oy,v[2]+oz])
  const q=(a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  return [...q(0,1,2,3),...q(4,5,6,7),...q(0,1,5,4),...q(1,2,6,5),...q(2,3,7,6),...q(3,0,4,7)]
}
function stlOf(t){const b=Buffer.alloc(84+t.length*50);b.writeUInt32LE(t.length,80);let o=84
  for(const tr of t){o+=12;for(const v of tr){b.writeFloatLE(v[0],o);b.writeFloatLE(v[1],o+4);b.writeFloatLE(v[2],o+8);o+=12}b.writeUInt16LE(0,o);o+=2}return b}
// Note: the z boundaries deliberately overlap by 0.5mm. Making them exactly flush (plate 6~9, column 9~15) means
//   tri_plane's [zmin, zmax) test catches no triangle at that plane, producing an **empty layer**,
//   and all support above it is misjudged as "nothing below" (confirmed by measurement).
const model = [
  ...box(-4,-4,0, 8,8,6.5),       // lower column, z 0~6.5
  ...box(-15,-15,6, 30,30,3),     // middle plate, z 6~9 (overhangs all around -> support beneath)
  ...box(6,6,8.5, 8,8,6.5),       // upper column, z 8.5~15 (on the plate, offset in XY)
  ...box(-15,-15,14.5, 30,30,3),  // upper plate, z 14.5~17.5 (overhangs all around again)
]
const stl = new Uint8Array(stlOf(model))

const M = await createSlicer()
const params = {
  layer_height:0.2, first_layer_height:0.2, line_width:0.42, wall_loops:2, infill_density:0.15,
  nozzle_diameter:0.4, filament_diameter:1.75, bed_width:220, bed_depth:220,
  enable_support:true, support_style:'grid', support_threshold_angle:45,
  support_top_z_distance:0.2, support_xy_distance:0.35, support_interface_top_layers:2,
}
const r = M.slice(stl, JSON.stringify(params), () => {})
if (r.error) { console.log('FAIL slice error:', r.error); process.exit(1) }

const CELL = 0.5
const key = (x,y) => `${Math.round(x/CELL)},${Math.round(y/CELL)}`
// Support cells per layer / all (support + model) cells
const supCells = [], allCells = []
for (const L of r.layers || []) {
  const s = new Set(), a = new Set()
  const p = L.paths
  if (p) for (let i=0;i<p.length;i+=8) {
    const t = p[i+3]; if (t === 0) continue                     // skip travels
    // Sample the segment at CELL intervals
    const x0=p[i], y0=p[i+1], x1=p[i+4], y1=p[i+5]
    const n = Math.max(1, Math.ceil(Math.hypot(x1-x0,y1-y0)/CELL))
    for (let k=0;k<=n;k++) {
      const kk = key(x0+(x1-x0)*k/n, y0+(y1-y0)*k/n)
      a.add(kk); if (t===5||t===6) s.add(kk)
    }
  }
  supCells.push(s); allCells.push(a)
}

// The below-layer test allows up to the 8 neighbors: support sitting over the support_xy_distance (0.35mm) gap,
//  and grid discretization boundaries, protrude by less than one cell (0.5mm) and are physically printable.
//  Without that tolerance the whole gap ring around the model counts as "floating" and the metric becomes meaningless.
const hasBelow = (below, c) => {
  const [cx, cy] = c.split(',').map(Number)
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
    if (below.has(`${cx+dx},${cy+dy}`)) return true
  return false
}
let floating = 0, totalSup = 0, worstLayer = -1, worstN = 0
for (let j = 1; j < supCells.length; j++) {           // j=0 rests on the bed -> excluded
  const cur = supCells[j], below = allCells[j-1]      // all support + model on the layer below
  if (!cur.size) continue
  let n = 0
  for (const c of cur) { totalSup++; if (!hasBelow(below, c)) { floating++; n++ } }
  if (n > worstN) { worstN = n; worstLayer = j }
}
const pct = totalSup ? (floating/totalSup*100) : 0
console.log(`support cells ${totalSup.toLocaleString()}  cells with nothing below ${floating.toLocaleString()} (${pct.toFixed(1)}%)  worst layer ${worstLayer}(${worstN})`)

// Threshold 5%: a measured baseline — 8.0% before the fix (the model was not subtracted in the downward projection), 3.2% after.
//  Most of the remaining 3.2% is a known bias of the metric: the raster holds only extrusion "lines", not the filled
//  interior of a model cross-section, so support that landed properly on the model's top surface (= bottom contact) also counts as "nothing below".
//  Use it as a regression ceiling, not an absolute number.
const LIMIT = 5
if (pct > LIMIT) { console.log(`\nFLOATING SUPPORT TEST FAILED — ${pct.toFixed(1)}% > ${LIMIT}%`); process.exit(1) }
console.log(`\nFLOATING SUPPORT TEST PASSED — ${pct.toFixed(1)}% ≤ ${LIMIT}%`)
