// Stage-32 support-structure regression guards + Fix A/B invariants (grid/tree_lite sweep).
//  Locks the correct behavior measured in the reproduce-first round (hypotheses rejected) and guards
//  the two real fixes: A=floating overhang gets support, B=support_bottom_z_distance z-gap.
//  time_engine:transcribed — the full GCodeProcessor OOBs on these non-manifold overlapping-box fixtures'
//  g-code (separate fragility, documented in README §32); toolpath geometry (type5) is identical.
import createSlicer from '../engine/src/slicer_core.js'
function boxTris(ox,oy,oz,sx,sy,sz){const c=[[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v=>[v[0]+ox,v[1]+oy,v[2]+oz]);const q=(a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]];return [...q(0,1,2,3),...q(4,5,6,7),...q(0,1,5,4),...q(1,2,6,5),...q(2,3,7,6),...q(3,0,4,7)]}
function trisToSTL(t){const b=Buffer.alloc(84+t.length*50);b.writeUInt32LE(t.length,80);let o=84;for(const x of t){o+=12;for(const p of x){b.writeFloatLE(p[0],o);b.writeFloatLE(p[1],o+4);b.writeFloatLE(p[2],o+8);o+=12}b.writeUInt16LE(0,o);o+=2}return b}
const roof=(arm)=>{const t=[...boxTris(-12,-8,0,4,16,12),...boxTris(8,-8,0,4,16,12),...boxTris(-14,-10,12,28,20,3)];if(arm){t.push(...boxTris(-2,-2,15,3,4,3));t.push(...boxTris(-2,-2,18,16,4,3))}return trisToSTL(t)}
const cup=()=>trisToSTL([...boxTris(-15,-15,0,30,30,3),...boxTris(-15,-15,3,5,30,17),...boxTris(10,-15,3,5,30,17),...boxTris(-10,-15,3,20,5,17),...boxTris(-10,10,3,20,5,17),...boxTris(-10,-10,12,20,2,2),...boxTris(-10,8,12,20,2,2),...boxTris(-10,-8,12,2,16,2),...boxTris(8,-8,12,2,16,2)])
const cantilever=()=>trisToSTL([...boxTris(-3,-3,0,6,6,15),...boxTris(-10,-2,15,20,4,3)])   // arm ON pillar top (connected)
const floating=()=>trisToSTL([...boxTris(-3,-3,0,6,6,15),...boxTris(-10,-2,18,20,4,3)])     // arm 3mm ABOVE pillar (floating over z-gap)
// wide base z[0,5] + narrow tower z[5,20] + cantilever arm x[2,12] z[17,20]: the arm's support descends
//  and RESTS ON THE BASE TOP (z=5) at x[2,12] → clean site to measure the bottom z-gap (support_bottom_z_distance).
const towerArm=()=>trisToSTL([...boxTris(-15,-15,0,30,30,5),...boxTris(-2,-2,5,4,4,15),...boxTris(2,-2,17,10,4,3)])
const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:2,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:3,bottom_shell_layers:3,skirt_loops:0,time_engine:'transcribed',enable_support:true,support_threshold_angle:40,support_top_z_distance:0.2,support_xy_distance:0.35}
const M=await createSlicer()
const slice=(stl,p)=>M.slice(new Uint8Array(stl),JSON.stringify({...base,...p}),()=>{})
// yr (optional): y range filter — the WP2 port can emit segments that "wrap" the column with the upstream first-layer flange
//  (raft_first_layer_expansion 2mm), so "inside the solid" must only be true when both x and y are within the column (the intended 3D column).
const count5=(r,xr,zr,yr)=>{let n=0;for(const L of r.layers){const z=L.z;if(z<zr[0]||z>=zr[1])continue;const p=L.paths;if(!p)continue;for(let k=0;k<p.length;k+=8){if(p[k+3]===5){const mx=(p[k]+p[k+4])/2;if(mx<xr[0]||mx>=xr[1])continue;if(yr){const my=(p[k+1]+p[k+5])/2;if(my<yr[0]||my>=yr[1])continue}n++}}}return n}
const total5=(r)=>{let n=0;for(const L of r.layers){const p=L.paths;if(p)for(let k=0;k<p.length;k+=8)if(p[k+3]===5)n++;}return n}
const lowest5=(r,xr)=>{let z=1e9;for(const L of r.layers){const p=L.paths;if(!p)continue;for(let k=0;k<p.length;k+=8){if(p[k+3]===5){const mx=(p[k]+p[k+4])/2;if(mx>=xr[0]&&mx<xr[1]&&L.z<z)z=L.z}}}return z}
let fail=0; const ok=(c,m)=>{console.log((c?'  ok: ':'  FAIL: ')+m);if(!c)fail++}

for(const style of ['grid','tree_lite']){
  console.log(`[${style}]`)
  // guard 1: CUP — no support inside wall solid, support present in cavity (hole/offset handling correct)
  const rc=slice(cup(),{support_style:style})
  const wall=count5(rc,[10,15],[0,20])+count5(rc,[-15,-10],[0,20]), cav=count5(rc,[-8,8],[0,12])
  ok(wall===0, `${style} cup: no type5 in wall solid (=${wall})`)
  ok(cav>0, `${style} cup: support present in cavity (=${cav})`)
  // guard 2: ROOF — top arm does not add support below the roof (Δ=0), rests on roof (on-roof>0)
  const gA=count5(slice(roof(true),{support_style:style}),[-8,8],[0,12]), gN=count5(slice(roof(false),{support_style:style}),[-8,8],[0,12])
  ok(Math.abs(gA-gN)<=2, `${style} roof: top-arm adds no support below roof (Δ=${gA-gN})`)
  ok(count5(slice(roof(true),{support_style:style}),[-8,8],[15,18])>0, `${style} roof: arm support rests on roof (z15-18 > 0)`)
  // guard 3: CANTILEVER — support beside pillar, none over/inside pillar solid
  const rk=slice(cantilever(),{support_style:style})
  ok(count5(rk,[-3,3],[0,15],[-3,3])===0, `${style} cantilever: no support over/in pillar solid`)
  ok(count5(rk,[5,10],[0,15])>0, `${style} cantilever: support beside pillar (overhang)`)
  // Fix A: floating part above a full z-gap now gets support underneath (was 0 before the fix)
  const rf=slice(floating(),{support_style:style})
  ok(total5(rf)>0, `${style} FIX A: floating overhang (above full z-gap) gets support (type5=${total5(rf)})`)
  // Fix B: larger support_bottom_z_distance lifts the support bottom off the model top (base top z=5, arm@x[2,12]).
  //  Default 0.2 (botGap=1) is a no-op → golden byte-identical; 0.6 (botGap=3) adds a 0.4mm gap.
  const lo02=lowest5(slice(towerArm(),{support_style:style,support_bottom_z_distance:0.2}),[3,11])
  const lo06=lowest5(slice(towerArm(),{support_style:style,support_bottom_z_distance:0.6}),[3,11])
  ok(lo06>lo02+0.25, `${style} FIX B: bottom z-gap 0.6 lifts support bottom above 0.2 (z ${lo02.toFixed(2)}->${lo06.toFixed(2)})`)
}
console.log(fail===0?'\nSUPPORT STRUCTURE TEST PASSED':`\n${fail} SUPPORT STRUCTURE CHECK(S) FAILED`)
process.exit(fail===0?0:1)
