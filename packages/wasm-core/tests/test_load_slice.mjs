// A loaded mesh reaches the kernel: file bytes -> loadModel -> modelPos -> binary STL -> slice -> G-code.
//   Run: node packages/wasm-core/tests/test_load_slice.mjs
// The viewer's own loader test (packages-mit/tests/test_loaders.mjs) stops at the parsed mesh, and the kernel tests
//  all start from an STL this repo builds in code — so nothing else checks that what the loader hands over is
//  something the kernel can actually slice, in the frame the loader promises (z up, millimetres). It is the half of
//  the deleted wasm-core/test_loaders.mjs that was worth keeping; that one had imported the pre-split viewer path
//  and had not run since 0.3.0.
// 3MF/AMF need DOMParser and are covered in the browser.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import createSlicer from '../../engine/src/slicer_core.js'
import { loadModel, SUPPORTED_EXT } from '../../../packages-mit/src/scene/model_loaders.js'

const here = join(dirname(fileURLToPath(import.meta.url)), '..')   // the package root, one above tests/
// cube20.stl sits at the package root, the rest under testing_files/ — both are committed fixtures.
const fixture = (name) => {
  const inFolder = join(here, 'testing_files', name)
  return readFileSync(existsSync(inFolder) ? inFolder : join(here, name))
}

function modelToSTL(pos) {   // N*9 z-up model -> binary STL
  const triangles = pos.length / 9
  const buffer = Buffer.alloc(84 + triangles * 50)
  buffer.writeUInt32LE(triangles, 80)
  let at = 84, read = 0
  for (let t = 0; t < triangles; t++) {
    at += 12                                     // the stored normal stays zero; the kernel recomputes it
    for (let corner = 0; corner < 3; corner++) {
      buffer.writeFloatLE(pos[read++], at); buffer.writeFloatLE(pos[read++], at + 4); buffer.writeFloatLE(pos[read++], at + 8)
      at += 12
    }
    at += 2
  }
  return buffer
}

const params = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15,
  nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0, print_speed: 60, first_layer_speed: 20,
  travel_speed: 150, nozzle_temp: 210, bed_temp: 60, top_shell_layers: 3, bottom_shell_layers: 3,
  skirt_loops: 0, brim_width: 0, infill_angle: 45,
}

const M = await createSlicer()
let failures = 0
const check = (label, condition, detail = '') => {
  console.log((condition ? '  ok: ' : '  FAIL: ') + label + (condition || !detail ? '' : ' — ' + detail))
  if (!condition) failures++
}

check(`the loader still claims stl,obj,3mf,amf,ply (${SUPPORTED_EXT.join(',')})`, SUPPORTED_EXT.join(',') === 'stl,obj,3mf,amf,ply')

for (const name of ['cube20.stl', 'cube.obj', 'cube.ply']) {
  const bytes = fixture(name)
  const objects = await loadModel(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const pos = objects[0]?.modelPos ?? new Float32Array(0)
  const span = (axis) => {
    let low = Infinity, high = -Infinity
    for (let at = axis; at < pos.length; at += 3) { if (pos[at] < low) low = pos[at]; if (pos[at] > high) high = pos[at] }
    return high - low
  }
  check(`${name}: one object of 12 triangles`, objects.length === 1 && pos.length / 9 === 12, `${objects.length} objects, ${pos.length / 9} triangles`)
  check(`${name}: a 20mm cube, z still up`, Math.abs(span(0) - 20) < 0.1 && Math.abs(span(2) - 20) < 0.1,
    `x ${span(0).toFixed(2)}, z ${span(2).toFixed(2)}`)
  const result = M.slice(new Uint8Array(modelToSTL(pos)), JSON.stringify(params), () => {})
  const layers = result.layers?.length ?? 0
  check(`${name}: the kernel slices it into ~99 layers of real G-code`, layers >= 90 && layers <= 105 && (result.gcode || '').length > 1000,
    `${layers} layers, ${(result.gcode || '').length} bytes`)
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nLOAD -> SLICE PASSED (stl/obj/ply; 3mf/amf are browser-only)\n')
process.exit(failures ? 1 : 0)
