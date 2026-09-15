// Stage-32 reproduce-first: characterize grid/tree_lite/tree support structure for a ROOF fixture
//  (support penetrating below a model top surface into open space = bottom-contact defect) and a CUP
//  fixture (support inside wall solid = hole/offset defect). Prints type5 counts by (x-region, z-band).
import createSlicer from '../../engine/src/slicer_core.js'
function boxTris(ox,oy,oz,sx,sy,sz){const c=[[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v=>[v[0]+ox,v[1]+oy,v[2]+oz]);const q=(a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]];return [...q(0,1,2,3),...q(4,5,6,7),...q(0,1,5,4),...q(1,2,6,5),...q(2,3,7,6),...q(3,0,4,7)]}
function trisToSTL(t){const b=Buffer.alloc(84+t.length*50);b.writeUInt32LE(t.length,80);let o=84;for(const x of t){o+=12;for(const p of x){b.writeFloatLE(p[0],o);b.writeFloatLE(p[1],o+4);b.writeFloatLE(p[2],o+8);o+=12}b.writeUInt16LE(0,o);o+=2}return b}

// ROOF/table: two legs (x[-12,-8] and [8,12]) + roof slab z[12,15] spanning x[-14,14]; optional top
//  cantilever arm sitting ON the roof (z[18,21]) reaching x[-2,14] — its underside overhangs and should
//  rest ON the roof, not descend into the open gap between the legs (x[-8,8], z<12).
function roofFixture(withArm){
  const t=[...boxTris(-12,-8,0,4,16,12), ...boxTris(8,-8,0,4,16,12), ...boxTris(-14,-10,12,28,20,3)]
  if(withArm){ t.push(...boxTris(-2,-2,15,3,4,3));            // small riser on roof center (x[-2,1])
               t.push(...boxTris(-2,-2,18,16,4,3)) }          // cantilever arm z[18,21], x[-2,14] (overhangs)
  return trisToSTL(t)
}
// CUP: thick-wall (5mm) cup, outer x/y[-15,15] z[0,20], inner cavity x/y[-10,10] z[3,20] (open top),
//  + an overhang ring shelf inside the cavity above the floor (annulus at z[10,12]).
function cupFixture(){
  const t=[]
  // outer solid block then subtract... we can't boolean; build walls as 4 boxes + floor + inner shelf ring
  // floor:
  t.push(...boxTris(-15,-15,0,30,30,3))
  // 4 walls (thickness 5): left/right/front/back
  t.push(...boxTris(-15,-15,3,5,30,17), ...boxTris(10,-15,3,5,30,17), ...boxTris(-10,-15,3,20,5,17), ...boxTris(-10,10,3,20,5,17))
  // inner overhang shelf: a ring ledge protruding inward from the walls at z[12,14] (overhangs the cavity)
  t.push(...boxTris(-10,-10,12,20,2,2), ...boxTris(-10,8,12,20,2,2), ...boxTris(-10,-8,12,2,16,2), ...boxTris(8,-8,12,2,16,2))
  return trisToSTL(t)
}

// time_engine:transcribed — bypass the full GCodeProcessor (crashes on this non-manifold overlapping-box
//  fixture's g-code; separate fragility, not the support-structure subject of stage 32).
const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:2,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:3,bottom_shell_layers:3,skirt_loops:0,time_engine:'transcribed',enable_support:true,support_threshold_angle:40,support_top_z_distance:0.2,support_xy_distance:0.35,support_interface_top_layers:2}
const M=await createSlicer()
const slice=(stl,p)=>M.slice(new Uint8Array(stl),JSON.stringify(p),()=>{})

// count type5 segments whose midpoint falls in [x0,x1]×any-y and z-band
function count5(r, xr, zr){ let n=0; for(const L of r.layers){ const z=L.z; if(z<zr[0]||z>=zr[1])continue; const p=L.paths; if(!p)continue; for(let k=0;k<p.length;k+=8){ if(p[k+3]===5){ const mx=(p[k]+p[k+4])/2; if(mx>=xr[0]&&mx<xr[1]) n++ } } } return n }
const total5=(r)=>{let n=0;for(const L of r.layers){const p=L.paths;if(p)for(let k=0;k<p.length;k+=8)if(p[k+3]===5)n++;}return n}

console.log('=== ROOF fixture (gap between legs = x[-8,8]; roof top z=15) ===')
for(const style of ['grid','tree_lite','tree']){
  const rNo=slice(roofFixture(false),{...base,support_style:style})
  const rArm=slice(roofFixture(true),{...base,support_style:style})
  if(rNo.error||rArm.error){console.log(`  ${style}: ERR ${rNo.error||rArm.error}`);continue}
  // gap region below roof (x[-8,8], z[0,12]) — WITH-arm minus WITHOUT-arm = arm penetration below roof
  const gapNo=count5(rNo,[-8,8],[0,12]), gapArm=count5(rArm,[-8,8],[0,12])
  // arm rests-on-roof region (x[-8,8], z[15,18]) should have support (gap between arm z18 and roof z15)
  const onRoof=count5(rArm,[-8,8],[15,18])
  console.log(`  ${style}: total5 no-arm=${total5(rNo)} arm=${total5(rArm)} | gap<roof(z0-12) no-arm=${gapNo} arm=${gapArm} (Δ=${gapArm-gapNo}) | on-roof(z15-18)=${onRoof}`)
}
console.log('\n=== CUP fixture (wall solid = x[10,15]; cavity = x[-10,10]) ===')
for(const style of ['grid','tree_lite','tree']){
  const r=slice(cupFixture(),{...base,support_style:style})
  if(r.error){console.log(`  ${style}: ERR ${r.error}`);continue}
  const wall=count5(r,[10,15],[0,20]) + count5(r,[-15,-10],[0,20])  // both side walls' solid
  const cavity=count5(r,[-8,8],[0,12])                               // inside cavity below the shelf
  console.log(`  ${style}: total5=${total5(r)} | in-wall-solid=${wall} | in-cavity=${cavity}`)
}
