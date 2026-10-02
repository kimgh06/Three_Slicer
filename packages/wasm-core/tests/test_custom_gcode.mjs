// Issue 63: a printer profile's custom G-code is expanded by upstream's PlaceholderParser when the host sends the
// flattened settings (`placeholder_config`), and copied as written when it does not. Pins: the raw path, the
// expansion (variables, conditionals, the computed first-layer box, total_layer_count), upstream's temperature rule
// around the start block, the Bambu Lab M109, the end block (filament_end_gcode per filament with its
// filament_extruder_id, then machine_end_gcode with layer_num), a template error as a typed slice error that leaves
// the kernel usable, the multi-material path's spliced start block, and st == mt.
import createSlicer from '../../engine/src/slicer_core.js'
import createSlicerMt from '../../engine/src/slicer_core.mt.js'
import { CUSTOM_GCODE_KEYS } from '../../../viewer-package/src/settings/settings_core.js'
import { schema } from '../../engine/src/data.js'

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
// A cube centred on the plate-local origin, as the viewer sends it.
const CUBE_SIZE = 20
const cube = trisToSTL(boxTris(-CUBE_SIZE / 2, -CUBE_SIZE / 2, 0, CUBE_SIZE, CUBE_SIZE, 4))

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
// The skirt's centreline sits skirt_distance + w/2 outside the cube, which is centred on the bed.
const skirtReach = CUBE_SIZE / 2 + params.skirt_distance + params.line_width / 2
const expectedMin = params.bed_width / 2 - skirtReach, expectedMax = params.bed_width / 2 + skirtReach
ok(Math.abs(minX - expectedMin) < 0.01 && Math.abs(minY - expectedMin) < 0.01 && Math.abs(maxX - expectedMax) < 0.01,
   `first_layer_print_min/max hold the skirt's extent (min ${minX}, ${minY}, max ${maxX}; expected ${expectedMin}..${expectedMax})`)
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

