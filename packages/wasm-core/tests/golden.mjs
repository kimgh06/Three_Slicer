// Stage-18 golden guard: slice cube + overhang table on DEFAULT paths and dump G-code.
// Run before and after the FillBase un-trim + integration; byte-diff of the two dumps must be 0
// (proves the kernel's default paths never call the restored factory cases).
import createSlicer from '../engine/src/slicer_core.js'
import { writeFileSync } from 'node:fs'

function boxTris(ox, oy, oz, sx, sy, sz) {
  const c = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]]
    .map(v => [v[0]+ox, v[1]+oy, v[2]+oz])
  const q = (a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  return [...q(0,1,2,3), ...q(4,5,6,7), ...q(0,1,5,4), ...q(1,2,6,5), ...q(2,3,7,6), ...q(3,0,4,7)]
}
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length*50); buf.writeUInt32LE(tris.length, 80); let off = 84
  for (const t of tris) { off += 12; for (const p of t){ buf.writeFloatLE(p[0],off); buf.writeFloatLE(p[1],off+4); buf.writeFloatLE(p[2],off+8); off += 12 } buf.writeUInt16LE(0,off); off += 2 }
  return buf
}
// Stage 28 P2: the harness sends "bed-centered placement coordinates" (same as the viewer's bakeLocal: XY bbox center at the origin, minz=0).
//  With the default auto_center=false (trusting the viewer's coordinates) these centered coordinates match the legacy realignment result -> golden stays byte-identical.
function centerTris(tris) {
  let mnx=1e9,mny=1e9,mnz=1e9,mxx=-1e9,mxy=-1e9
  for (const t of tris) for (const v of t){ mnx=Math.min(mnx,v[0]);mxx=Math.max(mxx,v[0]);mny=Math.min(mny,v[1]);mxy=Math.max(mxy,v[1]);mnz=Math.min(mnz,v[2]) }
  const cx=(mnx+mxx)/2, cy=(mny+mxy)/2
  return tris.map(t=>t.map(v=>[v[0]-cx, v[1]-cy, v[2]-mnz]))
}
const cubeSTL  = trisToSTL(centerTris(boxTris(0,0,0,20,20,20)))
const tableSTL = trisToSTL(centerTris([...boxTris(7,7,0,6,6,10), ...boxTris(0,0,10,20,20,4)]))

const params = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2,
  infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0,
  print_speed: 60, first_layer_speed: 20, travel_speed: 150, nozzle_temp: 210, bed_temp: 60,
  top_shell_layers: 4, bottom_shell_layers: 3, skirt_loops: 1, skirt_distance: 2, brim_width: 0,
  retract_length: 0.8, retract_speed: 30, z_hop: 0.4, infill_angle: 45,
}
const supGrid = { ...params, enable_support: true, support_threshold_angle: 30, support_density: 0.15,
  support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2, support_style: 'grid' }

const M = await createSlicer()
const gc = (stl, p) => M.slice(new Uint8Array(stl), JSON.stringify(p), ()=>{}).gcode

// Three default-path slices that must be untouched by the factory un-trim.
const dump = [
  '=== cube (default, no support) ===', gc(cubeSTL, params),
  '=== table (default, no support) ===', gc(tableSTL, params),
  '=== table (grid support — default support_style) ===', gc(tableSTL, supGrid),
].join('\n')

const tag = process.argv[2] || 'out'
writeFileSync(`/tmp/golden_${tag}.txt`, dump)
console.log(`golden_${tag}: ${dump.length} bytes -> /tmp/golden_${tag}.txt`)
