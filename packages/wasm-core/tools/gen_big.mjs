// For stage-22 verification: generates a large (>150k segment) STL and measures the segment count.
// A high-density model that reproduces desktop-preview (libvgcode) class volumetric render load.
import createSlicer from '../engine/src/slicer_core.js'
import { writeFileSync } from 'node:fs'

function boxTris(ox,oy,oz,sx,sy,sz){
  const c=[[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v=>[v[0]+ox,v[1]+oy,v[2]+oz])
  const q=(a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  return[...q(0,1,2,3),...q(4,5,6,7),...q(0,1,5,4),...q(1,2,6,5),...q(2,3,7,6),...q(3,0,4,7)]
}
function trisToSTL(tris){
  const buf=Buffer.alloc(84+tris.length*50);buf.writeUInt32LE(tris.length,80);let off=84
  for(const t of tris){off+=12;for(const p of t){buf.writeFloatLE(p[0],off);buf.writeFloatLE(p[1],off+4);buf.writeFloatLE(p[2],off+8);off+=12}buf.writeUInt16LE(0,off);off+=2}
  return buf
}
// High-resolution cylinder: the curved wall means many short segments per layer (reproducing the segment explosion of real models).
// N-gon x wall_loops = wall segments per layer, x layer count -> 150k+ segments.
function cylTris(cx,cy,r,h,n){
  const tris=[]; const top=[], bot=[]
  for(let i=0;i<n;i++){const a=2*Math.PI*i/n; top.push([cx+r*Math.cos(a),cy+r*Math.sin(a),h]); bot.push([cx+r*Math.cos(a),cy+r*Math.sin(a),0])}
  for(let i=0;i<n;i++){const j=(i+1)%n
    tris.push([bot[i],bot[j],top[j]],[bot[i],top[j],top[i]])        // side wall
    tris.push([[cx,cy,h],top[i],top[j]])                            // top cap
    tris.push([[cx,cy,0],bot[j],bot[i]])                            // bottom cap
  }
  return tris
}
const R=60, H=40, NFACET=256
const stl=trisToSTL(cylTris(0,0,R,H,NFACET))
const params={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:3,
  infill_density:0.35,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,
  print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,
  top_shell_layers:4,bottom_shell_layers:3,skirt_loops:0,skirt_distance:2,brim_width:0,
  retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45,wall_generator:'classic'}
const M=await createSlicer()
const r=M.slice(new Uint8Array(stl),JSON.stringify(params),()=>{})
console.log(`cylinder R${R} H${H} ${NFACET}-gon  infill ${params.infill_density}  walls ${params.wall_loops}`)
console.log(`layers=${r.stats.layers}  segments=${r.stats.path_segments}`)
writeFileSync('big_cyl.stl', stl)
console.log(`wrote big_cyl.stl (${(stl.length/1024).toFixed(0)} KB)`)
