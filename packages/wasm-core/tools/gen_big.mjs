// For stage-22 verification: generates a large (>150k segment) STL and measures the segment count.
// A high-density model that reproduces desktop-preview (libvgcode) class volumetric render load.
import createSlicer from '../../engine/src/slicer_core.js'
import { writeFileSync } from 'node:fs'

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
// High-resolution cylinder: the curved wall means many short segments per layer (reproducing the segment explosion of real models).
// N-gon x wall_loops = wall segments per layer, x layer count -> 150k+ segments.
function cylTris(centerX,centerY,radius,height,facetCount){
  const tris=[]
  const top=[], bottom=[]
  for(let i=0;i<facetCount;i++){
    const angle=2*Math.PI*i/facetCount
    top.push([centerX+radius*Math.cos(angle),centerY+radius*Math.sin(angle),height])
    bottom.push([centerX+radius*Math.cos(angle),centerY+radius*Math.sin(angle),0])
  }
  for(let i=0;i<facetCount;i++){
    const j=(i+1)%facetCount
    tris.push([bottom[i],bottom[j],top[j]],[bottom[i],top[j],top[i]])        // side wall
    tris.push([[centerX,centerY,height],top[i],top[j]])                            // top cap
    tris.push([[centerX,centerY,0],bottom[j],bottom[i]])                            // bottom cap
  }
  return tris
}
const R=60, H=40, NFACET=256
const stl=trisToSTL(cylTris(0,0,R,H,NFACET))
const params={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:3,
  infill_density:0.35,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,
  print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,
  top_shell_layers:4,bottom_shell_layers:3,skirt_loops:0,skirt_distance:2,brim_width:0,
  retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45,wall_generator:'classic'}
const slicer=await createSlicer()
const result=slicer.slice(new Uint8Array(stl),JSON.stringify(params),()=>{})
console.log(`cylinder R${R} H${H} ${NFACET}-gon  infill ${params.infill_density}  walls ${params.wall_loops}`)
console.log(`layers=${result.stats.layers}  segments=${result.stats.path_segments}`)
writeFileSync('big_cyl.stl', stl)
console.log(`wrote big_cyl.stl (${(stl.length/1024).toFixed(0)} KB)`)
