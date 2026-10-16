// Stage-20 physical test: manual support painting (enforcer/blocker) on tree + grid.
//  enforcer (manual mode, auto off): baseline 0 support -> paint enforcer on overhang -> support appears.
//  blocker  (auto mode): full support -> paint blocker on part of overhang -> that region suppressed, rest kept.
import createSlicer from '../../engine/src/slicer_core.js'
import { boxTrianglesWithInwardBottom, tableTriangles, trianglesToSTL } from './stl_fixtures.mjs'
// overhang table: leg (tris 0..11) + cap (12..23). Cap underside overhang = tris 12,13 (z=10). Kernel coords: XY-centered, z-min=0.
const tableSTL=trianglesToSTL(tableTriangles(boxTrianglesWithInwardBottom))
const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:2,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:4,bottom_shell_layers:3,skirt_loops:1,skirt_distance:2,brim_width:0,retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45,
  enable_support:true,support_threshold_angle:30,support_top_z_distance:0.2,support_xy_distance:0.35,support_interface_top_layers:2}
// Stage 33: the support-quantity metric was corrected from "segment count" to "real path length (mm)".
//  After grid snapping was introduced, regions fragment along cell boundaries, so the count can rise even when support really shrinks
//  (measured: applying a blocker raised the count 822 -> 880 while the length fell 8669 -> 7001mm). Length is the real material usage.
const countByType=(paths)=>{
  let length=0
  for(let i=0;i<paths.length;i+=8)if(paths[i+3]===5)
    length+=Math.hypot(paths[i+4]-paths[i],paths[i+5]-paths[i+1])
  return length
}
const type5=(result)=>Math.round(result.layers.reduce((sum,layer)=>sum+countByType(layer.paths),0))
const slicer=await createSlicer()
const slice=(sliceParams)=>slicer.slice(new Uint8Array(tableSTL),JSON.stringify(sliceParams),()=>{})
let fail=0
const ok=(condition,message)=>{
  if(condition){
    console.log('  ok: '+message)
    return
  }
  console.log('  FAIL: '+message)
  fail++
}

for (const style of ['tree','grid']) {
  console.log(`\n[${style}]`)
  // --- ENFORCER (manual mode: auto off) ---
  slicer.selector_prepare(new Uint8Array(tableSTL))
  slicer.selector_clear()
  const manualBase = type5(slice({...base, support_style:style, support_auto:false}))
  slicer.selector_prepare(new Uint8Array(tableSTL))
  slicer.selector_paint(12, 0,0,10, 0,0,-40, 20.0, true)   // enforcer over the whole cap underside
  const enforcerFacets = slicer.selector_painted_count(true)
  const manualWithEnforcer = type5(slice({...base, support_style:style, support_auto:false}))
  console.log(`  enforcer facets=${enforcerFacets}  manual: base=${manualBase} +enforcer=${manualWithEnforcer}`)
  ok(manualBase===0 && manualWithEnforcer>0, `enforcer forces support in manual mode (0 -> ${manualWithEnforcer})`)

  // --- BLOCKER (auto mode), partial on one quadrant of the overhang ---
  slicer.selector_prepare(new Uint8Array(tableSTL))
  slicer.selector_clear()
  const autoBase = type5(slice({...base, support_style:style, support_auto:true}))
  slicer.selector_prepare(new Uint8Array(tableSTL))
  slicer.selector_paint(12, 6,6,10, 6,6,-40, 7.0, false)   // blocker on one corner region
  const blockerFacets = slicer.selector_painted_count(false)
  const autoWithBlocker = type5(slice({...base, support_style:style, support_auto:true}))
  console.log(`  blocker facets=${blockerFacets}  auto: base=${autoBase} +blocker=${autoWithBlocker}`)
  ok(blockerFacets>0 && autoWithBlocker < autoBase && autoWithBlocker > 0, `blocker suppresses part, rest kept (${autoBase} -> ${autoWithBlocker})`)

  // --- determinism (enforcer case) ---
  slicer.selector_prepare(new Uint8Array(tableSTL))
  slicer.selector_paint(12, 0,0,10, 0,0,-40, 20.0, true)
  const firstGcode=slice({...base, support_style:style, support_auto:false}).gcode
  slicer.selector_prepare(new Uint8Array(tableSTL))
  slicer.selector_paint(12, 0,0,10, 0,0,-40, 20.0, true)
  const secondGcode=slice({...base, support_style:style, support_auto:false}).gcode
  ok(firstGcode===secondGcode, 'determinism: identical g-code with same paint')
}
if(fail===0) console.log('\nPAINT TEST PASSED')
else console.log(`\n${fail} FAIL`)
