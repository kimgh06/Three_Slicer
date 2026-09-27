// Issue 63: a printer profile's custom G-code is expanded by upstream's PlaceholderParser when the host sends the
// flattened settings (`placeholder_config`), and copied as written when it does not. Pins: the raw path, the
// expansion (variables, conditionals, the computed first-layer box, total_layer_count), upstream's temperature rule
// around the start block, the Bambu Lab M109, the end block (filament_end_gcode per filament with its
// filament_extruder_id, then machine_end_gcode with layer_num), a template error as a typed slice error that leaves
// the kernel usable, the multi-material path's spliced start block, and st == mt.
import createSlicer from '../../engine/src/slicer_core.js'
import createSlicerMt from '../../engine/src/slicer_core.mt.js'

let failures = 0
const ok = (condition, message) => {
  console.log(`  ${{ true: 'ok' }[condition] ?? 'FAIL'}: ${message}`)
  if (!condition) failures++
}

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
// A 20 x 20 x 4 mm cube centred on the plate-local origin, as the viewer sends it.
const cube = trisToSTL(boxTris(-10, -10, 0, 20, 20, 4))

const START = [
  'M140 S[bed_temperature_initial_layer_single]',
  '{if curr_bed_type=="Textured PEI Plate"}; plate textured{else}; plate other{endif}',
  '; first layer min {first_layer_print_min[0]} {first_layer_print_min[1]} max {first_layer_print_max[0]}',
  '; layers [total_layer_count] filament {filament_type[initial_extruder]} nozzle [nozzle_temperature_initial_layer]',
].join('\n')
const END = '; end at layer [layer_num] z {layer_z}'
// The settings as a project_settings.config holds them: strings, and arrays of strings for vector options.
const settings = {
  printer_model: 'Generic Test Printer',
  curr_bed_type: 'Textured PEI Plate',
  textured_plate_temp_initial_layer: ['65'], textured_plate_temp: ['60'],
  hot_plate_temp_initial_layer: ['55'], hot_plate_temp: ['55'],
  nozzle_temperature_initial_layer: ['220'], nozzle_temperature: ['215'],
  filament_type: ['PETG'],
  filament_end_gcode: ['; filament end [filament_extruder_id] of [current_filament_id]'],
  machine_start_gcode: START, machine_end_gcode: END,
  printable_area: ['0x0', '180x0', '180x180', '0x180'],
}
const params = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15,
  nozzle_temp: 215, bed_temp: 55, bed_width: 180, bed_depth: 180, skirt_loops: 1, skirt_distance: 2,
  machine_start_gcode: START, machine_end_gcode: END,
}
const withConfig = (extra, overrides = {}) => {
  const merged = { ...settings, ...extra }
  return { ...params, ...overrides, machine_start_gcode: merged.machine_start_gcode, machine_end_gcode: merged.machine_end_gcode,
           placeholder_config: JSON.stringify(merged) }
}

const slicer = await createSlicer()
const slice = (p, stl = cube) => slicer.slice(stl, JSON.stringify(p), () => {})

console.log('[raw path] no placeholder_config: the templates are copied as written')
const raw = slice(params)
ok(!raw.error && raw.gcode.includes('M140 S[bed_temperature_initial_layer_single]'), 'the template text is copied unexpanded')
ok(raw.gcode.includes('M190 S55'), 'the kernel keeps its own temperature preamble')

console.log('[expanded] placeholder_config present')
const expanded = slice(withConfig({}))
ok(!expanded.error, `slices (${expanded.error ?? 'no error'})`)
const gcode = expanded.gcode ?? ''
const startBlock = gcode.slice(gcode.indexOf('; machine_start_gcode (printer profile, expanded)'), gcode.indexOf('; LAYER 0'))
ok(startBlock.includes('M140 S65'), 'bed_temperature_initial_layer_single follows curr_bed_type (textured first layer 65)')
ok(startBlock.includes('; plate textured'), 'the {if} branch on curr_bed_type is taken')
ok(startBlock.includes('filament PETG nozzle 220'), 'vector variables index by the initial extruder')
const layerCount = Number(/; layers (\d+)/.exec(startBlock)?.[1])
ok(layerCount === expanded.stats.layers, `total_layer_count = the slice's layer count (${layerCount} vs ${expanded.stats.layers})`)
const [minX, minY, maxX] = (/; first layer min ([-\d.]+) ([-\d.]+) max ([-\d.]+)/.exec(startBlock) ?? []).slice(1).map(Number)
// The cube spans 80..100 on the 180 mm bed; the skirt's centreline sits skirt_distance + w/2 outside it.
ok(Math.abs(minX - (80 - 2 - 0.21)) < 0.01 && Math.abs(minY - (80 - 2 - 0.21)) < 0.01 && Math.abs(maxX - (100 + 2 + 0.21)) < 0.01,
   `first_layer_print_min/max hold the skirt's extent (min ${minX}, ${minY}, max ${maxX})`)
