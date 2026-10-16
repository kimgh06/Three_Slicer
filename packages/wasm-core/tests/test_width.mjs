// Stage-21 verification: per-feature line width -> E (filament) + render widths[].
import createSlicer from '../../engine/src/slicer_core.js'
import { boxTrianglesWithInwardBottom, trianglesToSTL } from './stl_fixtures.mjs'
const cube=trianglesToSTL(boxTrianglesWithInwardBottom(0,0,0,20,20,20))
const twoBox={ stl: trianglesToSTL([...boxTrianglesWithInwardBottom(0,0,0,10,10,6), ...boxTrianglesWithInwardBottom(16,0,0,10,10,6)]), split: 12 }
const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:3,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:4,bottom_shell_layers:3,skirt_loops:0,skirt_distance:2,brim_width:0,retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45,wall_generator:'classic'}
// per-type width set: widths[k] parallels segment k (stride-8 paths); type = paths[k*8+3]
const widthsOfType=(result,type)=>{
  const widthSet=new Set()
  for(const layer of result.layers){
    const widths=layer.widths
    if(!widths)continue
    for(let k=0;k<widths.length;k++)if(layer.paths[k*8+3]===type)widthSet.add(Math.round(widths[k]*100)/100)
  }
  return [...widthSet].sort((left,right)=>left-right)
}
const anyWidths=(result)=>result.layers.some(layer=>layer.widths&&layer.widths.length>0)
const slicer=await createSlicer()
const slice=(stl,sliceParams)=>slicer.slice(new Uint8Array(stl),JSON.stringify(sliceParams),()=>{})
let fail=0
const ok=(condition,message)=>{
  if(condition){
    console.log('  ok: '+message)
    return
  }
  console.log('  FAIL: '+message)
  fail++
}

// ① outer 0.6 / inner 0.42 → wall widths[] has both; filament increases vs default
const defaultResult=slice(cube,base)
const wideResult=slice(cube,{...base,outer_wall_line_width:0.6,inner_wall_line_width:0.42})
const defaultWallWidths=widthsOfType(defaultResult,1), wideWallWidths=widthsOfType(wideResult,1)
console.log(`  wall widths default=[${defaultWallWidths}]  outer0.6/inner0.42=[${wideWallWidths}]`)
ok(defaultWallWidths.length===1 && Math.abs(defaultWallWidths[0]-0.42)<0.02, 'default wall width = 0.42 (uniform)')
ok(wideWallWidths.includes(0.6) && wideWallWidths.includes(0.42), 'wall widths[] carry outer=0.6 AND inner=0.42 (render reflects)')
ok(wideResult.stats.filament_mm > defaultResult.stats.filament_mm, `outer 0.6 uses more filament (E reflects width): ${defaultResult.stats.filament_mm.toFixed(1)} -> ${wideResult.stats.filament_mm.toFixed(1)}`)

// ② top_surface width
const topResult=slice(cube,{...base,top_surface_line_width:0.6})
const topWidths=widthsOfType(topResult,3)
console.log(`  solid/top widths (top_surface=0.6)=[${topWidths}]`)
ok(topWidths.includes(0.6), 'top_surface_line_width 0.6 reflected in top-surface segments')

// ③ 0=auto → Flow formula (1.125*nozzle=0.45 for walls)
const autoResult=slice(cube,{...base,line_width:0})
const autoWidths=widthsOfType(autoResult,1)
console.log(`  auto wall widths (line_width:0, nozzle 0.4)=[${autoWidths}]`)
ok(autoWidths.some(width=>Math.abs(width-0.45)<0.02), '0=auto → Flow auto width 1.125*nozzle = 0.45')

// ④ FloatOrPercent "150%" → 1.5*nozzle = 0.6
const percentResult=slice(cube,{...base,outer_wall_line_width:'150%'})
ok(widthsOfType(percentResult,1).includes(0.6), 'outer_wall_line_width "150%" → 1.5*nozzle = 0.6')

// ⑤ MM path widths present
const multiMaterialResult=slice(twoBox.stl,{...base,extruder_count:2,mm_group_split:twoBox.split})
ok(anyWidths(multiMaterialResult), 'multimaterial path exports widths[] (no uniform fallback)')

if(fail===0){
  console.log('\nWIDTH TEST PASSED')
  process.exit(0)
}
console.log(`\n${fail} FAIL`)
process.exit(1)
