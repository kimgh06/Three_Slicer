// Stage-32 support-structure regression guards + Fix A/B invariants (grid/tree_lite sweep).
//  Locks the correct behavior measured in the reproduce-first round (hypotheses rejected) and guards
//  the two real fixes: A=floating overhang gets support, B=support_bottom_z_distance z-gap.
//  time_engine:transcribed — the full GCodeProcessor OOBs on these non-manifold overlapping-box fixtures'
//  g-code (separate fragility, documented in README §32); toolpath geometry (type5) is identical.
import createSlicer from '../../engine/src/slicer_core.js'
import { boxTrianglesWithInwardBottom, trianglesToSTL } from './stl_fixtures.mjs'
const roof=(arm)=>{
  const triangles=[...boxTrianglesWithInwardBottom(-12,-8,0,4,16,12),...boxTrianglesWithInwardBottom(8,-8,0,4,16,12),...boxTrianglesWithInwardBottom(-14,-10,12,28,20,3)]
  if(arm){
    triangles.push(...boxTrianglesWithInwardBottom(-2,-2,15,3,4,3))
    triangles.push(...boxTrianglesWithInwardBottom(-2,-2,18,16,4,3))
  }
  return trianglesToSTL(triangles)
}
const cup=()=>trianglesToSTL([...boxTrianglesWithInwardBottom(-15,-15,0,30,30,3),...boxTrianglesWithInwardBottom(-15,-15,3,5,30,17),...boxTrianglesWithInwardBottom(10,-15,3,5,30,17),...boxTrianglesWithInwardBottom(-10,-15,3,20,5,17),...boxTrianglesWithInwardBottom(-10,10,3,20,5,17),...boxTrianglesWithInwardBottom(-10,-10,12,20,2,2),...boxTrianglesWithInwardBottom(-10,8,12,20,2,2),...boxTrianglesWithInwardBottom(-10,-8,12,2,16,2),...boxTrianglesWithInwardBottom(8,-8,12,2,16,2)])
const cantilever=()=>trianglesToSTL([...boxTrianglesWithInwardBottom(-3,-3,0,6,6,15),...boxTrianglesWithInwardBottom(-10,-2,15,20,4,3)])   // arm ON pillar top (connected)
const floating=()=>trianglesToSTL([...boxTrianglesWithInwardBottom(-3,-3,0,6,6,15),...boxTrianglesWithInwardBottom(-10,-2,18,20,4,3)])     // arm 3mm ABOVE pillar (floating over z-gap)
// wide base z[0,5] + narrow tower z[5,20] + cantilever arm x[2,12] z[17,20]: the arm's support descends
//  and RESTS ON THE BASE TOP (z=5) at x[2,12] → clean site to measure the bottom z-gap (support_bottom_z_distance).
const towerArm=()=>trianglesToSTL([...boxTrianglesWithInwardBottom(-15,-15,0,30,30,5),...boxTrianglesWithInwardBottom(-2,-2,5,4,4,15),...boxTrianglesWithInwardBottom(2,-2,17,10,4,3)])
const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:2,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:3,bottom_shell_layers:3,skirt_loops:0,time_engine:'transcribed',enable_support:true,support_threshold_angle:40,support_top_z_distance:0.2,support_xy_distance:0.35}
const slicer=await createSlicer()
const slice=(stl,overrides)=>slicer.slice(new Uint8Array(stl),JSON.stringify({...base,...overrides}),()=>{})
// yr (optional): y range filter — the WP2 port can emit segments that "wrap" the column with the upstream first-layer flange
//  (raft_first_layer_expansion 2mm), so "inside the solid" must only be true when both x and y are within the column (the intended 3D column).
const count5=(result,xRange,zRange,yRange)=>{
  let count=0
  for(const layer of result.layers){
    const z=layer.z
    if(z<zRange[0]||z>=zRange[1])continue
    const paths=layer.paths
    if(!paths)continue
    for(let k=0;k<paths.length;k+=8){
      if(paths[k+3]===5){
        const midX=(paths[k]+paths[k+4])/2
        if(midX<xRange[0]||midX>=xRange[1])continue
        if(yRange){
          const midY=(paths[k+1]+paths[k+5])/2
          if(midY<yRange[0]||midY>=yRange[1])continue
        }
        count++
      }
    }
  }
  return count
}
const total5=(result)=>{
  let count=0
  for(const layer of result.layers){
    const paths=layer.paths
    if(paths)for(let k=0;k<paths.length;k+=8)if(paths[k+3]===5)count++
  }
  return count
}
const lowest5=(result,xRange)=>{
  let lowestZ=1e9
  for(const layer of result.layers){
    const paths=layer.paths
    if(!paths)continue
    for(let k=0;k<paths.length;k+=8){
      if(paths[k+3]===5){
        const midX=(paths[k]+paths[k+4])/2
        if(midX>=xRange[0]&&midX<xRange[1]&&layer.z<lowestZ)lowestZ=layer.z
      }
    }
  }
  return lowestZ
}
let fail=0
const ok=(condition,message)=>{
  if(condition){
    console.log('  ok: '+message)
    return
  }
  console.log('  FAIL: '+message)
  fail++
}

