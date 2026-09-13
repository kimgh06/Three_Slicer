// Stage-21 verification: per-feature line width -> E (filament) + render widths[].
import createSlicer from '../engine/src/slicer_core.js'
function boxTris(ox,oy,oz,sx,sy,sz){const c=[[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v=>[v[0]+ox,v[1]+oy,v[2]+oz]);const q=(a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]];return[...q(0,1,2,3),...q(4,5,6,7),...q(0,1,5,4),...q(1,2,6,5),...q(2,3,7,6),...q(3,0,4,7)]}
function trisToSTL(tris){const buf=Buffer.alloc(84+tris.length*50);buf.writeUInt32LE(tris.length,80);let off=84;for(const t of tris){off+=12;for(const p of t){buf.writeFloatLE(p[0],off);buf.writeFloatLE(p[1],off+4);buf.writeFloatLE(p[2],off+8);off+=12}buf.writeUInt16LE(0,off);off+=2}return buf}
const cube=trisToSTL(boxTris(0,0,0,20,20,20))
const twoBox={ stl: trisToSTL([...boxTris(0,0,0,10,10,6), ...boxTris(16,0,0,10,10,6)]), split: 12 }
const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:3,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:4,bottom_shell_layers:3,skirt_loops:0,skirt_distance:2,brim_width:0,retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45,wall_generator:'classic'}
// per-type width set: widths[k] parallels segment k (stride-8 paths); type = paths[k*8+3]
const widthsOfType=(r,t)=>{const s=new Set();for(const L of r.layers){const w=L.widths;if(!w)continue;for(let k=0;k<w.length;k++)if(L.paths[k*8+3]===t)s.add(Math.round(w[k]*100)/100)}return [...s].sort((a,b)=>a-b)}
const anyWidths=(r)=>r.layers.some(L=>L.widths&&L.widths.length>0)
const M=await createSlicer()
const slice=(stl,p)=>M.slice(new Uint8Array(stl),JSON.stringify(p),()=>{})
let fail=0;const ok=(c,m)=>{console.log((c?'  ok: ':'  FAIL: ')+m);if(!c)fail++}

// ① outer 0.6 / inner 0.42 → wall widths[] has both; filament increases vs default
const r0=slice(cube,base)
const rW=slice(cube,{...base,outer_wall_line_width:0.6,inner_wall_line_width:0.42})
const w0=widthsOfType(r0,1), wW=widthsOfType(rW,1)
console.log(`  wall widths default=[${w0}]  outer0.6/inner0.42=[${wW}]`)
ok(w0.length===1 && Math.abs(w0[0]-0.42)<0.02, 'default wall width = 0.42 (uniform)')
ok(wW.includes(0.6) && wW.includes(0.42), 'wall widths[] carry outer=0.6 AND inner=0.42 (render reflects)')
ok(rW.stats.filament_mm > r0.stats.filament_mm, `outer 0.6 uses more filament (E reflects width): ${r0.stats.filament_mm.toFixed(1)} -> ${rW.stats.filament_mm.toFixed(1)}`)

// ② top_surface width
const rT=slice(cube,{...base,top_surface_line_width:0.6})
const wT=widthsOfType(rT,3)
console.log(`  solid/top widths (top_surface=0.6)=[${wT}]`)
ok(wT.includes(0.6), 'top_surface_line_width 0.6 reflected in top-surface segments')

// ③ 0=auto → Flow formula (1.125*nozzle=0.45 for walls)
const rA=slice(cube,{...base,line_width:0})
const wA=widthsOfType(rA,1)
console.log(`  auto wall widths (line_width:0, nozzle 0.4)=[${wA}]`)
ok(wA.some(x=>Math.abs(x-0.45)<0.02), '0=auto → Flow auto width 1.125*nozzle = 0.45')

// ④ FloatOrPercent "150%" → 1.5*nozzle = 0.6
const rP=slice(cube,{...base,outer_wall_line_width:'150%'})
ok(widthsOfType(rP,1).includes(0.6), 'outer_wall_line_width "150%" → 1.5*nozzle = 0.6')

// ⑤ MM path widths present
const rMM=slice(twoBox.stl,{...base,extruder_count:2,mm_group_split:twoBox.split})
ok(anyWidths(rMM), 'multimaterial path exports widths[] (no uniform fallback)')

console.log(fail===0?'\nWIDTH TEST PASSED':`\n${fail} FAIL`)
process.exit(fail===0?0:1)