console.log('[CUSTOM_GCODE_KEYS] every key the host gates on is one the kernel expands')
// settings_core.js decides when to send the settings by these keys and custom_gcode.cpp names the templates it
//  expands; the two sides are in different languages, so this is what keeps them the same list.
// change_filament_gcode runs at a tool change, so it is checked on the two-box multi-material slice.
const mmBoxes = trisToSTL([...boxTris(-13, -5, 0, 10, 10, 4), ...boxTris(3, -5, 0, 10, 10, 4)])
for (const key of CUSTOM_GCODE_KEYS) {
  const template = `; marker ${key} [total_layer_count]`
  const toolChange = key === 'change_filament_gcode'
  const onlyThis = { ...settings, machine_start_gcode: '', machine_end_gcode: '', filament_end_gcode: [''] }
  if (toolChange) Object.assign(onlyThis, { filament_type: ['PLA', 'PETG'], nozzle_temperature: ['210', '230'], filament_end_gcode: ['', ''] })
  // A per-filament template (coStrings: filament_start/end_gcode) is one entry per filament.
  if (schema[key]?.type === 'coStrings') onlyThis[key] = [template]
  else onlyThis[key] = template
  const keyParams = { ...params, machine_start_gcode: onlyThis.machine_start_gcode, machine_end_gcode: onlyThis.machine_end_gcode,
                      placeholder_config: JSON.stringify(onlyThis) }
  let stl = cube
  if (toolChange) { Object.assign(keyParams, { extruder_count: 2, mm_group_split: 12 }); stl = mmBoxes }
  const run = slice(keyParams, stl)
  ok(new RegExp(`; marker ${key} \\d+`).test(run.gcode ?? ''), `${key} is expanded by the kernel`)
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
const toolChanges = (mm.gcode.match(/^T\d+$/gm) ?? []).length - 1   // the first selection is a T command too
ok(changes === toolChanges && changes > 0, `total_toolchanges = the T commands written after the first (${changes} vs ${toolChanges})`)
ok(/; changes \d+ used true/.test(mm.gcode), 'is_extruder_used marks the second filament (a bool prints as true)')
ok(mm.gcode.indexOf('; machine_start_gcode') < mm.gcode.search(/^T0$/m), 'the start block precedes the first tool select')
ok(mm.gcode.includes('; end A') && mm.gcode.includes('; end B'), 'every filament_end_gcode is written')

console.log('[first filaments] per physical extruder, as cal_non_support_filaments + physical_extruder_map set them')
// A two-nozzle printer whose logical extruder 0 is physical nozzle 1 (Bambu Lab H2D/X2D profiles). Their start
//  G-code indexes first_filaments by physical nozzle; the variable was missing and every slice failed.
const firstTemplate = '; first {first_filaments[0]} {first_filaments[1]} non-support {first_non_support_filaments[0]} {first_non_support_filaments[1]} tools {first_tools[1]}'
const twoNozzles = { nozzle_diameter: ['0.4', '0.4'], physical_extruder_map: ['1', '0'], machine_start_gcode: firstTemplate }
const onOneNozzle = slice(withConfig({ ...twoNozzles, filament_map: ['1'] }))
ok(!onOneNozzle.error, `a two-nozzle template slices (${String(onOneNozzle.error).split('\n')[0]})`)
ok((onOneNozzle.gcode ?? '').includes('; first -1 0 non-support -1 0 tools 0'),
   `filament 0 on logical extruder 0 lands at physical index 1 (${/; first .*/.exec(onOneNozzle.gcode ?? '')?.[0]})`)
const onTwoNozzles = slice(withConfig({ ...mmSettings, ...twoNozzles, filament_map: ['1', '2'] }, { extruder_count: 2, mm_group_split: A.length }), twoBoxes)
ok((onTwoNozzles.gcode ?? '').includes('; first 1 0 non-support 1 0 tools 0'),
   `one filament per nozzle, swapped by the physical map (${/; first .*/.exec(onTwoNozzles.gcode ?? '')?.[0]})`)
const supportFirst = slice(withConfig({ ...mmSettings, ...twoNozzles, filament_map: ['1', '1'], filament_is_support: ['1', '0'] },
                                      { extruder_count: 2, mm_group_split: A.length }), twoBoxes)
ok((supportFirst.gcode ?? '').includes('; first -1 0 non-support -1 1 tools 0'),
   `a support filament is skipped for first_non_support_filaments only (${/; first .*/.exec(supportFirst.gcode ?? '')?.[0]})`)

console.log('[single tool] every object on the third filament: the single-material path prints with it')
// A Bambu Lab project assigns each plate's objects to one filament; a plate on filament 4 used to load filament 1.
const singleSettings = { ...settings, filament_type: ['PLA', 'PETG', 'ABS'], nozzle_temperature_initial_layer: ['210', '230', '250'],
                         nozzle_temperature: ['205', '225', '245'], filament_end_gcode: [''],
                         machine_start_gcode: '; load [initial_extruder] {filament_type[initial_extruder]}', machine_end_gcode: '; end on [current_extruder]' }
const singleParams = { single_tool: 2, extruder_nozzle_temp: [205, 225, 245], extruder_retract_length: [0.8, 0.8, 1.5], gcode_stats_block: true }
const singleTool = slice(withConfig(singleSettings, singleParams))
const singleText = singleTool.gcode ?? ''
ok(!singleTool.error, `slices (${singleTool.error ?? 'no error'})`)
ok(singleText.includes('; load 2 ABS'), 'initial_extruder is the filament the plate prints with')
ok(/^M104 S250 /m.test(singleText.slice(0, singleText.indexOf('; machine_start_gcode'))), 'the nozzle is heated to that filament\'s first-layer temperature')
ok(singleText.includes('; end on 2'), 'the end G-code sees it as the current extruder')
ok(!/^T\d+/m.test(singleText), 'no T command: a single-extruder machine switches nothing (GCode.cpp set_extruder)')
ok(/^G1 E-1\.5000 /m.test(singleText) && !/^G1 E-0\.8000 /m.test(singleText), 'retraction is that filament\'s')
ok(/; filament used \[mm\] = 0\.00, 0\.00, [1-9]/.test(singleText), 'the footer reports the use on that filament')
// A .gcode.3mf's slice_info.config and the stats card read this; without it a Bambu Lab printer was told filament 1.
const byTool = singleTool.stats.filament_mm_by_tool ?? []
ok(byTool.length === 3 && byTool[0] === 0 && byTool[1] === 0 && byTool[2] === singleTool.stats.filament_mm,
   `filament_mm_by_tool puts the use on that filament (${JSON.stringify(byTool)})`)
let otherTool = 0
for (const layer of singleTool.layers) for (let k = 3; k < layer.paths.length; k += 8) if ((layer.paths[k] & 15) !== 0 && (layer.paths[k] >>> 4) !== 2) otherTool++
ok(otherTool === 0, `every extrusion in the toolpath stream carries tool 2 (${otherTool} do not)`)

console.log('[st == mt] the same expanded slice through the pthread kernel')
const slicerMt = await createSlicerMt()
const mtResult = slicerMt.slice(cube, JSON.stringify(withConfig({})), () => {})
ok(mtResult.gcode === gcode, 'byte-identical')
ok(slicerMt.slice(cube, JSON.stringify(withConfig(singleSettings, singleParams)), () => {}).gcode === singleText, 'byte-identical on a single tool')

if (failures) { console.log(`${failures} CUSTOM G-CODE CHECK(S) FAILED`); process.exit(1) }
console.log('ALL CUSTOM G-CODE CHECKS PASSED')
process.exit(0)
