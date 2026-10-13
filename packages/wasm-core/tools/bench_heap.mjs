// Stage-30 heap benchmark: slices a large model (big_cyl ~318k segments) twice — legacy BATCH (full GW::gcode +
//  full layersArr resident, then GCodeProcessor buffers the whole string) vs STREAMING (per-layer chunk
//  emit + heap release; worker-side transfer simulated by dropping each chunk). Reports peak WASM heap via
//  Module.heap_size() (emscripten_get_heap_size; ALLOW_MEMORY_GROWTH grows monotonically → == peak).
//  Fresh Module per run. Progress → stderr (keeps the session watchdog fed). Hard self-timeout.
import createSlicer from '../../engine/src/slicer_core.js'

const HARD_TIMEOUT_MS = 180000
const killer = setTimeout(() => { console.error('bench: HARD TIMEOUT'); process.exit(2) }, HARD_TIMEOUT_MS)

function cylTris(centerX,centerY,radius,height,facetCount){
  const tris=[]
  const top=[],bottom=[]
  for(let i=0;i<facetCount;i++){
    const angle=2*Math.PI*i/facetCount
    top.push([centerX+radius*Math.cos(angle),centerY+radius*Math.sin(angle),height])
    bottom.push([centerX+radius*Math.cos(angle),centerY+radius*Math.sin(angle),0])
  }
  for(let i=0;i<facetCount;i++){
    const j=(i+1)%facetCount
    tris.push([bottom[i],bottom[j],top[j]],[bottom[i],top[j],top[i]])
    tris.push([[centerX,centerY,height],top[i],top[j]])
    tris.push([[centerX,centerY,0],bottom[j],bottom[i]])
  }
  return tris
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
const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:3,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:3,bottom_shell_layers:3,skirt_loops:0,skirt_distance:2,brim_width:0,retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45,wall_generator:'classic'}
const stl = trisToSTL(cylTris(0,0,60,40,256))
const MB = (bytes) => (bytes/(1024*1024)).toFixed(1)
const progress = (tag) => (done,total) => { if (done % 40 === 0 || done===total) process.stderr.write(`  [${tag}] layer ${done}/${total}\r`) }

// BATCH
const batchModule = await createSlicer()
const batchBase = batchModule.heap_size()
const batchResult = batchModule.slice(new Uint8Array(stl), JSON.stringify(base), progress('batch'))
const batchPeak = batchModule.heap_size()
process.stderr.write('\n')
console.log(`BATCH  : base ${MB(batchBase)}MB -> peak ${MB(batchPeak)}MB | layers=${batchResult.stats.layers} segs=${batchResult.stats.path_segments} gcode=${(batchResult.gcode.length/1e6).toFixed(1)}MB (result holds gcode+layers)`)

// STREAM (drop each chunk immediately → measures kernel per-layer-release peak)
const streamModule = await createSlicer()
const streamBase = streamModule.heap_size()
let streamLayers=0, streamSegments=0
streamModule.set_layer_sink((z,layerIndex,gcode,paths,widths)=>{
  streamLayers++
  if(paths&&paths.length) streamSegments+=paths.length/8
  /* drop chunk */
})
const streamResult = streamModule.slice(new Uint8Array(stl), JSON.stringify(base), progress('stream'))
streamModule.clear_layer_sink()
const streamPeak = streamModule.heap_size()
process.stderr.write('\n')
console.log(`STREAM : base ${MB(streamBase)}MB -> peak ${MB(streamPeak)}MB | layers=${streamLayers} segs=${streamSegments|0} streamed=${streamResult.stats.streamed} (result stats-only)`)

// ECONOMY (OOM fallback): sink + economy → no toolpaths, no time estimation (no GCodeProcessor moves
//  vector), g-code streamed out per layer. This is the last rung of the OOM ladder — the survival mode.
const economyModule = await createSlicer()
const economyBase = economyModule.heap_size()
let economyLayers=0, economyBytes=0
economyModule.set_layer_sink((z,layerIndex,gcode,paths,widths)=>{
  economyLayers++
  economyBytes+=gcode.length
  /* drop */
})
const economyResult = economyModule.slice(new Uint8Array(stl), JSON.stringify({ ...base, economy: true }), progress('econ'))
economyModule.clear_layer_sink()
const economyPeak = economyModule.heap_size()
process.stderr.write('\n')
console.log(`ECONOMY: base ${MB(economyBase)}MB -> peak ${MB(economyPeak)}MB | layers=${economyLayers} gcode=${(economyBytes/1e6).toFixed(1)}MB economy=${economyResult.stats.economy} (no toolpaths, no time est)`)

console.log(`\nHEAP PEAK @ ${batchResult.stats.path_segments} segs:`)
console.log(`  batch   ${MB(batchPeak)}MB  (baseline: full gcode+layers resident + GCodeProcessor)`)
console.log(`  stream  ${MB(streamPeak)}MB  (${(100*(batchPeak-streamPeak)/batchPeak).toFixed(1)}% lower — per-layer release)`)
console.log(`  economy ${MB(economyPeak)}MB  (${(100*(batchPeak-economyPeak)/batchPeak).toFixed(1)}% lower — OOM survival: gcode-only)`)
clearTimeout(killer)
