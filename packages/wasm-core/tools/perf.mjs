import createSlicer from '../engine/src/slicer_core.js'
function boxTris(ox,oy,oz,sx,sy,sz){const c=[[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v=>[v[0]+ox,v[1]+oy,v[2]+oz]);const q=(a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]];return[...q(0,1,2,3),...q(4,5,6,7),...q(0,1,5,4),...q(1,2,6,5),...q(2,3,7,6),...q(3,0,4,7)]}
function trisToSTL(tris){const buf=Buffer.alloc(84+tris.length*50);buf.writeUInt32LE(tris.length,80);let off=84;for(const t of tris){off+=12;for(const p of t){buf.writeFloatLE(p[0],off);buf.writeFloatLE(p[1],off+4);buf.writeFloatLE(p[2],off+8);off+=12}buf.writeUInt16LE(0,off);off+=2}return buf}
const cube=trisToSTL(boxTris(0,0,0,20,20,20))
const params={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:2,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:4,bottom_shell_layers:3,skirt_loops:1,skirt_distance:2,brim_width:0,retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45,wall_generator:'arachne'}
const M=await createSlicer()
for(let w=0;w<2;w++) M.slice(new Uint8Array(cube),JSON.stringify(params),()=>{}) // warmup
let best=1e9; for(let i=0;i<5;i++){const t=performance.now();M.slice(new Uint8Array(cube),JSON.stringify(params),()=>{});best=Math.min(best,performance.now()-t)}
console.log(`cube slice best-of-5: ${best.toFixed(1)} ms`)
const r=M.slice(new Uint8Array(cube),JSON.stringify(params),()=>{})
console.log(`cgal_planar_check_count=${M.cgal_planar_check_count()}`)
