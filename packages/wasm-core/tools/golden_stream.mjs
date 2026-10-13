// Stage-30 streaming golden guard: proves the per-layer STREAMING emission path (set_layer_sink →
//  chunk callback + heap release per layer) reassembles to a g-code that is BYTE-IDENTICAL to the
//  legacy BATCH path (result.gcode). This is the "absolute output-identity requirement" for the OOM streaming round.
//  Runs the same three default-path cases as golden.mjs; for each, slices twice (batch, stream) and
//  asserts the concatenated stream chunks == batch bytes. Also asserts stats parity (segments/filament).
import createSlicer from '../../engine/src/slicer_core.js'

function boxTris(originX, originY, originZ, sizeX, sizeY, sizeZ) {
  const corners = [[0,0,0],[sizeX,0,0],[sizeX,sizeY,0],[0,sizeY,0],[0,0,sizeZ],[sizeX,0,sizeZ],[sizeX,sizeY,sizeZ],[0,sizeY,sizeZ]]
    .map(vertex => [vertex[0]+originX, vertex[1]+originY, vertex[2]+originZ])
  const quad = (first,second,third,fourth)=>[[corners[first],corners[second],corners[third]],[corners[first],corners[third],corners[fourth]]]
  return [...quad(0,1,2,3), ...quad(4,5,6,7), ...quad(0,1,5,4), ...quad(1,2,6,5), ...quad(2,3,7,6), ...quad(3,0,4,7)]
}
function trisToSTL(tris) {
  const buffer = Buffer.alloc(84 + tris.length*50)
  buffer.writeUInt32LE(tris.length, 80)
  let offset = 84
  for (const triangle of tris) {
    offset += 12
    for (const point of triangle){
      buffer.writeFloatLE(point[0],offset)
      buffer.writeFloatLE(point[1],offset+4)
      buffer.writeFloatLE(point[2],offset+8)
      offset += 12
    }
    buffer.writeUInt16LE(0,offset)
    offset += 2
  }
  return buffer
}
function centerTris(tris) {
  let minX=1e9,minY=1e9,minZ=1e9,maxX=-1e9,maxY=-1e9
  for (const triangle of tris) for (const vertex of triangle){
    minX=Math.min(minX,vertex[0])
    maxX=Math.max(maxX,vertex[0])
    minY=Math.min(minY,vertex[1])
    maxY=Math.max(maxY,vertex[1])
    minZ=Math.min(minZ,vertex[2])
  }
  const centerX=(minX+maxX)/2, centerY=(minY+maxY)/2
  return tris.map(triangle=>triangle.map(vertex=>[vertex[0]-centerX, vertex[1]-centerY, vertex[2]-minZ]))
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
const supGrid = { ...params, enable_support: true, support_threshold_angle: 30, support_density: 0.15,
  support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2, support_style: 'grid' }

const slicer = await createSlicer()

// batch: one-shot slice → result.gcode
function batch(stl, sliceParams) { return slicer.slice(new Uint8Array(stl), JSON.stringify(sliceParams), ()=>{}) }
// stream: register sink collecting chunks + per-layer counts, slice, unregister, join
function stream(stl, sliceParams, economy=false) {
  const chunks = []
  let layers = 0
  let toolpathSegs = 0
  slicer.set_layer_sink((z, layerIndex, chunk, paths, widths) => {
    chunks.push(chunk)
    layers++
    if (paths && typeof paths.length === 'number') toolpathSegs += (paths.length / 8) | 0   // stride 8 floats/seg
  })
  const result = slicer.slice(new Uint8Array(stl), JSON.stringify({ ...sliceParams, economy }), ()=>{})
  slicer.clear_layer_sink()
  return { gcode: chunks.join(''), layers, toolpathSegs, stats: result.stats, streamed: result.stats && result.stats.streamed }
}

let pass = 0, fail = 0
function eq(name, batchText, streamText) {
  if (batchText === streamText) {
    console.log(`  ok: ${name} — byte-identical (${batchText.length} chars)`)
    pass++
  }
  else {
    fail++
    // find first divergence
    let i = 0
    const commonLength = Math.min(batchText.length, streamText.length)
    while (i < commonLength && batchText[i] === streamText[i]) i++
    console.log(`  FAIL: ${name} — batch ${batchText.length} vs stream ${streamText.length}, first diff @${i}:`)
    console.log(`    batch : ${JSON.stringify(batchText.slice(Math.max(0,i-20), i+40))}`)
    console.log(`    stream: ${JSON.stringify(streamText.slice(Math.max(0,i-20), i+40))}`)
  }
}
function approx(name, batchValue, streamValue, tolerance=1e-6) {
  const ok = Math.abs(batchValue-streamValue) <= tolerance * Math.max(1, Math.abs(batchValue))
  if (ok) {
    console.log(`  ok: ${name} (${batchValue} ~= ${streamValue})`)
    pass++
  } else {
    fail++
    console.log(`  FAIL: ${name} (${batchValue} != ${streamValue})`)
  }
}

const cases = [
  ['cube (default, no support)', cubeSTL, params],
  ['table (default, no support)', tableSTL, params],
  ['table (grid support)', tableSTL, supGrid],
]
for (const [name, stl, sliceParams] of cases) {
  const batchResult = batch(stl, sliceParams)
  const streamResult = stream(stl, sliceParams)
  eq(name, batchResult.gcode, streamResult.gcode)                              // absolute requirement: streamed assembly == batch, byte-identical
  if (!streamResult.streamed) {
    fail++
    console.log(`  FAIL: ${name} — stats.streamed not set (streaming path not taken)`)
  }
  approx(`${name}: filament stat parity`, batchResult.stats.filament_mm, streamResult.stats.filament_mm)
  approx(`${name}: segment stat parity`, batchResult.stats.path_segments, streamResult.stats.path_segments, 0)
  approx(`${name}: time_estimate parity (streaming GCodeProcessor)`, batchResult.stats.time_estimate, streamResult.stats.time_estimate, 1e-4)
}

// economy mode: g-code must still be byte-identical (toolpaths omitted, time skipped).
{
  const batchResult = batch(cubeSTL, params)
  const streamResult = stream(cubeSTL, params, /*economy*/true)
  eq('cube (economy — no toolpath/time)', batchResult.gcode, streamResult.gcode)
  if (streamResult.toolpathSegs !== 0) {
    fail++
    console.log(`  FAIL: economy emitted ${streamResult.toolpathSegs} toolpath segs (expected 0)`)
  }
  else {
    console.log('  ok: economy omits toolpaths (0 segs streamed)')
    pass++
  }
  if (streamResult.stats.economy !== true) {
    fail++
    console.log('  FAIL: stats.economy not set')
  } else {
    console.log('  ok: stats.economy=true')
    pass++
  }
}

console.log(`\nSTREAM GOLDEN: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('STREAM GOLDEN PASSED — streaming assembly is byte-identical to batch (A1/A2/A3 removed, output unchanged)')
