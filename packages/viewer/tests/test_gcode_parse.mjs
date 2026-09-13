// gcode_parse self-check — (1) synthetic G-code covering every recognized convention, (2) round-trip:
//  slice a cube with the kernel, parse its own G-code back, compare layers/z/extruded length against r.layers.
//   Run: node packages/viewer/test_gcode_parse.mjs
import assert from 'node:assert'
// This is a ROUND TRIP across the license boundary — slice with the AGPL kernel, read the result
//  back with the permissive parser — so it stays on the AGPL side. The permissive package must not
//  depend on the kernel, in tests either.
import createSlicer from '../engine/src/slicer_core.js'
import { parseGcode } from 'three-slicer-viewer/gcode'

const ROLE_OF = (v) => v & 15, TOOL_OF = (v) => v >>> 4

// ── (1) synthetic: Orca-style comments, absolute E + G92, tool change, arc, travel ───────────────
const synthetic = `
G90
M82
G28 ; home (before any layer -> travel dropped)
;LAYER_CHANGE
;Z:0.2
;TYPE:Skirt
;WIDTH:0.5
G1 X0 Y0 Z0.2 F9000
G1 X10 Y0 E1.0
G1 X10 Y10 E2.0
G92 E0
;TYPE:Outer wall
G1 X0 Y10 E1.0
T1
G1 X0 Y0 E2.0
;LAYER_CHANGE
;Z:0.4
;TYPE:Sparse infill
G1 Z0.4 F9000
G1 X10 Y0 E3.0
G3 X0 Y10 I-10 J0 E4.0 ; quarter arc ccw, r=10
M83
G1 X0 Y0 E1.5 ; relative E now
`
const s = parseGcode(synthetic)
assert.strictEqual(s.layers.length, 2, `synthetic layer count ${s.layers.length}`)
assert.ok(Math.abs(s.layers[0].z - 0.2) < 1e-6 && Math.abs(s.layers[1].z - 0.4) < 1e-6, 'synthetic layer z')
const roles0 = new Set(), tools0 = new Set()
for (let k = 0; k < s.layers[0].paths.length; k += 8) { roles0.add(ROLE_OF(s.layers[0].paths[k + 3])); tools0.add(TOOL_OF(s.layers[0].paths[k + 3])) }
assert.ok(roles0.has(4) && roles0.has(1), `layer0 roles skirt+wall, got ${[...roles0]}`)
assert.ok(tools0.has(0) && tools0.has(1), `layer0 tools 0 and 1, got ${[...tools0]}`)
assert.deepStrictEqual(s.stats.tools, [0, 1], 'tools seen')
const firstExtrW = [...s.layers[0].widths].find(w => w > 0)   // widths[i]=0 for travels — skip to the first extrusion
assert.ok(Math.abs(firstExtrW - 0.5) < 1e-6, `;WIDTH: honored (got ${firstExtrW})`)
// quarter arc r=10 -> length 5π ≈ 15.708, interpolated into chords; compare summed length
let arcLen = 0
{
  const p = s.layers[1].paths
  for (let k = 0; k < p.length; k += 8) if (ROLE_OF(p[k + 3]) === 2) arcLen += Math.hypot(p[k + 4] - p[k], p[k + 5] - p[k + 1])
}
const expectArc = 10 /*G1*/ + 5 * Math.PI /*G3*/ + 10 /*relative-E G1*/
assert.ok(Math.abs(arcLen - expectArc) / expectArc < 0.01, `arc+linear length ${arcLen.toFixed(3)} ≈ ${expectArc.toFixed(3)}`)
// travel: the Z-only hop at layer 2 start is a travel inside layer 2; pre-layer G28 was dropped
assert.ok(s.stats.travel_segments >= 1, 'travel counted')
const t0 = s.layers[1].paths
assert.ok(ROLE_OF(t0[3]) === 0, 'layer2 starts with the z-move travel')
console.log(`  ok: synthetic (${s.stats.path_segments} extrusions, ${s.stats.travel_segments} travels)`)

// ── (2) round-trip against the kernel ────────────────────────────────────────────────────────────
function makeBoxSTL(sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]]
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  const buf = Buffer.alloc(84 + f.length * 50)
  buf.writeUInt32LE(f.length, 80)
  let off = 84
  for (const face of f) {
    off += 12
    for (const idx of face) { buf.writeFloatLE(v[idx][0], off); buf.writeFloatLE(v[idx][1], off + 4); buf.writeFloatLE(v[idx][2], off + 8); off += 12 }
    buf.writeUInt16LE(0, off); off += 2
  }
  return buf
}
const params = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2,
  infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0,
  print_speed: 60, first_layer_speed: 20, travel_speed: 150, nozzle_temp: 210, bed_temp: 60,
  top_shell_layers: 4, bottom_shell_layers: 3, skirt_loops: 1, skirt_distance: 2, brim_width: 0,
  retract_length: 0.8, retract_speed: 30, z_hop: 0.4, infill_angle: 45,
}
const Module = await createSlicer()
const r = Module.slice(new Uint8Array(makeBoxSTL(20, 20, 20)), JSON.stringify(params), () => {})
assert.ok(!r.error, `slice error: ${r.error}`)
const g = parseGcode(r.gcode, { filamentDiameter: params.filament_diameter })

