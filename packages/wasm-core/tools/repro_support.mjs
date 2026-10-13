// Stage-32 reproduce-first: characterize grid/tree_lite/tree support structure for a ROOF fixture
//  (support penetrating below a model top surface into open space = bottom-contact defect) and a CUP
//  fixture (support inside wall solid = hole/offset defect). Prints type5 counts by (x-region, z-band).
import createSlicer from '../../engine/src/slicer_core.js'
function boxTris(originX,originY,originZ,sizeX,sizeY,sizeZ){
  const corners=[[0,0,0],[sizeX,0,0],[sizeX,sizeY,0],[0,sizeY,0],[0,0,sizeZ],[sizeX,0,sizeZ],[sizeX,sizeY,sizeZ],[0,sizeY,sizeZ]].map(vertex=>[vertex[0]+originX,vertex[1]+originY,vertex[2]+originZ])
  const quad=(first,second,third,fourth)=>[[corners[first],corners[second],corners[third]],[corners[first],corners[third],corners[fourth]]]
  return [...quad(0,1,2,3),...quad(4,5,6,7),...quad(0,1,5,4),...quad(1,2,6,5),...quad(2,3,7,6),...quad(3,0,4,7)]
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

// ROOF/table: two legs (x[-12,-8] and [8,12]) + roof slab z[12,15] spanning x[-14,14]; optional top
//  cantilever arm sitting ON the roof (z[18,21]) reaching x[-2,14] — its underside overhangs and should
//  rest ON the roof, not descend into the open gap between the legs (x[-8,8], z<12).
function roofFixture(withArm){
  const tris=[...boxTris(-12,-8,0,4,16,12), ...boxTris(8,-8,0,4,16,12), ...boxTris(-14,-10,12,28,20,3)]
  if(withArm){
    tris.push(...boxTris(-2,-2,15,3,4,3))            // small riser on roof center (x[-2,1])
    tris.push(...boxTris(-2,-2,18,16,4,3))           // cantilever arm z[18,21], x[-2,14] (overhangs)
  }
  return trisToSTL(tris)
}
// CUP: thick-wall (5mm) cup, outer x/y[-15,15] z[0,20], inner cavity x/y[-10,10] z[3,20] (open top),
//  + an overhang ring shelf inside the cavity above the floor (annulus at z[10,12]).
function cupFixture(){
  const tris=[]
  // outer solid block then subtract... we can't boolean; build walls as 4 boxes + floor + inner shelf ring
  // floor:
  tris.push(...boxTris(-15,-15,0,30,30,3))
  // 4 walls (thickness 5): left/right/front/back
  tris.push(...boxTris(-15,-15,3,5,30,17), ...boxTris(10,-15,3,5,30,17), ...boxTris(-10,-15,3,20,5,17), ...boxTris(-10,10,3,20,5,17))
  // inner overhang shelf: a ring ledge protruding inward from the walls at z[12,14] (overhangs the cavity)
  tris.push(...boxTris(-10,-10,12,20,2,2), ...boxTris(-10,8,12,20,2,2), ...boxTris(-10,-8,12,2,16,2), ...boxTris(8,-8,12,2,16,2))
  return trisToSTL(tris)
}

// time_engine:transcribed — bypass the full GCodeProcessor (crashes on this non-manifold overlapping-box
//  fixture's g-code; separate fragility, not the support-structure subject of stage 32).
const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:2,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:3,bottom_shell_layers:3,skirt_loops:0,time_engine:'transcribed',enable_support:true,support_threshold_angle:40,support_top_z_distance:0.2,support_xy_distance:0.35,support_interface_top_layers:2}
const slicer=await createSlicer()
const slice=(stl,sliceParams)=>slicer.slice(new Uint8Array(stl),JSON.stringify(sliceParams),()=>{})

// count type5 segments whose midpoint falls in [x0,x1]×any-y and z-band
function count5(result, xRange, zRange){
  let count=0
  for(const layer of result.layers){
    const z=layer.z
    if(z<zRange[0]||z>=zRange[1])continue
    const paths=layer.paths
    if(!paths)continue
    for(let k=0;k<paths.length;k+=8){
      if(paths[k+3]===5){
        const midX=(paths[k]+paths[k+4])/2
        if(midX>=xRange[0]&&midX<xRange[1]) count++
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

console.log('=== ROOF fixture (gap between legs = x[-8,8]; roof top z=15) ===')
for(const style of ['grid','tree_lite','tree']){
  const resultNoArm=slice(roofFixture(false),{...base,support_style:style})
  const resultArm=slice(roofFixture(true),{...base,support_style:style})
  if(resultNoArm.error||resultArm.error){
    console.log(`  ${style}: ERR ${resultNoArm.error||resultArm.error}`)
    continue
  }
  // gap region below roof (x[-8,8], z[0,12]) — WITH-arm minus WITHOUT-arm = arm penetration below roof
  const gapNo=count5(resultNoArm,[-8,8],[0,12]), gapArm=count5(resultArm,[-8,8],[0,12])
  // arm rests-on-roof region (x[-8,8], z[15,18]) should have support (gap between arm z18 and roof z15)
  const onRoof=count5(resultArm,[-8,8],[15,18])
  console.log(`  ${style}: total5 no-arm=${total5(resultNoArm)} arm=${total5(resultArm)} | gap<roof(z0-12) no-arm=${gapNo} arm=${gapArm} (Δ=${gapArm-gapNo}) | on-roof(z15-18)=${onRoof}`)
}
console.log('\n=== CUP fixture (wall solid = x[10,15]; cavity = x[-10,10]) ===')
for(const style of ['grid','tree_lite','tree']){
  const result=slice(cupFixture(),{...base,support_style:style})
  if(result.error){
    console.log(`  ${style}: ERR ${result.error}`)
    continue
  }
  const wall=count5(result,[10,15],[0,20]) + count5(result,[-15,-10],[0,20])  // both side walls' solid
  const cavity=count5(result,[-8,8],[0,12])                               // inside cavity below the shelf
  console.log(`  ${style}: total5=${total5(result)} | in-wall-solid=${wall} | in-cavity=${cavity}`)
}
