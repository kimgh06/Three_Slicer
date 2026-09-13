// Stage-30 heap benchmark: slices a large model (big_cyl ~318k segments) twice — legacy BATCH (full gw.s +
//  full layersArr resident, then GCodeProcessor buffers the whole string) vs STREAMING (per-layer chunk
//  emit + heap release; worker-side transfer simulated by dropping each chunk). Reports peak WASM heap via
//  Module.heap_size() (emscripten_get_heap_size; ALLOW_MEMORY_GROWTH grows monotonically → == peak).
//  Fresh Module per run. Progress → stderr (keeps the session watchdog fed). Hard self-timeout.
import createSlicer from '../engine/src/slicer_core.js'

const HARD_TIMEOUT_MS = 180000
const killer = setTimeout(() => { console.error('bench: HARD TIMEOUT'); process.exit(2) }, HARD_TIMEOUT_MS)

function cylTris(cx,cy,r,h,n){const t=[];const top=[],bot=[];for(let i=0;i<n;i++){const A=2*Math.PI*i/n;top.push([cx+r*Math.cos(A),cy+r*Math.sin(A),h]);bot.push([cx+r*Math.cos(A),cy+r*Math.sin(A),0])}for(let i=0;i<n;i++){const j=(i+1)%n;t.push([bot[i],bot[j],top[j]],[bot[i],top[j],top[i]]);t.push([[cx,cy,h],top[i],top[j]]);t.push([[cx,cy,0],bot[j],bot[i]])}return t}
function trisToSTL(tris){const buf=Buffer.alloc(84+tris.length*50);buf.writeUInt32LE(tris.length,80);let off=84;for(const t of tris){off+=12;for(const p of t){buf.writeFloatLE(p[0],off);buf.writeFloatLE(p[1],off+4);buf.writeFloatLE(p[2],off+8);off+=12}buf.writeUInt16LE(0,off);off+=2}return buf}
const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:3,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:3,bottom_shell_layers:3,skirt_loops:0,skirt_distance:2,brim_width:0,retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45,wall_generator:'classic'}
const stl = trisToSTL(cylTris(0,0,60,40,256))
const MB = (b) => (b/(1024*1024)).toFixed(1)
const prog = (tag) => (done,total) => { if (done % 40 === 0 || done===total) process.stderr.write(`  [${tag}] layer ${done}/${total}\r`) }

// BATCH
const Mb = await createSlicer()
const b0 = Mb.heap_size()
const rb = Mb.slice(new Uint8Array(stl), JSON.stringify(base), prog('batch'))
const bPeak = Mb.heap_size()
process.stderr.write('\n')
console.log(`BATCH  : base ${MB(b0)}MB -> peak ${MB(bPeak)}MB | layers=${rb.stats.layers} segs=${rb.stats.path_segments} gcode=${(rb.gcode.length/1e6).toFixed(1)}MB (result holds gcode+layers)`)

// STREAM (drop each chunk immediately → measures kernel per-layer-release peak)
const Ms = await createSlicer()
const s0 = Ms.heap_size()
let nL=0, nS=0
Ms.set_layer_sink((z,idx,gcode,paths,widths)=>{ nL++; if(paths&&paths.length) nS+=paths.length/8; /* drop chunk */ })
const rs = Ms.slice(new Uint8Array(stl), JSON.stringify(base), prog('stream'))
Ms.clear_layer_sink()
const sPeak = Ms.heap_size()
process.stderr.write('\n')
console.log(`STREAM : base ${MB(s0)}MB -> peak ${MB(sPeak)}MB | layers=${nL} segs=${nS|0} streamed=${rs.stats.streamed} (result stats-only)`)

// ECONOMY (OOM fallback): sink + economy → no toolpaths, no time estimation (no GCodeProcessor moves
//  vector), g-code streamed out per layer. This is the last rung of the OOM ladder — the survival mode.
const Me = await createSlicer()
const e0 = Me.heap_size()
let eL=0, eBytes=0
Me.set_layer_sink((z,idx,gcode,paths,widths)=>{ eL++; eBytes+=gcode.length; /* drop */ })
const re = Me.slice(new Uint8Array(stl), JSON.stringify({ ...base, economy: true }), prog('econ'))
Me.clear_layer_sink()
const ePeak = Me.heap_size()
process.stderr.write('\n')
console.log(`ECONOMY: base ${MB(e0)}MB -> peak ${MB(ePeak)}MB | layers=${eL} gcode=${(eBytes/1e6).toFixed(1)}MB economy=${re.stats.economy} (no toolpaths, no time est)`)

console.log(`\nHEAP PEAK @ ${rb.stats.path_segments} segs:`)
console.log(`  batch   ${MB(bPeak)}MB  (baseline: full gcode+layers resident + GCodeProcessor)`)
console.log(`  stream  ${MB(sPeak)}MB  (${(100*(bPeak-sPeak)/bPeak).toFixed(1)}% lower — per-layer release)`)
console.log(`  economy ${MB(ePeak)}MB  (${(100*(bPeak-ePeak)/bPeak).toFixed(1)}% lower — OOM survival: gcode-only)`)
clearTimeout(killer)
