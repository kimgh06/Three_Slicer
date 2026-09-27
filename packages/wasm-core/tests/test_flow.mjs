// Upstream's extrusion multipliers and volumetric cap (GCode.cpp:7343-7390, :7492), each against the same slice
// without the key: a key the host does not send changes nothing (golden pins that), a key it sends scales exactly the
// paths upstream scales. E per millimetre is read back from the G-code text, per ;TYPE: role and layer.
import createSlicer from '../../engine/src/slicer_core.js'

let failures = 0
const ok = (condition, message) => {
  console.log(`  ${{ true: 'ok' }[condition] ?? 'FAIL'}: ${message}`)
  if (!condition) failures++
}
const near = (a, b, tolerance = 0.002) => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b))

function boxTris(ox, oy, oz, sx, sy, sz) {
  const c = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v => [v[0]+ox, v[1]+oy, v[2]+oz])
  const q = (a,b,cc,d) => [[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  return [...q(0,1,2,3), ...q(4,5,6,7), ...q(0,1,5,4), ...q(1,2,6,5), ...q(2,3,7,6), ...q(3,0,4,7)]
}
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length*50); buf.writeUInt32LE(tris.length, 80); let off = 84
  for (const t of tris) { off += 12; for (const p of t) { buf.writeFloatLE(p[0],off); buf.writeFloatLE(p[1],off+4); buf.writeFloatLE(p[2],off+8); off += 12 } buf.writeUInt16LE(0,off); off += 2 }
  return new Uint8Array(buf)
}
const cube = trisToSTL(boxTris(-10, -10, 0, 20, 20, 4))
// A 6 mm post under a 20 mm slab: the slab's underside is a bridge.
const table = trisToSTL([...boxTris(-3, -3, 0, 6, 6, 10), ...boxTris(-10, -10, 10, 20, 20, 4)])
const base = { layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15,
  nozzle_diameter: 0.4, filament_diameter: 1.75, nozzle_temp: 210, bed_temp: 60, bed_width: 220, bed_depth: 220,
  skirt_loops: 1, skirt_distance: 2, gcode_role_tags: true, wall_generator: 'classic' }
const FILAMENT_AREA = Math.PI * base.filament_diameter ** 2 / 4

// Every extrusion G1/G2/G3 longer than 1 mm: { layer, role, ePerMm, flow (mm³/s) }.
function extrusions(gcode) {
  const moves = []
  let x = 0, y = 0, f = 0, layer = -1, role = ''
  for (const line of gcode.split('\n')) {
    const marker = /^; LAYER (\d+)/.exec(line)
    if (marker) { layer = Number(marker[1]); continue }
    if (line.startsWith(';TYPE:')) { role = line.slice(6); continue }
    const move = /^G([0-3]) (.*)/.exec(line)
    if (!move) continue
    const words = Object.fromEntries(move[2].split(';')[0].trim().split(/\s+/).map(w => [w[0], Number(w.slice(1))]))
    if (words.F) f = words.F
    const nx = words.X ?? x, ny = words.Y ?? y
    const distance = Math.hypot(nx - x, ny - y)
    x = nx; y = ny
    if (move[1] !== '1' || !(words.E > 0) || distance < 1) continue
    moves.push({ layer, role, ePerMm: words.E / distance, flow: words.E * FILAMENT_AREA / distance * f / 60 })
  }
  return moves
}
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] }
const ePerMm = (moves, keep) => median(moves.filter(keep).map(m => m.ePerMm))

const slicer = await createSlicer()
const slice = (model, params) => {
  const result = slicer.slice(model, JSON.stringify(params), () => {})
  if (result.error) throw new Error(result.error)
  return { result, moves: extrusions(result.gcode) }
}

console.log('[filament_max_volumetric_speed] caps every extrusion, as upstream does (GCode.cpp:7492)')
{
  const fast = { ...base, print_speed: 300, first_layer_speed: 300 }
  const free = slice(cube, fast)
  const capped = slice(cube, { ...fast, filament_max_volumetric_speed: [5] })
  const maxFree = Math.max(...free.moves.map(m => m.flow)), maxCapped = Math.max(...capped.moves.map(m => m.flow))
  ok(maxFree > 5, `without the key the flow reaches ${maxFree.toFixed(1)} mm³/s`)
  ok(maxCapped <= 5.01, `with a 5 mm³/s cap the fastest extrusion is ${maxCapped.toFixed(2)} mm³/s`)
  ok(capped.result.gcode.split('\n').filter(l => /^G1 .*E/.test(l)).length === free.result.gcode.split('\n').filter(l => /^G1 .*E/.test(l)).length,
    'the cap changes speeds, not the paths')
  ok(near(capped.result.stats.filament_mm, free.result.stats.filament_mm, 1e-9), 'nor the filament')
}

console.log('[print_flow_ratio] scales every path')
{
  const plain = slice(cube, base), scaled = slice(cube, { ...base, print_flow_ratio: 0.9 })
  ok(near(scaled.result.stats.filament_mm / plain.result.stats.filament_mm, 0.9, 1e-6),
    `filament ${plain.result.stats.filament_mm.toFixed(2)} -> ${scaled.result.stats.filament_mm.toFixed(2)} mm (x0.9)`)
}

