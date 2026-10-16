// Stage-18 golden guard: slice cube + overhang table on DEFAULT paths and dump G-code.
// Run before and after the FillBase un-trim + integration; byte-diff of the two dumps must be 0
// (proves the kernel's default paths never call the restored factory cases).
import createSlicer from '../../engine/src/slicer_core.js'
import { writeFileSync } from 'node:fs'
import { boxTrianglesWithInwardBottom, centreXYSeatZ, tableTriangles, trianglesToSTL } from './stl_fixtures.mjs'

// Stage 28 P2: the harness sends "bed-centered placement coordinates" (same as the viewer's bakeLocal: XY bbox center at the origin, minz=0).
//  With the default auto_center=false (trusting the viewer's coordinates) these centered coordinates match the legacy realignment result -> golden stays byte-identical.
//  centreXYSeatZ (stl_fixtures.mjs) is that placement.
const cubeSTL  = trianglesToSTL(centreXYSeatZ(boxTrianglesWithInwardBottom(0,0,0,20,20,20)))
const tableSTL = trianglesToSTL(centreXYSeatZ(tableTriangles(boxTrianglesWithInwardBottom)))

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