assert.strictEqual(g.layers.length, r.layers.length, `layer count parsed ${g.layers.length} vs kernel ${r.layers.length}`)
const extrLen = (paths) => { let L = 0; for (let k = 0; k < paths.length; k += 8) if (ROLE_OF(paths[k + 3]) !== 0) L += Math.hypot(paths[k + 4] - paths[k], paths[k + 5] - paths[k + 1]); return L }
let worst = 0
for (let i = 0; i < r.layers.length; i++) {
  assert.ok(Math.abs(g.layers[i].z - r.layers[i].z) < 2e-3, `layer ${i} z parsed ${g.layers[i].z} vs kernel ${r.layers[i].z}`)
  const a = extrLen(g.layers[i].paths), b = extrLen(r.layers[i].paths)
  const rel = Math.abs(a - b) / Math.max(b, 1e-9)
  worst = Math.max(worst, rel)
  assert.ok(rel < 0.02, `layer ${i} extruded length parsed ${a.toFixed(2)} vs kernel ${b.toFixed(2)} (${(rel * 100).toFixed(2)}%)`)
}
// Role markers are per-run and must not leak. The kernel writes "; skirt" once, for layer 0's skirt, plus a header
//  line "; skirt=1@2.0mm brim=…" that describes settings rather than a feature — both used to stamp the ENTIRE file
//  as skirt (measured in the browser: every layer rendered skirt-green).
const rolesOf = (Ly) => { const s = new Set(); for (let k = 0; k < Ly.paths.length; k += 8) s.add(ROLE_OF(Ly.paths[k + 3])); return s }
const l0roles = rolesOf(g.layers[0])
assert.ok(l0roles.has(4), `layer0 has skirt role, got ${[...l0roles]}`)
for (let i = 1; i < g.layers.length; i++) {
  assert.ok(!rolesOf(g.layers[i]).has(4), `layer ${i} must not inherit layer 0's skirt marker`)
}
// The settings header alone must set nothing (it precedes every layer, so a false positive colours the whole file).
const headerOnly = parseGcode('; skirt=1@2.0mm brim=0.0mm\n;LAYER_CHANGE\n;Z:0.2\nG1 X10 Y0 E1\n')
assert.strictEqual(ROLE_OF(headerOnly.layers[0].paths[3]), 1, 'header "; skirt=…" is not a skirt marker')
const meanW = (Ly) => { let s = 0, n = 0; for (const w of Ly.widths) if (w > 0) { s += w; n++ } return n ? s / n : 0 }
const mid = r.layers.length >> 1
const wRel = Math.abs(meanW(g.layers[mid]) - meanW(r.layers[mid])) / meanW(r.layers[mid])
assert.ok(wRel < 0.25, `mid-layer mean width parsed ${meanW(g.layers[mid]).toFixed(3)} vs kernel ${meanW(r.layers[mid]).toFixed(3)} (${(wRel * 100).toFixed(1)}%)`)
console.log(`  ok: round-trip (${g.layers.length} layers, worst layer length delta ${(worst * 100).toFixed(3)}%, mid width delta ${(wRel * 100).toFixed(1)}%)`)

// ── (3) tag mode: exact role recovery ────────────────────────────────────────────────────────────
// Without tags the kernel states a role only where it writes a free-form marker ("; skirt"), so unmarked runs
//  can only fall back to wall — the check above pins the fallback down. With `emit_pe_tags` every run carries
//  ;_EXTRUSION_ROLE, and then the parsed roles must match the kernel's own per-segment roles exactly.
// pe_strip_tags defaults to true (slicer_core.cpp strips them from the final output), so tag mode has to ask to keep them.
const rTag = Module.slice(new Uint8Array(makeBoxSTL(20, 20, 20)), JSON.stringify({ ...params, emit_pe_tags: true, pe_strip_tags: false }), () => {})
assert.ok(!rTag.error, `tag-mode slice error: ${rTag.error}`)
assert.ok(rTag.gcode.includes(';_EXTRUSION_ROLE:'), 'tag mode emits ;_EXTRUSION_ROLE')
const gTag = parseGcode(rTag.gcode, { filamentDiameter: params.filament_diameter })
const histogram = (layers, pick) => {
  const h = {}
  for (const Ly of layers) for (let k = 0; k < Ly.paths.length; k += 8) {
    const role = ROLE_OF(Ly.paths[k + 3]); if (role === 0) continue
    h[role] = (h[role] ?? 0) + pick(Ly, k)
  }
  return h
}
const lenOf = (Ly, k) => Math.hypot(Ly.paths[k + 4] - Ly.paths[k], Ly.paths[k + 5] - Ly.paths[k + 1])
const hParsed = histogram(gTag.layers, lenOf), hKernel = histogram(rTag.layers, lenOf)
for (const role of Object.keys(hKernel)) {
  const a = hParsed[role] ?? 0, b = hKernel[role]
  assert.ok(Math.abs(a - b) / b < 0.02, `role ${role} length parsed ${a.toFixed(1)} vs kernel ${b.toFixed(1)}`)
}
assert.deepStrictEqual(Object.keys(hParsed).sort(), Object.keys(hKernel).sort(), 'tag mode recovers exactly the kernel roles')
console.log(`  ok: tag mode roles ${Object.keys(hKernel).sort((a, b) => a - b).join(',')} recovered exactly`)
console.log('gcode_parse: ALL OK')
