// Stage-20 physical test: manual support painting (enforcer/blocker) on tree + grid.
//  enforcer (manual mode, auto off): baseline 0 support -> paint enforcer on overhang -> support appears.
//  blocker  (auto mode): full support -> paint blocker on part of overhang -> that region suppressed, rest kept.
import createSlicer from '../engine/src/slicer_core.js'
function boxTris(ox,oy,oz,sx,sy,sz){const c=[[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v=>[v[0]+ox,v[1]+oy,v[2]+oz]);const q=(a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]];return[...q(0,1,2,3),...q(4,5,6,7),...q(0,1,5,4),...q(1,2,6,5),...q(2,3,7,6),...q(3,0,4,7)]}
function trisToSTL(tris){const buf=Buffer.alloc(84+tris.length*50);buf.writeUInt32LE(tris.length,80);let off=84;for(const t of tris){off+=12;for(const p of t){buf.writeFloatLE(p[0],off);buf.writeFloatLE(p[1],off+4);buf.writeFloatLE(p[2],off+8);off+=12}buf.writeUInt16LE(0,off);off+=2}return buf}
// overhang table: leg (tris 0..11) + cap (12..23). Cap underside overhang = tris 12,13 (z=10). Kernel coords: XY-centered, z-min=0.
const tableSTL=trisToSTL([...boxTris(7,7,0,6,6,10), ...boxTris(0,0,10,20,20,4)])
const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:2,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:4,bottom_shell_layers:3,skirt_loops:1,skirt_distance:2,brim_width:0,retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45,
  enable_support:true,support_threshold_angle:30,support_top_z_distance:0.2,support_xy_distance:0.35,support_interface_top_layers:2}
// Stage 33: the support-quantity metric was corrected from "segment count" to "real path length (mm)".
//  After grid snapping was introduced, regions fragment along cell boundaries, so the count can rise even when support really shrinks
//  (measured: applying a blocker raised the count 822 -> 880 while the length fell 8669 -> 7001mm). Length is the real material usage.
const countByType=(paths)=>{let s=0;for(let i=0;i<paths.length;i+=8)if(paths[i+3]===5)
  s+=Math.hypot(paths[i+4]-paths[i],paths[i+5]-paths[i+1]);return s}
const type5=(r)=>Math.round(r.layers.reduce((a,L)=>a+countByType(L.paths),0))
const M=await createSlicer()
const slice=(p)=>M.slice(new Uint8Array(tableSTL),JSON.stringify(p),()=>{})
let fail=0; const ok=(c,m)=>{console.log((c?'  ok: ':'  FAIL: ')+m);if(!c)fail++}

for (const style of ['tree','grid']) {
  console.log(`\n[${style}]`)
  // --- ENFORCER (manual mode: auto off) ---
  M.selector_prepare(new Uint8Array(tableSTL)); M.selector_clear()
  const manualBase = type5(slice({...base, support_style:style, support_auto:false}))
  M.selector_prepare(new Uint8Array(tableSTL))
  M.selector_paint(12, 0,0,10, 0,0,-40, 20.0, true)   // enforcer over the whole cap underside
  const enfC = M.selector_painted_count(true)
  const manualEnf = type5(slice({...base, support_style:style, support_auto:false}))
  console.log(`  enforcer facets=${enfC}  manual: base=${manualBase} +enforcer=${manualEnf}`)
  ok(manualBase===0 && manualEnf>0, `enforcer forces support in manual mode (0 -> ${manualEnf})`)

  // --- BLOCKER (auto mode), partial on one quadrant of the overhang ---
  M.selector_prepare(new Uint8Array(tableSTL)); M.selector_clear()
  const autoBase = type5(slice({...base, support_style:style, support_auto:true}))
  M.selector_prepare(new Uint8Array(tableSTL))
  M.selector_paint(12, 6,6,10, 6,6,-40, 7.0, false)   // blocker on one corner region
  const blkC = M.selector_painted_count(false)
  const autoBlk = type5(slice({...base, support_style:style, support_auto:true}))
  console.log(`  blocker facets=${blkC}  auto: base=${autoBase} +blocker=${autoBlk}`)
  ok(blkC>0 && autoBlk < autoBase && autoBlk > 0, `blocker suppresses part, rest kept (${autoBase} -> ${autoBlk})`)

  // --- determinism (enforcer case) ---
  M.selector_prepare(new Uint8Array(tableSTL)); M.selector_paint(12, 0,0,10, 0,0,-40, 20.0, true)
  const g1=slice({...base, support_style:style, support_auto:false}).gcode
  M.selector_prepare(new Uint8Array(tableSTL)); M.selector_paint(12, 0,0,10, 0,0,-40, 20.0, true)
  const g2=slice({...base, support_style:style, support_auto:false}).gcode
  ok(g1===g2, 'determinism: identical g-code with same paint')
}
console.log(fail===0?'\nPAINT TEST PASSED':`\n${fail} FAIL`)