ok(!/\[[a-z_][a-z_0-9]*\]|\{[^}\n]*\}/.test(startBlock), 'nothing is left unexpanded in the start block')
const preStart = gcode.slice(0, gcode.indexOf('; machine_start_gcode (printer profile, expanded)'))
ok(!/^M140 |^M190 /m.test(preStart), 'the start G-code sets the bed, so no bed temperature is written before it')
ok(/^M104 S220 ; set nozzle temperature$/m.test(preStart), 'the nozzle is not set by the template, so M104 S220 precedes it (upstream text)')
ok(!/^M109 /m.test(gcode.slice(gcode.indexOf('; machine_start_gcode'), gcode.indexOf('G21 ; mm'))), 'no M109 after the start block for a non-Bambu printer')
ok(gcode.indexOf('G21 ; mm') > gcode.indexOf('; machine_start_gcode'), "the writer's modes follow the start block")
ok(gcode.includes('; filament end 0 of 0'), 'filament_end_gcode sees filament_extruder_id and current_filament_id')
ok(new RegExp(`; end at layer ${expanded.stats.layers - 1} z [\\d.]+`).test(gcode), 'machine_end_gcode sees layer_num of the last layer')
ok(!/^M104 S0$/m.test(gcode), "the kernel's own heater shutdown is replaced by the end G-code")

console.log('[streamed] the worker slices through the layer sink; the chunks join to the batch text')
{
  const chunks = []
  slicer.set_layer_sink((z, idx, text) => { chunks.push(text) })
  let streamed
  try { streamed = slicer.slice(cube, JSON.stringify(withConfig({})), () => {}) } finally { slicer.clear_layer_sink() }
  ok(!streamed.error && streamed.stats.streamed, `streams (${streamed.error ?? 'no error'})`)
  ok(chunks.join('') === gcode, `streamed chunks == batch G-code (${chunks.join('').length} vs ${gcode.length} bytes)`)
}

console.log('[upstream temperature rule] template without temperatures')
const bare = slice(withConfig({ machine_start_gcode: 'G28' }))
const barePre = bare.gcode.slice(0, bare.gcode.indexOf('; machine_start_gcode'))
ok(/^M190 S65 ; set bed temperature and wait for it to be reached$/m.test(barePre), 'M190 with the first-layer bed temperature is written before it')

console.log('[Bambu Lab] printer_model "Bambu Lab ..." waits for the nozzle after the start block')
const bbl = slice(withConfig({ printer_model: 'Bambu Lab A1 mini', machine_start_gcode: 'G28' }))
const bblAfter = bbl.gcode.slice(bbl.gcode.indexOf('; machine_start_gcode'), bbl.gcode.indexOf('G21 ; mm'))
ok(/^M109 S220 ; set nozzle temperature and wait for it to be reached$/m.test(bblAfter), 'M109 follows the start block')
ok(bbl.gcode.includes('M981 S0 P20000 ; close spaghetti detector'), 'the end block closes the spaghetti detector')

console.log('[error] a template error fails the slice with a typed code and leaves the kernel usable')
const broken = slice(withConfig({ machine_start_gcode: 'M104 S[no_such_variable]' }))
ok(typeof broken.error === 'string' && broken.error.startsWith('CUSTOM_GCODE_ERROR: machine_start_gcode: Parsing error at line 1'),
   `error: ${String(broken.error).split('\n')[0]}`)
const afterError = slice(withConfig({}))
ok(afterError.gcode === gcode, 'the next slice is byte-identical to the one before the error')

console.log('[multi-material] the start block is spliced in after emission, with the real tool changes')
const A = boxTris(-13, -5, 0, 10, 10, 4), B = boxTris(3, -5, 0, 10, 10, 4)
const twoBoxes = trisToSTL([...A, ...B])
const mmSettings = { ...settings, filament_type: ['PLA', 'PETG'], nozzle_temperature_initial_layer: ['210', '230'], nozzle_temperature: ['210', '230'],
                     filament_end_gcode: ['; end A', '; end B'], machine_start_gcode: '; changes [total_toolchanges] used {is_extruder_used[1]}' }
const mm = slice(withConfig(mmSettings, { extruder_count: 2, mm_group_split: A.length }), twoBoxes)
ok(!mm.error, `multi-material slices (${mm.error ?? 'no error'})`)
const changes = Number(/; changes (\d+) used (\w+)/.exec(mm.gcode ?? '')?.[1])
const toolChanges = (mm.gcode.match(/^T\d+$/gm) ?? []).length
ok(changes === toolChanges && changes > 0, `total_toolchanges = the T commands written (${changes} vs ${toolChanges})`)
ok(/; changes \d+ used true/.test(mm.gcode), 'is_extruder_used marks the second filament (a bool prints as true)')
ok(mm.gcode.indexOf('; machine_start_gcode') < mm.gcode.indexOf('T0 ; start extruder'), 'the start block precedes the first tool select')
ok(mm.gcode.includes('; end A') && mm.gcode.includes('; end B'), 'every filament_end_gcode is written')

console.log('[st == mt] the same expanded slice through the pthread kernel')
const slicerMt = await createSlicerMt()
const mtResult = slicerMt.slice(cube, JSON.stringify(withConfig({})), () => {})
ok(mtResult.gcode === gcode, 'byte-identical')

if (failures) { console.log(`${failures} CUSTOM G-CODE CHECK(S) FAILED`); process.exit(1) }
console.log('ALL CUSTOM G-CODE CHECKS PASSED')
process.exit(0)
