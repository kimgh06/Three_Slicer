// Stage-31 regression: organic TreeSupport must be LEFT/RIGHT symmetric for a symmetric model.
// Bug: model was re-centered to the ORIGIN before the tree bridge, so its negative-X half fell outside
//  the printable area [0,bed]; TreeSupport clips support to m_machine_border (intersection_ex) → the
//  negative-side ear got NO support (right-only). Fix: re-center to the BED CENTER (positive plate coords).
// Invariant: for a symmetric fixture (central body + two identical ±X ears), the type5 (support) segment
//  count on each side of the model center must be balanced — L/R ratio in [0.7, 1.3] and both sides > 0.
import createSlicer from '../../engine/src/slicer_core.js'

function boxTris(originX,originY,originZ,sizeX,sizeY,sizeZ){
  const corners=[[0,0,0],[sizeX,0,0],[sizeX,sizeY,0],[0,sizeY,0],[0,0,sizeZ],[sizeX,0,sizeZ],[sizeX,sizeY,sizeZ],[0,sizeY,sizeZ]].map(vertex=>[vertex[0]+originX,vertex[1]+originY,vertex[2]+originZ])
  const quad=(first,second,third,fourth)=>[[corners[first],corners[second],corners[third]],[corners[first],corners[third],corners[fourth]]]
  return[...quad(0,1,2,3),...quad(4,5,6,7),...quad(0,1,5,4),...quad(1,2,6,5),...quad(2,3,7,6),...quad(3,0,4,7)]
}
function trisToSTL(tris){
  const buffer=Buffer.alloc(84+tris.length*50)
  buffer.writeUInt32LE(tris.length,80)
  let offset=84
  for(const triangle of tris){
    offset+=12
    for(const point of triangle){
      buffer.writeFloatLE(point[0],offset)
      buffer.writeFloatLE(point[1],offset+4)
      buffer.writeFloatLE(point[2],offset+8)
      offset+=12
    }
    buffer.writeUInt16LE(0,offset)
    offset+=2
  }
  return buffer
}
// central column x[-5,5] + two identical elevated ears at z[20,24] sticking out ±X (undersides overhang).
function symFixture(shiftX=0){
  return trisToSTL([
    ...boxTris(-5+shiftX,-5,0, 10,10,30),
    ...boxTris(-15+shiftX,-3,20, 10,6,4),   // LEFT ear
    ...boxTris(5+shiftX,-3,20, 10,6,4),     // RIGHT ear
  ])
}
const base = {
  layer_height:0.2, first_layer_height:0.2, line_width:0.42, wall_loops:2, infill_density:0.15,
  nozzle_diameter:0.4, filament_diameter:1.75, print_speed:60, first_layer_speed:20, travel_speed:150,
  nozzle_temp:210, bed_temp:60, top_shell_layers:3, bottom_shell_layers:3, skirt_loops:0,
  enable_support:true, support_threshold_angle:40, support_top_z_distance:0.2,
  support_xy_distance:0.35, support_interface_top_layers:2,
}
function analyze(result, centerX){
  let left=0, right=0, total=0
  for (const layer of result.layers){
    const paths=layer.paths
    if(!paths) continue
    for (let k=0;k<paths.length;k+=8){
      if(paths[k+3]===5){
        const midX=(paths[k]+paths[k+4])/2
        total++
        if(midX<centerX-1e-6) left++
        else if(midX>centerX+1e-6) right++
      }
    }
  }
  return { left, right, total }
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
const formatRatio=(ratio)=>{
  if(Number.isFinite(ratio)) return ratio.toFixed(2)
  return ratio
}
const slicer = await createSlicer()
const slice=(stl,sliceParams)=>slicer.slice(new Uint8Array(stl), JSON.stringify(sliceParams), ()=>{})

for (const [tag, shiftX] of [['centered', 0], ['off-center +40', 40]]) {
  const result = slice(symFixture(shiftX), { ...base, support_style:'tree' })
  if (result.error){
    ok(false, `${tag}: slice error ${result.error}`)
    continue
  }
  const counts = analyze(result, shiftX)
  let ratio = NaN
  if (counts.right>0) ratio = counts.left/counts.right
  else if (counts.left>0) ratio = Infinity
  console.log(`  [${tag}] type5 total=${counts.total} left=${counts.left} right=${counts.right} L/R=${formatRatio(ratio)}`)
  ok(counts.left>0 && counts.right>0, `${tag}: BOTH ears get organic support (left=${counts.left}, right=${counts.right})`)
  ok(Number.isFinite(ratio) && ratio>=0.7 && ratio<=1.3, `${tag}: L/R support balance in [0.7,1.3] (L/R=${formatRatio(ratio)})`)
}
// control: tree_lite was already symmetric — guards against a fix that breaks the lite path.
{
  const result = slice(symFixture(0), { ...base, support_style:'tree_lite' })
  const counts = analyze(result, 0)
  let ratio = NaN
  if (counts.right>0) ratio = counts.left/counts.right
  ok(counts.left>0 && counts.right>0 && ratio>=0.7 && ratio<=1.3, `tree_lite control still symmetric (L/R=${formatRatio(ratio)})`)
}
if (fail===0) {
  console.log('\nTREE SYMMETRY TEST PASSED')
  process.exit(0)
}
console.log(`\n${fail} TREE SYMMETRY CHECK(S) FAILED`)
process.exit(1)
