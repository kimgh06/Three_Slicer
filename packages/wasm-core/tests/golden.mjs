// Stage-18 golden guard: slice cube + overhang table on DEFAULT paths and dump G-code.
// Run before and after the FillBase un-trim + integration; byte-diff of the two dumps must be 0
// (proves the kernel's default paths never call the restored factory cases).
import createSlicer from '../../engine/src/slicer_core.js'
import { writeFileSync } from 'node:fs'

function boxTris(originX, originY, originZ, sizeX, sizeY, sizeZ) {
  const corners = [[0,0,0],[sizeX,0,0],[sizeX,sizeY,0],[0,sizeY,0],[0,0,sizeZ],[sizeX,0,sizeZ],[sizeX,sizeY,sizeZ],[0,sizeY,sizeZ]]
    .map(corner => [corner[0]+originX, corner[1]+originY, corner[2]+originZ])
  const quad = (first, second, third, fourth) => [[corners[first], corners[second], corners[third]], [corners[first], corners[third], corners[fourth]]]
  return [...quad(0,1,2,3), ...quad(4,5,6,7), ...quad(0,1,5,4), ...quad(1,2,6,5), ...quad(2,3,7,6), ...quad(3,0,4,7)]
}
function trisToSTL(tris) {
  const buffer = Buffer.alloc(84 + tris.length*50)
  buffer.writeUInt32LE(tris.length, 80)
  let offset = 84
  for (const triangle of tris) {
    offset += 12
    for (const vertex of triangle) {
      buffer.writeFloatLE(vertex[0], offset)
      buffer.writeFloatLE(vertex[1], offset+4)
      buffer.writeFloatLE(vertex[2], offset+8)
      offset += 12
    }
    buffer.writeUInt16LE(0, offset)
    offset += 2
  }
  return buffer
}
// Stage 28 P2: the harness sends "bed-centered placement coordinates" (same as the viewer's bakeLocal: XY bbox center at the origin, minz=0).
//  With the default auto_center=false (trusting the viewer's coordinates) these centered coordinates match the legacy realignment result -> golden stays byte-identical.
function centerTris(tris) {
  let minX = 1e9
  let minY = 1e9
  let minZ = 1e9
  let maxX = -1e9
  let maxY = -1e9
  for (const triangle of tris) {
    for (const vertex of triangle) {
      minX = Math.min(minX, vertex[0])
      maxX = Math.max(maxX, vertex[0])
      minY = Math.min(minY, vertex[1])
      maxY = Math.max(maxY, vertex[1])
      minZ = Math.min(minZ, vertex[2])
    }
  }
  const centerX = (minX+maxX)/2
  const centerY = (minY+maxY)/2
  return tris.map(triangle => triangle.map(vertex => [vertex[0]-centerX, vertex[1]-centerY, vertex[2]-minZ]))
}
const cubeSTL  = trisToSTL(centerTris(boxTris(0,0,0,20,20,20)))
const tableSTL = trisToSTL(centerTris([...boxTris(7,7,0,6,6,10), ...boxTris(0,0,10,20,20,4)]))

const params = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2,
  infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0,
  print_speed: 60, first_layer_speed: 20, travel_speed: 150, nozzle_temp: 210, bed_temp: 60,
  top_shell_layers: 4, bottom_shell_layers: 3, skirt_loops: 1, skirt_distance: 2, brim_width: 0,
  retract_length: 0.8, retract_speed: 30, z_hop: 0.4, infill_angle: 45,
}
const supportGrid = { ...params, enable_support: true, support_threshold_angle: 30, support_density: 0.15,
  support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2, support_style: 'grid' }

const slicer = await createSlicer()
const sliceGcode = (stl, sliceParams) => slicer.slice(new Uint8Array(stl), JSON.stringify(sliceParams), ()=>{}).gcode

// Three default-path slices that must be untouched by the factory un-trim.
const dump = [
  '=== cube (default, no support) ===', sliceGcode(cubeSTL, params),
  '=== table (default, no support) ===', sliceGcode(tableSTL, params),
  '=== table (grid support — default support_style) ===', sliceGcode(tableSTL, supportGrid),
].join('\n')

const tag = process.argv[2] || 'out'
writeFileSync(`/tmp/golden_${tag}.txt`, dump)
console.log(`golden_${tag}: ${dump.length} bytes -> /tmp/golden_${tag}.txt`)
