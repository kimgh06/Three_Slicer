// Stage-31 regression: organic TreeSupport must be LEFT/RIGHT symmetric for a symmetric model.
// Bug: model was re-centered to the ORIGIN before the tree bridge, so its negative-X half fell outside
//  the printable area [0,bed]; TreeSupport clips support to m_machine_border (intersection_ex) → the
//  negative-side ear got NO support (right-only). Fix: re-center to the BED CENTER (positive plate coords).
// Invariant: for a symmetric fixture (central body + two identical ±X ears), the type5 (support) segment
//  count on each side of the model center must be balanced — L/R ratio in [0.7, 1.3] and both sides > 0.
import createSlicer from '../engine/src/slicer_core.js'

function boxTris(ox,oy,oz,sx,sy,sz){
  const c=[[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v=>[v[0]+ox,v[1]+oy,v[2]+oz])
  const q=(a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  return [...q(0,1,2,3),...q(4,5,6,7),...q(0,1,5,4),...q(1,2,6,5),...q(2,3,7,6),...q(3,0,4,7)]
}
function trisToSTL(tris){const buf=Buffer.alloc(84+tris.length*50);buf.writeUInt32LE(tris.length,80);let off=84;for(const t of tris){off+=12;for(const p of t){buf.writeFloatLE(p[0],off);buf.writeFloatLE(p[1],off+4);buf.writeFloatLE(p[2],off+8);off+=12}buf.writeUInt16LE(0,off);off+=2}return buf}
// central column x[-5,5] + two identical elevated ears at z[20,24] sticking out ±X (undersides overhang).
function symFixture(shiftX=0){
  return trisToSTL([
    ...boxTris(-5+shiftX,-5,0, 10,10,30),
    ...boxTris(-15+shiftX,-3,20, 10,6,4),   // LEFT ear
    ...boxTris(5+shiftX,-3,20, 10,6,4),     // RIGHT ear
  ])
}
const base = {
  layer_height:0.2, first_layer_height:0.2, line_width:0.42, wall_loops:2, infill_density:0.15,
  nozzle_diameter:0.4, filament_diameter:1.75, print_speed:60, first_layer_speed:20, travel_speed:150,
  nozzle_temp:210, bed_temp:60, top_shell_layers:3, bottom_shell_layers:3, skirt_loops:0,
  enable_support:true, support_threshold_angle:40, support_top_z_distance:0.2,
  support_xy_distance:0.35, support_interface_top_layers:2,
}
function analyze(r, centerX){
  let left=0, right=0, tot=0
  for (const L of r.layers){ const p=L.paths; if(!p) continue
    for (let k=0;k<p.length;k+=8){ if(p[k+3]===5){ const mx=(p[k]+p[k+4])/2; tot++; if(mx<centerX-1e-6) left++; else if(mx>centerX+1e-6) right++; } } }
  return { left, right, tot }
}
let fail=0
const ok=(c,m)=>{ console.log((c?'  ok: ':'  FAIL: ')+m); if(!c) fail++ }
const M = await createSlicer()
const slice=(stl,p)=>M.slice(new Uint8Array(stl), JSON.stringify(p), ()=>{})

for (const [tag, shiftX] of [['centered', 0], ['off-center +40', 40]]) {
  const r = slice(symFixture(shiftX), { ...base, support_style:'tree' })
  if (r.error){ ok(false, `${tag}: slice error ${r.error}`); continue }
  const a = analyze(r, shiftX)
  const ratio = a.right>0 ? a.left/a.right : (a.left>0?Infinity:NaN)
  console.log(`  [${tag}] type5 total=${a.tot} left=${a.left} right=${a.right} L/R=${Number.isFinite(ratio)?ratio.toFixed(2):ratio}`)
  ok(a.left>0 && a.right>0, `${tag}: BOTH ears get organic support (left=${a.left}, right=${a.right})`)
  ok(Number.isFinite(ratio) && ratio>=0.7 && ratio<=1.3, `${tag}: L/R support balance in [0.7,1.3] (L/R=${Number.isFinite(ratio)?ratio.toFixed(2):ratio})`)
}
// control: tree_lite was already symmetric — guards against a fix that breaks the lite path.
{
  const r = slice(symFixture(0), { ...base, support_style:'tree_lite' })
  const a = analyze(r, 0); const ratio = a.right>0? a.left/a.right : NaN
  ok(a.left>0 && a.right>0 && ratio>=0.7 && ratio<=1.3, `tree_lite control still symmetric (L/R=${Number.isFinite(ratio)?ratio.toFixed(2):ratio})`)
}
console.log(fail===0 ? '\nTREE SYMMETRY TEST PASSED' : `\n${fail} TREE SYMMETRY CHECK(S) FAILED`)
process.exit(fail===0?0:1)
