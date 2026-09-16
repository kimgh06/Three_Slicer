// S3 investigation: comparison of the two prime tower paths — default (square ring approximation) vs wipe_tower_real (the ported real WipeTower.generate()).
//  Collects evidence for switching the default. Prints success and G-code plausibility indicators side by side (a human makes the call).
import createSlicer from '../../engine/src/slicer_core.js'

// MM input: two boxes side by side — the kernel splits groups so the leading tris are ext1 and everything after split is ext2
function boxTris(ox, oy, oz, sx, sy, sz) {
  const c = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v => [v[0]+ox, v[1]+oy, v[2]+oz])
  const q = (a,b,cc,d) => [[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  return [...q(0,1,2,3), ...q(4,5,6,7), ...q(0,1,5,4), ...q(1,2,6,5), ...q(2,3,7,6), ...q(3,0,4,7)]
}
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80)
  let off = 84
  for (const t of tris) { off += 12; for (const p of t) { buf.writeFloatLE(p[0], off); buf.writeFloatLE(p[1], off+4); buf.writeFloatLE(p[2], off+8); off += 12 } buf.writeUInt16LE(0, off); off += 2 }
  return buf
}
const A = boxTris(-25, -10, 0, 20, 20, 10), B = boxTris(5, -10, 0, 20, 20, 10)
const stl = new Uint8Array(trisToSTL([...A, ...B]))
const SPLIT = A.length   // triangle index where ext2 starts

const base = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2,
  infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75,
  extruder_count: 2, mm_group_split: SPLIT, prime_tower_width: 30,
}
const M = await createSlicer()

const probe = (label, extra) => {
  let r, err = null
  const t0 = performance.now()
  try { r = M.slice(stl, JSON.stringify({ ...base, ...extra }), () => {}) } catch (e) { err = String(e && e.message || e) }
  const ms = performance.now() - t0
  if (err || !r || r.error) { console.log(`${label.padEnd(22)} failed: ${err || r?.error}`); return null }
  const g = r.gcode
  const lines = g.split('\n')
  const toolChanges = lines.filter(l => /^T[01]\b/.test(l)).length
  const towerReal = lines.filter(l => l.includes('wipe_tower_real')).length
  const towerRing = lines.filter(l => l.includes('prime tower')).length
  const cpToolchange = lines.filter(l => l.includes('CP TOOLCHANGE') || l.includes('WIPE_TOWER')).length
  // type 11 = prime tower toolpath segments
  let towerSeg = 0
  for (const L of r.layers || []) { const p = L.paths; if (!p) continue; for (let i = 0; i < p.length; i += 8) if (p[i+3] === 11) towerSeg++ }
  console.log(`${label.padEnd(22)} layers ${String(r.stats.layers).padStart(3)}  tool changes ${String(toolChanges).padStart(3)}  ` +
    `tower segs ${String(towerSeg).padStart(5)}  filament ${r.stats.filament_mm.toFixed(1).padStart(8)}mm  ` +
    `gcode ${String(g.length).padStart(7)}B  ${ms.toFixed(0)}ms`)
  console.log(`${''.padEnd(22)}   markers: real tower ${towerReal} · ring ${towerRing} · CP/WIPE ${cpToolchange}`)
  return { r, towerSeg, toolChanges, towerReal, cpToolchange }
}

console.log('=== Prime tower path comparison (MM, 2 extruders) ===')
const ring = probe('default (square ring)', { wipe_tower_real: false })
const real = probe('wipe_tower_real', { wipe_tower_real: true })

console.log('\n=== Evidence ===')
if (ring && real) {
  console.log(`Real WipeTower markers emitted: ${real.towerReal > 0 ? 'yes (real path ran)' : 'no (fell back)'}`)
  console.log(`Ring fallback markers: default ${ring.towerRing ?? '-'} / real path ${real.towerRing ?? '-'}`)
  console.log(`Tower toolpath segments: ring ${ring.towerSeg} vs real ${real.towerSeg}`)
}
process.exit(0)
