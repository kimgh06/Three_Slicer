// For stage-22 verification: generates a large (>150k segment) STL and measures the segment count.
// A high-density model that reproduces desktop-preview (libvgcode) class volumetric render load.
import createSlicer from '../../engine/src/slicer_core.js'
import { writeFileSync } from 'node:fs'
import { closedCylinderTriangles, trianglesToSTL } from '../tests/stl_fixtures.mjs'

// High-resolution cylinder: the curved wall means many short segments per layer (reproducing the segment explosion of real models).
// N-gon x wall_loops = wall segments per layer, x layer count -> 150k+ segments.
const RADIUS=60, HEIGHT=40, FACET_COUNT=256
const stl=trianglesToSTL(closedCylinderTriangles(0,0,RADIUS,HEIGHT,FACET_COUNT))
const params={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:3,
  infill_density:0.35,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,
  print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,
  top_shell_layers:4,bottom_shell_layers:3,skirt_loops:0,skirt_distance:2,brim_width:0,
  retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45,wall_generator:'classic'}
const slicer=await createSlicer()
const result=slicer.slice(new Uint8Array(stl),JSON.stringify(params),()=>{})
console.log(`cylinder R${RADIUS} H${HEIGHT} ${FACET_COUNT}-gon  infill ${params.infill_density}  walls ${params.wall_loops}`)
console.log(`layers=${result.stats.layers}  segments=${result.stats.path_segments}`)
writeFileSync('big_cyl.stl', stl)
console.log(`wrote big_cyl.stl (${(stl.length/1024).toFixed(0)} KB)`)
