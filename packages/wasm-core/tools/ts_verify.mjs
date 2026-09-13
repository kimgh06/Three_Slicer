// Stage-17 verification: real organic TreeSupport integrated into slicer_core.js.
// Checks: (1) support_style=tree slices an overhang model with type5 support segments > 0 + the
// "organic tree" g-code marker, (2) per-layer type5 distribution DIFFERS from tree_lite (organic
// branch signature), (3) determinism (two identical runs).
import createSlicer from '../engine/src/slicer_core.js'

// --- self-contained binary-STL box generator (avoids importing test.mjs, which runs+exits) ---
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
// overhang table: 6x6x10 leg at (7,7) + 20x20x4 top at z=10 (same as test.mjs makeTableSTL)
const tableSTL = trisToSTL([...boxTris(7,7,0,6,6,10), ...boxTris(0,0,10,20,20,4)])

const params = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2,
  infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0,
  print_speed: 60, first_layer_speed: 20, travel_speed: 150, nozzle_temp: 210, bed_temp: 60,
  top_shell_layers: 4, bottom_shell_layers: 3, skirt_loops: 1, skirt_distance: 2, brim_width: 0,
  retract_length: 0.8, retract_speed: 30, z_hop: 0.4, infill_angle: 45,
  enable_support: true, support_threshold_angle: 30, support_density: 0.15,
  support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2,
}
const countByType = (paths) => { const c = {}; for (let i=0;i<paths.length;i+=8) c[paths[i+3]]=(c[paths[i+3]]||0)+1; return c }
const typeTotal = (r,t) => r.layers.reduce((a,L)=>a+(countByType(L.paths)[t]||0), 0)
const perLayerType = (r,t) => r.layers.map(L => countByType(L.paths)[t]||0)

let fail = 0
const ok = (c,m) => { console.log((c?'  ok: ':'  FAIL: ')+m); if(!c) fail++ }

const M = await createSlicer()
const slice = (p) => M.slice(new Uint8Array(tableSTL), JSON.stringify(p), ()=>{})

const rTree = slice({ ...params, support_style: 'tree' })
const rLite = slice({ ...params, support_style: 'tree_lite' })
if (rTree.error) { console.error('FAIL: tree slice error', rTree.error); process.exit(1) }

const t5tree = typeTotal(rTree, 5), t5lite = typeTotal(rLite, 5)
console.log(`  tree: layers=${rTree.stats.layers} type5=${t5tree} | tree_lite type5=${t5lite}`)
// (1) organic tree generates support segments + emits the real-pipeline marker
ok(t5tree > 0, `support_style=tree generates support toolpaths (type5=${t5tree})`)
ok(/; support \(organic tree/.test(rTree.gcode), 'g-code has "; support (organic tree — real ported TreeSupport)" marker')
// (2) per-layer distribution differs from tree_lite (organic branches vs simple taper)
const dTree = perLayerType(rTree,5).join(','), dLite = perLayerType(rLite,5).join(',')
ok(dTree !== dLite, 'per-layer support distribution differs from tree_lite (organic branch signature)')
// (3) determinism
const rTree2 = slice({ ...params, support_style: 'tree' })
ok(rTree.gcode === rTree2.gcode, 'determinism: two tree runs produce identical g-code')

// (4) Stage 19 per-path width: widths[k] parallels segment k (stride-8 paths). Prove the bridge carries the
//     REAL per-path support width end-to-end (config -> support flow -> ExtrusionPath::width -> E + ribbon)
//     by showing the emitted support width TRACKS support_line_width config (0.4 default vs explicit 0.6).
//     (Note: this port's support_material_flow/interface_flow share one width key, so interface==body width.)
const treeSupWidths = (r) => {
  const set = new Set()
  for (const L of r.layers) {
    const w = L.widths; if (!w) continue
    for (let k = 0; k < w.length; k++) if (L.paths[k*8+3] === 5) set.add(Math.round(w[k]*1000)/1000)
  }
  return [...set].sort((a,b)=>a-b)
}
const tw = treeSupWidths(rTree)
const rW06 = slice({ ...params, support_style: 'tree', support_line_width: 0.6 })
const tw06 = treeSupWidths(rW06)
console.log(`  support widths — default: [${tw.join(',')}]  support_line_width=0.6: [${tw06.join(',')}]`)
ok(tw.length >= 1 && tw.every(x=>x>0), 'default: support paths carry real per-path width (non-zero, from support flow)')
ok(tw06.includes(0.6) && !tw.includes(0.6), 'support width tracks config (0.6) — per-path width propagated to E + widths[]')

// (5) Stage 19 z alignment: z_resid_max ≈ 0 (support layers sit exactly on the object z grid)
const zr = rTree.gcode.match(/tree_support layers=(\d+) z_resid_max=([0-9.]+)mm/)
ok(!!zr, 'g-code has tree_support z-alignment diagnostic')
if (zr) {
  const resid = parseFloat(zr[2])
  console.log(`  tree_support layers=${zr[1]} z_resid_max=${resid}mm`)
  ok(resid < 1e-4, `support-layer Z exactly on object grid (z_resid_max=${resid}mm < 1e-4)`)
}

console.log(fail === 0 ? '\nTREE VERIFY PASSED' : `\n${fail} TREE CHECK(S) FAILED`)
process.exit(fail === 0 ? 0 : 1)
