// Stage-30 streaming golden guard: proves the per-layer STREAMING emission path (set_layer_sink →
//  chunk callback + heap release per layer) reassembles to a g-code that is BYTE-IDENTICAL to the
//  legacy BATCH path (result.gcode). This is the "absolute output-identity requirement" for the OOM streaming round.
//  Runs the same three default-path cases as golden.mjs; for each, slices twice (batch, stream) and
//  asserts the concatenated stream chunks == batch bytes. Also asserts stats parity (segments/filament).
import createSlicer from '../engine/src/slicer_core.js'

function boxTris(ox, oy, oz, sx, sy, sz) {
  const c = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]]
    .map(v => [v[0]+ox, v[1]+oy, v[2]+oz])
  const q = (a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  return [...q(0,1,2,3), ...q(4,5,6,7), ...q(0,1,5,4), ...q(1,2,6,5), ...q(2,3,7,6), ...q(3,0,4,7)]
}
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length*50); buf.writeUInt32LE(tris.length, 80); let off = 84
  for (const t of tris) { off += 12; for (const p of t){ buf.writeFloatLE(p[0],off); buf.writeFloatLE(p[1],off+4); buf.writeFloatLE(p[2],off+8); off += 12 } buf.writeUInt16LE(0,off); off += 2 }
  return buf
}
function centerTris(tris) {
  let mnx=1e9,mny=1e9,mnz=1e9,mxx=-1e9,mxy=-1e9
  for (const t of tris) for (const v of t){ mnx=Math.min(mnx,v[0]);mxx=Math.max(mxx,v[0]);mny=Math.min(mny,v[1]);mxy=Math.max(mxy,v[1]);mnz=Math.min(mnz,v[2]) }
  const cx=(mnx+mxx)/2, cy=(mny+mxy)/2
  return tris.map(t=>t.map(v=>[v[0]-cx, v[1]-cy, v[2]-mnz]))
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

const M = await createSlicer()

// batch: one-shot slice → result.gcode
function batch(stl, p) { return M.slice(new Uint8Array(stl), JSON.stringify(p), ()=>{}) }
// stream: register sink collecting chunks + per-layer counts, slice, unregister, join
function stream(stl, p, economy=false) {
  const chunks = []; let layers = 0; let toolpathSegs = 0
  M.set_layer_sink((z, idx, chunk, paths, widths) => {
    chunks.push(chunk); layers++
    if (paths && typeof paths.length === 'number') toolpathSegs += (paths.length / 8) | 0   // stride 8 floats/seg
  })
  const r = M.slice(new Uint8Array(stl), JSON.stringify({ ...p, economy }), ()=>{})
  M.clear_layer_sink()
  return { gcode: chunks.join(''), layers, toolpathSegs, stats: r.stats, streamed: r.stats && r.stats.streamed }
}

let pass = 0, fail = 0
function eq(name, a, b) {
  if (a === b) { console.log(`  ok: ${name} — byte-identical (${a.length} chars)`); pass++ }
  else {
    fail++
    // find first divergence
    let i = 0; const n = Math.min(a.length, b.length); while (i < n && a[i] === b[i]) i++
    console.log(`  FAIL: ${name} — batch ${a.length} vs stream ${b.length}, first diff @${i}:`)
    console.log(`    batch : ${JSON.stringify(a.slice(Math.max(0,i-20), i+40))}`)
    console.log(`    stream: ${JSON.stringify(b.slice(Math.max(0,i-20), i+40))}`)
  }
}
function approx(name, a, b, tol=1e-6) {
  const ok = Math.abs(a-b) <= tol * Math.max(1, Math.abs(a))
  if (ok) { console.log(`  ok: ${name} (${a} ~= ${b})`); pass++ } else { fail++; console.log(`  FAIL: ${name} (${a} != ${b})`) }
}

const cases = [
  ['cube (default, no support)', cubeSTL, params],
  ['table (default, no support)', tableSTL, params],
  ['table (grid support)', tableSTL, supGrid],
]
for (const [name, stl, p] of cases) {
  const b = batch(stl, p)
  const s = stream(stl, p)
  eq(name, b.gcode, s.gcode)                              // absolute requirement: streamed assembly == batch, byte-identical
  if (!s.streamed) { fail++; console.log(`  FAIL: ${name} — stats.streamed not set (streaming path not taken)`) }
  approx(`${name}: filament stat parity`, b.stats.filament_mm, s.stats.filament_mm)
  approx(`${name}: segment stat parity`, b.stats.path_segments, s.stats.path_segments, 0)
  approx(`${name}: time_estimate parity (streaming GCodeProcessor)`, b.stats.time_estimate, s.stats.time_estimate, 1e-4)
}

// economy mode: g-code must still be byte-identical (toolpaths omitted, time skipped).
{
  const b = batch(cubeSTL, params)
  const s = stream(cubeSTL, params, /*economy*/true)
  eq('cube (economy — no toolpath/time)', b.gcode, s.gcode)
  if (s.toolpathSegs !== 0) { fail++; console.log(`  FAIL: economy emitted ${s.toolpathSegs} toolpath segs (expected 0)`) }
  else { console.log('  ok: economy omits toolpaths (0 segs streamed)'); pass++ }
  if (s.stats.economy !== true) { fail++; console.log('  FAIL: stats.economy not set') } else { console.log('  ok: stats.economy=true'); pass++ }
}

console.log(`\nSTREAM GOLDEN: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('STREAM GOLDEN PASSED — streaming assembly is byte-identical to batch (A1/A2/A3 removed, output unchanged)')