console.log("[top_solid_infill_flow_ratio / bottom_solid_infill_flow_ratio] only this layer's exposed top and bottom")
{
  const plain = slice(cube, base), scaled = slice(cube, { ...base, top_solid_infill_flow_ratio: 0.8, bottom_solid_infill_flow_ratio: 1.2 })
  const top = plain.result.stats.layers - 1
  const solidOn = (moves, layer) => ePerMm(moves, m => m.layer === layer && m.role === 'Internal solid infill')
  ok(near(solidOn(scaled.moves, top) / solidOn(plain.moves, top), 0.8), `top layer solid E/mm x${(solidOn(scaled.moves, top) / solidOn(plain.moves, top)).toFixed(3)}`)
  ok(near(solidOn(scaled.moves, 0) / solidOn(plain.moves, 0), 1.2), `first layer solid E/mm x${(solidOn(scaled.moves, 0) / solidOn(plain.moves, 0)).toFixed(3)}`)
  ok(near(solidOn(scaled.moves, top - 1), solidOn(plain.moves, top - 1)), 'a shell layer below the top prints as before')
}

console.log('[bridge_flow] the bridge section, regular or a round thread (thick_bridges)')
{
  const plain = slice(table, base)
  const bridge = moves => ePerMm(moves, m => m.role === 'Bridge')
  ok(Number.isFinite(bridge(plain.moves)), 'the table has a bridge')
  const scaled = slice(table, { ...base, bridge_flow: 0.8 })
  ok(near(bridge(scaled.moves) / bridge(plain.moves), 0.8), `bridge E/mm x${(bridge(scaled.moves) / bridge(plain.moves)).toFixed(3)}`)
  const thick = slice(table, { ...base, bridge_flow: 0.8, thick_bridges: true })
  const expected = Math.PI * (base.nozzle_diameter * Math.sqrt(0.8)) ** 2 / 4 / FILAMENT_AREA
  ok(near(bridge(thick.moves), expected, 0.002), `thick bridge E/mm ${bridge(thick.moves).toFixed(5)} = pi/4 (0.4 sqrt 0.8)^2 / filament area`)
}

console.log('[brim_flow_ratio] the brim, not the skirt')
{
  const withBrim = { ...base, brim_width: 2 }
  const plain = slice(cube, withBrim), scaled = slice(cube, { ...withBrim, brim_flow_ratio: 0.7 })
  const skirt = moves => ePerMm(moves, m => m.layer === 0 && m.role === 'Skirt')
  ok(scaled.result.gcode.includes('; brim'), 'the brim is emitted on its own')
  const brimMoves = scaled.result.gcode.split('; brim\n')[1]
  ok(brimMoves && near(ePerMm(extrusions('; LAYER 0\n;TYPE:Skirt\n' + brimMoves.split(';TYPE:')[0]), () => true) / skirt(plain.moves), 0.7, 0.01),
    'brim E/mm x0.7 of the skirt')
}

console.log('[set_other_flow_ratios] per-role ratios and the first layer, off unless the switch is on')
{
  const others = { outer_wall_flow_ratio: 0.9, sparse_infill_flow_ratio: 1.1, first_layer_flow_ratio: 1.05 }
  const plain = slice(cube, base)
  const off = slice(cube, { ...base, ...others })
  ok(off.result.gcode === plain.result.gcode, 'without set_other_flow_ratios the per-role ratios do nothing')
  const on = slice(cube, { ...base, ...others, set_other_flow_ratios: true })
  const sparse = (moves, layer) => ePerMm(moves, m => m.layer === layer && m.role === 'Sparse infill')
  ok(near(sparse(on.moves, 5) / sparse(plain.moves, 5), 1.1), 'sparse infill x1.1')
  const walls = (moves, layer) => moves.filter(m => m.layer === layer && m.role === 'Outer wall').map(m => m.ePerMm)
  ok(near(Math.min(...walls(on.moves, 5)) / Math.min(...walls(plain.moves, 5)), 0.9), 'the outer wall x0.9')
  const skirt = moves => ePerMm(moves, m => m.layer === 0 && m.role === 'Skirt')
  ok(near(skirt(on.moves), skirt(plain.moves)), 'the skirt keeps its flow on the first layer')
  // The cube's first layer is all bottom shell, so the first-layer ratio is read on its outer wall.
  ok(near(Math.min(...walls(on.moves, 0)) / Math.min(...walls(plain.moves, 0)), 0.9 * 1.05), 'the first layer outer wall x0.9 x1.05')
}

console.log('[multi-material] the same multipliers on the multi-material path')
{
  const A = boxTris(-13, -5, 0, 10, 10, 4), B = boxTris(3, -5, 0, 10, 10, 4)
  const twoBoxes = trisToSTL([...A, ...B])
  const mm = { ...base, extruder_count: 2, mm_group_split: A.length, wall_generator: 'arachne' }
  const plain = slice(twoBoxes, mm), scaled = slice(twoBoxes, { ...mm, print_flow_ratio: 0.9, filament_max_volumetric_speed: [2, 2] })
  ok(scaled.result.stats.filament_mm < plain.result.stats.filament_mm * 0.95, 'print_flow_ratio scales it')
  ok(Math.max(...scaled.moves.filter(m => m.role !== 'Prime tower').map(m => m.flow)) <= 2.01, 'the cap holds for both tools')
}

if (failures) { console.log(`${failures} FLOW CHECK(S) FAILED`); process.exit(1) }
console.log('ALL FLOW CHECKS PASSED')
process.exit(0)