for(const style of ['grid','tree_lite']){
  console.log(`[${style}]`)
  // guard 1: CUP — no support inside wall solid, support present in cavity (hole/offset handling correct)
  const cupResult=slice(cup(),{support_style:style})
  const wall=count5(cupResult,[10,15],[0,20])+count5(cupResult,[-15,-10],[0,20]), cavity=count5(cupResult,[-8,8],[0,12])
  ok(wall===0, `${style} cup: no type5 in wall solid (=${wall})`)
  ok(cavity>0, `${style} cup: support present in cavity (=${cavity})`)
  // guard 2: ROOF — top arm does not add support below the roof (Δ=0), rests on roof (on-roof>0)
  const gapWithArm=count5(slice(roof(true),{support_style:style}),[-8,8],[0,12]), gapNoArm=count5(slice(roof(false),{support_style:style}),[-8,8],[0,12])
  ok(Math.abs(gapWithArm-gapNoArm)<=2, `${style} roof: top-arm adds no support below roof (Δ=${gapWithArm-gapNoArm})`)
  ok(count5(slice(roof(true),{support_style:style}),[-8,8],[15,18])>0, `${style} roof: arm support rests on roof (z15-18 > 0)`)
  // guard 3: CANTILEVER — support beside pillar, none over/inside pillar solid
  const cantileverResult=slice(cantilever(),{support_style:style})
  ok(count5(cantileverResult,[-3,3],[0,15],[-3,3])===0, `${style} cantilever: no support over/in pillar solid`)
  ok(count5(cantileverResult,[5,10],[0,15])>0, `${style} cantilever: support beside pillar (overhang)`)
  // Fix A: floating part above a full z-gap now gets support underneath (was 0 before the fix)
  const floatingResult=slice(floating(),{support_style:style})
  ok(total5(floatingResult)>0, `${style} FIX A: floating overhang (above full z-gap) gets support (type5=${total5(floatingResult)})`)
  // Fix B: larger support_bottom_z_distance lifts the support bottom off the model top (base top z=5, arm@x[2,12]).
  //  Default 0.2 (botGap=1) is a no-op → golden byte-identical; 0.6 (botGap=3) adds a 0.4mm gap.
  const lowestGap02=lowest5(slice(towerArm(),{support_style:style,support_bottom_z_distance:0.2}),[3,11])
  const lowestGap06=lowest5(slice(towerArm(),{support_style:style,support_bottom_z_distance:0.6}),[3,11])
  ok(lowestGap06>lowestGap02+0.25, `${style} FIX B: bottom z-gap 0.6 lifts support bottom above 0.2 (z ${lowestGap02.toFixed(2)}->${lowestGap06.toFixed(2)})`)
}
if(fail===0){
  console.log('\nSUPPORT STRUCTURE TEST PASSED')
  process.exit(0)
}
console.log(`\n${fail} SUPPORT STRUCTURE CHECK(S) FAILED`)
process.exit(1)
